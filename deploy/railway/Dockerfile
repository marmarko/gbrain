FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Run from source under Bun rather than `bun build --compile`. The compiled
# binary embeds JS but gbrain also loads WASM assets at runtime (tree-sitter
# grammars, @jsquash codecs); running from source keeps them resolvable from
# node_modules with no bundler asset config to keep in sync.
RUN printf '#!/bin/sh\nexec bun /app/src/cli.ts "$@"\n' > /usr/local/bin/gbrain \
 && chmod +x /usr/local/bin/gbrain

# configDir() appends '.gbrain' to GBRAIN_HOME, so this resolves to
# /data/.gbrain — supervisor.pid and audit logs land there. Mount a Railway
# volume at /data on the worker to persist them across deploys.
ENV GBRAIN_HOME=/data
RUN mkdir -p /data

# One image, both services. GBRAIN_ROLE (a Railway service variable) selects
# which process runs — see entrypoint.sh for why the role lives in a variable
# rather than in Railway's per-service startCommand.
COPY deploy/railway/entrypoint.sh /usr/local/bin/gbrain-entrypoint
RUN chmod +x /usr/local/bin/gbrain-entrypoint

CMD ["/usr/local/bin/gbrain-entrypoint"]
