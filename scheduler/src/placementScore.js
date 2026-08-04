/* ============================================================================
   PLACEMENT SCORING — the tunable half of the scheduling engine.
   ----------------------------------------------------------------------------
   `runScheduler` decides two things about an unpinned job: which candidates are
   ELIGIBLE (hard constraints — process, capability tags, lockedEquipmentId,
   staffId, readyDate, equipment day locks) and, among those, which is BEST.

   The first half is not negotiable and does not live here. Hard means never:
   a score can always in principle be outvoted by a big enough number, so
   folding "this job may only run on the machine it's locked to" into a weight
   would silently turn a guarantee into a preference. Eligibility stays a
   filter in scheduler.js, upstream of everything below.

   The second half is what this file is for. It used to be a sort comparator —
   a strict lexicographic cascade (finishes soonest, then earliest start, then
   least exclusively-demanded machine, then staff continuity, then fewest
   handovers, then fewest chunks) where each signal only got a say if every
   signal above it was *exactly* tied. That structure has a hard ceiling: it
   cannot express "prefer this, but not at any cost." Preferred equipment ran
   straight into it — it had to be bolted on as a "wins outright" branch above
   the whole cascade, which is why a preferred machine booked solid for two
   weeks still beat an identical machine free tomorrow. Every future soft
   nuance would have needed its own carve-out in the same way, and those
   carve-outs are what eventually conflict with each other.

   Here every signal is a term in one weighted sum, so signals genuinely trade
   off against each other instead of one strictly overriding the next.

   WHY FEATURES AND WEIGHTS ARE KEPT SEPARATE
   ------------------------------------------
   `scoreCandidate` returns the raw measurements (`features`) alongside the
   weighted `contributions` and the final `score`. That separation is the whole
   point of the design, not bookkeeping:

     score = Σ  weights[term] × features[term]

   - `features` describe the candidate factually — "this plan spans 3 days",
     "this is the preferred machine", "2 different operators". They do not
     encode any opinion about what is good.
   - `weights` are the opinion, and the only thing that has to change to change
     the scheduler's judgement.

   Which means a disagreement between the scheduler and the user is directly
   measurable. When the user overrides a placement, both the chosen candidate's
   and the user's candidate's feature vectors are known, and their difference
   says exactly which terms were mis-weighted and in which direction — the
   gradient of a standard structured-prediction update. That is the substrate
   for learning from corrections; it exists only because features are recorded
   separately from the weights applied to them. Don't collapse them into a
   single number.

   Pure, no imports, no React/DOM — same constraint as scheduler.js, for the
   same reason: `node --test` loads it directly with no build step. scheduler.js
   importing THIS file is fine (plain ESM, no runtime deps); importing anything
   React- or DOM-shaped into either is what would cost the arrangement.
   ============================================================================ */

/* ============================================================
   WEIGHTS
   ============================================================ */

// Higher score wins. Every feature below is a raw, unsigned magnitude, so the
// SIGN LIVES HERE: a negative weight means "more of this is worse". That makes
// the whole table readable as a statement of preference — which is what a user
// will eventually be editing, and what a learning pass will eventually be
// adjusting, so it needs to be legible on its own.
//
// The magnitudes are a starting point, deliberately chosen to be interpretable
// against each other rather than tuned against real data — the units are
// "roughly, one day of delay is worth 10". Read them as ratios:
//
//   preferredEquipment (+60) vs finishDelay (-10/day)
//     → a preferred machine is worth waiting about 6 days for, and no longer.
//       Under the old cascade this was infinite: the preference won outright
//       no matter how much later the job finished. This is the one deliberate
//       behavioural change in the scoring path, and the clearest example of
//       what the old structure could not say.
//
//   lateness (-25/day) vs finishDelay (-10/day)
//     → a day past the (department) due date hurts 2.5× more than a day of
//       ordinary slowness. The old cascade had NO lateness term at all — it
//       ranked purely on finishing soonest, which is only a proxy for being on
//       time. This is a genuinely new signal, not a restatement.
//
//   staffContinuity (+30) vs handover (-15 each)
//     → keeping the person who already had the job is worth about two
//       operator changes.
//
//   exclusiveDemand (-25 each) vs finishDelay (-10/day)
//     → taking a machine that some OTHER pending job has no alternative to is
//       worth about 2.5 days of this job's own delay, because that is roughly
//       what it costs the job being displaced. This weight is the clearest
//       illustration of why the cascade needed replacing AND of why the
//       weights need checking against real work: under the cascade this signal
//       only broke EXACT ties, so it was never required to compete with
//       anything and its magnitude was meaningless. Scored at a token -5 it
//       promptly lost to a two-day saving and parked a flexible job on the
//       one specialist cell an inflexible job needed — exactly the behaviour
//       the signal was introduced to prevent. `npm run compare-scoring`
//       surfaced it on the demo workload; that is what that script is for.
//
// None of these are load-bearing constants — they are the tuning surface.
export const DEFAULT_WEIGHTS = {
  finishDelay: -10,        // per day between the job's ready date and its finish
  startDelay: -1,          // per day it sits waiting before starting (weak; mostly a tie-break, as before)
  lateness: -25,           // per day it finishes past its effective due date
  preferredEquipment: 60,  // flat bonus for landing on job.preferredEquipmentId
  exclusiveDemand: -25,    // per OTHER pending job that has no alternative to this machine
  staffContinuity: 30,     // flat bonus for keeping whoever already had this job
  handover: -15,           // per operator change within the job (0 when one person covers it)
  fragmentation: -3,       // per extra day/shift chunk the plan is broken into
};

/* ============================================================
   DATE HELPERS
   Local copies rather than imports from scheduler.js: this file
   is meant to be loadable and testable entirely on its own, and
   these are three lines. Deliberately parsed at T00:00:00 local,
   matching scheduler.js's own convention, so a date never slips
   by a day across a timezone offset.
   ============================================================ */

const MS_PER_DAY = 86400000;

export function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return 0;
  const a = new Date(fromIso + 'T00:00:00');
  const b = new Date(toIso + 'T00:00:00');
  return Math.round((b - a) / MS_PER_DAY);
}

/* ============================================================
   FEATURES
   ============================================================ */

// The raw, weight-free description of what placing `job` on `candidate` would
// actually mean. Every value is a magnitude — larger means "more of this
// thing" — never a judgement about whether that is good; the weights decide
// that. Keeping this function opinion-free is what lets weights be retuned
// (by hand, or later from the user's own corrections) without touching it.
//
// `candidate` is one entry from runScheduler's candidate list:
//   { equipId, plan, startDate, endDate }
// where `plan` is the day-by-day fit tryFit returned.
//
// `context` carries what can't be read off the candidate alone:
//   { exclusiveDemand, seedStaffId, floorDate, dueDate }
export function placementFeatures(job, candidate, context = {}) {
  const { exclusiveDemand = {}, seedStaffId = null, floorDate = null, dueDate = null } = context;
  const plan = candidate.plan || [];

  // Turnaround, not an absolute date: every candidate here is for the SAME
  // job, so its ready date is a shared constant and this orders identically to
  // comparing endDate directly — the old cascade's primary key, expressed as a
  // number a weight can act on.
  const anchor = job.readyDate || floorDate || candidate.startDate;
  const finishDelay = Math.max(0, daysBetween(anchor, candidate.endDate));

  // How long it sits idle before starting. `floorDate` is the earliest the
  // scheduler was actually allowed to place it (the later of today and the
  // ready date), so this measures avoidable waiting, not the calendar.
  const startDelay = Math.max(0, daysBetween(floorDate || anchor, candidate.startDate));

  // Days past the date this department is really working to. Zero when it
  // lands on time — a job that isn't late shouldn't be penalised at all, so
  // this is one-sided rather than a signed distance. Finishing EARLY is
  // already rewarded through finishDelay; paying for it twice here would
  // double-count and quietly overpower everything else.
  const lateness = dueDate ? Math.max(0, daysBetween(dueDate, candidate.endDate)) : 0;

  const staffIds = new Set(plan.map((d) => d.staffId).filter(Boolean));

  return {
    finishDelay,
    startDelay,
    lateness,
    // 1/0 rather than a boolean: everything here has to be multipliable by a
    // weight, and a learning pass averages over these vectors.
    preferredEquipment: job.preferredEquipmentId && candidate.equipId === job.preferredEquipmentId ? 1 : 0,
    exclusiveDemand: exclusiveDemand[candidate.equipId] || 0,
    staffContinuity: seedStaffId && staffIds.has(seedStaffId) ? 1 : 0,
    // Counted as CHANGES, not people: one person covering the whole job is 0,
    // which is the ideal case and should cost nothing. Same for fragmentation
    // below — a single unbroken chunk is 0. Ordering is identical to counting
    // the raw totals, but the zero point now means "nothing wrong here",
    // which matters once these numbers are shown to a user or learned from.
    handover: Math.max(0, staffIds.size - 1),
    fragmentation: Math.max(0, plan.length - 1),
  };
}

/* ============================================================
   SCORING
   ============================================================ */

// Scores one candidate. Returns the features, the per-term weighted
// contributions, and their sum — not just the sum, so a placement can be
// explained ("this machine won on continuity despite finishing a day later")
// and, later, learned from.
export function scoreCandidate(job, candidate, context = {}, weights = DEFAULT_WEIGHTS) {
  const features = placementFeatures(job, candidate, context);
  const contributions = {};
  let score = 0;
  for (const term of Object.keys(features)) {
    const w = weights[term] ?? 0;
    const c = w * features[term];
    contributions[term] = c;
    score += c;
  }
  return { score, features, contributions };
}

// Ranks a candidate list, best first. Returns scored copies rather than
// mutating the inputs, so a caller can keep the whole ranking (for a trace, or
// to compare against a user's later override) and not just the winner.
//
// The tie-break is deliberate and not cosmetic: equal scores are broken by
// earliest finish, then earliest start, then equipment id. Without that last,
// arbitrary-but-fixed key, two genuinely identical candidates would be ordered
// by whatever order the equipment list happened to be in — the exact
// list-order dependence the staffLoad tie-break was introduced to kill on the
// staffing side. Ties must resolve the same way every run or a recompute can
// reshuffle the board for no reason the user can see.
export function rankCandidates(job, candidates, context = {}, weights = DEFAULT_WEIGHTS) {
  return candidates
    .map((c) => ({ ...c, ...scoreCandidate(job, c, context, weights) }))
    .sort((a, b) => {
      if (Math.abs(b.score - a.score) > 0.0001) return b.score - a.score;
      if (a.endDate !== b.endDate) return a.endDate < b.endDate ? -1 : 1;
      if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
      return a.equipId < b.equipId ? -1 : a.equipId > b.equipId ? 1 : 0;
    });
}

/* ============================================================
   LEARNING SUBSTRATE (not wired up yet)
   ============================================================ */

// The difference between what the user chose and what the scheduler chose,
// per term. This is the quantity a weight update is computed from: a term with
// a positive delta is one the user's pick had MORE of than the scheduler's, so
// if the user is right, that term's weight should move up (and vice versa).
//
// Exposed and tested now, deliberately ahead of anything consuming it, because
// it's the reason features are recorded separately from weights at all — and
// because getting the direction of this subtraction wrong is exactly the kind
// of thing that silently trains a model backwards.
export function featureDelta(chosenByUser, chosenByScheduler) {
  const delta = {};
  const terms = new Set([...Object.keys(chosenByUser || {}), ...Object.keys(chosenByScheduler || {})]);
  terms.forEach((t) => { delta[t] = (chosenByUser?.[t] ?? 0) - (chosenByScheduler?.[t] ?? 0); });
  return delta;
}
