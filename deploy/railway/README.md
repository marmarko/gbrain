# Deploying GBrain to Railway

Runs the MCP/HTTP surface and the minion worker as two always-on Railway
services against an existing managed Postgres brain. Railway hosts compute
only — the database stays where it is.

Compute on Railway, database wherever your brain already lives:

| Piece | Where | Why |
|---|---|---|
| `web` — MCP, OAuth, `/admin`, SSE, `POST /ingest` | Railway service | Long-lived process; in-memory admin sessions and rate limiters work correctly |
| `worker` — `gbrain jobs supervisor` | Railway service | Drains `minion_jobs`; nothing else runs it |
| Postgres + pgvector | Existing managed provider | No migration; the brain is already there |

Serverless hosts are a poor fit for the full surface even though the MCP
transport is stateless (`serve-http.ts:2171` sets `sessionIdGenerator:
undefined`). The admin session map, the four `express-rate-limit` memory
stores, and the `/admin/events` SSE feed all assume one process. Railway's
always-on containers satisfy that assumption; per-instance ephemerality does
not.

## Prerequisites

- A Postgres-backed brain. PGLite is local-only — `gbrain serve --http`
  refuses to start against it, and the worker's separate process cannot
  share PGLite's exclusive file lock.
- `vector`, `pg_trgm`, and `pgcrypto` installed. Any brain already serving
  queries has these.
- Railway CLI installed and authenticated (`railway whoami`).

## Create the services

```bash
railway init --name gbrain
railway add --service web --json
railway add --service worker --json
```

Both services build the same `deploy/railway/Dockerfile` and differ only by
the `GBRAIN_ROLE` variable, which `entrypoint.sh` dispatches on.

Select the Dockerfile and the role with service variables:

```bash
railway variable set RAILWAY_DOCKERFILE_PATH=deploy/railway/Dockerfile --service web
railway variable set GBRAIN_ROLE=web    --service web
railway variable set RAILWAY_DOCKERFILE_PATH=deploy/railway/Dockerfile --service worker
railway variable set GBRAIN_ROLE=worker --service worker
```

**Why the role is a variable rather than a per-service start command.**
`railway environment edit --service-config <svc> deploy.startCommand ...`
reports `{"committed":false,"message":"No changes to apply"}` and never
commits — including for keys the service has never had, so the message is not
a signal that the value was already correct. Without a start command Railway
falls back to Railpack auto-detection and ignores the Dockerfile entirely.
Service *variables* set reliably, so the role travels as data and the dispatch
lives in the image.

The two `*.json` files describe the same build for anyone wiring **Settings →
Config as code** in the dashboard, which is the path that does honor
`healthcheckPath` and the restart policy. They deliberately omit
`startCommand` so they cannot contradict the entrypoint.

Expect the first build of each service to be slow — the dependency tree is
large (AI SDKs, AWS SDK, PGLite, tree-sitter WASM grammars) and a cold
`bun install` of it runs into the tens of minutes. The Dockerfile installs
deps in a separate stage keyed on `package.json` + `bun.lock`, so subsequent
deploys reuse that layer and only pay for it again when dependencies change.
Do not mistake a slow first build for a hung one.

## Environment variables

Set on **both** services:

| Variable | Value | Why |
|---|---|---|
| `GBRAIN_DATABASE_URL` | your brain's connection string | Preferred over `DATABASE_URL`, which `config.ts:561` ignores when it matches a cwd `.env`. Always honored. |
| `GBRAIN_EMBEDDING_MODEL` | e.g. `litellm:openai/text-embedding-3-large` | Must match what the brain was embedded with |
| `GBRAIN_EMBEDDING_DIMENSIONS` | the brain's vector width | A mismatch against the `vector(N)` column fails at startup (`serve-http.ts:601`) |
| provider API key | e.g. `OPENAI_API_KEY`, or `LITELLM_BASE_URL` + `LITELLM_API_KEY` | Whatever your embedding gateway authenticates with |
| `RAILWAY_DOCKERFILE_PATH` | `deploy/railway/Dockerfile` | Without it Railway ignores the Dockerfile and auto-detects with Railpack |
| `GBRAIN_ROLE` | `web` or `worker` | Selects the process in `entrypoint.sh` |

`engine` needs no variable — `config.ts:605` infers `postgres` from the URL.
Per-provider base URLs can live in the database (`config.ts:758` reads the
`provider_base_urls.` prefix), so both services pick them up from the shared
brain with nothing set locally.

Set on **`web`** only:

| Variable | Value | Why |
|---|---|---|
| `GBRAIN_HTTP_TRUST_PROXY` | `1` | Railway proxies every request. Without this, X-Forwarded-For never resolves and all four rate limiters key on the proxy IP — one bucket for the whole internet. |
| `GBRAIN_HTTP_CORS_ORIGIN` | comma-separated origins | **Required.** With `--bind 0.0.0.0` and this unset, OAuth endpoints reject *all* cross-origin requests (`serve-http.ts:808`). |
| `GBRAIN_ADMIN_BOOTSTRAP_TOKEN` | a value you generate | Railway is non-TTY, so the generated token is suppressed to keep it out of log storage. Set your own or you cannot reach `/admin`. |

### Put the shared secrets in shared variables

Values identical across both services — the gateway key, the database URL, the
gateway base URL — belong in environment-level **shared variables**, not copied
per service. Rotation then touches one place instead of four, which is the
difference between a clean key swap and a half-updated deploy that fails only
on the service you forgot.

Shared variables are **not** auto-injected; each service opts in by reference:

```bash
# once, at environment level
railway environment edit --json <<'JSON'
{"sharedVariables":{"AI_GATEWAY_API_KEY":{"value":"vck_…"}}}
JSON

# then on each service
railway variable set 'AI_GATEWAY_API_KEY=${{shared.AI_GATEWAY_API_KEY}}' --service web
railway variable set 'LITELLM_API_KEY=${{shared.AI_GATEWAY_API_KEY}}'    --service web
```

Pointing `LITELLM_API_KEY` at `shared.AI_GATEWAY_API_KEY` is deliberate: the
credential is a Vercel AI Gateway key and deserves that name, but gbrain has no
Vercel provider — it reaches the gateway through the generic OpenAI-compatible
`litellm-proxy` recipe, which reads `LITELLM_API_KEY`. One value, honest name,
and gbrain still finds it. Do not also create a shared `LITELLM_API_KEY`;
nothing would reference it and Railway flags it as unused.

Unlike `--service-config`, `railway environment edit --json` for shared
variables genuinely commits (`"committed":true`) — but read it back anyway.

Leave `GBRAIN_ALLOW_SHELL_JOBS` **unset** unless you are actually submitting
shell jobs. It lets queued jobs execute arbitrary commands in the container;
on a network-reachable deployment that turns queue-write access into remote
code execution.

## Verify

```bash
railway logs --service web --lines 50
curl -fsS https://<your-domain>/health
railway logs --service worker --lines 50   # expect supervisor start, no lock-renewal-failed
```

Never call a deploy done on `railway up` returning — poll until the newest
deployment reports `SUCCESS`:

```bash
railway deployment list --json
```

## Pooler mode

Transaction-mode poolers strip the session-level GUCs applied to every new
backend (`db.ts:119`) — the ones that stop an orphaned backend holding a
`RowExclusiveLock` indefinitely. gbrain auto-detects the PgBouncer convention
on port 6543 and disables prepared statements (`db.ts:250`), but a
transaction-mode pooler served on **5432** defeats that heuristic: prepared
statements stay on and the GUCs are dropped silently.

One laptop tolerates this. Two always-on services holding pools do not. Use a
session-mode endpoint where your provider offers one, or set
`GBRAIN_PREPARE=false` explicitly. Cap the pool per service with
`GBRAIN_POOL_SIZE` — two services plus any local CLI all draw from the same
provider connection ceiling.

## Files and the volume constraint

Railway volumes attach to exactly one service, so `web` and `worker` cannot
share a disk. Do not plan on a shared brain-repo checkout.

Use storage tiering instead — `docs/storage-tiering.md` covers this under
"Container-based deployments." Mark bulk directories `db_only` so Postgres is
the system of record and local disk is only a cache; `gbrain export
--restore-only` rehydrates on demand.

### Persisting audit logs

Container filesystems are wiped on every deploy, so the worker's audit trail
does not survive a redeploy without a volume:

```bash
railway link --project <p> --environment production --service worker
railway volume add --mount-path /data
railway variable set GBRAIN_AUDIT_DIR=/data/audit --service worker
```

Set `GBRAIN_AUDIT_DIR` explicitly rather than relying on the Dockerfile's
`GBRAIN_HOME=/data` to derive it. Both land on the volume — `resolveAuditDir()`
checks the env var first and otherwise falls back to `gbrainPath('audit')` —
but the explicit form is one observable fact instead of a three-link inference
through `configDir()`, and it keeps working if `GBRAIN_HOME` is ever overridden.

The supervisor PID file is **not** covered: `supervisor.ts` resolves it from
`$HOME`, not `GBRAIN_HOME`, so it stays at `/root/.gbrain/`. That is correct —
a PID file from a dead container has no meaning in the next one.

## What does not move

The file-watcher and inbox-folder ingestion sources watch local directories
and are meaningless in a container nothing writes to. They live in the
ingestion daemon, not in `serve --http` (`serve-http.ts:2191`) — add a third
service if you want the cron-scheduler source. Webhook ingestion via
`POST /ingest` is hosted by `web` and works as-is.
