/* Unit tests for override capture (src/overrides.js).
   ----------------------------------------------------------------------------
   These record where the user overruled the scheduler, so a later pass can ask
   which terms are systematically mis-weighted. Two things matter most here and
   both are easy to get silently wrong:

   1. NOT recording is the common, correct outcome. Pinning a job exactly where
      it already sat is a confirmation, not a correction, and treating it as
      one would flood the history with zero-signal records that drag every
      average toward "no disagreement".

   2. The delta's DIRECTION. `featureDelta(user, scheduler)` is subtracted
      user-minus-scheduler, so positive means "the user's pick had more of
      this". Get it backwards and a future learning pass trains away from the
      user rather than toward them — a bug that would look like the tool
      slowly getting worse at its job, with nothing obviously broken.
*/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOverrideRecord, appendOverride, summariseOverrides, equipmentFlow, MAX_OVERRIDES,
} from '../src/overrides.js';
import { runScheduler } from '../src/scheduler.js';
import { MONDAY, days, equip, person, job } from './helpers.js';

// A trace entry as runScheduler emits it.
function traceEntry(chosenEquipId, candidates) {
  return {
    jobId: 'j1',
    scored: false,
    chosen: candidates.find((c) => c.equipId === chosenEquipId),
    candidates,
  };
}
const cand = (equipId, startDate, endDate, features = {}) => ({
  equipId,
  startDate,
  endDate,
  score: 0,
  features: { finishDelay: 0, handover: 0, staffContinuity: 0, ...features },
});

const j1 = job('j1', { name: 'Impeller Coat' });

describe('a correction is only recorded when there was actually a disagreement', () => {
  test('pinning a job exactly where the scheduler already put it records nothing', () => {
    const t = traceEntry('e1', [cand('e1', MONDAY, MONDAY), cand('e2', MONDAY, MONDAY)]);
    const rec = buildOverrideRecord({
      job: j1, traceEntry: t, userChoice: { equipmentId: 'e1', startDate: MONDAY }, source: 'drag',
    });
    assert.equal(rec, null, 'confirming a placement is not a correction and must not be logged');
  });

  test('a job with no trace entry records nothing — it was never auto-placed', () => {
    const rec = buildOverrideRecord({
      job: j1, traceEntry: undefined, userChoice: { equipmentId: 'e1', startDate: MONDAY }, source: 'drag',
    });
    assert.equal(rec, null);
  });

  test('moving to a different machine is recorded as an equipment disagreement', () => {
    const t = traceEntry('e1', [cand('e1', MONDAY, MONDAY), cand('e2', MONDAY, MONDAY)]);
    const rec = buildOverrideRecord({
      job: j1, traceEntry: t, userChoice: { equipmentId: 'e2', startDate: MONDAY }, source: 'drag',
    });
    assert.deepEqual(rec.changed, ['equipment'], 'same day, different machine');
    assert.equal(rec.scheduler.equipmentId, 'e1');
    assert.equal(rec.user.equipmentId, 'e2');
  });

  test('moving to a different day on the SAME machine is a timing disagreement, not an equipment one', () => {
    const t = traceEntry('e1', [cand('e1', MONDAY, MONDAY)]);
    const rec = buildOverrideRecord({
      job: j1, traceEntry: t, userChoice: { equipmentId: 'e1', startDate: '2026-03-05' }, source: 'drag',
    });
    assert.deepEqual(rec.changed, ['startDate'],
      'these are different signals and must not be blurred into one another');
  });

  // runScheduler only ever evaluates ONE placement per machine — its earliest
  // slot — so a day it never considered has no feature vector, and computing a
  // delta against the wrong row would quietly drag learned weights sideways
  // with nothing to show that it had happened.
  test('a move to a day the scheduler never evaluated is recorded but yields NO delta', () => {
    const t = traceEntry('e1', [cand('e1', MONDAY, MONDAY), cand('e2', MONDAY, MONDAY)]);
    const rec = buildOverrideRecord({
      job: j1, traceEntry: t, userChoice: { equipmentId: 'e2', startDate: '2026-03-06' }, source: 'drag',
    });
    assert.ok(rec, 'the correction still happened and is still worth keeping');
    assert.equal(rec.user.consideredFeasible, true, 'the machine itself was feasible…');
    assert.equal(rec.user.atCandidateStart, false, '…but not on the day the user picked');
    assert.equal(rec.comparable, false);
    assert.equal(rec.delta, null, 'a delta computed against the wrong day is worse than none');
  });

  test('a move to another machine on that machine’s own earliest day IS comparable', () => {
    const t = traceEntry('e1', [cand('e1', MONDAY, MONDAY), cand('e2', '2026-03-04', '2026-03-04')]);
    const rec = buildOverrideRecord({
      job: j1, traceEntry: t, userChoice: { equipmentId: 'e2', startDate: '2026-03-04' }, source: 'drag',
    });
    assert.equal(rec.comparable, true);
    assert.ok(rec.delta, 'both vectors describe placements that were actually evaluated');
  });

  test('changing both is recorded as both', () => {
    const t = traceEntry('e1', [cand('e1', MONDAY, MONDAY), cand('e2', MONDAY, MONDAY)]);
    const rec = buildOverrideRecord({
      job: j1, traceEntry: t, userChoice: { equipmentId: 'e2', startDate: '2026-03-05' }, source: 'drag',
    });
    assert.deepEqual(rec.changed.sort(), ['equipment', 'startDate']);
  });

  test('the job name is denormalised so the record survives the job being deleted', () => {
    const t = traceEntry('e1', [cand('e1', MONDAY, MONDAY), cand('e2', MONDAY, MONDAY)]);
    const rec = buildOverrideRecord({
      job: j1, traceEntry: t, userChoice: { equipmentId: 'e2', startDate: MONDAY }, source: 'drag',
    });
    assert.equal(rec.jobName, 'Impeller Coat');
    assert.equal(rec.jobId, 'j1');
  });
});

describe('the delta points from the scheduler toward the user', () => {
  test('a term the user’s pick has more of comes out positive', () => {
    const t = traceEntry('e1', [
      cand('e1', MONDAY, MONDAY, { finishDelay: 1, staffContinuity: 0, handover: 1 }),
      cand('e2', MONDAY, MONDAY, { finishDelay: 4, staffContinuity: 1, handover: 0 }),
    ]);
    const rec = buildOverrideRecord({
      job: j1, traceEntry: t, userChoice: { equipmentId: 'e2', startDate: MONDAY }, source: 'drag',
    });
    // The user took a machine that finishes 3 days later but keeps the same
    // operator and avoids a handover — i.e. continuity is worth more to them
    // than the current weights say.
    assert.equal(rec.delta.staffContinuity, 1, 'positive → the user wanted MORE of this');
    assert.equal(rec.delta.handover, -1, 'negative → the user wanted LESS of this');
    assert.equal(rec.delta.finishDelay, 3, 'and this is the cost they accepted to get it');
  });

  test('a user pick the scheduler found infeasible is still recorded, but with no delta', () => {
    // Deliberate overbooking: the user dropped it somewhere tryFit found no
    // slot for, so there is no feature vector to compare and none is invented.
    const t = traceEntry('e1', [cand('e1', MONDAY, MONDAY)]);
    const rec = buildOverrideRecord({
      job: j1, traceEntry: t, userChoice: { equipmentId: 'e_busy', startDate: MONDAY }, source: 'drag',
    });
    assert.ok(rec, 'the correction still happened and is still worth knowing about');
    assert.equal(rec.user.consideredFeasible, false);
    assert.equal(rec.user.features, null);
    assert.equal(rec.delta, null, 'a partial vector must not be faked into a delta');
  });

  test('the source is kept, because a lock is stronger evidence than one drag', () => {
    const t = traceEntry('e1', [cand('e1', MONDAY, MONDAY), cand('e2', MONDAY, MONDAY)]);
    for (const source of ['drag', 'modal-pin', 'lock']) {
      const rec = buildOverrideRecord({
        job: j1, traceEntry: t, userChoice: { equipmentId: 'e2', startDate: MONDAY }, source,
      });
      assert.equal(rec.source, source);
    }
  });
});

describe('the stored list stays bounded and immutable', () => {
  test('appendOverride returns a new array and never mutates the input', () => {
    const list = [];
    const next = appendOverride(list, { id: 'a' });
    assert.equal(list.length, 0, 'React state must be safe to hold');
    assert.equal(next.length, 1);
  });

  test('a null record (no disagreement) leaves the list untouched', () => {
    const list = [{ id: 'a' }];
    assert.equal(appendOverride(list, null), list);
  });

  test('the oldest records are dropped once the cap is hit', () => {
    let list = [];
    for (let i = 0; i < MAX_OVERRIDES + 25; i++) list = appendOverride(list, { id: `r${i}` });
    assert.equal(list.length, MAX_OVERRIDES, 'shared mode writes this to the host PC — it cannot grow forever');
    assert.equal(list[0].id, 'r25', 'oldest dropped first; a year-old correction describes a department that no longer exists');
    assert.equal(list[list.length - 1].id, `r${MAX_OVERRIDES + 24}`);
  });
});

describe('summarising the pile', () => {
  const mk = (delta, over = {}) => ({
    id: 'x', source: 'drag', changed: ['equipment'],
    scheduler: { equipmentId: 'e1' }, user: { equipmentId: 'e2' }, delta, ...over,
  });

  test('mean delta averages only the records that have one', () => {
    const s = summariseOverrides([
      mk({ staffContinuity: 1 }, { comparable: true }),
      mk({ staffContinuity: 1 }, { comparable: true }),
      mk(null), // infeasible pick — recorded, but contributes no delta
    ]);
    assert.equal(s.n, 3, 'every record counts toward the total');
    assert.equal(s.nComparable, 2, 'but only two are comparable');
    assert.equal(s.meanDelta.staffContinuity, 1, 'and the mean must not be diluted by the third');
  });

  test('it says WHY the incomparable records were left out', () => {
    const s = summariseOverrides([
      mk(null, { user: { equipmentId: 'e9', consideredFeasible: false, atCandidateStart: false } }),
      mk(null, { user: { equipmentId: 'e2', consideredFeasible: true, atCandidateStart: false } }),
      mk(null, { user: { equipmentId: 'e2', consideredFeasible: true, atCandidateStart: false } }),
    ]);
    assert.equal(s.notComparable.infeasiblePick, 1);
    assert.equal(s.notComparable.movedToUnevaluatedDay, 2,
      'if this dominates, the disagreement is about timing and no amount of feature differencing will explain it');
  });

  test('n is reported alongside the mean, because three corrections is an anecdote', () => {
    const s = summariseOverrides([mk({ finishDelay: 9 })]);
    assert.equal(s.nComparable, 1);
    assert.equal(s.meanDelta.finishDelay, 9,
      'a huge mean off one record is exactly why the count has to travel with it');
  });

  test('an empty history summarises cleanly rather than dividing by zero', () => {
    const s = summariseOverrides([]);
    assert.equal(s.n, 0);
    assert.deepEqual(s.meanDelta, {});
    assert.ok(Object.values(s.meanDelta).every(Number.isFinite));
  });

  test('equipmentFlow counts what work is moved off and onto', () => {
    const flow = equipmentFlow([
      mk({}, { scheduler: { equipmentId: 'cell_b' }, user: { equipmentId: 'cell_a' } }),
      mk({}, { scheduler: { equipmentId: 'cell_b' }, user: { equipmentId: 'cell_a' } }),
      mk({}, { scheduler: { equipmentId: 'cell_a' }, user: { equipmentId: 'cell_c' } }),
      // A timing-only correction says nothing about equipment and is skipped.
      mk({}, { changed: ['startDate'], scheduler: { equipmentId: 'cell_b' }, user: { equipmentId: 'cell_b' } }),
    ]);
    assert.equal(flow.cell_b.movedFrom, 2, '"you keep taking things off Cell B" — a claim a person can verify');
    assert.equal(flow.cell_a.movedTo, 2);
    assert.equal(flow.cell_a.movedFrom, 1);
    assert.equal(flow.cell_c.movedTo, 1);
  });
});

describe('end to end against a real trace', () => {
  test('a real runScheduler trace feeds buildOverrideRecord directly', () => {
    // Guards the seam between the two modules: the trace's shape is what
    // buildOverrideRecord reads, so a change to one that breaks the other
    // should fail here rather than silently stop recording in the app.
    const d = days();
    const trace = [];
    runScheduler([job('j1', { hoursTotal: 8 })], [equip('e1'), equip('e2')], [person('s1')], d, 0, { trace });

    const entry = trace.find((t) => t.jobId === 'j1');
    assert.ok(entry, 'the default path must emit a trace for an auto-placed job');
    const other = entry.candidates.find((c) => c.equipId !== entry.chosen.equipId);

    const rec = buildOverrideRecord({
      job: j1,
      traceEntry: entry,
      userChoice: { equipmentId: other.equipId, startDate: other.startDate },
      source: 'drag',
      at: '2026-03-02T09:00:00.000Z',
      id: 'ovr_1',
    });

    assert.ok(rec, 'moving to the machine the scheduler passed over is a real disagreement');
    assert.ok(rec.delta, 'both picks were feasible, so a delta is available');
    assert.equal(rec.scheduler.equipmentId, entry.chosen.equipId);
    assert.equal(rec.user.consideredFeasible, true);
    assert.deepEqual(Object.keys(rec.delta).sort(), Object.keys(other.features).sort(),
      'every scored term should appear in the delta');
  });
});
