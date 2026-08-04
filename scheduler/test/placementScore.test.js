/* Unit tests for the weighted placement scoring (src/placementScore.js) and
   for runScheduler's opt-in scoring path.
   ----------------------------------------------------------------------------
   Two things are being pinned down here, and they're different in kind:

   1. The scoring path is OPT-IN and the default is untouched. The whole point
      of the flag is that a working tool keeps working, so "five-argument
      runScheduler behaves exactly as before" is itself an invariant worth a
      test, not just an implementation detail.

   2. Scoring can express tradeoffs the old lexicographic cascade could not.
      The headline case is preferred equipment: under the cascade it won
      outright at ANY cost, so these tests assert the new path takes it when
      it's cheap and drops it when it's expensive — behaviour the old
      structure had no way to represent.

   Run: npm test (in scheduler/), alongside the engine's own suite.
*/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WEIGHTS, placementFeatures, scoreCandidate, rankCandidates,
  featureDelta, daysBetween,
} from '../src/placementScore.js';
import { runScheduler } from '../src/scheduler.js';
import { MONDAY, days, equip, person, job, byId } from './helpers.js';

// A candidate as runScheduler builds it: { equipId, plan, startDate, endDate }.
function candidate(equipId, planDays, over = {}) {
  const plan = planDays.map(([date, staffId, hours = 8]) => ({ date, shift: 'day', staffId, hours }));
  return {
    equipId,
    plan,
    startDate: plan[0]?.date,
    endDate: plan[plan.length - 1]?.date,
    ...over,
  };
}

describe('placement features are raw measurements, not judgements', () => {
  test('a one-person, one-day plan has no handovers and no fragmentation', () => {
    const c = candidate('e1', [[MONDAY, 's1']]);
    const f = placementFeatures(job('j', { readyDate: MONDAY }), c, { floorDate: MONDAY });
    assert.equal(f.handover, 0, 'one operator is the ideal case and must cost nothing');
    assert.equal(f.fragmentation, 0, 'one unbroken chunk is the ideal case and must cost nothing');
    assert.equal(f.finishDelay, 0);
    assert.equal(f.startDelay, 0);
  });

  test('handovers count operator CHANGES, not operators', () => {
    const c = candidate('e1', [[MONDAY, 's1'], ['2026-03-03', 's2'], ['2026-03-04', 's3']]);
    const f = placementFeatures(job('j', { readyDate: MONDAY }), c, {});
    assert.equal(f.handover, 2, 'three people on a job is two changes');
    assert.equal(f.fragmentation, 2, 'three chunks is two extra beyond the first');
  });

  test('the same person across several days is still zero handovers', () => {
    const c = candidate('e1', [[MONDAY, 's1'], ['2026-03-03', 's1'], ['2026-03-04', 's1']]);
    const f = placementFeatures(job('j', { readyDate: MONDAY }), c, {});
    assert.equal(f.handover, 0);
    assert.equal(f.fragmentation, 2, 'still three chunks, even with one operator');
  });

  test('lateness is one-sided — finishing early is not a negative lateness', () => {
    const c = candidate('e1', [[MONDAY, 's1']]);
    const early = placementFeatures(job('j', { readyDate: MONDAY }), c, { dueDate: '2026-03-20' });
    assert.equal(early.lateness, 0, 'finishing well before the due date is not "negative late"');

    const lateC = candidate('e1', [['2026-03-10', 's1']]);
    const late = placementFeatures(job('j', { readyDate: MONDAY }), lateC, { dueDate: '2026-03-05' });
    assert.equal(late.lateness, 5);
  });

  test('preferredEquipment and staffContinuity are 1/0, so a weight can multiply them', () => {
    const c = candidate('e1', [[MONDAY, 's1']]);
    const hit = placementFeatures(job('j', { preferredEquipmentId: 'e1' }), c, { seedStaffId: 's1' });
    assert.equal(hit.preferredEquipment, 1);
    assert.equal(hit.staffContinuity, 1);

    const miss = placementFeatures(job('j', { preferredEquipmentId: 'e2' }), c, { seedStaffId: 's9' });
    assert.equal(miss.preferredEquipment, 0);
    assert.equal(miss.staffContinuity, 0);
  });

  test('exclusiveDemand reads the count for this candidate’s own machine', () => {
    const c = candidate('e1', [[MONDAY, 's1']]);
    const f = placementFeatures(job('j'), c, { exclusiveDemand: { e1: 3, e2: 7 } });
    assert.equal(f.exclusiveDemand, 3);
  });

  test('daysBetween is inclusive-exclusive and tolerates blanks', () => {
    assert.equal(daysBetween('2026-03-02', '2026-03-05'), 3);
    assert.equal(daysBetween('2026-03-05', '2026-03-02'), -3);
    assert.equal(daysBetween(null, '2026-03-05'), 0);
    assert.equal(daysBetween('2026-03-05', ''), 0);
  });
});

describe('score = Σ weight × feature, and the parts stay visible', () => {
  test('contributions sum to the score', () => {
    const c = candidate('e1', [[MONDAY, 's1'], ['2026-03-03', 's2']]);
    const { score, contributions } = scoreCandidate(
      job('j', { readyDate: MONDAY, preferredEquipmentId: 'e1' }), c, { seedStaffId: 's1' },
    );
    const summed = Object.values(contributions).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(summed - score) < 0.0001, `${summed} vs ${score}`);
  });

  test('features are reported unweighted, so weights can change without touching them', () => {
    const c = candidate('e1', [[MONDAY, 's1']]);
    const j = job('j', { readyDate: MONDAY, preferredEquipmentId: 'e1' });
    const stock = scoreCandidate(j, c, {});
    const doubled = scoreCandidate(j, c, {}, { ...DEFAULT_WEIGHTS, preferredEquipment: 120 });
    assert.deepEqual(stock.features, doubled.features, 'the measurement is the same; only the opinion changed');
    assert.equal(doubled.contributions.preferredEquipment, 2 * stock.contributions.preferredEquipment);
  });

  test('an unknown term in the feature set contributes nothing rather than NaN', () => {
    const c = candidate('e1', [[MONDAY, 's1']]);
    const { score } = scoreCandidate(job('j', { readyDate: MONDAY }), c, {}, { finishDelay: -10 });
    assert.ok(Number.isFinite(score), `expected a real number, got ${score}`);
  });

  test('rankCandidates orders best-first and breaks exact ties deterministically', () => {
    const j = job('j', { readyDate: MONDAY });
    // Two candidates identical in every scored respect — the tie must not fall
    // through to input order, or a recompute could reshuffle the board.
    const a = candidate('zzz', [[MONDAY, 's1']]);
    const b = candidate('aaa', [[MONDAY, 's1']]);
    const forward = rankCandidates(j, [a, b], {});
    const backward = rankCandidates(j, [b, a], {});
    assert.equal(forward[0].equipId, backward[0].equipId, 'the winner must not depend on list order');
    assert.equal(forward[0].equipId, 'aaa');
  });

  test('rankCandidates returns copies — the caller keeps the whole ranking, not just the winner', () => {
    const j = job('j', { readyDate: MONDAY });
    const input = [candidate('e1', [[MONDAY, 's1']]), candidate('e2', [['2026-03-04', 's1']])];
    const ranked = rankCandidates(j, input, {});
    assert.equal(ranked.length, 2, 'every candidate is scored and kept, for later comparison');
    assert.ok(ranked.every((c) => typeof c.score === 'number' && c.features));
    assert.equal(input[0].score, undefined, 'the inputs must not be mutated');
  });
});

describe('the tradeoff the old lexicographic cascade could not express', () => {
  const j = (over) => job('j', { readyDate: MONDAY, preferredEquipmentId: 'pref', ...over });

  test('a preferred machine wins when it costs only a day or two', () => {
    const pref = candidate('pref', [['2026-03-04', 's1']]);   // 2 days later
    const fast = candidate('other', [[MONDAY, 's1']]);        // available now
    const ranked = rankCandidates(j(), [fast, pref], { floorDate: MONDAY });
    assert.equal(ranked[0].equipId, 'pref',
      'a 2-day wait (-20) should not outweigh the preference (+60)');
  });

  test('the same preference LOSES once the wait gets expensive', () => {
    const pref = candidate('pref', [['2026-03-16', 's1']]);   // 14 days later
    const fast = candidate('other', [[MONDAY, 's1']]);
    const ranked = rankCandidates(j(), [fast, pref], { floorDate: MONDAY });
    assert.equal(ranked[0].equipId, 'other',
      'a 14-day wait (-140) must outweigh the preference (+60) — the old cascade took "pref" regardless');
  });

  test('for contrast: the default lexicographic path takes the preferred machine at any cost', () => {
    const d = days(30);
    // e1 is tied up for a fortnight; e2 is free immediately. The job prefers e1.
    const blocker = job('blocker', {
      hoursTotal: 80,
      assignment: { equipmentId: 'e1', startDate: MONDAY, endDate: MONDAY, pinned: true, days: [] },
    });
    const preferring = job('preferring', { hoursTotal: 8, preferredEquipmentId: 'e1', dueDate: '2026-03-30' });

    const legacy = runScheduler([blocker, preferring], [equip('e1'), equip('e2')], [person('s1'), person('s2')], d);
    assert.equal(byId(legacy, 'preferring').assignment.equipmentId, 'e1',
      'the default path is unchanged: the preference still wins outright');

    const scored = runScheduler([blocker, preferring], [equip('e1'), equip('e2')], [person('s1'), person('s2')], d,
      0, { weights: DEFAULT_WEIGHTS });
    assert.equal(byId(scored, 'preferring').assignment.equipmentId, 'e2',
      'the scoring path trades the preference away once the wait is long enough');
  });

  test('a flexible job does not camp on the one machine an inflexible job needs, to save a day or two', () => {
    // Found by `npm run compare-scoring` on the demo workload: exclusiveDemand
    // only ever broke EXACT ties under the cascade, so its magnitude had never
    // been under any pressure. Scored at a token weight it lost to a two-day
    // saving and parked a general job on the only tagged cell — the precise
    // thing the signal exists to prevent. This pins the corrected weight.
    const d = days();
    const jobs = [
      // Only the tagged machine can take this one.
      job('needs-positioner', { hoursTotal: 8, tags: ['5T Positioner'], dueDate: '2026-03-18' }),
      // This one can run anywhere, and the tagged machine happens to be free soonest.
      job('flexible', { hoursTotal: 8, dueDate: '2026-03-18' }),
    ];
    const equipment = [
      equip('general', { unavailableDates: [d[0]] }), // busy today, so 'special' looks quicker
      equip('special', { tags: ['5T Positioner'] }),
    ];
    const out = runScheduler(jobs, equipment, [person('s1'), person('s2')], d, 0, { weights: DEFAULT_WEIGHTS });

    assert.equal(byId(out, 'needs-positioner').assignment.equipmentId, 'special',
      'the job with no alternative must keep the machine it depends on');
    assert.equal(byId(out, 'flexible').assignment.equipmentId, 'general',
      'the flexible job should wait for the general machine rather than block the specialist');
  });

  test('lateness is a real signal the cascade never had at all', () => {
    // Same finish date either way, so the cascade's primary key can't separate
    // them; only the due date differs, which the cascade never looked at.
    const c = candidate('e1', [['2026-03-10', 's1']]);
    const onTime = scoreCandidate(job('j', { readyDate: MONDAY }), c, { dueDate: '2026-03-20' });
    const late = scoreCandidate(job('j', { readyDate: MONDAY }), c, { dueDate: '2026-03-05' });
    assert.ok(late.score < onTime.score, 'finishing past the due date must score worse than the same plan on time');
    assert.equal(late.features.lateness, 5);
    assert.equal(onTime.features.lateness, 0);
  });
});

describe('runScheduler: the scoring path is opt-in and changes nothing by default', () => {
  const fixture = () => ({
    d: days(20),
    jobs: [
      job('a', { hoursTotal: 8, dueDate: '2026-03-10' }),
      job('b', { hoursTotal: 8, dueDate: '2026-03-12' }),
      job('c', { hoursTotal: 16, dueDate: '2026-03-15' }),
    ],
    equipment: [equip('e1'), equip('e2')],
    staff: [person('s1'), person('s2')],
  });

  test('five-argument runScheduler is byte-identical to before the flag existed', () => {
    const { d, jobs, equipment, staff } = fixture();
    const five = runScheduler(jobs.map((j) => ({ ...j })), equipment, staff, d, 0);
    const withEmptyOptions = runScheduler(jobs.map((j) => ({ ...j })), equipment, staff, d, 0, {});
    assert.deepEqual(
      five.map((j) => j.assignment),
      withEmptyOptions.map((j) => j.assignment),
      'an absent options object and an empty one must both mean "legacy path"',
    );
  });

  test('hard constraints still bind under scoring — a locked job cannot be scored onto another machine', () => {
    const d = days();
    const out = runScheduler(
      [job('locked', { hoursTotal: 8, lockedEquipmentId: 'e1' })],
      [equip('e1'), equip('e2')], [person('s1')], d, 0, { weights: DEFAULT_WEIGHTS },
    );
    assert.equal(byId(out, 'locked').assignment.equipmentId, 'e1',
      'eligibility is filtered before scoring; a weight must never be able to outvote a lock');
  });

  test('an unschedulable job is still unschedulable under scoring, with the same reason', () => {
    const d = days();
    const args = [[job('nope', { readyDate: null, hoursTotal: 8 })], [equip('e1')], [person('s1')], d];
    const legacy = runScheduler(...args, 0);
    const scored = runScheduler(...args, 0, { weights: DEFAULT_WEIGHTS });
    assert.equal(byId(legacy, 'nope').assignment, null);
    assert.equal(byId(scored, 'nope').assignment, null);
    assert.equal(byId(scored, 'nope').unschedReason, byId(legacy, 'nope').unschedReason);
  });

  test('scoring still places every job it can — it reorders candidates, never removes them', () => {
    const { d, jobs, equipment, staff } = fixture();
    const scored = runScheduler(jobs, equipment, staff, d, 0, { weights: DEFAULT_WEIGHTS });
    assert.ok(scored.every((j) => j.assignment), 'no job should fall out of the schedule under scoring');
  });

  test('the trace records every candidate considered, not just the winner', () => {
    const d = days();
    const trace = [];
    runScheduler([job('j', { hoursTotal: 8 })], [equip('e1'), equip('e2')], [person('s1')], d,
      0, { weights: DEFAULT_WEIGHTS, trace });

    assert.equal(trace.length, 1);
    assert.equal(trace[0].jobId, 'j');
    assert.equal(trace[0].candidates.length, 2, 'both machines were feasible and both must be recorded');
    assert.ok(trace[0].candidates.every((c) => c.features && typeof c.score === 'number'));
    assert.equal(trace[0].chosenEquipId, trace[0].candidates[0].equipId, 'the trace is stored best-first');
  });

  test('no trace is produced on the default path, and passing none costs nothing', () => {
    const d = days();
    const trace = [];
    runScheduler([job('j')], [equip('e1')], [person('s1')], d, 0, { trace });
    assert.equal(trace.length, 0, 'the legacy path must not silently start emitting traces');
  });
});

describe('featureDelta — the learning signal', () => {
  test('it points from the scheduler’s pick toward the user’s', () => {
    // The user moved the job to a machine that finished 3 days later but kept
    // the same operator — i.e. they care about continuity more than the
    // current weights say.
    const schedulerPick = { finishDelay: 2, staffContinuity: 0, handover: 1 };
    const userPick = { finishDelay: 5, staffContinuity: 1, handover: 0 };
    const delta = featureDelta(userPick, schedulerPick);

    assert.equal(delta.staffContinuity, 1, 'positive: the user’s pick had MORE of this, so its weight should rise');
    assert.equal(delta.handover, -1, 'negative: the user’s pick had LESS of this, so its weight should fall');
    assert.equal(delta.finishDelay, 3, 'the user accepted 3 more days — the cost they were willing to pay');
  });

  test('terms missing from either side are treated as zero, not dropped', () => {
    const delta = featureDelta({ lateness: 2 }, { handover: 1 });
    assert.equal(delta.lateness, 2);
    assert.equal(delta.handover, -1);
  });

  test('an agreement produces an all-zero delta — nothing to learn', () => {
    const same = { finishDelay: 2, handover: 1 };
    const delta = featureDelta(same, { ...same });
    assert.ok(Object.values(delta).every((v) => v === 0), JSON.stringify(delta));
  });
});
