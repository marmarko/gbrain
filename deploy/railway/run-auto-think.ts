#!/usr/bin/env bun
/**
 * Nightly synthesis runner — invokes the `auto_think` dream phase once, then exits.
 *
 * WHY THIS FILE EXISTS: `runPhaseAutoThink` (src/core/cycle/auto-think.ts) is
 * fully implemented and config-driven, but nothing in the tree calls it — it is
 * absent from `ALL_PHASES`, `gbrain dream --phase auto_think` rejects it as
 * unknown, and grep finds zero call sites. So setting `dream.auto_think.*`
 * alone can never produce a synthesis; the gap is a missing call site, not a
 * missing schedule. This is the call site.
 *
 * It deliberately does NOT register `auto_think` as a cycle phase. That would
 * mean edits in several places across a ~2700-line core file and would couple
 * nightly synthesis to the autopilot's 150s cadence, where the only thing
 * keeping it from running every cycle is a cooldown check. A separate scheduled
 * process is both smaller and easier to reason about.
 *
 * Connect sequence mirrors `connectEngine` in src/cli.ts. The gateway MUST be
 * configured before the engine is used, or model calls resolve no provider and
 * the synthesis comes back empty — which `auto-think.ts` correctly refuses to
 * persist, leaving a silent no-op that looks like "nothing to synthesize".
 *
 * Exit codes: 0 ran (or correctly skipped), 1 failed.
 */
import { loadConfig, toEngineConfig } from '../../src/core/config.ts';
import { buildGatewayConfig } from '../../src/core/ai/build-gateway-config.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { createEngine } from '../../src/core/engine-factory.ts';
import { connectWithRetry } from '../../src/core/db.ts';
import { runPhaseAutoThink } from '../../src/core/cycle/auto-think.ts';

const dryRun = process.argv.includes('--dry-run');

/**
 * Wall-clock ceiling for the whole run. Without it a single wedged synthesis
 * blocks the scheduler loop until the container is redeployed — the loop only
 * sleeps again once this process exits, so "hung" and "never runs again" are
 * the same failure. A bounded bad night is strictly better.
 *
 * On expiry the in-flight work is abandoned rather than cancelled:
 * runPhaseAutoThink takes no AbortSignal, and the LLM call would keep the event
 * loop alive, so the process exits explicitly. That is safe — pages already
 * persisted stay persisted, and the cooldown advances only on a successful
 * completion, so an aborted night simply retries tomorrow.
 */
const TIMEOUT_MS = Math.max(60_000, Number(process.env.GBRAIN_DREAM_TIMEOUT_MS ?? 30 * 60 * 1000));

const config = loadConfig();
if (!config) {
  console.error('[auto-think] no brain configured (GBRAIN_DATABASE_URL unset?)');
  process.exit(1);
}

configureGateway(buildGatewayConfig(config));

const engine = await createEngine(toEngineConfig(config));
await connectWithRetry(engine, toEngineConfig(config), { noRetry: false });

const started = Date.now();
let timer: ReturnType<typeof setTimeout> | undefined;

try {
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`wall-clock timeout after ${Math.round(TIMEOUT_MS / 1000)}s`)),
      TIMEOUT_MS,
    );
  });

  const result = await Promise.race([runPhaseAutoThink(engine, { dryRun }), timeout]);
  const secs = Math.round((Date.now() - started) / 1000);
  // Single-line JSON: this runs unattended, and the log is the only record.
  console.log(`[auto-think] ${dryRun ? '(dry-run) ' : ''}${secs}s ${JSON.stringify(result)}`);
  clearTimeout(timer);
  await engine.close?.();
} catch (err) {
  const secs = Math.round((Date.now() - started) / 1000);
  console.error(`[auto-think] failed after ${secs}s: ${err instanceof Error ? err.message : String(err)}`);
  clearTimeout(timer);
  // Best-effort close, then leave regardless: on the timeout path an LLM call is
  // still in flight and would otherwise hold the process open past its ceiling,
  // defeating the guard.
  await Promise.race([
    engine.close?.() ?? Promise.resolve(),
    new Promise(r => setTimeout(r, 5_000)),
  ]).catch(() => {});
  process.exit(1);
}
