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
