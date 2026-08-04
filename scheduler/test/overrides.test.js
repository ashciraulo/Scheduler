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
  buildOverrideRecord, appendOverride, summariseOverrides, equipmentFlow,
  attributeAffinity, classifyAffinity, affinityFindings, dedupeFindings, weightEvidence,
  overrideDateRange, TERM_READINGS, AFFINITY_TIERS, MAX_OVERRIDES,
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

describe('what kind of work it was — captured at correction time or lost forever', () => {
  const rich = job('j1', {
    name: 'Impeller Coat',
    templateId: 'tp_hvof',
    process: 'Thermal Spray - HVOF',
    procedureId: 'proc_9',
    tags: ['5T Positioner'],
    preferredEquipmentId: 'cell_a',
    lockedEquipmentId: null,
  });

  test('the job’s descriptors travel with the record', () => {
    const t = traceEntry('e1', [cand('e1', MONDAY, MONDAY), cand('e2', MONDAY, MONDAY)]);
    const rec = buildOverrideRecord({
      job: rich, traceEntry: t, userChoice: { equipmentId: 'e2', startDate: MONDAY }, source: 'drag',
    });
    // Without these the history can only ever tune global weights; these are
    // what make "this KIND of work belongs on that machine" answerable at all.
    assert.equal(rec.job.templateId, 'tp_hvof');
    assert.equal(rec.job.process, 'Thermal Spray - HVOF');
    assert.equal(rec.job.procedureId, 'proc_9');
    assert.deepEqual(rec.job.tags, ['5T Positioner']);
  });

  test('the job’s existing preference is captured, separating "establishing" from "enforcing"', () => {
    const t = traceEntry('e1', [cand('e1', MONDAY, MONDAY), cand('cell_a', MONDAY, MONDAY)]);
    // Moving it ONTO the machine it already preferred: not a new preference,
    // but evidence the scheduler keeps failing to honour an existing one.
    const enforcing = buildOverrideRecord({
      job: rich, traceEntry: t, userChoice: { equipmentId: 'cell_a', startDate: MONDAY }, source: 'drag',
    });
    assert.equal(enforcing.job.preferredEquipmentId, 'cell_a');
    assert.equal(enforcing.user.equipmentId, 'cell_a',
      'same machine as the stated preference — these two facts together are the whole distinction');

    const noPref = buildOverrideRecord({
      job: { ...rich, preferredEquipmentId: null },
      traceEntry: t, userChoice: { equipmentId: 'cell_a', startDate: MONDAY }, source: 'drag',
    });
    assert.equal(noPref.job.preferredEquipmentId, null, 'nothing claimed yet — this one IS a new suggestion');
  });

  test('a job missing these fields records nulls rather than throwing', () => {
    const t = traceEntry('e1', [cand('e1', MONDAY, MONDAY), cand('e2', MONDAY, MONDAY)]);
    const bare = { id: 'j2', name: 'Bare' };
    const rec = buildOverrideRecord({
      job: bare, traceEntry: t, userChoice: { equipmentId: 'e2', startDate: MONDAY }, source: 'drag',
    });
    assert.equal(rec.job.templateId, null);
    assert.deepEqual(rec.job.tags, []);
  });
});

describe('attributeAffinity — "this kind of work belongs on that machine"', () => {
  const mkRec = (jobFields, from, to, changed = ['equipment']) => ({
    changed,
    scheduler: { equipmentId: from },
    user: { equipmentId: to },
    job: { templateId: null, process: null, procedureId: null, tags: [], preferredEquipmentId: null, ...jobFields },
  });

  test('it groups corrections by template and names the machine work keeps landing on', () => {
    const flow = attributeAffinity([
      mkRec({ templateId: 'tp_bracket' }, 'eq_1', 'eq_2'),
      mkRec({ templateId: 'tp_bracket' }, 'eq_1', 'eq_2'),
      mkRec({ templateId: 'tp_bracket' }, 'eq_3', 'eq_2'),
      mkRec({ templateId: 'tp_bracket' }, 'eq_1', 'eq_4'),
      mkRec({ templateId: 'tp_shaft' }, 'eq_2', 'eq_1'),
    ], 'templateId');

    assert.equal(flow.tp_bracket.n, 4);
    assert.equal(flow.tp_bracket.top.equipmentId, 'eq_2');
    assert.equal(flow.tp_bracket.top.count, 3);
    assert.equal(flow.tp_bracket.top.share, 0.75, '3 of the 4 equipment moves for this template');
    assert.equal(flow.tp_shaft.n, 1, 'and one correction is an anecdote, which the count makes obvious');
  });

  test('it works the same over process and procedure', () => {
    const list = [
      mkRec({ process: 'Weld', procedureId: 'p1' }, 'eq_1', 'eq_2'),
      mkRec({ process: 'Weld', procedureId: 'p1' }, 'eq_3', 'eq_2'),
    ];
    assert.equal(attributeAffinity(list, 'process').Weld.top.equipmentId, 'eq_2');
    assert.equal(attributeAffinity(list, 'procedureId').p1.top.equipmentId, 'eq_2');
  });

  test('a job counts once under each of its tags', () => {
    const flow = attributeAffinity([
      mkRec({ tags: ['5T Positioner', 'Cleanroom'] }, 'eq_1', 'eq_2'),
    ], 'tags');
    assert.equal(flow['5T Positioner'].n, 1);
    assert.equal(flow.Cleanroom.n, 1);
  });

  test('timing-only corrections are excluded — they say nothing about which machine', () => {
    const flow = attributeAffinity([
      mkRec({ templateId: 'tp_a' }, 'eq_1', 'eq_2'),
      mkRec({ templateId: 'tp_a' }, 'eq_1', 'eq_1', ['startDate']),
      mkRec({ templateId: 'tp_a' }, 'eq_1', 'eq_1', ['startDate']),
    ], 'templateId');
    assert.equal(flow.tp_a.n, 1,
      'including day-moves would dilute every share toward meaninglessness');
    assert.equal(flow.tp_a.top.share, 1);
  });

  test('jobs with the attribute unset are skipped, not bucketed under a blank key', () => {
    const flow = attributeAffinity([
      mkRec({ templateId: null }, 'eq_1', 'eq_2'),
      mkRec({ templateId: '' }, 'eq_1', 'eq_2'),
      mkRec({ templateId: 'tp_a' }, 'eq_1', 'eq_2'),
    ], 'templateId');
    assert.deepEqual(Object.keys(flow), ['tp_a'], 'a custom one-off job belongs to no template group');
  });

  test('an existing preference is reported alongside, so "enforcing" is distinguishable from "establishing"', () => {
    const enforcing = attributeAffinity([
      mkRec({ templateId: 'tp_a', preferredEquipmentId: 'eq_2' }, 'eq_1', 'eq_2'),
      mkRec({ templateId: 'tp_a', preferredEquipmentId: 'eq_2' }, 'eq_1', 'eq_2'),
    ], 'templateId');
    assert.equal(enforcing.tp_a.top.equipmentId, 'eq_2');
    assert.equal(enforcing.tp_a.existingPreferences.eq_2, 2,
      'the preference was already set — this is the scheduler failing to honour it, NOT a new suggestion');

    const establishing = attributeAffinity([
      mkRec({ templateId: 'tp_b' }, 'eq_1', 'eq_2'),
      mkRec({ templateId: 'tp_b' }, 'eq_1', 'eq_2'),
    ], 'templateId');
    assert.deepEqual(establishing.tp_b.existingPreferences, {},
      'nothing claimed yet — this one genuinely is a suggestion to record a preference');
  });

  test('an empty history gives an empty grouping rather than throwing', () => {
    assert.deepEqual(attributeAffinity([], 'templateId'), {});
    assert.deepEqual(attributeAffinity(null, 'templateId'), {});
  });
});

describe('presenting findings to a person who has to judge them', () => {
  const group = (over = {}) => ({
    n: 8, movedTo: { eq_2: 7, eq_3: 1 }, movedFrom: { eq_1: 8 }, existingPreferences: {},
    top: { equipmentId: 'eq_2', count: 7, share: 7 / 8 }, ...over,
  });

  test('a group with no dominant machine is not a finding at all', () => {
    const spread = group({ top: { equipmentId: 'eq_2', count: 3, share: 0.3 } });
    assert.equal(classifyAffinity(spread), null,
      'work being spread around says nothing — showing it as a pattern would be noise');
  });

  test('a thin group is still shown but labelled as too few to call', () => {
    const thin = group({ n: 2, top: { equipmentId: 'eq_2', count: 2, share: 1 } });
    assert.equal(classifyAffinity(thin).tier, 'too-few',
      'two corrections at 100% is not a pattern, and the label has to say so');
  });

  test('tiers escalate with both count and consistency', () => {
    assert.equal(classifyAffinity(group({ n: 4, top: { equipmentId: 'eq_2', count: 3, share: 0.75 } })).tier, 'emerging');
    assert.equal(classifyAffinity(group()).tier, 'consistent');
    // High count but scattered is deliberately NOT promoted.
    assert.equal(classifyAffinity(group({ n: 20, top: { equipmentId: 'eq_2', count: 13, share: 0.65 } })).tier, 'emerging');
  });

  test('the SAME numbers classify differently depending on an existing preference', () => {
    // This is the distinction the whole record.job capture exists to make.
    const fresh = classifyAffinity(group());
    const already = classifyAffinity(group({ existingPreferences: { eq_2: 7 } }));

    assert.equal(fresh.kind, 'set-preference', 'nothing claimed yet → suggest recording a preference');
    assert.equal(already.kind, 'preference-ignored',
      'already prefers that exact machine → the preference is being outvoted; recording it again fixes nothing');
    assert.equal(fresh.n, already.n, 'identical counts…');
    assert.equal(fresh.share, already.share, '…and identical shares, but opposite conclusions');
  });

  test('an existing preference for a DIFFERENT machine is still a new suggestion', () => {
    const c = classifyAffinity(group({ existingPreferences: { eq_9: 8 } }));
    assert.equal(c.kind, 'set-preference',
      'preferring eq_9 while everything moves to eq_2 means the recorded preference is simply wrong');
  });

  test('affinityFindings sorts strongest first and drops the non-findings', () => {
    const list = [];
    const rec = (templateId, to) => ({
      changed: ['equipment'], scheduler: { equipmentId: 'eq_1' }, user: { equipmentId: to },
      job: { templateId, tags: [], preferredEquipmentId: null },
    });
    for (let i = 0; i < 6; i++) list.push(rec('tp_strong', 'eq_2'));
    for (let i = 0; i < 3; i++) list.push(rec('tp_weak', 'eq_2'));
    // Scattered: 2 each to three different machines — no dominant target.
    ['eq_2', 'eq_2', 'eq_3', 'eq_3', 'eq_4', 'eq_4'].forEach((to) => list.push(rec('tp_spread', to)));

    const found = affinityFindings(list, 'templateId');
    assert.deepEqual(found.map((f) => f.value), ['tp_strong', 'tp_weak'],
      'the scattered template is not a finding and must not be listed');
    assert.equal(found[0].tier, 'consistent');
    assert.equal(found[1].tier, 'emerging');
  });

  // Every template has exactly one process, so an un-deduped view reports the
  // same corrections two or three times over and one pattern looks like
  // several corroborating ones.
  test('a process finding built from the same corrections as a template finding is dropped', () => {
    const rec = (id, templateId, process, to) => ({
      id, changed: ['equipment'], scheduler: { equipmentId: 'eq_1' }, user: { equipmentId: to },
      job: { templateId, process, tags: [], preferredEquipmentId: null },
    });
    const list = [];
    for (let i = 0; i < 6; i++) list.push(rec('r' + i, 'tp_1', 'Weld', 'eq_2'));

    const byKey = {
      templateId: affinityFindings(list, 'templateId'),
      process: affinityFindings(list, 'process'),
    };
    assert.equal(byKey.process.length, 1, 'un-deduped, the process repeats the template finding');

    const out = dedupeFindings(byKey, ['templateId', 'process']);
    assert.equal(out.templateId.length, 1, 'the specific, actionable finding is the one kept');
    assert.equal(out.process.length, 0, 'its restatement adds nothing and is dropped');
  });

  test('but a BROADER pattern spanning several templates survives — it is the more informative one', () => {
    const rec = (id, templateId, to) => ({
      id, changed: ['equipment'], scheduler: { equipmentId: 'eq_1' }, user: { equipmentId: to },
      job: { templateId, process: 'Thermal Spray - HVOF', tags: [], preferredEquipmentId: null },
    });
    // Three templates, two corrections each — no single template reaches the
    // threshold, but together the process clearly does.
    const list = [
      rec('a1', 'tp_1', 'eq_9'), rec('a2', 'tp_1', 'eq_9'),
      rec('b1', 'tp_2', 'eq_9'), rec('b2', 'tp_2', 'eq_9'),
      rec('c1', 'tp_3', 'eq_9'), rec('c2', 'tp_3', 'eq_9'),
    ];
    const out = dedupeFindings({
      templateId: affinityFindings(list, 'templateId'),
      process: affinityFindings(list, 'process'),
    }, ['templateId', 'process']);

    assert.equal(out.process.length, 1, 'all HVOF work heading to one cell is a real finding in its own right');
    assert.equal(out.process[0].n, 6, 'and it spans records no single template covers');
    assert.ok(out.templateId.every((f) => f.tier === 'too-few'),
      'the per-template views are individually thin, which is exactly why the broader one matters');
  });

  test('a finding pointing at a DIFFERENT machine is never treated as a duplicate', () => {
    const rec = (id, templateId, process, to) => ({
      id, changed: ['equipment'], scheduler: { equipmentId: 'eq_1' }, user: { equipmentId: to },
      job: { templateId, process, tags: [], preferredEquipmentId: null },
    });
    const list = [];
    for (let i = 0; i < 6; i++) list.push(rec('r' + i, 'tp_1', 'Weld', 'eq_2'));
    // Same records, but suppose the process group somehow favoured another
    // machine — that is a different claim and must not be silently swallowed.
    const byKey = {
      templateId: affinityFindings(list, 'templateId'),
      process: [{ key: 'process', value: 'Weld', equipmentId: 'eq_7', n: 6, share: 1, count: 6,
        kind: 'set-preference', tier: 'consistent', alreadyPrefers: 0,
        recordIds: new Set(list.map((r) => r.id)) }],
    };
    const out = dedupeFindings(byKey, ['templateId', 'process']);
    assert.equal(out.process.length, 1, 'same records, different conclusion — both deserve to be seen');
  });

  test('weightEvidence turns a mean delta into something a person can agree or disagree with', () => {
    const mk = (delta) => ({ changed: ['equipment'], comparable: true, delta, scheduler: {}, user: {}, job: {} });
    const ev = weightEvidence([
      mk({ staffContinuity: 1, finishDelay: 3, handover: -1 }),
      mk({ staffContinuity: 1, finishDelay: 3, handover: -1 }),
    ]);
    const byTerm = Object.fromEntries(ev.map((e) => [e.term, e]));
    assert.equal(byTerm.staffContinuity.reading, TERM_READINGS.staffContinuity.more);
    assert.equal(byTerm.handover.reading, TERM_READINGS.handover.less,
      'a negative mean must read as avoiding the thing, not accepting it');
    assert.equal(byTerm.finishDelay.mean, 3);
    assert.ok(ev[0].n === 2, 'the sample size travels with every reading');
  });

  test('terms hovering around zero are dropped — they mean "this played no part"', () => {
    const mk = (delta) => ({ changed: ['equipment'], comparable: true, delta, scheduler: {}, user: {}, job: {} });
    const ev = weightEvidence([mk({ staffContinuity: 0, finishDelay: 0, handover: 0 })]);
    assert.equal(ev.length, 0,
      'an all-zero delta means the features do not explain the correction — better shown as nothing than as evidence');
  });

  test('every scoring term has a reading in both directions', () => {
    // A missing reading would silently render as a raw field name in the UI.
    const terms = ['finishDelay', 'startDelay', 'lateness', 'preferredEquipment',
      'exclusiveDemand', 'staffContinuity', 'handover', 'fragmentation'];
    terms.forEach((t) => {
      assert.ok(TERM_READINGS[t]?.more, `${t} has no "more" reading`);
      assert.ok(TERM_READINGS[t]?.less, `${t} has no "less" reading`);
    });
  });

  test('the date range reports the span the history actually covers', () => {
    const r = overrideDateRange([
      { at: '2026-08-04T09:00:00Z' }, { at: '2026-07-01T09:00:00Z' }, { at: '2026-08-20T09:00:00Z' },
    ]);
    assert.equal(r.first, '2026-07-01T09:00:00Z');
    assert.equal(r.last, '2026-08-20T09:00:00Z');
    assert.equal(overrideDateRange([]), null, 'an empty history has no span to claim');
  });

  test('the tier thresholds are exported so they can be tuned without hunting through the UI', () => {
    assert.ok(AFFINITY_TIERS.minShare > 0 && AFFINITY_TIERS.minShare <= 1);
    assert.ok(AFFINITY_TIERS.consistentN > AFFINITY_TIERS.emergingN);
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
