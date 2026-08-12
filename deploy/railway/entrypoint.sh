#!/bin/sh
# Dispatch on GBRAIN_ROLE so one image serves both Railway services.
#
# Railway's per-service `deploy.startCommand` is set through the dashboard's
# config-as-code path; `railway environment edit --service-config` reports
# "No changes to apply" and never commits, so the start command cannot be
# driven from the CLI. Service *variables* set reliably, so the role is a
# variable and the dispatch lives here in the image.
set -e

# Clone/refresh the brain repo and configure git + deploy keys.
#
# Called by BOTH the worker and autopilot roles. It used to run only for
# autopilot, which was a bug: `sync` jobs go to the shared 'default' queue and
# BOTH the standalone worker service and the autopilot's own embedded worker
# drain it. Whichever claimed a sync job first ran it — and in the worker
# container /app/brain did not exist, so the job died with "Not inside a git
# repository: /app/brain". Roughly half of all syncs were lost that way, while
# the surviving half kept last_commit moving so the failure looked intermittent
# rather than structural.
setup_brain_repo() {
    # `sync` reads AND writes the brain repo (gbrain commits and pushes back —
    # see brain-repo-durability.ts), so the deploy key must be read-write and git
    # needs a committer identity in every container that might run a sync job.
    BRAIN_DIR="${GBRAIN_BRAIN_DIR:-/app/brain}"
    BRANCH="${GBRAIN_BRAIN_BRANCH:-main}"

    # A GitHub deploy key authorizes exactly one repo, so multiple repos need
    # multiple keys — and ssh cannot tell them apart by hostname alone, since
    # both are github.com. Each key therefore gets a Host alias that pins it via
    # IdentitiesOnly; clone URLs use `git@<alias>:owner/repo.git`.
    mkdir -p /root/.ssh && chmod 700 /root/.ssh
    : > /root/.ssh/config && chmod 600 /root/.ssh/config

    add_deploy_key() {  # $1 = host alias, $2 = base64 private key
      [ -n "$2" ] || return 0
      _kf="/root/.ssh/id_$1"
      # base64 because an OpenSSH private key is multi-line and env-var
      # round-tripping through a platform UI mangles embedded newlines.
      printf '%s' "$2" | base64 -d > "$_kf"
      chmod 600 "$_kf"
      {
        echo "Host $1"
        echo "  HostName github.com"
        echo "  User git"
        echo "  IdentityFile $_kf"
        echo "  IdentitiesOnly yes"
      } >> /root/.ssh/config
      echo "entrypoint: deploy key registered for alias $1" >&2
    }

    add_deploy_key gh-sam-brain "${GBRAIN_BRAIN_DEPLOY_KEY_B64:-}"
    add_deploy_key gh-obsidian  "${GBRAIN_OBSIDIAN_DEPLOY_KEY_B64:-}"

    # Pin the host key instead of StrictHostKeyChecking=no, which would accept
    # any MITM offering itself as github.com. One entry covers every alias
    # because they all resolve to HostName github.com.
    ssh-keyscan -t ed25519 github.com > /root/.ssh/known_hosts 2>/dev/null
    chmod 644 /root/.ssh/known_hosts

    git config --global user.name "${GBRAIN_GIT_USER_NAME:-gbrain autopilot}"
    git config --global user.email "${GBRAIN_GIT_USER_EMAIL:-autopilot@gbrain.local}"
    git config --global --add safe.directory "$BRAIN_DIR"

    clone_or_update() {  # $1 = remote, $2 = dest, $3 = branch
      [ -n "$1" ] || return 0
      if [ -d "$2/.git" ]; then
        # Reset rather than pull: the container holds no work worth preserving,
        # and a merge conflict here would wedge the loop with no operator present.
        git -C "$2" fetch origin "$3" && git -C "$2" reset --hard "origin/$3"
      else
        # Full clone, not --depth 1: gbrain pushes back to the brain repo, and a
        # shallow clone makes that fragile.
        git clone --branch "$3" "$1" "$2"
      fi
      git config --global --add safe.directory "$2"
    }

    clone_or_update "${GBRAIN_BRAIN_REPO:-}" "$BRAIN_DIR" "$BRANCH"
    # Secondary content source (Obsidian vault). Read-only; a failure here must
    # not stop the brain's own cycle, so it is not fatal.
    if [ -n "${GBRAIN_OBSIDIAN_REPO:-}" ]; then
      clone_or_update "$GBRAIN_OBSIDIAN_REPO" "${GBRAIN_OBSIDIAN_DIR:-/app/obsidian}" \
        "${GBRAIN_OBSIDIAN_BRANCH:-main}" \
        || echo "entrypoint: obsidian clone/update failed — continuing without it" >&2
    fi

    if [ ! -d "$BRAIN_DIR/.git" ]; then
      echo "entrypoint: $BRAIN_DIR is not a git repo and GBRAIN_BRAIN_REPO is unset — sync would fail every cycle" >&2
      exit 1
    fi

}


case "${GBRAIN_ROLE:-web}" in
  web)
    # --bind 0.0.0.0 is required: the default flipped to 127.0.0.1 in v0.34.1,
    # and Railway's proxy reaches the container over its private interface.
    exec gbrain serve --http \
      --port "${PORT:-8080}" \
      --bind 0.0.0.0 \
      --public-url "https://${RAILWAY_PUBLIC_DOMAIN}"
    ;;
  worker)
    # Needs the brain repo: this service drains the same 'default' queue the
    # autopilot dispatches sync jobs onto.
    setup_brain_repo
    exec gbrain jobs supervisor --concurrency "${GBRAIN_WORKER_CONCURRENCY:-2}"
    ;;
  autopilot)
    setup_brain_repo
    exec gbrain autopilot --repo "$BRAIN_DIR"
    ;;
  dream)
    # Nightly synthesis. Self-scheduling rather than a platform cron: Railway
    # exposes no cron subcommand in the CLI, and the `--service-config` path
    # that would set one silently reports "No changes to apply" without
    # committing. A sleep-until-target loop needs no platform feature at all.
    #
    # Idempotent across restarts: dream.auto_think.cooldown_days gates the work
    # itself, so a redeploy at 03:05 cannot produce a second run for that day.
    HOUR="${GBRAIN_DREAM_HOUR_UTC:-3}"
    while :; do
      # Epoch modulo 86400 == seconds since UTC midnight. Deliberately avoids
      # parsing %H/%M/%S: those are zero-padded, and the `10#` base prefix that
      # would make them safe is a bashism this image's /bin/sh (dash) rejects.
      secs_today=$(( $(date -u +%s) % 86400 ))
      delta=$(( HOUR * 3600 - secs_today ))
      [ "$delta" -le 0 ] && delta=$(( delta + 86400 ))
      # Floor the sleep. If delta were ever empty or non-positive, a bare
      # `sleep` would return instantly and spin the loop hot.
      [ "$delta" -ge 1 ] 2>/dev/null || delta=3600
      echo "[dream] sleeping ${delta}s until ${HOUR}:00 UTC" >&2
      sleep "$delta"
      # Never exit the loop on failure: one bad night must not silently end
      # every future night. The cooldown still advances only on success.
      bun /app/deploy/railway/run-auto-think.ts || echo "[dream] run failed; will retry tomorrow" >&2
    done
    ;;
  *)
    echo "entrypoint: unknown GBRAIN_ROLE='${GBRAIN_ROLE}' (expected 'web', 'worker', 'autopilot' or 'dream')" >&2
    exit 1
    ;;
esac
