/* ============================================================================
   SCHEDULING ENGINE + the roster/date model it runs on.
   ----------------------------------------------------------------------------
   Extracted from WeldingScheduler.jsx so it can be unit-tested directly: this
   file is plain JavaScript with no JSX, so `node --test` loads it with no
   build step and no test framework. Its ONE import is ./placementScore.js,
   which is plain ESM under the same rule — a React or DOM import into either
   file is what would cost the arrangement, not a pure sibling module.

   It is pure — no React, no storage, no DOM. `runScheduler(jobs, equipment,
   staff, days, earliestIdx)` takes plain data and returns plain data, which is
   what makes the invariants in scheduler/CLAUDE.md testable at all.

   The rules commented through here each fixed a real scheduling bug. The tests
   in test/scheduler.test.js pin them down; don't regress either.
   ============================================================================ */

import { rankCandidates, DEFAULT_WEIGHTS } from './placementScore.js';

/* ============================================================
   SHIFTS & ROSTER CONSTANTS
   ============================================================ */

export const SHIFT_DEFS = {
  day: { id: 'day', label: 'Day Shift', defaultHours: 8 },
  afternoon: { id: 'afternoon', label: 'Afternoon Shift', defaultHours: 8 },
};
export const SHIFT_ORDER = ['day', 'afternoon'];
// A second (or later) person joining a shift block already in progress isn't
// worth bringing in for a sliver — see tryFit's fill loop (#57). Below this,
// it's not a real handover, just staff-shuffling to use up capacity that
// could just as well sit idle for the rest of the day.
export const MIN_HANDOVER_HOURS = 4;
export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // indexed by Date.getDay()
export const DAY_COLS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

// `production: false` means rostered on but not available for scheduled
// production work — training, covering the office, on the tools elsewhere.
// Distinct from `working: false` (not rostered at all) so the roster still
// shows the person is in, and distinct from leave, which is a date range.
export function defaultWeeklyRoster(shift = 'day') {
  return {
    mon: { working: true, production: true, shift, hours: 8 },
    tue: { working: true, production: true, shift, hours: 8 },
    wed: { working: true, production: true, shift, hours: 8 },
    thu: { working: true, production: true, shift, hours: 8 },
    fri: { working: true, production: true, shift, hours: 8 },
    sat: { working: false, production: true, shift: 'day', hours: 0 },
    sun: { working: false, production: true, shift: 'day', hours: 0 },
  };
}

// Absence kinds. All of them make someone unavailable — the distinction is for
// the record, so "I'm on a course" doesn't have to be booked as annual leave.
export const ABSENCE_KINDS = [
  ['leave', 'Leave'],
  ['sick', 'Sick'],
  ['training', 'Training'],
  ['other', 'Other duties'],
];
export const absenceKindLabel = (k) => (ABSENCE_KINDS.find(([v]) => v === k) || ABSENCE_KINDS[0])[1];

export function normalizeStaff(s) {
  const roster = s.weeklyRoster || defaultWeeklyRoster();
  return {
    ...s,
    // `production` post-dates the roster, so days saved before it exist
    // without the flag — absent means available, or every existing roster
    // would read as non-production.
    weeklyRoster: Object.fromEntries(
      Object.entries(roster).map(([k, d]) => [k, { production: true, ...d }])
    ),
    leavePeriods: (s.leavePeriods || []).map((p) => ({ kind: 'leave', ...p })),
  };
}

/* ============================================================
   DATE HELPERS
   ============================================================ */

export function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
export function generateCalendarDays(startDateStr, numCalendarDays) {
  const days = [];
  let d = new Date(startDateStr + 'T00:00:00');
  for (let i = 0; i < numCalendarDays; i++) {
    days.push(isoDate(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}
export function isWeekendDate(dateStr) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  return dow === 0 || dow === 6;
}
export function isOnLeave(staffMember, dateStr) {
  return (staffMember.leavePeriods || []).some((p) => dateStr >= p.startDate && dateStr <= p.endDate);
}
export function getStaffDayInfo(staffMember, dateStr) {
  if (isOnLeave(staffMember, dateStr)) return { working: false, shift: null, hours: 0 };
  const key = DAY_KEYS[new Date(dateStr + 'T00:00:00').getDay()];
  const pattern = (staffMember.weeklyRoster || {})[key];
  if (!pattern || !pattern.working) return { working: false, shift: null, hours: 0 };
  // Rostered on but not available for production — the scheduler must treat
  // this exactly like a day off; the difference is only what the roster shows.
  if (pattern.production === false) return { working: false, shift: null, hours: 0 };
  return { working: true, shift: pattern.shift || 'day', hours: Number(pattern.hours) || 0 };
}
export function fmtDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return {
    dow: d.toLocaleDateString('en-US', { weekday: 'short' }),
    dom: d.getDate(),
  };
}
export function fmtDate(dateStr) {
  if (!dateStr) return '—'; // e.g. a job with no ready date set yet (#59)
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
export function fmtDateRange(startIso, endIso) {
  if (!startIso || !endIso) return '';
  const year = new Date(endIso + 'T00:00:00').getFullYear();
  return `${fmtDate(startIso)} – ${fmtDate(endIso)}, ${year}`;
}

/* ============================================================
   SCHEDULING ENGINE
   Capacity is now tracked per equipment/day/shift, and per staff
   member/day (staff work at most one shift a day, per their
   roster). A single job can be fulfilled by different staff on
   different days, or even by two different people on the same
   day if it runs across both a day-shift and afternoon-shift
   block on the same equipment.
   ============================================================ */

export function buildCapacityMaps(equipment, staff, days) {
  // staffLoad[staffId] = hours this person has picked up so far this run. Used
  // purely as a tie-break when two people are equally able to take a stint —
  // without it the comparison fell through to the order of the staff list, so
  // whoever was first in the list collected the work every time.
  const staffLoad = {};
  staff.forEach((s) => { staffLoad[s.id] = 0; });
  // equipDayLock[equipId][date] = the id of the job currently "set up" on that
  // equipment that day (or 'closed' for a marked-unavailable day), else null.
  // A day is locked once a job has claimed it AND still has hours left to go
  // after that day — i.e. every day strictly before a job's last working day.
  // Equipment is a physical cell/robot — once a job claims it, nothing else can
  // use it, even an idle gap day within that job's own span, because tearing
  // down and re-fixturing a different job just to grab a few spare hours isn't
  // realistic. A job's *final* day (where its hours run out) is the exception:
  // whatever's left over that specific day, after the job is done, is fair
  // game for the next job to use the same day — see equipShiftUsed.
  const equipDayLock = {};
  const equipShiftUsed = {}; // equipShiftUsed[equipId][date][shift] = hours already spoken for
  equipment.forEach((e) => {
    equipDayLock[e.id] = {};
    equipShiftUsed[e.id] = {};
    days.forEach((day) => {
      equipDayLock[e.id][day] = (e.unavailableDates || []).includes(day) ? 'closed' : null;
      equipShiftUsed[e.id][day] = { day: 0, afternoon: 0 };
    });
  });
  const staffDayRemain = {}; // staffDayRemain[staffId][date] = hours available that day
  const staffDayShift = {}; // staffDayShift[staffId][date] = 'day' | 'afternoon' | null
  // staffDayHours[staffId][date] = their full rostered hours that day — unlike
  // staffDayRemain (which consume() decrements as the run places jobs), this
  // stays constant, so tryFit can tell "how long could this shift actually
  // run today" from "how much of it is left" (see shiftCapacity below).
  const staffDayHours = {};
  staff.forEach((s) => {
    staffDayRemain[s.id] = {};
    staffDayShift[s.id] = {};
    staffDayHours[s.id] = {};
    days.forEach((day) => {
      const info = getStaffDayInfo(s, day);
      staffDayRemain[s.id][day] = info.hours;
      staffDayShift[s.id][day] = info.shift;
      staffDayHours[s.id][day] = info.hours;
    });
  });
  return { equipDayLock, equipShiftUsed, staffDayRemain, staffDayShift, staffDayHours, staffLoad };
}

// Who actually did most of the work on an existing assignment. The scheduler
// re-derives every assignment from scratch on every recompute, so without this
// the people on a job were free to change for no reason the user could see —
// most obviously when dragging a job onto other equipment, which reorders
// placement and reshuffled names across the whole board. Feeding the previous
// primary person back in as `seedStaffId` keeps whoever had the job on it
// wherever they're still available.
export function primaryStaffOf(assignment) {
  const hoursByStaff = new Map();
  (assignment?.days || []).forEach((d) => {
    if (!d.staffId) return;
    hoursByStaff.set(d.staffId, (hoursByStaff.get(d.staffId) || 0) + (d.hours || 0));
  });
  let best = null;
  let bestHours = 0;
  hoursByStaff.forEach((h, sid) => { if (h > bestHours) { best = sid; bestHours = h; } });
  return best;
}

// Who is allowed to run this job. Normally that's everyone signed off on the
// process, but a job can carry a manual assignment (`job.staffId`) — the user
// has said who does this one. That is a hard restriction, not a hint: the
// scheduler waits for that person rather than quietly handing the work to
// someone else. Clearing it puts the job back to automatic.
export function eligibleStaffIds(job, staff) {
  const qualified = staff.filter((s) => s.processes.includes(job.process));
  if (job.staffId) return qualified.some((s) => s.id === job.staffId) ? [job.staffId] : [];
  return qualified.map((s) => s.id);
}

// Equipment a job could actually run on: every process+tag compatible
// machine, narrowed to exactly one if the job carries `job.lockedEquipmentId`
// — the equipment equivalent of `job.staffId`: a hard restriction, not a
// hint. Unlike `preferredEquipmentId` (a soft nudge only ever consulted among
// machines that already fit), a lock changes which machines are even
// considered in the first place — if the locked machine isn't process/tag
// compatible, `eligibleEquipment` returns nothing for it at all, same as
// naming someone via `job.staffId` who isn't signed off on the process.
export function eligibleEquipment(job, equipment) {
  const compat = equipment.filter((e) => e.processes.includes(job.process) && tagOk(job, e));
  if (job.lockedEquipmentId) return compat.filter((e) => e.id === job.lockedEquipmentId);
  return compat;
}

// `dueDate` is when the job is due to the client (or an end-of-month target)
// — it's not necessarily when THIS department has to be finished with it.
// `departmentDueDate` (optional) is the earlier internal deadline for jobs
// that still have scope after this department: the client due date less
// however long that downstream work needs. Scheduling order cares about
// whichever is actually binding on us, so every date comparison the engine
// makes uses this instead of reading `job.dueDate` directly.
export function effectiveDueDate(job) {
  return job.departmentDueDate || job.dueDate;
}

// `allowParallel` is set for a job carrying the "parallel processing" tag
// (#30) — the operator can nominally mind a second job while this one's
// automation does the work, so it doesn't compete for the shared
// staffDayRemain pool the way ordinary jobs do. It still needs someone
// qualified rostered onto the shift (and the equipment's own shift capacity
// still applies unchanged) — only the "does this person have hours left
// today" check is bypassed, and consume() (below) correspondingly doesn't
// deduct this job's hours from anyone's remaining capacity, so a second job
// can still draw on the same person at the same time.
export function tryFit(days, startIdx, hoursNeeded, equipId, compatibleStaffIds, caps, seedStaffId = null, allowParallel = false) {
  const { equipDayLock, equipShiftUsed, staffDayRemain, staffDayShift, staffDayHours, staffLoad } = caps;
  // A job with no positive hours has nothing to place; return null so the
  // caller falls into its conflict/placeholder path instead of accepting an
  // empty (but truthy) plan that would render as a blank block.
  if (!(hoursNeeded > 0.001)) return null;
  if (!compatibleStaffIds.length) return null;
  let remaining = hoursNeeded;
  let idx = startIdx;
  const plan = [];
  // Once someone starts this job, keep them on it where possible — seeded from
  // whoever had it before this recompute (see primaryStaffOf).
  let preferredStaffId = seedStaffId && compatibleStaffIds.includes(seedStaffId) ? seedStaffId : null;
  while (remaining > 0.001) {
    if (idx >= days.length) return null;
    const date = days[idx];
    // Someone else's unfinished job already has this whole day claimed (or
    // it's marked unavailable) — this job can't slot into the gap, full stop.
    if (equipDayLock[equipId]?.[date]) return null;
    for (const shift of SHIFT_ORDER) {
      if (remaining <= 0.001) break;
      const already = equipShiftUsed[equipId]?.[date]?.[shift] ?? 0;

      // Everyone qualified, rostered onto this shift today — with hours to
      // give, unless this job doesn't need them exclusively (allowParallel).
      const pool = compatibleStaffIds.filter(
        (sid) => staffDayShift[sid]?.[date] === shift && (allowParallel || (staffDayRemain[sid]?.[date] ?? 0) > 0.001)
      );
      if (!pool.length) continue;

      // "Ordinary" for this shift/day isn't always the flat SHIFT_DEFS
      // default (8h) — a shortened day (Saturday, 6h at this department) is
      // exactly as "ordinary" for everyone rostered onto it as an 8h weekday
      // is for everyone rostered onto THAT (#59). Using a flat 8h here let
      // two people who were each genuinely only rostered 6 hours combine for
      // up to 8 between them on a Saturday — the same physically-impossible
      // over-combination #57 fixed for weekdays, just via a different cause:
      // there it was a second person drawing on a first person's personal
      // extension; here it's the SHARED ceiling itself being wrong for the
      // day. `defaultCap` is now whichever length most of today's pool is
      // actually rostered for (a plain mode, smaller value winning a tie) —
      // on an ordinary weekday where everyone's rostered the flat 8h this
      // reproduces exactly that, and on a shortened day it correctly reads
      // as 6 instead. Anyone individually rostered longer than that still
      // gets their own genuine extension (`myExtension` below), same as ever.
      let defaultCap = SHIFT_DEFS[shift].defaultHours;
      {
        const counts = new Map();
        let bestCount = 0;
        pool.forEach((sid) => {
          const h = staffDayHours[sid]?.[date] ?? 0;
          const c = (counts.get(h) ?? 0) + 1;
          counts.set(h, c);
          if (c > bestCount || (c === bestCount && h < defaultCap)) { bestCount = c; defaultCap = h; }
        });
      }

      // A shift block is one concurrent window — everyone rostered onto it
      // starts at the same clock time, so it can only run longer than the
      // default when someone eligible is individually rostered that long
      // (#32). `personalCap(sid)` is what a candidate could offer if THEY
      // end up covering the block solo.
      //
      // The block's real capacity is two separate pools, not one (#57):
      // `sharedLeft`, up to `defaultCap`, that ANY candidate on this shift
      // can draw on (we don't model literal per-person start times finely
      // enough to say which of several same-length people is in the chair at
      // a given hour, so the combined total across ALL ordinarily-rostered
      // people is capped at one ordinary shift's length) — and
      // `extensionLeft`, hours past `defaultCap` that exist because SOME
      // candidate here is individually rostered that long. Extension hours
      // are real clock time — 2pm-6pm on a 6am-6pm production day — that
      // only someone actually rostered that late can plausibly be covering,
      // so a candidate can draw on it only up to *their own* personal
      // overtime ceiling — but that's a property of the PERSON, not of
      // placement order: an ordinarily-rostered 8h person filling the first
      // half of the shift doesn't stop a separately-rostered 12h person from
      // covering the back half themselves, same as it wouldn't if the
      // long-rostered person had gone first instead (an earlier version of
      // this tied extension access to whichever candidate the fill loop
      // happened to place first, so a longer-rostered person landing second
      // in fill order — e.g. an ordinary 8h person had a slightly higher
      // `contribution()` that day — lost access to their own overtime hours
      // entirely). What extension hours can NEVER do is get drawn on by a
      // second ordinarily-rostered (8h) person just because someone else's
      // longer roster happened to open the window up — an 8-hour shift
      // covers the *first* 8 hours of the day, not whichever hours are left
      // over once someone else's day has run.
      let sharedLeft = defaultCap - already;
      if (sharedLeft <= 0.001) continue;

      const personalCap = (sid) => Math.max(defaultCap, staffDayHours[sid]?.[date] ?? 0) - already;
      const myExtension = (sid) => Math.max(0, personalCap(sid) - defaultCap);
      const contribution = (sid) => allowParallel
        ? Math.min(personalCap(sid), remaining)
        : Math.min(staffDayRemain[sid][date], personalCap(sid), remaining);
      const bestContribution = Math.max(...pool.map(contribution));
      pool.sort((a, b) => {
        // Continuity first — but only while the person already on the job can
        // still cover as much of it today as anyone else could. Keeping them on
        // it for the sake of a half-hour leftover is what used to stretch a job
        // out over days while a colleague with a whole free shift sat idle, and
        // it read as one person hogging every job.
        const aPref = a === preferredStaffId && contribution(a) >= bestContribution - 0.001;
        const bPref = b === preferredStaffId && contribution(b) >= bestContribution - 0.001;
        if (aPref !== bPref) return aPref ? -1 : 1;
        const byContribution = contribution(b) - contribution(a);
        if (Math.abs(byContribution) > 0.001) return byContribution; // longest single stint = fewest handovers
        // A genuine tie: give it to whoever has least on so far, so the work
        // spreads instead of always landing on the first name in the list.
        const byLoad = (staffLoad[a] ?? 0) - (staffLoad[b] ?? 0);
        if (Math.abs(byLoad) > 0.001) return byLoad;
        return a < b ? -1 : a > b ? 1 : 0; // stable, list-order-independent
      });
      // Fill the shift from the top of that order. Normally one person takes
      // the whole stint; a second only joins once the first has run out of
      // hours and the block's shared pool still has room. `extensionLeft` is
      // set once, from whoever in the WHOLE pool is individually rostered
      // longest — not from whichever candidate ends up going first — and each
      // candidate can only draw down to their own `myExtension` ceiling from
      // it, however far down the fill order they land.
      let firstOnShift = null;
      let preferredStayed = false;
      let extensionLeft = Math.max(0, ...pool.map(myExtension));
      for (const sid of pool) {
        if (remaining <= 0.001) break;
        const isFirst = !firstOnShift;
        const cap = sharedLeft + Math.min(extensionLeft, myExtension(sid));
        if (cap <= 0.001) continue;
        const use = allowParallel
          ? Math.min(cap, remaining)
          : Math.min(cap, staffDayRemain[sid][date], remaining);
        if (use <= 0.001) continue;
        // A second-or-later person isn't brought in for a sliver just to use
        // up whatever's left of the shift (#57) — that's what was producing
        // pointless same-day handovers ("staff switching for the last 2
        // hours" to keep a block fully booked). Only skip them when the
        // shortfall is genuinely artificial, though: if the *person* doesn't
        // have `MIN_HANDOVER_HOURS` to give regardless (their own day is
        // naturally almost over), or the *job* doesn't need that much more
        // regardless (there's nothing bigger to offer them), a short stint
        // is the correct answer, not a workaround to route around.
        if (!isFirst && use < MIN_HANDOVER_HOURS
            && staffDayRemain[sid][date] >= MIN_HANDOVER_HOURS - 0.001
            && remaining >= MIN_HANDOVER_HOURS - 0.001) {
          continue;
        }
        plan.push({ date, shift, staffId: sid, hours: use });
        remaining -= use;
        const fromShared = Math.min(use, sharedLeft);
        sharedLeft -= fromShared;
        extensionLeft -= (use - fromShared);
        if (!firstOnShift) firstOnShift = sid;
        if (sid === preferredStaffId) preferredStayed = true;
      }
      // The person who was on it is genuinely off it now — whoever picked up
      // the bulk of this shift becomes the one to keep for continuity.
      if (!preferredStayed && firstOnShift) preferredStaffId = firstOnShift;
    }
    idx++;
  }
  return plan;
}

export function consume(plan, equipId, jobId, days, caps, allowParallel = false) {
  const { equipDayLock, equipShiftUsed, staffDayRemain, staffLoad } = caps;
  if (!plan.length) return;
  const startDate = plan[0].date;
  const finalDate = plan[plan.length - 1].date;
  // Lock every calendar day strictly before the job's last working day —
  // fully exclusive, including any idle gap day, since the job isn't done
  // until that last day. The last day itself is only "used up" for the hours
  // actually spent (below), so whatever's left over is free the same day.
  let inSpan = false;
  for (const d of days) {
    if (d === startDate) inSpan = true;
    if (inSpan && d !== finalDate) equipDayLock[equipId][d] = jobId;
    if (d === finalDate) break;
  }
  plan.forEach(({ date, shift, staffId, hours }) => {
    equipShiftUsed[equipId][date][shift] += hours;
    if (!staffId) return; // an overbooked pinned job's placeholder plan has no one on it
    // A parallel-processing job never actually claimed this person's time —
    // tryFit placed them without checking staffDayRemain, so undoing that
    // here would make their remaining hours negative for no reason, and
    // would wrongly block a second, unrelated job from also drawing on them.
    if (allowParallel) return;
    staffDayRemain[staffId][date] -= hours;
    staffLoad[staffId] = (staffLoad[staffId] ?? 0) + hours;
  });
}

// A batch (#47) is a set of otherwise-independent jobs the user wants run
// back-to-back on the SAME equipment — the department's answer to jobs that
// are really the same component/scope and shouldn't get scattered across
// whichever machine happens to be free first. `batchId` groups them;
// `batchOrder` fixes the sequence. Only unpinned, non-split, same-process
// jobs combine: anything pinned individually, split into parts, or a
// mismatched process falls back to being scheduled on its own — there's no
// single equipment/time slot left to negotiate for a group like that, so
// guessing would be worse than just not combining it.
function groupBatches(jobsIn) {
  const byBatch = new Map();
  jobsIn.forEach((j) => {
    if (!j.batchId || j.status === 'complete' || Array.isArray(j.parts) || (j.assignment && j.assignment.pinned)) return;
    if (!byBatch.has(j.batchId)) byBatch.set(j.batchId, []);
    byBatch.get(j.batchId).push(j);
  });
  const groups = new Map(); // batchId -> ordered member jobs, only for groups that actually combine
  byBatch.forEach((members, batchId) => {
    if (members.length < 2) return; // nothing to combine
    if (!members.every((m) => m.process === members[0].process)) return; // mismatched scope — don't guess
    members.sort((a, b) => (a.batchOrder ?? 0) - (b.batchOrder ?? 0));
    groups.set(batchId, members);
  });
  return groups;
}

// Distributes one combined day-by-day plan across a batch's members, in
// order, splitting a single plan entry across a member boundary when the
// hours don't land on a day/shift edge — the same operator finishing one
// member and immediately starting the next, same day. That's what actually
// makes the group run back-to-back rather than merely share equipment.
function sliceBatchPlan(plan, members) {
  const perMember = members.map(() => []);
  let mi = 0;
  let left = members[0]?.hoursTotal ?? 0;
  for (const entry of plan) {
    let entryLeft = entry.hours;
    while (entryLeft > 0.001) {
      if (mi >= members.length) break; // the plan should sum to exactly the combined total
      const take = Math.min(entryLeft, left);
      if (take > 0.001) perMember[mi].push({ ...entry, hours: take });
      entryLeft -= take;
      left -= take;
      if (left <= 0.001) { mi++; left = members[mi]?.hoursTotal ?? 0; }
    }
  }
  return perMember;
}

// A job schedules on a piece of equipment only if the equipment carries every
// capability tag the job requires (e.g. a positioner load rating). Untagged
// jobs run anywhere their process allows, exactly as before.
export function tagOk(job, equip) {
  const need = job.tags || [];
  return !need.length || need.every((t) => (equip.tags || []).includes(t));
}

// Which other job(s) are actually holding the operator a freshly-pinned,
// now-overbooked job needed (#30). Used to drive the "allow parallel
// processing?" prompt: rather than just flagging the drop as overbooked and
// leaving the user to figure out why, name what it collided with so they can
// choose which job (this one or the other) is the automated one that can
// tolerate sharing an operator.
//
// `conflictedJob` must already be through runScheduler (so its `.assignment`
// reflects the failed placement) and its `.assignment.conflict` must be
// true. Scans every other active job's actual day-by-day plan for an entry
// on one of the same dates staffed by someone who could have covered
// `conflictedJob` — i.e. whoever it was actually contending with for that
// person's time, not just "everyone qualified for this process".
export function findStaffConflictJobs(conflictedJob, jobs, staff) {
  if (!conflictedJob.assignment?.conflict) return [];
  const eligible = new Set(eligibleStaffIds(conflictedJob, staff));
  if (!eligible.size) return [];
  const dates = new Set((conflictedJob.assignment.days || []).map((d) => d.date));
  if (!dates.size) return [];
  const found = new Map(); // jobId -> job
  jobs.forEach((j) => {
    if (j.id === conflictedJob.id || j.status === 'complete') return;
    const dayLists = Array.isArray(j.parts) && j.parts.length
      ? j.parts.map((p) => p.assignment?.days || [])
      : [j.assignment?.days || []];
    const collides = dayLists.some((ds) => ds.some((d) => dates.has(d.date) && d.staffId && eligible.has(d.staffId)));
    if (collides) found.set(j.id, j);
  });
  return [...found.values()];
}

// Human-readable reason a job couldn't be auto-placed, shown on its
// "Needs scheduling" card. Checked in order of severity.
export function whyUnscheduled(job, equipment, staff, days) {
  if (!(job.hoursTotal > 0.001)) return 'no hours set on this job yet — add hours (or a template) so it can be scheduled';
  // Blank, not "ready now" (#59) — nothing here confirms the job has actually
  // arrived/materials are in, so it's excluded from placement entirely until
  // someone sets a real date, rather than silently defaulting to today.
  if (!job.readyDate) return 'no ready-for-processing date set yet — set one on the job so the scheduler knows it can start';
  const runsProcess = equipment.filter((e) => e.processes.includes(job.process));
  if (!runsProcess.length) return `no equipment runs ${job.process}`;
  const need = job.tags || [];
  if (need.length) {
    const ok = runsProcess.filter((e) => tagOk(job, e));
    if (!ok.length) {
      const missing = need.filter((t) => !runsProcess.some((e) => (e.tags || []).includes(t)));
      return missing.length
        ? `no equipment running ${job.process} has: ${missing.join(', ')}`
        : `no single ${job.process} system has all of: ${need.join(', ')}`;
    }
  }
  if (!staff.filter((s) => s.processes.includes(job.process)).length) return `no staff can run ${job.process}`;
  // A manual staff assignment narrows the job to one person, so it's the most
  // likely reason a job that would otherwise fit can't be placed — say so
  // plainly, and name the way out.
  if (job.staffId) {
    const person = staff.find((s) => s.id === job.staffId);
    if (!person) return 'the person this job was assigned to is no longer on staff — reassign it or set it back to automatic';
    if (!person.processes.includes(job.process)) return `${person.name} isn't signed off on ${job.process} — reassign this job or set it back to automatic`;
  }
  // Same reasoning, for a hard equipment lock (job.lockedEquipmentId): it
  // narrows the job to one machine, so a lock the machine can no longer
  // honour is the most likely explanation and worth naming directly.
  if (job.lockedEquipmentId) {
    const locked = equipment.find((e) => e.id === job.lockedEquipmentId);
    if (!locked) return 'the equipment this job is locked to no longer exists — unlock it or lock it to a different machine';
    if (!locked.processes.includes(job.process) || !tagOk(job, locked)) return `${locked.name} can't run this job — unlock it or lock it to a different machine`;
  }
  if (job.readyDate && job.readyDate > days[days.length - 1]) return `not ready until ${fmtDate(job.readyDate)} — beyond the schedule horizon`;
  const assignee = job.staffId ? staff.find((s) => s.id === job.staffId) : null;
  if (assignee) return `${assignee.name} has no free ${job.hoursTotal}h alongside a free machine in the horizon — reassign this job or set it back to automatic`;
  const lockedMachine = job.lockedEquipmentId ? equipment.find((e) => e.id === job.lockedEquipmentId) : null;
  if (lockedMachine) return `${lockedMachine.name} has no free ${job.hoursTotal}h in the horizon — unlock this job or lock it to a different machine`;
  return `no free equipment/staff capacity in the horizon for ${job.hoursTotal}h`;
}

// `days` now runs from some way *behind* today (so finished work stays on the
// timeline) up to the forward horizon. `earliestIdx` is the index of today —
// the floor below which nothing may be auto-placed. Pinned jobs are exempt: a
// job the user dropped on a past date is a record of what actually happened,
// and it keeps that slot.
//
// `options` is entirely optional and every field is off by default — calling
// runScheduler with five arguments, as the app does, behaves exactly as it
// always has:
//   { weights }  opt into the weighted-scoring placement path (see
//                placementScore.js). Pass DEFAULT_WEIGHTS for the stock
//                tuning, or a modified copy. Absent → the original
//                lexicographic comparator, unchanged.
//   { trace }    an array to push a per-job record of every candidate
//                considered onto — its dates, its features, and its score.
//                Pure observation: it works on BOTH paths and never affects
//                a placement, which is what lets the app record what the
//                scheduler was thinking without first opting into a
//                behaviour change. This is what a user's manual override
//                gets compared against (see src/overrides.js).
export function runScheduler(jobsIn, equipment, staff, days, earliestIdx = 0, options = {}) {
  const { weights = null, trace = null } = options;
  const order = jobsIn.map((j) => j.id);

  // Batches (#47) combine first: a qualifying group of jobs is replaced by
  // ONE pseudo-unit (combined hours, one equipment/placement decision) that
  // goes through the exact same unpinned-placement logic as any other job —
  // see the expansion back into per-member assignments at the bottom. Member
  // jobs are excluded from the ordinary per-job pass below.
  const batchGroups = groupBatches(jobsIn);
  const batchedIds = new Set();
  batchGroups.forEach((members) => members.forEach((m) => batchedIds.add(m.id)));

  // A split job (job.parts set) doesn't get scheduled as one unit — each part
  // is independently placeable (they may end up on different equipment, at
  // different times), so it's flattened into its parts here and reassembled
  // at the end. A regular job passes through unchanged.
  const splitParents = new Map(); // parentId -> original job, for reassembly
  const jobs = [];
  jobsIn.forEach((j) => {
    if (batchedIds.has(j.id)) return; // handled below, as one combined pseudo-unit per batch
    if (Array.isArray(j.parts) && j.parts.length > 0) {
      splitParents.set(j.id, j);
      j.parts.forEach((part, i) => {
        jobs.push({
          id: part.id,
          _parentId: j.id,
          _partIndex: i,
          // Each part can carry its own name, independent of the parent's
          // (#18) — purely cosmetic as far as the engine's concerned (nothing
          // here reads it for a scheduling decision), but it has to survive
          // the round trip through flatten/collapse or the next recompute
          // would silently overwrite whatever the user just typed.
          name: part.name || j.name,
          process: j.process,
          // Capability tags are a property of the work, so they apply to every
          // part of it. Without this the parts arrived with no `tags` at all
          // and tagOk waved them onto any machine — a split job that needed a
          // 5T positioner could be placed on equipment that hasn't got one.
          tags: j.tags || [],
          // A manual staff assignment is read from the PART, not the parent
          // (#68) — parts are placed independently and can end up on
          // different equipment at different times, so the person working one
          // part has no bearing on who works the other. This used to read
          // `j.staffId`, applying one job-level lock to every part alike:
          // setting "Assigned to" on a split job silently overrode BOTH
          // parts' operators identically, which is what read on the shop
          // floor as "changing one part's person changes the other's" — they
          // were never independent to begin with, just displayed as if they
          // were. `part.staffId` is its own field a part carries by itself;
          // there is no cascade from the job level to fall back to.
          staffId: part.staffId || null,
          // Preferred equipment DOES still cascade from the job level — it's
          // a soft nudge (unlike staffId/lockedEquipmentId below), it hasn't
          // caused the same reported problem, and every part of a split job
          // is, by definition, the same underlying work, so "prefers the same
          // machine" is a reasonable default here in a way "assigned to the
          // same person" or "locked to the same machine" are not. Deliberate
          // asymmetry with the two fields below, not an oversight — see
          // `test/scheduler.test.js`, "every part of a split job inherits the
          // parent's preference".
          preferredEquipmentId: j.preferredEquipmentId || null,
          // A hard equipment lock is read from the PART too, same reasoning
          // as staffId above (#68): it names one specific machine that part
          // must wait for, and two parts of the same split job may need to
          // sit on two different machines. No cascade from the job level.
          lockedEquipmentId: part.lockedEquipmentId || null,
          // Same reasoning as tags: parallel-processing is a property of the
          // work (the automation runs unattended either way), so every part
          // gets it too, not just whichever part happened to trigger it.
          parallelProcessing: !!j.parallelProcessing,
          hoursTotal: part.hoursTotal,
          readyDate: j.readyDate,
          dueDate: j.dueDate,
          departmentDueDate: j.departmentDueDate || null,
          needsFurtherProcessing: !!j.needsFurtherProcessing,
          percentComplete: part.percentComplete,
          status: part.status,
          assignment: part.assignment ? { ...part.assignment } : null,
        });
      });
    } else {
      jobs.push({ ...j, assignment: j.assignment ? { ...j.assignment } : null });
    }
  });
  batchGroups.forEach((members, batchId) => {
    // Continuity across recomputes (see stickyStaff below) has nothing of its
    // own to seed from — this pseudo-unit is rebuilt fresh every run — so it
    // borrows whichever member most recently had a primary operator.
    const seedStaffId = members.map((m) => primaryStaffOf(m.assignment)).find(Boolean) || null;
    const staffIds = new Set(members.map((m) => m.staffId).filter(Boolean));
    const preferredEquipIds = new Set(members.map((m) => m.preferredEquipmentId).filter(Boolean));
    const lockedEquipIds = new Set(members.map((m) => m.lockedEquipmentId).filter(Boolean));
    jobs.push({
      id: `batch:${batchId}`,
      _batchId: batchId,
      name: `Batch: ${members.map((m) => m.name).join(', ')}`,
      process: members[0].process,
      tags: [...new Set(members.flatMap((m) => m.tags || []))],
      // Only carries a manual assignment forward if every member agreed on
      // the same person — a mixed group has no single "the user named them"
      // to honour, so it's automatic like an ordinary multi-person job.
      staffId: staffIds.size === 1 ? [...staffIds][0] : null,
      // Same reasoning as staffId: a preference only carries into the combined
      // run if every member agreed on the same equipment.
      preferredEquipmentId: preferredEquipIds.size === 1 ? [...preferredEquipIds][0] : null,
      // Same reasoning again, for a hard lock: only unanimous agreement
      // carries it forward, otherwise the group places as if unrestricted.
      lockedEquipmentId: lockedEquipIds.size === 1 ? [...lockedEquipIds][0] : null,
      // Conservative both ways: the combined run can only share an operator
      // if EVERY member individually tolerates it, and needs to clear early
      // if ANY member does — being wrong the safe direction on either one is
      // cheaper than silently double-booking someone or slipping a due date.
      parallelProcessing: members.every((m) => !!m.parallelProcessing),
      needsFurtherProcessing: members.some((m) => !!m.needsFurtherProcessing),
      hoursTotal: members.reduce((s, m) => s + (m.hoursTotal || 0), 0),
      // The combined run can't start until every member is genuinely ready —
      // using the latest of them keeps it one contiguous block rather than
      // implying a gap partway through for a member that isn't ready yet. If
      // even one member has no ready date set at all (#59), the whole group
      // doesn't either — a blank date isn't "earliest", it's "unknown", so
      // treating it as the minimum would let the other members' real dates
      // silently outvote it instead of blocking the group like it should.
      readyDate: members.some((m) => !m.readyDate) ? '' : members.reduce((r, m) => (m.readyDate > r ? m.readyDate : r), members[0].readyDate),
      // Earliest (effective) due date among members drives placement
      // priority — the group is only as un-urgent as its most urgent member.
      dueDate: new Date(Math.min(...members.map((m) => new Date(effectiveDueDate(m)).getTime()))).toISOString().slice(0, 10),
      status: 'active',
      assignment: seedStaffId ? { seedStaffId } : null,
    });
  });

  const caps = buildCapacityMaps(equipment, staff, days);
  const { equipDayLock } = caps;
  let claimCounter = 0; // stamped onto each placed assignment so the Schedule view can lay out same-day handoffs left-to-right in the order they were actually claimed

  // Whoever was on each unit before this run, captured now because placement
  // overwrites `assignment` as it goes.
  // `seedStaffId` is set when a drag throws the day plan away (see handleDrop);
  // otherwise the plan itself says who had it.
  const stickyStaff = new Map();
  jobs.forEach((j) => {
    stickyStaff.set(j.id, j.assignment?.seedStaffId || primaryStaffOf(j.assignment));
  });

  const complete = jobs.filter((j) => j.status === 'complete');
  const active = jobs.filter((j) => j.status !== 'complete');
  const pinned = active.filter((j) => j.assignment && j.assignment.pinned);
  const unpinned = active.filter((j) => !(j.assignment && j.assignment.pinned));

  // A completed job is history — it already happened, so its equipment/staff
  // claim has to stay reserved exactly as it was, or completing it would
  // silently free that capacity for something still-active to slide into,
  // rewriting a day that's already in the past (#49). Replayed into the
  // capacity maps up front, before anything active is placed, using the
  // job's own already-fixed day-by-day plan — there's no placement search to
  // redo, since none of a completed job's slot is genuinely up for grabs.
  // The one case it's allowed to give any of it back: it actually took less
  // time than estimated (`actualHours` < `hoursTotal`, captured when the job
  // was marked complete — see ActualHoursModal). Only then is the plan
  // trimmed to that many hours, cumulative from the start, so the trailing
  // time that was saved becomes free — the same "final day" release an
  // ordinary in-progress job already gets once its own hours are satisfied,
  // just decided at completion time instead of by the day-by-day fit.
  complete.forEach((job) => {
    const plan = job.assignment?.days;
    if (!plan || !plan.length) return;
    const cap = (job.actualHours != null && job.actualHours < job.hoursTotal) ? job.actualHours : Infinity;
    let used = 0;
    const trimmed = [];
    for (const entry of plan) {
      if (used >= cap - 0.001) break;
      const hours = Math.min(entry.hours, cap - used);
      trimmed.push({ ...entry, hours });
      used += hours;
    }
    consume(trimmed, job.assignment.equipmentId, job.id, days, caps, false);
  });

  // 1. Place pinned (manually placed) jobs first - reserve their capacity.
  //    Which staff/shift cover each day is worked out automatically from
  //    the roster; a job can span a day-shift stint and an afternoon-shift
  //    stint (different people) on the same date if that's what it takes.
  //    Earliest start first: a pinned job starting sooner should get first
  //    call on the roster, otherwise one pinned later in the array could take
  //    the person an earlier job was already relying on.
  pinned.sort((a, b) => {
    const ad = a.assignment.startDate;
    const bd = b.assignment.startDate;
    if (ad !== bd) return ad < bd ? -1 : 1;
    // Same day: the most recent human decision wins. `claimOrder` is stamped on
    // every assignment at the end of each run, so a pin that has none is one
    // the user has just dropped and the scheduler hasn't seen yet — it places
    // first and keeps the slot, and the job already sitting there slides. That
    // is the point of dragging a job onto an occupied day: you are saying it
    // matters more than what is there.
    //
    // Defaulting to -1 rather than 0 matters: 0 is a real claimOrder (the first
    // job placed last run), so `?? 0` made a fresh drop tie with it and the
    // winner fell through to array order.
    return (a.assignment.claimOrder ?? -1) - (b.assignment.claimOrder ?? -1);
  });
  pinned.forEach((job) => {
    const a = job.assignment;
    const compatibleStaffIds = eligibleStaffIds(job, staff);
    const startIdx = days.indexOf(a.startDate);
    const notYetReady = job.readyDate && a.startDate < job.readyDate;
    let conflict = false;
    let plan = [];
    if (startIdx === -1 || notYetReady || !equipDayLock[a.equipmentId]) {
      conflict = true;
    } else {
      const fit = tryFit(days, startIdx, job.hoursTotal, a.equipmentId, compatibleStaffIds, caps, stickyStaff.get(job.id), !!job.parallelProcessing);
      if (fit) {
        plan = fit;
        consume(plan, a.equipmentId, job.id, days, caps, !!job.parallelProcessing);
      } else {
        conflict = true;
      }
    }
    if (conflict) {
      // Forced fallback so the job still shows up where the user dropped it,
      // clearly flagged as overbooked rather than silently vanishing.
      let idx = Math.max(0, startIdx);
      let remaining = job.hoursTotal;
      while (remaining > 0.001 && idx < days.length) {
        const date = days[idx];
        const use = Math.min(SHIFT_DEFS.day.defaultHours, remaining);
        plan.push({ date, shift: 'day', staffId: null, hours: use });
        remaining -= use;
        idx++;
      }
      if (plan.length === 0) plan = [{ date: a.startDate, shift: 'day', staffId: null, hours: job.hoursTotal }];
    }
    job.assignment = {
      equipmentId: a.equipmentId,
      startDate: plan[0]?.date || a.startDate,
      endDate: plan[plan.length - 1]?.date || a.startDate,
      pinned: true,
      conflict,
      days: plan,
      claimOrder: claimCounter++,
    };
  });

  // 2. Auto-schedule unpinned jobs into the earliest available slot, in order
  // of how little room each has to move.
  unpinned.sort((a, b) => {
    // A job with a manual staff assignment or a hard equipment lock places
    // first: it can only draw on the one person named, or the one machine
    // locked, so it gets first call on that resource. An automatic job still
    // has the whole qualified team / compatible fleet to fall back on.
    const aManual = (a.staffId || a.lockedEquipmentId) ? 0 : 1;
    const bManual = (b.staffId || b.lockedEquipmentId) ? 0 : 1;
    if (aManual !== bManual) return aManual - bManual;
    // Then earliest (effective) due date.
    const byDue = new Date(effectiveDueDate(a)) - new Date(effectiveDueDate(b));
    if (byDue) return byDue;
    // On an equal due date, a job flagged `needsFurtherProcessing` goes first:
    // it still has machining or manual work to go through after us, so the
    // same due date leaves it strictly less slack than one that ships straight
    // from this department.
    return (b.needsFurtherProcessing ? 1 : 0) - (a.needsFurtherProcessing ? 1 : 0);
  });

  // How many pending jobs can run on ONLY this one piece of equipment (no
  // alternative machine). Used below so that when a job with a choice of
  // machines finds them equally good, it defers to whichever one nothing
  // else is depending on exclusively — instead of camping on a machine a
  // less-flexible job needs and blocking it for no benefit to anyone.
  // A job locked to one machine (job.lockedEquipmentId) is exclusive by
  // definition, same as one with only a single process/tag-compatible
  // machine to begin with — eligibleEquipment folds both cases together.
  const exclusiveDemand = {};
  equipment.forEach((e) => { exclusiveDemand[e.id] = 0; });
  unpinned.forEach((j) => {
    const compat = eligibleEquipment(j, equipment);
    if (compat.length === 1) exclusiveDemand[compat[0].id] += 1;
  });

  unpinned.forEach((job) => {
    // No ready-for-processing date is not the same as "ready now" (#59) — a
    // blank field means nobody has actually confirmed materials/prior-stage
    // work are in this department yet, so the job sits out of auto-placement
    // entirely (same "needs scheduling" list as no capacity found) until
    // someone sets a real date, rather than quietly defaulting to today.
    if (!job.readyDate) {
      job.assignment = null;
      job.unschedReason = whyUnscheduled(job, equipment, staff, days);
      return;
    }
    const compatibleEquip = eligibleEquipment(job, equipment);
    const compatibleStaffIds = eligibleStaffIds(job, staff);
    const seedStaffId = stickyStaff.get(job.id);
    let best = null;
    // Never auto-place into the past: `days` starts behind today so history
    // stays visible, but new work begins today at the earliest.
    let floorIdx = earliestIdx;
    {
      const readyIdx = days.findIndex((d) => d >= job.readyDate);
      floorIdx = readyIdx === -1 ? days.length : Math.max(floorIdx, readyIdx);
    }
    if (compatibleEquip.length && compatibleStaffIds.length) {
      const candidates = [];
      for (const e of compatibleEquip) {
        for (let idx = floorIdx; idx < days.length; idx++) {
          const fit = tryFit(days, idx, job.hoursTotal, e.id, compatibleStaffIds, caps, seedStaffId, !!job.parallelProcessing);
          if (fit) {
            candidates.push({ equipId: e.id, plan: fit, startDate: fit[0].date, endDate: fit[fit.length - 1].date });
            break; // this is the earliest start this particular machine can offer
          }
        }
      }
      // Pick whichever compatible machine finishes the job soonest (ties broken by
      // earliest start). This is the key fix: previously the first machine in the
      // list that could fit the job *at all* was used, even if it meant dragging
      // the job out over many sparse days while an equally-capable machine sat
      // completely free — which is exactly what was piling every job onto one
      // robot and pushing due dates out.

      // Scoring the candidates and USING that score to choose are deliberately
      // independent. `trace` is pure observation — it describes the options
      // that existed and what each one measured, which is exactly what an
      // override later needs to be compared against, and it has to work on
      // the DEFAULT (legacy) path or the app could never record anything
      // without first opting into a behaviour change. `weights` is the only
      // thing that changes which candidate wins. When only tracing, the score
      // is computed against DEFAULT_WEIGHTS purely as a reference reading —
      // `scored: false` on the record says it didn't drive the decision.
      const ranked = (candidates.length && (weights || trace))
        ? rankCandidates(job, candidates, {
          exclusiveDemand,
          seedStaffId,
          floorDate: days[Math.min(floorIdx, days.length - 1)],
          dueDate: effectiveDueDate(job),
        }, weights || DEFAULT_WEIGHTS)
        : null;

      if (candidates.length && weights) {
        // ---- Weighted scoring path (opt-in; see placementScore.js) ----
        // Every signal the cascade below expresses as a strict priority level
        // becomes a term in one weighted sum here, so they can genuinely trade
        // off. Note this deliberately CHANGES one behaviour relative to the
        // cascade: preferred equipment stops winning outright regardless of
        // cost and instead competes on its weight, so a preferred machine
        // booked solid for weeks now loses to one free tomorrow. That is the
        // point of the path, not an oversight — the flag exists so the change
        // is opted into rather than inflicted.
        //
        // Eligibility is untouched: `candidates` has already been filtered by
        // every hard constraint (process, tags, lockedEquipmentId, staffId,
        // readyDate, day locks) before anything here runs, and scoring can
        // only ever reorder that list, never extend it.
        best = ranked[0];
      } else if (candidates.length) {
        // ---- Original lexicographic path (the default) ----
        // Preferred equipment (job.preferredEquipmentId — a soft nudge, set
        // by hand on the job or inherited from its template) wins outright
        // over "finishes soonest" whenever it's actually among the feasible
        // candidates, rather than only breaking ties. It's still just a
        // preference, not a pin: if it's not process/tag-compatible, or
        // genuinely has no free slot in the horizon, it never makes it into
        // `candidates` at all, and placement falls through to the ordinary
        // soonest-finish selection below — the job still gets scheduled, just
        // not where it was preferred, which is what the
        // `preferredEquipmentUnmet` flag on the resulting assignment is for.
        const preferred = job.preferredEquipmentId
          ? candidates.find((c) => c.equipId === job.preferredEquipmentId)
          : null;
        if (preferred) {
          best = preferred;
        } else {
          candidates.sort((a, b) => {
            if (a.endDate !== b.endDate) return a.endDate < b.endDate ? -1 : 1;
            if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
            // This job would finish equally well on either machine — prefer the
            // one fewer other pending jobs are exclusively stuck with, so a
            // flexible job doesn't block a less-flexible one for no gain.
            const aExcl = exclusiveDemand[a.equipId] || 0;
            const bExcl = exclusiveDemand[b.equipId] || 0;
            if (aExcl !== bExcl) return aExcl - bExcl;
            // Still tied: take the machine that keeps the person who already had
            // this job on it. Moving a job between equipment shouldn't change who
            // is doing it when they're perfectly free to carry on.
            if (seedStaffId) {
              const aKeeps = primaryStaffOf({ days: a.plan }) === seedStaffId;
              const bKeeps = primaryStaffOf({ days: b.plan }) === seedStaffId;
              if (aKeeps !== bKeeps) return aKeeps ? -1 : 1;
            }
            const aStaffCount = new Set(a.plan.map((d) => d.staffId)).size;
            const bStaffCount = new Set(b.plan.map((d) => d.staffId)).size;
            if (aStaffCount !== bStaffCount) return aStaffCount - bStaffCount; // fewer different people = less handover
            return a.plan.length - b.plan.length; // fewer chunks = less fragmented
          });
          best = candidates[0];
        }
      }

      // Emitted after `best` is settled, so `chosen` always reflects whichever
      // path actually decided — on the legacy path that is NOT necessarily
      // `candidates[0]` of the score-ranked list, and the difference between
      // the two is itself worth being able to see.
      if (trace && ranked) {
        trace.push({
          jobId: job.id,
          scored: !!weights, // did the score drive this, or is it just a reading?
          chosen: best ? { equipId: best.equipId, startDate: best.startDate, endDate: best.endDate } : null,
          candidates: ranked.map((c) => ({
            equipId: c.equipId,
            startDate: c.startDate,
            endDate: c.endDate,
            score: c.score,
            features: c.features,
          })),
        });
      }
    }
    if (best) {
      consume(best.plan, best.equipId, job.id, days, caps, !!job.parallelProcessing);
      job.assignment = {
        equipmentId: best.equipId,
        startDate: best.plan[0].date,
        endDate: best.plan[best.plan.length - 1].date,
        pinned: false,
        conflict: false,
        preferredEquipmentUnmet: !!(job.preferredEquipmentId && best.equipId !== job.preferredEquipmentId),
        days: best.plan,
        claimOrder: claimCounter++,
      };
    } else {
      job.assignment = null;
      job.unschedReason = whyUnscheduled(job, equipment, staff, days);
    }
  });

  const flatResult = [...pinned, ...unpinned, ...complete];

  // Reassemble: collapse each split job's scheduled parts back onto its
  // parent (hoursTotal/percentComplete/status become aggregates; the parent
  // itself carries no single assignment — see its parts instead). Regular
  // jobs pass through untouched.
  const collapsedByParent = new Map();
  const all = [];
  flatResult.forEach((unit) => {
    // Expand a batch pseudo-unit back into its members — the reverse of the
    // combine step above: one placement decision, sliced into each member's
    // own day-by-day assignment in batch order (see sliceBatchPlan). An
    // unplaced batch's members all come back unscheduled together, sharing
    // the one reason the combined unit couldn't be placed.
    if (unit._batchId) {
      const members = batchGroups.get(unit._batchId);
      const sliced = unit.assignment ? sliceBatchPlan(unit.assignment.days, members) : members.map(() => []);
      members.forEach((m, i) => {
        const memberDays = sliced[i];
        all.push({
          ...m,
          assignment: memberDays.length ? {
            equipmentId: unit.assignment.equipmentId,
            startDate: memberDays[0].date,
            endDate: memberDays[memberDays.length - 1].date,
            pinned: false,
            conflict: false,
            // Judged per member, not from the batch's own (unanimous-only)
            // preference — a member can prefer equipment none of the others
            // agreed on and still have that preference honoured or missed.
            preferredEquipmentUnmet: !!(m.preferredEquipmentId && unit.assignment.equipmentId !== m.preferredEquipmentId),
            days: memberDays,
            claimOrder: unit.assignment.claimOrder,
          } : null,
          unschedReason: memberDays.length ? undefined : unit.unschedReason,
        });
      });
      return;
    }
    if (!unit._parentId) { all.push(unit); return; }
    const parent = splitParents.get(unit._parentId);
    let collapsed = collapsedByParent.get(unit._parentId);
    if (!collapsed) {
      collapsed = { ...parent, parts: new Array(parent.parts.length) };
      collapsedByParent.set(unit._parentId, collapsed);
      all.push(collapsed);
    }
    collapsed.parts[unit._partIndex] = {
      id: unit.id,
      // The exact original value, not unit.name — flatten falls back to the
      // parent's name for a part that has none, purely so the engine (and
      // whyUnscheduled's messages) always has *something* to work with, but
      // that fallback must not get written back as if the user had set it.
      // Round-tripping it here would leave every legacy part's name equal to
      // the bare parent name after the very next recompute, permanently
      // erasing the "(Part 1)"/"(Part 2)" distinction the UI derives when
      // this field is absent.
      name: parent.parts[unit._partIndex].name,
      hoursTotal: unit.hoursTotal,
      percentComplete: unit.percentComplete,
      status: unit.status,
      // Round-tripped from the flattened unit, not from
      // `parent.parts[unit._partIndex]` like `name` above — these ARE the
      // authoritative current value (flatten reads them straight off the
      // part, see the split-job block above), not a fallback that would
      // corrupt a user's real setting the way name's placeholder would.
      // Omitting this entirely was the actual bug behind #68: a part's
      // staffId/lockedEquipmentId could be set correctly on save, only to
      // vanish on the very same recompute that save triggers, because this
      // object never had a key for either — every part looked permanently
      // stuck on "Automatic" no matter what the modal sent.
      staffId: unit.staffId || null,
      lockedEquipmentId: unit.lockedEquipmentId || null,
      assignment: unit.assignment,
      unschedReason: unit.unschedReason,
    };
  });
  collapsedByParent.forEach((collapsed) => {
    const totalHours = collapsed.parts.reduce((s, p) => s + (p.hoursTotal || 0), 0);
    const weightedPct = totalHours > 0
      ? collapsed.parts.reduce((s, p) => s + (p.percentComplete || 0) * (p.hoursTotal || 0), 0) / totalHours
      : 0;
    collapsed.hoursTotal = Math.round(totalHours * 100) / 100;
    collapsed.percentComplete = Math.round(weightedPct);
    collapsed.status = collapsed.parts.every((p) => p.status === 'complete') ? 'complete' : 'active';
    collapsed.assignment = null;
  });

  all.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return all;
}
