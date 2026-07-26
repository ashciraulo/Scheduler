/* ============================================================================
   SCHEDULING ENGINE + the roster/date model it runs on.
   ----------------------------------------------------------------------------
   Extracted from WeldingScheduler.jsx so it can be unit-tested directly: this
   file is plain JavaScript with no JSX and no imports, so `node --test` loads
   it with no build step and no test framework.

   It is pure — no React, no storage, no DOM. `runScheduler(jobs, equipment,
   staff, days, earliestIdx)` takes plain data and returns plain data, which is
   what makes the invariants in scheduler/CLAUDE.md testable at all.

   The rules commented through here each fixed a real scheduling bug. The tests
   in test/scheduler.test.js pin them down; don't regress either.
   ============================================================================ */

/* ============================================================
   SHIFTS & ROSTER CONSTANTS
   ============================================================ */

export const SHIFT_DEFS = {
  day: { id: 'day', label: 'Day Shift', defaultHours: 8 },
  afternoon: { id: 'afternoon', label: 'Afternoon Shift', defaultHours: 8 },
};
export const SHIFT_ORDER = ['day', 'afternoon'];
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
  staff.forEach((s) => {
    staffDayRemain[s.id] = {};
    staffDayShift[s.id] = {};
    days.forEach((day) => {
      const info = getStaffDayInfo(s, day);
      staffDayRemain[s.id][day] = info.hours;
      staffDayShift[s.id][day] = info.shift;
    });
  });
  return { equipDayLock, equipShiftUsed, staffDayRemain, staffDayShift, staffLoad };
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

export function tryFit(days, startIdx, hoursNeeded, equipId, compatibleStaffIds, caps, seedStaffId = null) {
  const { equipDayLock, equipShiftUsed, staffDayRemain, staffDayShift, staffLoad } = caps;
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
      let shiftLeft = SHIFT_DEFS[shift].defaultHours - already;
      if (shiftLeft <= 0.001) continue;

      // Everyone qualified, rostered onto this shift today, with hours to give.
      const pool = compatibleStaffIds.filter(
        (sid) => staffDayShift[sid]?.[date] === shift && (staffDayRemain[sid]?.[date] ?? 0) > 0.001
      );
      if (!pool.length) continue;
      const contribution = (sid) => Math.min(staffDayRemain[sid][date], shiftLeft, remaining);
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
      // hours and the equipment still has shift capacity going spare.
      let firstOnShift = null;
      let preferredStayed = false;
      for (const sid of pool) {
        if (remaining <= 0.001 || shiftLeft <= 0.001) break;
        const use = Math.min(shiftLeft, staffDayRemain[sid][date], remaining);
        if (use <= 0.001) continue;
        plan.push({ date, shift, staffId: sid, hours: use });
        remaining -= use;
        shiftLeft -= use;
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

export function consume(plan, equipId, jobId, days, caps) {
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
    staffDayRemain[staffId][date] -= hours;
    staffLoad[staffId] = (staffLoad[staffId] ?? 0) + hours;
  });
}

// A job schedules on a piece of equipment only if the equipment carries every
// capability tag the job requires (e.g. a positioner load rating). Untagged
// jobs run anywhere their process allows, exactly as before.
export function tagOk(job, equip) {
  const need = job.tags || [];
  return !need.length || need.every((t) => (equip.tags || []).includes(t));
}

// Human-readable reason a job couldn't be auto-placed, shown on its
// "Needs scheduling" card. Checked in order of severity.
export function whyUnscheduled(job, equipment, staff, days) {
  if (!(job.hoursTotal > 0.001)) return 'no hours set on this job yet — add hours (or a template) so it can be scheduled';
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
  if (job.readyDate && job.readyDate > days[days.length - 1]) return `not ready until ${fmtDate(job.readyDate)} — beyond the schedule horizon`;
  const assignee = job.staffId ? staff.find((s) => s.id === job.staffId) : null;
  if (assignee) return `${assignee.name} has no free ${job.hoursTotal}h alongside a free machine in the horizon — reassign this job or set it back to automatic`;
  return `no free equipment/staff capacity in the horizon for ${job.hoursTotal}h`;
}

// `days` now runs from some way *behind* today (so finished work stays on the
// timeline) up to the forward horizon. `earliestIdx` is the index of today —
// the floor below which nothing may be auto-placed. Pinned jobs are exempt: a
// job the user dropped on a past date is a record of what actually happened,
// and it keeps that slot.
export function runScheduler(jobsIn, equipment, staff, days, earliestIdx = 0) {
  const order = jobsIn.map((j) => j.id);

  // A split job (job.parts set) doesn't get scheduled as one unit — each part
  // is independently placeable (they may end up on different equipment, at
  // different times), so it's flattened into its parts here and reassembled
  // at the end. A regular job passes through unchanged.
  const splitParents = new Map(); // parentId -> original job, for reassembly
  const jobs = [];
  jobsIn.forEach((j) => {
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
          // A manual staff assignment sits on the job, so it applies to every
          // part of it — the parts are separately *placed*, not separately
          // staffed.
          staffId: j.staffId || null,
          hoursTotal: part.hoursTotal,
          readyDate: j.readyDate,
          dueDate: j.dueDate,
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
      const fit = tryFit(days, startIdx, job.hoursTotal, a.equipmentId, compatibleStaffIds, caps, stickyStaff.get(job.id));
      if (fit) {
        plan = fit;
        consume(plan, a.equipmentId, job.id, days, caps);
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
    // A job with a manual staff assignment places first: it can only draw on
    // the one person the user named, so it gets first call on their time. An
    // automatic job still has the whole qualified team to fall back on.
    const aManual = a.staffId ? 0 : 1;
    const bManual = b.staffId ? 0 : 1;
    if (aManual !== bManual) return aManual - bManual;
    // Then earliest due date.
    const byDue = new Date(a.dueDate) - new Date(b.dueDate);
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
  const exclusiveDemand = {};
  equipment.forEach((e) => { exclusiveDemand[e.id] = 0; });
  unpinned.forEach((j) => {
    const compat = equipment.filter((e) => e.processes.includes(j.process) && tagOk(j, e));
    if (compat.length === 1) exclusiveDemand[compat[0].id] += 1;
  });

  unpinned.forEach((job) => {
    const compatibleEquip = equipment.filter((e) => e.processes.includes(job.process) && tagOk(job, e));
    const compatibleStaffIds = eligibleStaffIds(job, staff);
    const seedStaffId = stickyStaff.get(job.id);
    let best = null;
    // Never auto-place into the past: `days` starts behind today so history
    // stays visible, but new work begins today at the earliest.
    let floorIdx = earliestIdx;
    if (job.readyDate) {
      const readyIdx = days.findIndex((d) => d >= job.readyDate);
      floorIdx = readyIdx === -1 ? days.length : Math.max(floorIdx, readyIdx);
    }
    if (compatibleEquip.length && compatibleStaffIds.length) {
      const candidates = [];
      for (const e of compatibleEquip) {
        for (let idx = floorIdx; idx < days.length; idx++) {
          const fit = tryFit(days, idx, job.hoursTotal, e.id, compatibleStaffIds, caps, seedStaffId);
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
      if (candidates.length) {
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
    if (best) {
      consume(best.plan, best.equipId, job.id, days, caps);
      job.assignment = {
        equipmentId: best.equipId,
        startDate: best.plan[0].date,
        endDate: best.plan[best.plan.length - 1].date,
        pinned: false,
        conflict: false,
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
