/**
 * Regression coverage for the autopilot dispatch bug: remediation steps whose
 * job is NOT a cycle phase were discarded whenever `shouldFullCycle` was true
 * — i.e. on every tick of any brain scoring under 70, which is precisely the
 * population that needs remediation. Observed consequence on a real brain: zero
 * `extract-ner` rows in `minion_jobs` across the table's entire history, while
 * the onboard check re-requested it every ~150s.
 *
 * The selector is pure, so the branching logic gets real unit tests rather than
 * the source-grep wiring guard this file's neighbours have to settle for. A
 * static wiring assertion still pins the autopilot.ts call site, since the loop
 * around it needs a Postgres fixture to exercise end to end.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  FULL_CYCLE_COVERED_JOBS,
  stepsNotCoveredByFullCycle,
  dispatchTargetedSteps,
  TIMEOUT_SAFETY_FACTOR,
  type DispatchableStep,
  type StepQueue,
} from '../src/commands/autopilot-plan-dispatch.ts';
import { MANUAL_ONLY_PROTECTED_JOBS } from '../src/core/minions/protected-names.ts';

const step = (id: string, job: string, extra: Partial<DispatchableStep> = {}): DispatchableStep => ({
  id,
  job,
  params: {},
  idempotency_key: `default:${job}:deadbeef`,
  ...extra,
});

const RECOMMENDATIONS_SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'core', 'brain-score-recommendations.ts'),
  'utf8',
);
const ONBOARD_CHECKS_SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'core', 'onboard', 'checks.ts'),
  'utf8',
);
const AUTOPILOT_SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts'),
  'utf8',
);

const jobNamesIn = (src: string): string[] =>
  [...new Set([...src.matchAll(/job:\s*'([a-z0-9_-]+)'/g)].map(m => m[1]))].sort();

describe('stepsNotCoveredByFullCycle', () => {
  test('drops jobs the full cycle already performs', () => {
    const plan = [step('a', 'sync'), step('b', 'embed'), step('c', 'extract'), step('d', 'backlinks')];
    expect(stepsNotCoveredByFullCycle(plan)).toEqual([]);
  });

  test('keeps onboard remediations that no phase performs', () => {
    const plan = [
      step('a', 'extract-ner'),
      step('b', 'extract-timeline-from-meetings'),
    ];
    expect(stepsNotCoveredByFullCycle(plan).map(s => s.job)).toEqual([
      'extract-ner',
      'extract-timeline-from-meetings',
    ]);
  });

  test('embed-catch-up is covered — same work as the embed phase, different name', () => {
    // Both call runEmbedCore({stale:true}) and neither single-flights, so
    // dispatching it alongside the cycle double-embeds and double-bills.
    expect(stepsNotCoveredByFullCycle([step('a', 'embed-catch-up')])).toEqual([]);
  });

  test('splits a mixed plan — the exact shape that produced the bug', () => {
    // `sync` is covered (the cycle syncs); `extract-ner` is not. Pre-fix the
    // whole plan was dropped, so extract-ner never ran.
    const plan = [step('sync-step', 'sync'), step('ner-step', 'extract-ner')];
    expect(stepsNotCoveredByFullCycle(plan).map(s => s.id)).toEqual(['ner-step']);
  });

  test('empty plan is not an error', () => {
    expect(stepsNotCoveredByFullCycle([])).toEqual([]);
  });

  test('preserves order and object identity (idempotency keys must survive)', () => {
    const a = step('a', 'extract-ner');
    const b = step('b', 'unify-types');
    const out = stepsNotCoveredByFullCycle([a, step('x', 'sync'), b]);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });
});

describe('FULL_CYCLE_COVERED_JOBS stays honest as upstream drifts', () => {
  test('covers every job the hardcoded recommendations emit', () => {
    // If a new hardcoded recommendation appears whose job the cycle performs,
    // it must be added here or the full-cycle branch will double-submit it.
    const jobs = jobNamesIn(RECOMMENDATIONS_SRC);
    // Without this the loop body could never execute and the test would pass
    // with zero assertions if the source formatting ever changed.
    expect(jobs.sort()).toEqual(['backlinks', 'embed', 'extract', 'sync']);
    for (const job of jobs) {
      expect(FULL_CYCLE_COVERED_JOBS.has(job)).toBe(true);
    }
  });

  test('every onboard remediation is covered, manual-only, or dispatched — none silently lost', () => {
    // The real invariant. A job may legitimately be cycle-covered (embed-catch-up)
    // or consent-gated (unify-types), but it must never fall through all three
    // categories unnoticed, which is how the original bug hid.
    const onboardJobs = jobNamesIn(ONBOARD_CHECKS_SRC);
    expect(onboardJobs.length).toBeGreaterThan(0);
    const dispatched = onboardJobs.filter(
      j => !FULL_CYCLE_COVERED_JOBS.has(j) && !MANUAL_ONLY_PROTECTED_JOBS.has(j),
    );
    // Pinned exactly: adding a remediation forces a deliberate classification.
    expect(dispatched.sort()).toEqual(['extract-ner', 'extract-timeline-from-meetings']);
  });
});

describe('dispatchTargetedSteps', () => {
  const baseOpts = {
    timeoutMs: 1234,
    jsonMode: false,
    score: 66,
    planSize: 2,
    mode: 'full_cycle_uncovered' as const,
    onError: () => {},
  };

  test('submits every step with backpressure and its idempotency key', async () => {
    const calls: Array<{ name: string; opts: Record<string, unknown> }> = [];
    const queue: StepQueue = {
      async add(name, _params, opts) { calls.push({ name, opts }); return { id: calls.length }; },
    };
    const res = await dispatchTargetedSteps(
      queue,
      [step('a', 'extract-ner'), step('b', 'extract-timeline-from-meetings')],
      baseOpts,
    );
    expect(res.dispatched).toEqual(['a', 'b']);
    expect(calls.map(c => c.name)).toEqual(['extract-ner', 'extract-timeline-from-meetings']);
    expect(calls[0].opts.maxWaiting).toBe(1);
    expect(calls[0].opts.idempotency_key).toBe('default:extract-ner:deadbeef');
    expect(calls[0].opts.timeout_ms).toBe(1234);
  });

  test('one failing step never blocks the rest', async () => {
    const queue: StepQueue = {
      async add(name) {
        if (name === 'extract-ner') throw new Error('boom');
        return { id: 7 };
      },
    };
    const errors: string[] = [];
    const res = await dispatchTargetedSteps(
      queue,
      [step('a', 'extract-ner'), step('b', 'extract-timeline-from-meetings')],
      { ...baseOpts, onError: (label) => errors.push(label) },
    );
    expect(res.failed).toEqual(['a']);
    expect(res.dispatched).toEqual(['b']);
    expect(errors).toEqual(['dispatch.step']);
  });

  test('protected steps pass allowProtectedSubmit; ordinary ones do not', async () => {
    const extras: unknown[] = [];
    const queue: StepQueue = {
      async add(_n, _p, _o, extra) { extras.push(extra); return { id: 1 }; },
    };
    await dispatchTargetedSteps(
      queue,
      [step('a', 'extract-ner'), step('b', 'extract-timeline-from-meetings', { protected: true })],
      baseOpts,
    );
    expect(extras[0]).toBeUndefined();
    expect(extras[1]).toEqual({ allowProtectedSubmit: true });
  });

  test('NEVER auto-submits manual-only jobs, even though they are protected', async () => {
    // The blocker this review caught: unify-types carries params {apply:true} and
    // flips the active schema pack, retyping every page. autopilot is a trusted
    // caller and would happily set allowProtectedSubmit, so trust is the wrong
    // gate — consent is. render.ts:36 states the invariant outright.
    const names: string[] = [];
    const queue: StepQueue = { async add(name) { names.push(name); return { id: 1 }; } };
    const res = await dispatchTargetedSteps(
      queue,
      [
        step('u', 'unify-types', { protected: true }),
        step('t', 'extract-takes-from-pages', { protected: true }),
        step('n', 'extract-ner'),
      ],
      baseOpts,
    );
    expect(names).toEqual(['extract-ner']);          // zero submits for the other two
    expect(res.skipped.sort()).toEqual(['t', 'u']);
    expect(res.dispatched).toEqual(['n']);
  });

  test('every manual-only job is refused, whatever the set grows to', async () => {
    const names: string[] = [];
    const queue: StepQueue = { async add(name) { names.push(name); return { id: 1 }; } };
    const plan = [...MANUAL_ONLY_PROTECTED_JOBS].map((j, i) => step(`s${i}`, j, { protected: true }));
    const res = await dispatchTargetedSteps(queue, plan, baseOpts);
    expect(names).toEqual([]);
    expect(res.skipped.length).toBe(plan.length);
  });

  test('timeout is never below the planner estimate — a breach is terminal, not a retry', async () => {
    // embed-catch-up estimates 3600s; the interval-derived floor is 600s. Stamping
    // the floor would kill the job every run, and the queue NULLs a dead row's
    // idempotency key, so the next tick resubmits it forever.
    const opts: Record<string, unknown>[] = [];
    const queue: StepQueue = { async add(_n, _p, o) { opts.push(o); return { id: 1 }; } };
    await dispatchTargetedSteps(
      queue,
      [step('long', 'extract-ner', { est_seconds: 3600 }), step('short', 'extract-ner', { est_seconds: 10 })],
      { ...baseOpts, timeoutMs: 600_000 },
    );
    expect(opts[0].timeout_ms).toBe(Math.ceil(3600 * 1000 * TIMEOUT_SAFETY_FACTOR));
    expect(opts[0].timeout_ms as number).toBeGreaterThan(600_000);
    // A short estimate must not LOWER the interval-derived floor.
    expect(opts[1].timeout_ms).toBe(600_000);
  });

  test('a step with no est_seconds keeps the interval-derived timeout', async () => {
    const opts: Record<string, unknown>[] = [];
    const queue: StepQueue = { async add(_n, _p, o) { opts.push(o); return { id: 1 }; } };
    await dispatchTargetedSteps(queue, [step('a', 'extract-ner')], { ...baseOpts, timeoutMs: 42_000 });
    expect(opts[0].timeout_ms).toBe(42_000);
  });
});

describe('autopilot.ts wiring', () => {
  test('the full-cycle branch dispatches uncovered steps', () => {
    expect(AUTOPILOT_SRC).toMatch(/stepsNotCoveredByFullCycle\(plan\)/);
    expect(AUTOPILOT_SRC).toMatch(/mode:\s*'full_cycle_uncovered'/);
  });

  test('both branches route through the shared helper', () => {
    const uses = [...AUTOPILOT_SRC.matchAll(/dispatchTargetedSteps\(/g)].length;
    expect(uses).toBeGreaterThanOrEqual(2);
  });

  test('the uncovered-step dispatch runs BEFORE the fan-out that can throw', () => {
    // dispatchPerSource / resolveEffectiveFanoutMax / the dynamic import all throw
    // to the branch catch; if this block sat after them a struggling brain would
    // silently skip these steps — the very bug being fixed.
    const dispatchIdx = AUTOPILOT_SRC.indexOf('stepsNotCoveredByFullCycle(plan)');
    const fanoutIdx = AUTOPILOT_SRC.indexOf('await dispatchPerSource(');
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(fanoutIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeLessThan(fanoutIdx);
  });
});
