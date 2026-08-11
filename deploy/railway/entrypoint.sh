#!/bin/sh
# Dispatch on GBRAIN_ROLE so one image serves both Railway services.
#
# Railway's per-service `deploy.startCommand` is set through the dashboard's
# config-as-code path; `railway environment edit --service-config` reports
# "No changes to apply" and never commits, so the start command cannot be
# driven from the CLI. Service *variables* set reliably, so the role is a
# variable and the dispatch lives here in the image.
set -e

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
    exec gbrain jobs supervisor --concurrency "${GBRAIN_WORKER_CONCURRENCY:-2}"
    ;;
  autopilot)
    # The autopilot's main job is `sync`, which reads AND writes the brain repo
    # (gbrain commits and pushes back — see brain-repo-durability.ts), so the
    # deploy key must be read-write and git needs a committer identity.
    BRAIN_DIR="${GBRAIN_BRAIN_DIR:-/app/brain}"
    BRANCH="${GBRAIN_BRAIN_BRANCH:-main}"

    if [ -n "${GBRAIN_BRAIN_DEPLOY_KEY_B64:-}" ]; then
      mkdir -p /root/.ssh && chmod 700 /root/.ssh
      # base64 because an OpenSSH private key is multi-line and env-var
      # round-tripping through a platform UI mangles embedded newlines.
      printf '%s' "$GBRAIN_BRAIN_DEPLOY_KEY_B64" | base64 -d > /root/.ssh/id_ed25519
      chmod 600 /root/.ssh/id_ed25519
      # Pin the host key instead of StrictHostKeyChecking=no, which would accept
      # any MITM offering itself as github.com.
      ssh-keyscan -t ed25519 github.com > /root/.ssh/known_hosts 2>/dev/null
      chmod 644 /root/.ssh/known_hosts
    fi

    git config --global user.name "${GBRAIN_GIT_USER_NAME:-gbrain autopilot}"
    git config --global user.email "${GBRAIN_GIT_USER_EMAIL:-autopilot@gbrain.local}"
    git config --global --add safe.directory "$BRAIN_DIR"

    if [ -n "${GBRAIN_BRAIN_REPO:-}" ]; then
      if [ -d "$BRAIN_DIR/.git" ]; then
        # Reset rather than pull: the container holds no work worth preserving,
        # and a merge conflict here would wedge the loop with no operator present.
        git -C "$BRAIN_DIR" fetch origin "$BRANCH" && \
          git -C "$BRAIN_DIR" reset --hard "origin/$BRANCH"
      else
        # Full clone, not --depth 1: gbrain pushes back, and a shallow clone
        # makes that fragile.
        git clone --branch "$BRANCH" "$GBRAIN_BRAIN_REPO" "$BRAIN_DIR"
      fi
    fi

    if [ ! -d "$BRAIN_DIR/.git" ]; then
      echo "entrypoint: $BRAIN_DIR is not a git repo and GBRAIN_BRAIN_REPO is unset — sync would fail every cycle" >&2
      exit 1
    fi

    exec gbrain autopilot --repo "$BRAIN_DIR"
    ;;
  *)
    echo "entrypoint: unknown GBRAIN_ROLE='${GBRAIN_ROLE}' (expected 'web' or 'worker')" >&2
    exit 1
    ;;
esac
