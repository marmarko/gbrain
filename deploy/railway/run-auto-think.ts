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

const config = loadConfig();
if (!config) {
  console.error('[auto-think] no brain configured (GBRAIN_DATABASE_URL unset?)');
  process.exit(1);
}

configureGateway(buildGatewayConfig(config));

const engine = await createEngine(toEngineConfig(config));
await connectWithRetry(engine, toEngineConfig(config), { noRetry: false });

try {
  const started = Date.now();
  const result = await runPhaseAutoThink(engine, { dryRun });
  const secs = Math.round((Date.now() - started) / 1000);
  // Single-line JSON: this runs unattended, and the log is the only record.
  console.log(`[auto-think] ${dryRun ? '(dry-run) ' : ''}${secs}s ${JSON.stringify(result)}`);
} catch (err) {
  console.error(`[auto-think] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await engine.close?.();
}
