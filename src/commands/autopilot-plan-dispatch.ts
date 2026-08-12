/**
 * Targeted remediation-step dispatch, shared by both autopilot dispatch branches.
 *
 * THE BUG THIS EXISTS TO FIX: the per-step `queue.add(step.job, …)` loop used to
 * live ONLY in the `else` (small-plan) branch of `shouldFullCycle`. But
 * `shouldFullCycle` is true whenever `score < 70` OR `estTotal >= 300` OR
 * `plan.length > 3` — which on any brain that actually needs remediation is
 * every tick. The full-cycle branch dispatched `autopilot-cycle` +
 * `autopilot-global-maintenance` and discarded `plan` entirely, so a step whose
 * job is NOT one of the cycle's phases could never run. It was re-planned and
 * re-discarded every ~150s, forever, and the check that requested it stayed red
 * — which read as "the job is broken" when the job had simply never been
 * enqueued. Observed on a real brain: zero `extract-ner` rows in `minion_jobs`
 * ever, and zero rows carrying the targeted branch's `<source>:<job>:<hash>`
 * idempotency-key shape, across the table's entire history.
 *
 * The full cycle genuinely does perform some of these jobs, so dispatching the
 * whole plan alongside it would double-submit real work. The split is decided by
 * FULL_CYCLE_COVERED_JOBS below.
 */

import { MANUAL_ONLY_PROTECTED_JOBS } from '../core/minions/protected-names.ts';

/** A plan step, narrowed to what dispatch actually reads. */
export interface DispatchableStep {
  id: string;
  job: string;
  params: Record<string, unknown>;
  idempotency_key: string;
  protected?: boolean;
  /** Planner's runtime estimate; sizes the submit timeout. See TIMEOUT_SAFETY_FACTOR. */
  est_seconds?: number;
}

/**
 * Headroom over the planner's own estimate when stamping `timeout_ms`.
 *
 * A `timeout_ms` breach is TERMINAL, not a retry: the queue marks the job `dead`
 * and then NULLs its idempotency key, so the next tick submits the identical
 * step again — a permanent kill/resubmit treadmill that burns the work every
 * time it nearly finishes. The interval-derived dispatch timeout (600s at the
 * default 300s interval) is far below what these steps declare — `embed-catch-up`
 * estimates up to 3600s — so stamping it blindly would guarantee that treadmill.
 */
export const TIMEOUT_SAFETY_FACTOR = 1.5;

/**
 * Job names the full cycle already performs, so submitting them targeted during
 * a full cycle would duplicate work the cycle is about to do anyway.
 *
 * These are exactly the jobs emitted by the hardcoded recommendations in
 * `src/core/brain-score-recommendations.ts`, and each maps to a phase in
 * `ALL_PHASES` (`src/core/cycle.ts`). Kept as an explicit literal set rather
 * than derived from `ALL_PHASES` because phase names and job names are NOT 1:1
 * (`extract_facts` and `schema-suggest` are phases with no same-named job), so a
 * derived set would silently mis-classify. `test/autopilot-plan-dispatch.test.ts`
 * pins this against the recommendation source so upstream drift fails loudly
 * instead of quietly resurrecting the double-submit.
 */
export const FULL_CYCLE_COVERED_JOBS: ReadonlySet<string> = new Set([
  'sync',
  'embed',
  'extract',
  'backlinks',
  // Covered by WORK, not by name. `embed-catch-up` calls runEmbedCore({stale:true,
  // catchUp:true}) (src/commands/jobs.ts:2207); the cycle's `embed` phase calls
  // runEmbedCore({stale:true}) (src/core/cycle.ts:1348) inside
  // autopilot-global-maintenance, dispatched in the SAME tick. Neither passes
  // `singleFlight`, and embed.ts:346 takes the per-source backfill lock only when
  // that flag is set — its comment says so outright: "cycle / catch-up /
  // sync-auto-embed callers never single-flight". So both would keyset-walk
  // `embedding IS NULL` concurrently with no row claiming: the same chunks
  // embedded twice and billed twice. Classifying it as covered lets the cycle's
  // embed phase do the work once.
  'embed-catch-up',
]);

/**
 * Steps that must still be dispatched individually during a FULL cycle, because
 * the cycle has no phase that performs them.
 *
 * In practice this leaves `extract-ner` and `extract-timeline-from-meetings`.
 * The other onboard remediations are excluded elsewhere: `embed-catch-up` is
 * covered above (same work as the `embed` phase), and `extract-takes-from-pages`
 * / `unify-types` are dropped at submit time by MANUAL_ONLY_PROTECTED_JOBS —
 * deliberately NOT via this set, which would falsely claim the cycle performs
 * them.
 */
export function stepsNotCoveredByFullCycle<T extends DispatchableStep>(plan: readonly T[]): T[] {
  return plan.filter(step => !FULL_CYCLE_COVERED_JOBS.has(step.job));
}

/** Minimal queue surface this module needs; keeps the helper unit-testable. */
export interface StepQueue {
  add(
    name: string,
    params: Record<string, unknown>,
    opts: Record<string, unknown>,
    extra?: { allowProtectedSubmit: true },
  ): Promise<{ id: number | string }>;
}

export interface DispatchStepsOptions {
  /** Interval-derived, NOT the 30-min full-cycle anchor — targeted steps are
   *  deliberately short-lived (see the #2781 note in autopilot.ts). */
  timeoutMs: number;
  jsonMode: boolean;
  score: number;
  planSize: number;
  /** Distinguishes the two call sites in logs/telemetry. */
  mode: 'targeted' | 'full_cycle_uncovered';
  onError: (label: string, err: unknown) => void;
  log?: (line: string) => void;
  emitJson?: (line: string) => void;
}

/**
 * Submit each step, one failure never blocking the rest.
 *
 * `maxWaiting: 1` preserves the backpressure guarantee from the original loop
 * (codex #17), and the per-step content-hash `idempotency_key` means a step
 * re-planned on the next tick collapses onto the in-flight job rather than
 * queueing a duplicate.
 */
export async function dispatchTargetedSteps(
  queue: StepQueue,
  steps: readonly DispatchableStep[],
  opts: DispatchStepsOptions,
): Promise<{ dispatched: string[]; failed: string[]; skipped: string[] }> {
  const dispatched: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];

  for (const step of steps) {
    // Consent gate, distinct from the trust gate. `allowProtectedSubmit` asks
    // "is this caller trusted?"; autopilot is, and would set it. These jobs need
    // "should this run unattended?", which is always no.
    if (MANUAL_ONLY_PROTECTED_JOBS.has(step.job)) {
      skipped.push(step.id);
      if (opts.jsonMode) {
        opts.emitJson?.(JSON.stringify({
          event: 'skipped_manual_only',
          job: step.job,
          step: step.id,
          score: opts.score,
        }) + '\n');
      } else {
        opts.log?.(`[dispatch] skipped ${step.job} (${step.id}): manual-only, needs explicit operator consent`);
      }
      continue;
    }

    try {
      const job = await queue.add(
        step.job,
        step.params,
        {
          queue: 'default',
          idempotency_key: step.idempotency_key,
          max_attempts: 2,
          // Never below the planner's own estimate — a breach is terminal.
          timeout_ms: Math.max(
            opts.timeoutMs,
            Math.ceil((step.est_seconds ?? 0) * 1000 * TIMEOUT_SAFETY_FACTOR),
          ),
          maxWaiting: 1,
        },
        step.protected ? { allowProtectedSubmit: true } : undefined,
      );
      dispatched.push(step.id);
      if (opts.jsonMode) {
        opts.emitJson?.(JSON.stringify({
          event: 'dispatched',
          job_id: job.id,
          mode: opts.mode,
          step: step.id,
          score: opts.score,
          plan_size: opts.planSize,
        }) + '\n');
      } else {
        opts.log?.(`[dispatch] job #${job.id} ${step.job} (${opts.mode}: ${step.id}; score=${opts.score})`);
      }
    } catch (e) {
      failed.push(step.id);
      opts.onError('dispatch.step', e);
    }
  }

  return { dispatched, failed, skipped };
}
