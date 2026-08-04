/* ============================================================================
   OVERRIDE CAPTURE — recording where the user disagreed with the scheduler.
   ----------------------------------------------------------------------------
   Every time the user drags a job somewhere else, pins it from the job modal,
   or locks it to a machine, they are correcting the scheduler. Today that
   correction is applied and then forgotten: the job ends up pinned and nothing
   remembers that the automatic choice had been different, or why.

   This module turns each of those corrections into a durable record pairing
   WHAT THE SCHEDULER PICKED with WHAT THE USER PICKED, both described by the
   same weight-free feature vector (see placementScore.js). That pairing is the
   entire point — `featureDelta(user, scheduler)` over a pile of these says
   which terms are systematically mis-weighted and in which direction.

   Scope is deliberately narrow: this only RECORDS. Nothing here feeds back
   into placement, and nothing should be added that does until the captured
   data has actually been looked at. The gap between "a pattern was detected"
   and "the scheduler should change" is where this kind of system goes wrong.

   Pure — no React, no storage, no DOM. The caller owns persistence.
   ============================================================================ */

import { featureDelta } from './placementScore.js';

// Hard cap on the stored history. In shared mode this list lives in
// scheduler-data.json on the host PC and is read by everyone on the network,
// so it must not grow without bound. Oldest records are dropped first: a
// correction from a year ago describes a workload and a roster that no longer
// exist, so it is not evidence about how the department runs today.
export const MAX_OVERRIDES = 500;

// How the user expressed the correction. Kept because they don't carry equal
// weight as evidence: a drag is a decision about ONE job on ONE day, while a
// lock is a standing statement about where that work belongs. A learning pass
// should be free to trust them differently.
export const OVERRIDE_SOURCES = ['drag', 'modal-pin', 'lock'];

/* ============================================================
   BUILDING A RECORD
   ============================================================ */

// `traceEntry` is the record runScheduler emitted for this job on the run
// that placed it — CRUCIALLY the run BEFORE the override, while the job was
// still being auto-placed. Once the user pins it the job goes down the pinned
// path and stops generating candidates at all, so the caller has to hold onto
// the previous trace rather than re-deriving one afterwards.
//
// Returns null when there is nothing to learn. That is the common case and is
// not a failure:
//   - no trace entry (job was pinned already, or newly created)
//   - the user picked exactly what the scheduler had picked (they were
//     confirming the placement, not correcting it)
export function buildOverrideRecord({ job, traceEntry, userChoice, source, at, id }) {
  if (!traceEntry || !traceEntry.chosen || !userChoice?.equipmentId) return null;

  const schedulerPick = traceEntry.chosen;
  const sameEquip = schedulerPick.equipId === userChoice.equipmentId;
  const sameStart = schedulerPick.startDate === userChoice.startDate;
  if (sameEquip && sameStart) return null; // agreement — nothing to learn

  // WHICH dimension the user actually changed. A move to another machine and a
  // move to another day are different disagreements — one is about equipment
  // choice, the other about timing — and lumping them together would blur two
  // unrelated signals into one meaningless average.
  const changed = [];
  if (!sameEquip) changed.push('equipment');
  if (!sameStart) changed.push('startDate');

  // The user's machine as the scheduler measured it at the time. Usually
  // present: the user normally moves a job somewhere that was feasible and
  // simply wasn't chosen. It's absent when they moved it somewhere the
  // scheduler found no fit for at all (a deliberate overbooking, say) — that
  // is still worth recording, but it yields no comparable feature vector, so
  // `delta` stays null rather than being faked from a partial one.
  const userCandidate = traceEntry.candidates.find((c) => c.equipId === userChoice.equipmentId) || null;
  const schedulerCandidate = traceEntry.candidates.find((c) => c.equipId === schedulerPick.equipId) || null;

  // A candidate describes ONE placement — the earliest slot that machine could
  // offer — because that is all runScheduler ever evaluates per machine. So if
  // the user put the job on a DIFFERENT day than the candidate's own start,
  // the recorded features describe a placement they did not choose: right
  // machine, wrong day. The honest response is to refuse the delta rather than
  // publish one computed from the wrong row, because a wrong delta doesn't
  // announce itself — it just quietly drags the learned weights sideways.
  //
  // The record is still kept in full. A timing correction is real evidence,
  // it simply isn't evidence of the same KIND: `changed` and the two dates
  // carry it, and reading it needs a different method than differencing
  // feature vectors. Don't paper over that by interpolating a vector here.
  const atCandidateStart = !!userCandidate && userCandidate.startDate === userChoice.startDate;
  const comparable = !!userCandidate && !!schedulerCandidate && atCandidateStart;

  return {
    id,
    at,
    source,
    jobId: job.id,
    // Denormalised so a record still reads after the job is deleted or
    // renamed. This history is about the DECISION, not about a live job.
    jobName: job.name,
    // WHAT KIND OF WORK this was. Without these, the history can only support
    // ONE kind of learning — tuning the global weights, which apply equally to
    // every job. These are what make the other kind possible: "jobs from
    // template X keep ending up on machine Y", which is a different and often
    // more actionable finding, because its output is a concrete value for an
    // existing field (`template.preferredEquipmentId`) rather than a learned
    // number nobody can sanity-check.
    //
    // They MUST be captured at correction time. The feature vectors are a
    // snapshot of a capacity state that is gone, and a job's template or
    // process can be edited afterwards, so none of this can be backfilled onto
    // an old record with any confidence about what the job looked like then.
    job: {
      templateId: job.templateId || null,
      process: job.process || null,
      procedureId: job.procedureId || null,
      tags: job.tags || [],
      // The job's own soft preference AT THE TIME, which is what separates
      // "the user is establishing a new preference" from "the user is
      // enforcing one the scheduler failed to honour". Those look identical
      // in the equipment ids alone and mean opposite things: the first is a
      // suggestion to record a preference, the second is evidence that
      // preferences are being outvoted too easily (a weights problem).
      preferredEquipmentId: job.preferredEquipmentId || null,
      // Note for `source: 'lock'` this is the lock as just saved, since the
      // record is built from the job being written. For a drag it's whatever
      // lock the job already carried.
      lockedEquipmentId: job.lockedEquipmentId || null,
    },
    changed,
    scheduler: {
      equipmentId: schedulerPick.equipId,
      startDate: schedulerPick.startDate,
      endDate: schedulerPick.endDate,
      features: schedulerCandidate?.features || null,
      score: schedulerCandidate?.score ?? null,
    },
    user: {
      equipmentId: userChoice.equipmentId,
      startDate: userChoice.startDate || null,
      // null when the user's machine wasn't among the feasible candidates.
      // When set, it describes that machine at ITS earliest slot — which is
      // the day the user chose only when `atCandidateStart` is true.
      features: userCandidate?.features || null,
      score: userCandidate?.score ?? null,
      consideredFeasible: !!userCandidate,
      atCandidateStart,
    },
    // Whether the two feature vectors describe genuinely comparable
    // placements. Stored explicitly so a consumer never has to re-derive the
    // conditions under which the delta below is trustworthy.
    comparable,
    // Precomputed rather than derived on read: the feature vectors are a
    // snapshot of a capacity state that no longer exists, so this subtraction
    // can never be redone later from live data. Direction is
    // user-minus-scheduler, i.e. positive = "the user's pick had more of this".
    delta: comparable ? featureDelta(userCandidate.features, schedulerCandidate.features) : null,
  };
}

// Appends within the cap. Returns a new array — never mutates the input, so a
// caller holding React state can treat it as immutable.
export function appendOverride(list, record) {
  if (!record) return list;
  const next = [...list, record];
  return next.length > MAX_OVERRIDES ? next.slice(next.length - MAX_OVERRIDES) : next;
}

/* ============================================================
   READING THE PILE (step 2's substrate; no consumer yet)
   ============================================================ */

// Averages the per-term deltas across every record that has one. A term whose
// mean is consistently positive is one the user's picks keep having MORE of
// than the scheduler's — evidence its weight is too low (and vice versa).
//
// Deliberately reports `n` alongside, because the mean is meaningless without
// it: three corrections is an anecdote. Nothing here decides what counts as
// enough — that judgement belongs to whoever acts on it, not to the summary.
export function summariseOverrides(list) {
  const withDelta = (list || []).filter((r) => r.delta);
  const totals = {};
  withDelta.forEach((r) => {
    Object.entries(r.delta).forEach(([term, v]) => {
      totals[term] = (totals[term] || 0) + v;
    });
  });
  const meanDelta = {};
  Object.entries(totals).forEach(([term, sum]) => { meanDelta[term] = sum / (withDelta.length || 1); });

  const bySource = {};
  const byChange = {};
  (list || []).forEach((r) => {
    bySource[r.source] = (bySource[r.source] || 0) + 1;
    (r.changed || []).forEach((c) => { byChange[c] = (byChange[c] || 0) + 1; });
  });

  // Why the rest couldn't contribute — worth reporting rather than leaving as
  // an unexplained gap between `n` and `nComparable`. If nearly every
  // correction lands in `movedToUnevaluatedDay`, the useful conclusion is that
  // the disagreement is mostly about TIMING, which differencing feature
  // vectors will never explain no matter how many are collected.
  const notComparable = { infeasiblePick: 0, movedToUnevaluatedDay: 0 };
  (list || []).forEach((r) => {
    if (r.comparable) return;
    if (!r.user?.consideredFeasible) notComparable.infeasiblePick += 1;
    else if (!r.user?.atCandidateStart) notComparable.movedToUnevaluatedDay += 1;
  });

  return {
    n: (list || []).length,
    nComparable: withDelta.length, // only these contribute to meanDelta
    notComparable,
    meanDelta,
    bySource,
    byChange,
  };
}

// Which machine the user keeps moving a PARTICULAR KIND of work onto.
//
// This is the second, quite different kind of learning the history supports,
// and in practice the more useful one to reach first. Weight tuning produces
// one global number per term and asks to be trusted; this produces a concrete,
// checkable claim — "7 of the 9 times you moved a Bracket Weld job, it went to
// Robot 2" — whose output is a value for a field the scheduler ALREADY honours
// (`template.preferredEquipmentId`, see the preferred-equipment section in
// CLAUDE.md). Acting on it is just filling in something you'd otherwise type by
// hand, which is a far lower bar for trust than accepting a learned weight.
//
// `key` is one of the fields captured in `record.job`: 'templateId',
// 'process', 'procedureId', or 'tags' (an array, so a job counts once under
// each of its tags).
//
// Only corrections that actually CHANGED EQUIPMENT are counted. A timing-only
// move says nothing about which machine the work belongs on, and including it
// would dilute every share toward meaninglessness.
export function attributeAffinity(list, key) {
  const groups = {};
  (list || []).forEach((r, idx) => {
    if (!(r.changed || []).includes('equipment')) return;
    const raw = r.job?.[key];
    if (raw === null || raw === undefined || raw === '') return;
    const values = Array.isArray(raw) ? raw : [raw];
    values.forEach((value) => {
      const g = groups[value] || (groups[value] = {
        n: 0, movedTo: {}, movedFrom: {}, existingPreferences: {}, recordIds: new Set(),
      });
      // Which corrections built this group. Needed because the same
      // corrections show up under several attributes at once — a template has
      // exactly one process, so every template finding reproduces itself as a
      // process finding, and one pattern would read as two or three. See
      // dedupeFindings.
      g.recordIds.add(r.id ?? idx);
      g.n += 1;
      const to = r.user?.equipmentId;
      const from = r.scheduler?.equipmentId;
      if (to) g.movedTo[to] = (g.movedTo[to] || 0) + 1;
      if (from) g.movedFrom[from] = (g.movedFrom[from] || 0) + 1;
      // What this kind of work already claimed to prefer, if anything.
      const pref = r.job?.preferredEquipmentId;
      if (pref) g.existingPreferences[pref] = (g.existingPreferences[pref] || 0) + 1;
    });
  });

  // `share` is over equipment-changing corrections IN THIS GROUP — not over
  // all jobs of that kind, which isn't knowable from the history alone. A
  // consumer wanting "7 of 9 Bracket Weld jobs" has to bring its own
  // denominator; conflating the two would overstate every finding.
  Object.values(groups).forEach((g) => {
    const ranked = Object.entries(g.movedTo).sort((a, b) => b[1] - a[1]);
    g.top = ranked.length
      ? { equipmentId: ranked[0][0], count: ranked[0][1], share: ranked[0][1] / g.n }
      : null;
  });
  return groups;
}

// The machines the user keeps moving work AWAY from and TOWARD. Blunter than
// the feature deltas and, for that reason, often the first thing that will
// actually read as true — "you keep taking things off Cell B" is a sentence a
// person can immediately agree or disagree with, which is exactly what's
// needed before trusting any of this enough to act on it.
export function equipmentFlow(list) {
  const flow = {};
  const bump = (id, key) => {
    if (!id) return;
    flow[id] = flow[id] || { movedFrom: 0, movedTo: 0 };
    flow[id][key] += 1;
  };
  (list || []).forEach((r) => {
    if (!(r.changed || []).includes('equipment')) return;
    bump(r.scheduler?.equipmentId, 'movedFrom');
    bump(r.user?.equipmentId, 'movedTo');
  });
  return flow;
}

/* ============================================================
   TURNING THE PILE INTO SOMETHING A PERSON CAN JUDGE
   ============================================================ */

// Display thresholds — NOT statistics. There is no significance test here and
// pretending otherwise would be worse than saying nothing: with a handful of
// corrections from one person over a few weeks, any p-value would be theatre.
// These exist so the UI can avoid announcing a "pattern" built on two clicks,
// and so findings sort sensibly. Tune them freely; nothing depends on the
// exact numbers.
export const AFFINITY_TIERS = {
  minShare: 0.6,      // below this there's no dominant machine — not a finding at all
  emergingN: 3,       // worth showing, clearly labelled as thin
  consistentN: 6,     // worth taking seriously
  consistentShare: 0.75,
};

// Classifies one `attributeAffinity` group into something presentable.
// Returns null when the group says nothing — no dominant machine, or the work
// is being spread around rather than consistently redirected.
//
// `kind` is the important half, and the two values mean OPPOSITE things:
//
//   'set-preference'     nothing was ever claimed for this kind of work, and it
//                        keeps being moved to one machine → a suggestion to
//                        record `preferredEquipmentId`.
//
//   'preference-ignored' this work ALREADY prefers that exact machine and the
//                        user still has to move it there by hand → the
//                        preference is being outvoted, which is a WEIGHTS
//                        problem. Recording the preference again would fix
//                        nothing, because it is already recorded.
//
// Identical counts and shares produce these two different conclusions, which
// is precisely why `record.job.preferredEquipmentId` is captured.
export function classifyAffinity(group) {
  if (!group || !group.top || group.n < 1) return null;
  const { top, n } = group;
  if (top.share < AFFINITY_TIERS.minShare) return null;
  const tier = n >= AFFINITY_TIERS.consistentN && top.share >= AFFINITY_TIERS.consistentShare
    ? 'consistent'
    : n >= AFFINITY_TIERS.emergingN ? 'emerging' : 'too-few';
  const alreadyPrefers = (group.existingPreferences || {})[top.equipmentId] || 0;
  return {
    kind: alreadyPrefers > 0 ? 'preference-ignored' : 'set-preference',
    tier,
    alreadyPrefers,
    equipmentId: top.equipmentId,
    count: top.count,
    n,
    share: top.share,
  };
}

// attributeAffinity + classifyAffinity, sorted strongest first, with the
// nothing-to-say groups dropped. One call per attribute for a view to render.
export function affinityFindings(list, key) {
  const groups = attributeAffinity(list, key);
  return Object.entries(groups)
    .map(([value, group]) => {
      const c = classifyAffinity(group);
      return c ? { key, value, recordIds: group.recordIds || new Set(), ...c } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (b.n - a.n) || (b.share - a.share));
}

// Drops findings that are just a re-statement of one already shown.
//
// The same corrections appear under several attributes at once: a template has
// exactly one process, so a template-level finding reproduces itself as a
// process-level finding built from the identical records, and often as a
// capability-tag one too. Left alone, one real pattern reads as three
// independent ones and looks far more corroborated than it is.
//
// A finding is dropped only when its records are a SUBSET of an already-kept
// finding's AND it points at the same machine — i.e. it genuinely adds
// nothing. A broader group is kept: if three different templates all send work
// to the same cell, the process-level finding spans records no single template
// finding covers, and it is the MORE informative statement, not a duplicate.
//
// `order` is most-specific-first, because the specific finding is the more
// actionable one — a template has a `preferredEquipmentId` field to set; a
// process does not.
export function dedupeFindings(findingsByKey, order = ['templateId', 'procedureId', 'process', 'tags']) {
  const kept = [];
  const out = {};
  order.forEach((key) => {
    out[key] = (findingsByKey[key] || []).filter((f) => {
      const ids = f.recordIds || new Set();
      const redundant = kept.some((k) => k.equipmentId === f.equipmentId
        && [...ids].every((id) => k.recordIds.has(id)));
      if (!redundant) kept.push(f);
      return !redundant;
    });
  });
  return out;
}

// Plain-language readings for the mean feature deltas. A number like
// "+2.4 finishDelay" is not something anyone can agree or disagree with; "you
// accept a later finish" is. Kept here rather than in the view so the script
// and the UI say the same thing, and so the wording is testable.
//
// `more`/`less` describe what a POSITIVE / NEGATIVE mean delta means, given
// the delta is user-minus-scheduler.
export const TERM_READINGS = {
  finishDelay: { more: 'accept a later finish than the scheduler picks', less: 'want work finished sooner than the scheduler picks' },
  startDelay: { more: 'accept a later start', less: 'want work started sooner' },
  lateness: { more: 'tolerate running past the due date', less: 'protect the due date more than the scheduler does' },
  preferredEquipment: { more: 'move work ONTO its preferred machine', less: 'move work OFF its preferred machine' },
  exclusiveDemand: { more: 'accept taking a machine another job depends on', less: 'avoid taking a machine another job depends on' },
  staffContinuity: { more: 'keep the same operator on a job', less: 'change the operator more than the scheduler does' },
  handover: { more: 'accept more operator changes', less: 'avoid operator changes' },
  fragmentation: { more: 'accept work broken into more chunks', less: 'prefer work in fewer chunks' },
};

// The mean deltas that are actually worth showing, biggest first. `minMean`
// filters out terms hovering around zero, which are the majority and mean
// "this played no part" rather than anything worth reading.
export function weightEvidence(list, minMean = 0.05) {
  const { meanDelta, nComparable } = summariseOverrides(list);
  return Object.entries(meanDelta)
    .filter(([, v]) => Math.abs(v) >= minMean)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([term, mean]) => ({
      term,
      mean,
      n: nComparable,
      reading: (TERM_READINGS[term] || {})[mean > 0 ? 'more' : 'less'] || null,
    }));
}

// Oldest and newest correction, so a view can say "over the last N weeks"
// rather than implying the history is timeless.
export function overrideDateRange(list) {
  const times = (list || []).map((r) => r.at).filter(Boolean).sort();
  return times.length ? { first: times[0], last: times[times.length - 1] } : null;
}
