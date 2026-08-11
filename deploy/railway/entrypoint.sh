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
  *)
    echo "entrypoint: unknown GBRAIN_ROLE='${GBRAIN_ROLE}' (expected 'web' or 'worker')" >&2
    exit 1
    ;;
esac
