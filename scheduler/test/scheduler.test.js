/* Unit tests for the scheduling engine.
   ----------------------------------------------------------------------------
   These pin down the invariants written up in scheduler/CLAUDE.md. Each one
   corresponds to a rule that exists because a real scheduling bug was found —
   several of them reported from the shop floor — so a failure here is a
   regression of behaviour someone actually asked for, not a style question.

   Run: npm test (in scheduler/). No framework, no build: node:test loads
   src/scheduler.js directly.
*/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  runScheduler, whyUnscheduled, getStaffDayInfo, tagOk, primaryStaffOf, eligibleStaffIds,
  findStaffConflictJobs, fmtDate,
} from '../src/scheduler.js';
import {
  MONDAY, days, equip, person, job, rosterOn, datesOf, staffOn, hoursOn, byId,
} from './helpers.js';

describe('readiness and the schedule floor', () => {
  test('a job never starts before its readyDate', () => {
    const d = days();
    const out = runScheduler(
      [job('j', { readyDate: '2026-03-05', hoursTotal: 8 })],
      [equip('e1')], [person('s1')], d,
    );
    assert.ok(byId(out, 'j').assignment.startDate >= '2026-03-05');
  });

  test("a job with no readyDate at all isn't scheduled — a blank field isn't the same as ready now (#59)", () => {
    const d = days();
    const out = runScheduler(
      [job('j', { readyDate: null, hoursTotal: 8 })],
      [equip('e1')], [person('s1')], d,
    );
    const j = byId(out, 'j');
    assert.equal(j.assignment, null, "a job with no ready date shouldn't get auto-placed just because today counts as a valid start");
    assert.match(j.unschedReason, /ready.*date/i);
  });

  test('an empty-string readyDate is treated the same as null — not scheduled', () => {
    const d = days();
    const out = runScheduler(
      [job('j', { readyDate: '', hoursTotal: 8 })],
      [equip('e1')], [person('s1')], d,
    );
    assert.equal(byId(out, 'j').assignment, null);
  });

  test('setting a readyDate on a previously-unset job lets it schedule normally on the next recompute', () => {
    const d = days();
    const out = runScheduler(
      [job('j', { readyDate: '2026-03-05', hoursTotal: 8 })],
      [equip('e1')], [person('s1')], d,
    );
    assert.ok(byId(out, 'j').assignment, 'once a real date is set, the job schedules like any other');
  });

  test('whyUnscheduled names the missing ready date specifically, not a generic capacity message', () => {
    const d = days();
    const reason = whyUnscheduled(job('j', { readyDate: null, hoursTotal: 8 }), [equip('e1')], [person('s1')], d);
    assert.match(reason, /ready.*date/i);
  });

  test('fmtDate shows a placeholder rather than "Invalid Date" for a blank date', () => {
    assert.equal(fmtDate(null), '—');
    assert.equal(fmtDate(''), '—');
    assert.equal(fmtDate(undefined), '—');
  });

  test('earliestIdx keeps auto-placement out of the past, but pinned jobs keep their slot', () => {
    const d = days(20);
    const todayIdx = 5; // pretend the first five days are history

    const auto = runScheduler([job('auto', { readyDate: d[0] })], [equip('e1')], [person('s1')], d, todayIdx);
    assert.ok(byId(auto, 'auto').assignment.startDate >= d[todayIdx],
      'an unpinned job must not be backfilled into the past');

    // A job dropped on a past date is a record of what actually ran.
    const pinnedJob = job('pin', {
      readyDate: d[0],
      assignment: { equipmentId: 'e1', startDate: d[1], endDate: d[1], pinned: true, days: [] },
    });
    const pinned = runScheduler([pinnedJob], [equip('e1')], [person('s1')], d, todayIdx);
    assert.equal(byId(pinned, 'pin').assignment.startDate, d[1],
      'a pinned job keeps the past slot the user dropped it on');
  });
});

describe('equipment exclusivity', () => {
  test('a second job cannot use equipment mid-way through an unfinished job', () => {
    const d = days();
    // s1 works Mon+Tue only, so j1 spans Mon→Wed with an idle gap it still owns.
    const out = runScheduler(
      [
        job('j1', { hoursTotal: 24, dueDate: '2026-03-10' }),
        job('j2', { hoursTotal: 8, dueDate: '2026-03-11' }),
      ],
      [equip('e1')], [person('s1')], d,
    );
    const a1 = byId(out, 'j1').assignment;
    const a2 = byId(out, 'j2').assignment;
    assert.ok(a2, 'j2 should still be scheduled somewhere');
    assert.ok(a2.startDate > a1.endDate,
      `j2 must wait for j1 to finish on the same equipment (j1 ends ${a1.endDate}, j2 starts ${a2.startDate})`);
  });

  test("but a job's own final day is released once its hours are satisfied", () => {
    const d = days();
    // 5h + 3h fit one 8h shift: the second job may start the day the first ends.
    const out = runScheduler(
      [
        job('five', { hoursTotal: 5, dueDate: '2026-03-10' }),
        job('three', { hoursTotal: 3, dueDate: '2026-03-11' }),
      ],
      [equip('e1')], [person('s1')], d,
    );
    const a1 = byId(out, 'five').assignment;
    const a2 = byId(out, 'three').assignment;
    assert.equal(a1.endDate, a2.startDate, 'both should share the one day');
    assert.equal(hoursOn(a1, MONDAY) + hoursOn(a2, MONDAY), 8);
  });
});

describe('machine choice', () => {
  test('picks the machine that finishes the job soonest', () => {
    const d = days();
    // e1 is already tied up by a long pinned job, so e2 finishes sooner.
    const blocker = job('blocker', {
      hoursTotal: 40,
      assignment: { equipmentId: 'e1', startDate: MONDAY, endDate: MONDAY, pinned: true, days: [] },
    });
    const out = runScheduler(
      [blocker, job('later', { dueDate: '2026-03-19' })],
      [equip('e1'), equip('e2')],
      [person('s1'), person('s2')],
      d,
    );
    assert.equal(byId(out, 'later').assignment.equipmentId, 'e2');
  });

  test('capability tags restrict which equipment a job may use', () => {
    const d = days();
    const out = runScheduler(
      [job('needs5t', { tags: ['5T Positioner'] })],
      [equip('plain'), equip('big', { tags: ['5T Positioner'] })],
      [person('s1')], d,
    );
    assert.equal(byId(out, 'needs5t').assignment.equipmentId, 'big');
  });

  test('tagOk requires every tag, not just one', () => {
    assert.equal(tagOk({ tags: ['a', 'b'] }, { tags: ['a'] }), false);
    assert.equal(tagOk({ tags: ['a', 'b'] }, { tags: ['a', 'b', 'c'] }), true);
    assert.equal(tagOk({ tags: [] }, { tags: [] }), true);
  });
});

describe('preferred equipment — a soft nudge, not a pin', () => {
  test('an unpinned job with a preference is placed there even when another machine would finish it sooner', () => {
    const d = days();
    // e1 is already tied up, so e2 would ordinarily win on "finishes soonest"
    // — but the job prefers e1, and e1 is not full, just slower to free up.
    const blocker = job('blocker', {
      hoursTotal: 16,
      assignment: { equipmentId: 'e1', startDate: MONDAY, endDate: MONDAY, pinned: true, days: [] },
    });
    const out = runScheduler(
      [blocker, job('preferring', { hoursTotal: 8, preferredEquipmentId: 'e1', dueDate: '2026-03-19' })],
      [equip('e1'), equip('e2')],
      [person('s1'), person('s2')],
      d,
    );
    const a = byId(out, 'preferring').assignment;
    assert.equal(a.equipmentId, 'e1', 'the preference should win over the machine that would finish soonest');
    assert.equal(a.preferredEquipmentUnmet, false, 'the preference was honoured, so nothing needs review');
  });

  test('falls back to the best available machine, flagged for review, when the preferred one has no free capacity in the horizon', () => {
    const d = days();
    // e1 is blocked out for every day in the horizon, so it can never offer a
    // fit — this must not leave the job unscheduled, just not on e1.
    const out = runScheduler(
      [job('preferring', { hoursTotal: 8, preferredEquipmentId: 'e1', dueDate: '2026-03-19' })],
      [equip('e1', { unavailableDates: [...d] }), equip('e2')],
      [person('s1'), person('s2')],
      d,
    );
    const a = byId(out, 'preferring').assignment;
    assert.ok(a, 'the job must still be placed somewhere, not left unscheduled');
    assert.equal(a.equipmentId, 'e2', 'falls back to the only other compatible machine');
    assert.equal(a.preferredEquipmentUnmet, true, 'the missed preference should be flagged for review');
  });

  test('falls back, flagged, when the preferred equipment cannot run the process at all', () => {
    const d = days();
    const out = runScheduler(
      [job('preferring', { hoursTotal: 8, preferredEquipmentId: 'wrongProcess' })],
      [equip('wrongProcess', { processes: ['Coat'] }), equip('e2')],
      [person('s1')], d,
    );
    const a = byId(out, 'preferring').assignment;
    assert.equal(a.equipmentId, 'e2');
    assert.equal(a.preferredEquipmentUnmet, true);
  });

  test('a pinned job is unaffected by its own preference — pinning is already a stronger, exact placement', () => {
    const d = days();
    const out = runScheduler(
      [job('pinned-elsewhere', {
        hoursTotal: 8, preferredEquipmentId: 'e1',
        assignment: { equipmentId: 'e2', startDate: MONDAY, endDate: MONDAY, pinned: true, days: [] },
      })],
      [equip('e1'), equip('e2')], [person('s1')], d,
    );
    assert.equal(byId(out, 'pinned-elsewhere').assignment.equipmentId, 'e2');
  });

  test('no preference set behaves exactly as before — finishes-soonest selection, no flag', () => {
    const d = days();
    const out = runScheduler(
      [job('plain', { hoursTotal: 8 })],
      [equip('e1'), equip('e2')], [person('s1')], d,
    );
    assert.equal(byId(out, 'plain').assignment.preferredEquipmentUnmet, false);
  });

  test('every part of a split job inherits the parent’s preference', () => {
    const d = days();
    const split = job('split', {
      preferredEquipmentId: 'e1',
      hoursTotal: 16,
      parts: [
        { id: 'p1', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null },
        { id: 'p2', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null },
      ],
    });
    const out = runScheduler([split], [equip('e1'), equip('e2')], [person('s1'), person('s2')], d);
    const parts = byId(out, 'split').parts;
    assert.ok(parts.every((p) => p.assignment.equipmentId === 'e1'), 'both parts should land on the preferred machine');
  });

  test('a batch only carries the preference forward if every member agreed on the same equipment', () => {
    const d = days();
    const agreed = runScheduler(
      [
        job('b1', { hoursTotal: 8, batchId: 'batchPref', batchOrder: 0, preferredEquipmentId: 'e1' }),
        job('b2', { hoursTotal: 8, batchId: 'batchPref', batchOrder: 1, preferredEquipmentId: 'e1' }),
      ],
      [equip('e1'), equip('e2')], [person('s1')], d,
    );
    assert.equal(byId(agreed, 'b1').assignment.equipmentId, 'e1');
    assert.equal(byId(agreed, 'b2').assignment.equipmentId, 'e1');

    const blocker = job('blocker', {
      hoursTotal: 16,
      assignment: { equipmentId: 'e1', startDate: MONDAY, endDate: MONDAY, pinned: true, days: [] },
    });
    const mixed = runScheduler(
      [
        blocker,
        job('c1', { hoursTotal: 8, batchId: 'batchPref2', batchOrder: 0, preferredEquipmentId: 'e1', dueDate: '2026-03-19' }),
        job('c2', { hoursTotal: 8, batchId: 'batchPref2', batchOrder: 1, preferredEquipmentId: 'e2', dueDate: '2026-03-19' }),
      ],
      [equip('e1'), equip('e2')], [person('s1'), person('s2')], d,
    );
    // No unanimous preference, so the group places automatically — off the
    // busy e1, same as it would with no preference at all.
    assert.equal(byId(mixed, 'c1').assignment.equipmentId, 'e2');
    assert.equal(byId(mixed, 'c2').assignment.equipmentId, 'e2');
  });
});

describe('who gets the work', () => {
  test('work does not all pile onto the first person in the list', () => {
    const d = days();
    // Four one-day jobs, four machines, three equally capable people. If ties
    // fell through to array order they would all land on s1 — the reported bug.
    const jobs = [1, 2, 3].map((n) => job(`j${n}`, { hoursTotal: 8, dueDate: '2026-03-10' }));
    const out = runScheduler(
      jobs,
      [equip('e1'), equip('e2'), equip('e3')],
      [person('s1'), person('s2'), person('s3')],
      d,
    );
    const owners = jobs.map((j) => primaryStaffOf(byId(out, j.id).assignment));
    assert.equal(new Set(owners).size, 3, `expected three different people, got ${JSON.stringify(owners)}`);
  });

  test('one person stays on a job across days where their roster allows', () => {
    const d = days();
    const out = runScheduler(
      [job('long', { hoursTotal: 24 })],
      [equip('e1')],
      [person('s1'), person('s2')],
      d,
    );
    assert.deepEqual(staffOn(byId(out, 'long').assignment), ['s1'],
      'a job that one person can cover should not be handed around');
  });

  test('a handover happens only when the person is genuinely unavailable', () => {
    const d = days();
    // s1 works Monday only; s2 covers the rest.
    const out = runScheduler(
      [job('long', { hoursTotal: 24 })],
      [equip('e1')],
      [person('s1', { roster: rosterOn(['mon']) }), person('s2')],
      d,
    );
    const who = staffOn(byId(out, 'long').assignment);
    assert.ok(who.length > 1, 'expected a handover once s1 runs out of roster');
  });
});

describe('manual staff assignment', () => {
  test('the named person does the work even when someone else is free sooner', () => {
    const d = days();
    const out = runScheduler(
      [job('locked', { staffId: 's2', hoursTotal: 8 })],
      [equip('e1')],
      [person('s1'), person('s2', { roster: rosterOn(['wed']) })],
      d,
    );
    const a = byId(out, 'locked').assignment;
    assert.deepEqual(staffOn(a), ['s2'], 'must wait for s2 rather than give the job to s1');
    assert.equal(new Date(a.startDate + 'T00:00:00').getDay(), 3, 'should land on the Wednesday s2 works');
  });

  test('eligibleStaffIds narrows to the assigned person, or everyone qualified', () => {
    const staff = [person('s1'), person('s2'), person('s3', { processes: ['Spray'] })];
    assert.deepEqual(eligibleStaffIds(job('j'), staff), ['s1', 's2']);
    assert.deepEqual(eligibleStaffIds(job('j', { staffId: 's2' }), staff), ['s2']);
    assert.deepEqual(eligibleStaffIds(job('j', { staffId: 's3' }), staff), [],
      'someone not signed off on the process is not eligible even if named');
  });

  // #68: a split job's manual staff assignment used to be read from the
  // PARENT (`j.staffId`) and applied to every part identically — setting
  // "Assigned to" on the job silently locked both parts to the same person,
  // which is what read on the shop floor as "changing one part's person
  // changes the other's": they were never independent, just displayed as if
  // they were. Each part now carries its own `staffId`.
  test("a split job's manual staff assignment is per PART, not shared across parts", () => {
    const d = days();
    const split = job('split', {
      hoursTotal: 16,
      parts: [
        { id: 'p1', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null, staffId: 's2' },
        { id: 'p2', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null, staffId: 's3' },
      ],
    });
    const out = runScheduler(
      [split], [equip('e1'), equip('e2')],
      [person('s1'), person('s2', { roster: rosterOn(['wed']) }), person('s3')],
      d,
    );
    const parts = byId(out, 'split').parts;
    assert.deepEqual(staffOn(parts[0].assignment), ['s2'], "part 1 waits for the person locked to IT");
    assert.deepEqual(staffOn(parts[1].assignment), ['s3'], "part 2 gets its own different locked person, unaffected by part 1's");
  });

  // The bug behind #68 had two halves, and this pins the second one, which is
  // the one `staffOn(assignment)` above can't see: flatten reading the
  // right field (part.staffId) is necessary but not sufficient if the
  // COLLAPSE step that reassembles job.parts after scheduling never writes
  // `staffId` back onto the part at all — which is exactly what was
  // happening. A part's own field could be set correctly, survive the exact
  // recompute that saved it, LOOK right in `assignment.days`... and then
  // silently disappear from `part.staffId` itself on the very next
  // recompute, because collapse's object literal simply had no key for it.
  // Same shape of bug the "custom part name survives repeated recomputes"
  // test above already guards for `name` — this is the equivalent for the
  // two new per-part fields.
  test("a part's staffId/lockedEquipmentId survive repeated recomputes, not just the one that set them", () => {
    const d = days();
    const split = job('split', {
      hoursTotal: 16,
      parts: [
        { id: 'p1', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null, staffId: 's2', lockedEquipmentId: 'e1' },
        { id: 'p2', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null },
      ],
    });
    const equipment = [equip('e1'), equip('e2')];
    const staff = [person('s1'), person('s2')];

    const out1 = runScheduler([split], equipment, staff, d);
    const p1 = byId(out1, 'split');
    assert.equal(p1.parts[0].staffId, 's2');
    assert.equal(p1.parts[0].lockedEquipmentId, 'e1');
    assert.equal(p1.parts[1].staffId, null, 'a part with no lock of its own must read null, not undefined or inherited');

    // A second pass — what every ordinary recompute after a save actually is
    // — must not silently drop what the first pass just wrote.
    const out2 = runScheduler(out1, equipment, staff, d);
    const p2 = byId(out2, 'split');
    assert.equal(p2.parts[0].staffId, 's2', 'must survive a second recompute, not just the one that set it');
    assert.equal(p2.parts[0].lockedEquipmentId, 'e1', 'same for the equipment lock');
  });

  test('a manual assignment set at the JOB level on a split job is simply not read — parts are unrestricted unless they say so themselves', () => {
    const d = days();
    const split = job('split', {
      staffId: 's2', // job-level; must not cascade to either part
      hoursTotal: 16,
      parts: [
        { id: 'p1', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null },
        { id: 'p2', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null },
      ],
    });
    const out = runScheduler(
      [split], [equip('e1'), equip('e2')],
      [person('s1'), person('s2', { roster: rosterOn(['wed']) })],
      d,
    );
    const parts = byId(out, 'split').parts;
    // Neither part named anyone, so the only actually-available operator (s1,
    // rostered every weekday) covers both — the job-level staffId must not
    // force either part to sit idle waiting for s2's one day (Wednesday).
    assert.ok(parts.every((p) => staffOn(p.assignment).every((id) => id === 's1')),
      "the job-level staffId must not leak onto parts that never named anyone themselves");
  });
});

describe('two-person jobs — a second person riding along (training pairs)', () => {
  test('a second person free for the whole plan is stamped onto every day and their time is actually deducted', () => {
    const d = days();
    const out = runScheduler(
      [job('j', { staffId: 's1', secondStaffId: 's2', hoursTotal: 8 })],
      [equip('e1')], [person('s1'), person('s2')], d,
    );
    const a = byId(out, 'j').assignment;
    assert.equal(a.secondStaffUnmet, false);
    assert.ok(a.days.every((entry) => entry.secondStaffId === 's2'), JSON.stringify(a.days));

    // Their calendar is genuinely blocked, not just displayed as if it were —
    // a second, unrelated job also needing s2 must wait for the next day
    // s2's actually free, exactly as it would if s2 were the PRIMARY on a
    // job that Monday, rather than being free to double-book Monday too.
    const out2 = runScheduler(
      [job('j', { staffId: 's1', secondStaffId: 's2', hoursTotal: 8 }), job('other', { staffId: 's2', hoursTotal: 8 })],
      [equip('e1'), equip('e2')], [person('s1'), person('s2')], d,
    );
    assert.notEqual(byId(out2, 'other').assignment.startDate, MONDAY,
      's2 has no hours left Monday — they were genuinely consumed, not just recorded');
  });

  test('never affects who is ELIGIBLE — a second person needs no sign-off on the process at all', () => {
    const d = days();
    // s2 isn't even signed off on 'Weld' (job()'s default process) — the
    // whole point of a training pair is a second person who ISN'T qualified
    // yet. eligibleStaffIds must never have looked at them.
    const out = runScheduler(
      [job('j', { staffId: 's1', secondStaffId: 's2', hoursTotal: 8 })],
      [equip('e1')], [person('s1'), person('s2', { processes: ['Spray'] })], d,
    );
    const a = byId(out, 'j').assignment;
    assert.equal(a.secondStaffUnmet, false, 'sign-off is irrelevant to the second person');
    assert.ok(a.days.every((entry) => entry.secondStaffId === 's2'));
  });

  test('a second person not rostered that day is a soft miss, not a scheduling failure — the job still places', () => {
    const d = days();
    const out = runScheduler(
      [job('j', { staffId: 's1', secondStaffId: 's2', hoursTotal: 8 })],
      [equip('e1')], [person('s1'), person('s2', { roster: rosterOn(['wed']) })], d,
    );
    const a = byId(out, 'j').assignment;
    assert.ok(a, 'the primary still gets placed fine — a missing trainee is not an overbooking');
    assert.equal(a.conflict, false);
    assert.equal(a.secondStaffUnmet, true);
    assert.ok(a.days.every((entry) => !entry.secondStaffId), 'nothing stamped when the pairing could not be honoured');

    // And s2's calendar was never touched — they're free for other work.
    const out2 = runScheduler(
      [job('j', { staffId: 's1', secondStaffId: 's2', hoursTotal: 8 }), job('other', { staffId: 's2', hoursTotal: 8, readyDate: '2026-03-04' })],
      [equip('e1'), equip('e2')], [person('s1'), person('s2', { roster: rosterOn(['wed']) })], d,
    );
    assert.ok(byId(out2, 'other').assignment, 's2 must still be free to pick up other work on their own rostered day');
  });

  test('all-or-nothing: a second person busy on only ONE day of a multi-day plan gets stamped on NONE of it', () => {
    const d = days();
    // s2 is fully booked by an unrelated job on the SECOND day the primary
    // would need them.
    const blocker = job('blocker', {
      staffId: 's2', hoursTotal: 8,
      assignment: { equipmentId: 'e2', startDate: '2026-03-03', endDate: '2026-03-03', pinned: true, days: [] },
    });
    const out = runScheduler(
      [blocker, job('j', { staffId: 's1', secondStaffId: 's2', hoursTotal: 16 })],
      [equip('e1'), equip('e2')], [person('s1'), person('s2')], d,
    );
    const a = byId(out, 'j').assignment;
    assert.equal(a.secondStaffUnmet, true);
    assert.ok(a.days.every((entry) => !entry.secondStaffId),
      'day one must not be stamped just because day two failed — training a partial day is not what was asked for');
  });

  test('a second person with no primary staffId set is simply ignored — no unmet flag, nothing deducted', () => {
    const d = days();
    const out = runScheduler(
      [job('j', { secondStaffId: 's2', hoursTotal: 8 })], // no staffId at all
      [equip('e1')], [person('s1'), person('s2')], d,
    );
    const a = byId(out, 'j').assignment;
    assert.equal(a.secondStaffUnmet, false);
    assert.ok(a.days.every((entry) => !entry.secondStaffId));

    // s2's own calendar is genuinely untouched.
    const out2 = runScheduler(
      [job('j', { secondStaffId: 's2', hoursTotal: 8 }), job('other', { staffId: 's2', hoursTotal: 8 })],
      [equip('e1'), equip('e2')], [person('s1'), person('s2')], d,
    );
    assert.ok(byId(out2, 'other').assignment, 's2 was never actually blocked by a pairing with no primary to anchor it');
  });

  test('naming the same person as both primary and second is a no-op, not a self-deduction glitch', () => {
    const d = days();
    const out = runScheduler(
      [job('j', { staffId: 's1', secondStaffId: 's1', hoursTotal: 8 })],
      [equip('e1')], [person('s1')], d,
    );
    const a = byId(out, 'j').assignment;
    assert.equal(a.secondStaffUnmet, false);
    assert.ok(a.days.every((entry) => !entry.secondStaffId));
    assert.equal(hoursOn(a, MONDAY), 8, 's1 must not have their own hours double-deducted against themselves');
  });

  test('works on a PINNED job the same way it does on an auto-placed one', () => {
    const d = days();
    const out = runScheduler(
      [job('j', {
        staffId: 's1', secondStaffId: 's2', hoursTotal: 8,
        assignment: { equipmentId: 'e1', startDate: MONDAY, endDate: MONDAY, pinned: true, days: [] },
      })],
      [equip('e1')], [person('s1'), person('s2')], d,
    );
    const a = byId(out, 'j').assignment;
    assert.equal(a.pinned, true);
    assert.equal(a.secondStaffUnmet, false);
    assert.ok(a.days.every((entry) => entry.secondStaffId === 's2'));
  });

  test('an overbooked pin (primary has nowhere to go) does not also report a second-person miss on top', () => {
    const d = days();
    // s1 has no hours anywhere in the horizon for this pin to use — forces
    // the placeholder/conflict path, which has no real staffId on its days.
    const blocker = job('blocker', {
      staffId: 's1', hoursTotal: 200,
      assignment: { equipmentId: 'e1', startDate: MONDAY, endDate: MONDAY, pinned: true, days: [] },
    });
    const out = runScheduler(
      [blocker, job('j', {
        staffId: 's1', secondStaffId: 's2', hoursTotal: 8,
        assignment: { equipmentId: 'e1', startDate: MONDAY, endDate: MONDAY, pinned: true, days: [] },
      })],
      [equip('e1')], [person('s1'), person('s2')], d,
    );
    const a = byId(out, 'j').assignment;
    // Whichever of the two ends up the one that lost the day, a genuinely
    // conflicted pin must read secondStaffUnmet:false — the red flag already
    // says everything that needs saying.
    const conflicted = a.conflict ? a : byId(out, 'blocker').assignment;
    assert.equal(conflicted.conflict, true, 'sanity check: one of the two really is conflicted');
    assert.equal(conflicted.secondStaffUnmet, false);
  });

  test("a split job's second-person pairing is per PART, independent of the other part's", () => {
    const d = days();
    const split = job('split', {
      hoursTotal: 16,
      parts: [
        { id: 'p1', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null, staffId: 's1', secondStaffId: 's3' },
        { id: 'p2', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null, staffId: 's2', secondStaffId: null },
      ],
    });
    const out = runScheduler(
      [split], [equip('e1'), equip('e2')],
      [person('s1'), person('s2'), person('s3')],
      d,
    );
    const parts = byId(out, 'split').parts;
    assert.equal(parts[0].secondStaffId, 's3');
    assert.ok(parts[0].assignment.days.every((e) => e.secondStaffId === 's3'));
    assert.equal(parts[1].secondStaffId, null);
    assert.ok(parts[1].assignment.days.every((e) => !e.secondStaffId));
  });

  test("a part's secondStaffId survives repeated recomputes, same as staffId/lockedEquipmentId (#68's fix, same seam)", () => {
    const d = days();
    const split = job('split', {
      hoursTotal: 8,
      parts: [{ id: 'p1', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null, staffId: 's1', secondStaffId: 's2' }],
    });
    const equipment = [equip('e1')];
    const staff = [person('s1'), person('s2')];
    const out1 = runScheduler([split], equipment, staff, d);
    const out2 = runScheduler(out1, equipment, staff, d);
    assert.equal(byId(out2, 'split').parts[0].secondStaffId, 's2',
      'must survive a second recompute, not just the one that set it — collapse needs a key for this too');
  });
});

describe('hard equipment lock — like staffId, but for the machine', () => {
  test('a locked job waits for its machine rather than taking one that would finish sooner', () => {
    const d = days();
    // e1 is tied up for a while; e2 is free the whole time and would
    // ordinarily win on "finishes soonest" — but the job is locked to e1.
    const blocker = job('blocker', {
      hoursTotal: 16,
      assignment: { equipmentId: 'e1', startDate: MONDAY, endDate: MONDAY, pinned: true, days: [] },
    });
    const out = runScheduler(
      [blocker, job('locked', { hoursTotal: 8, lockedEquipmentId: 'e1', dueDate: '2026-03-19' })],
      [equip('e1'), equip('e2')],
      [person('s1'), person('s2')],
      d,
    );
    assert.equal(byId(out, 'locked').assignment.equipmentId, 'e1', 'must wait for its locked machine, not fall back to e2');
  });

  test('unlike a preference, a lock that the machine cannot honour leaves the job unscheduled instead of falling back', () => {
    const d = days();
    const out = runScheduler(
      [job('locked', { hoursTotal: 8, lockedEquipmentId: 'e1' })],
      [equip('e1', { unavailableDates: [...d] }), equip('e2')],
      [person('s1'), person('s2')],
      d,
    );
    assert.equal(byId(out, 'locked').assignment, null, 'e2 is free but the lock forbids using it');
    assert.match(byId(out, 'locked').unschedReason, /no free/i);
  });

  test('a lock onto equipment that cannot run the process leaves the job unscheduled, named specifically', () => {
    const d = days();
    const out = runScheduler(
      [job('locked', { hoursTotal: 8, lockedEquipmentId: 'wrongProcess' })],
      [equip('wrongProcess', { processes: ['Coat'] }), equip('e2')],
      [person('s1')], d,
    );
    assert.equal(byId(out, 'locked').assignment, null);
    assert.match(byId(out, 'locked').unschedReason, /wrongProcess/);
  });

  test("the scheduler still picks the date and the operator — only the machine is fixed", () => {
    const d = days();
    // s1 only works Wednesday, s2 covers the rest — the locked job should
    // still land on whichever operator is actually free, same as automatic.
    const out = runScheduler(
      [job('locked', { hoursTotal: 8, lockedEquipmentId: 'e1' })],
      [equip('e1'), equip('e2')],
      [person('s1', { roster: rosterOn(['wed']) }), person('s2')],
      d,
    );
    const a = byId(out, 'locked').assignment;
    assert.equal(a.equipmentId, 'e1');
    assert.equal(a.pinned, false, 'a lock is not a pin — the day is still auto-chosen and can move on future recomputes');
    assert.deepEqual(staffOn(a), ['s2'], 'the operator is still whoever is free, not fixed by the lock');
  });

  test('a pinned job is unaffected by its own lock — pinning is already a stronger, exact placement', () => {
    const d = days();
    const out = runScheduler(
      [job('pinned-elsewhere', {
        hoursTotal: 8, lockedEquipmentId: 'e1',
        assignment: { equipmentId: 'e2', startDate: MONDAY, endDate: MONDAY, pinned: true, days: [] },
      })],
      [equip('e1'), equip('e2')], [person('s1')], d,
    );
    assert.equal(byId(out, 'pinned-elsewhere').assignment.equipmentId, 'e2');
  });

  test('a locked job is placed before automatic ones, same priority as a manually assigned one', () => {
    const d = days();
    const out = runScheduler(
      [
        job('auto', { dueDate: '2026-03-09', hoursTotal: 8 }),
        job('locked', { dueDate: '2026-03-12', hoursTotal: 8, lockedEquipmentId: 'e1' }),
      ],
      [equip('e1')], [person('s1')], d,
    );
    assert.ok(byId(out, 'locked').assignment.startDate <= byId(out, 'auto').assignment.startDate);
  });

  // #68: unlike preferredEquipmentId (which deliberately still cascades — see
  // scheduler.js), a hard lock is read per PART, not from the parent. Two
  // parts of a split job can genuinely need two different machines (that's
  // the whole reason to split a job in the first place — pulling one part off
  // to make room for something urgent while the rest carries on), so forcing
  // both onto one locked machine was never the right default the way a soft
  // preference cascading is.
  test("a split job's hard equipment lock is per PART, not inherited from the job level", () => {
    const d = days();
    // e1 is tied up for a while; e2 is free the whole time and would win
    // ordinary "finishes soonest" placement.
    const blocker = job('blocker', {
      hoursTotal: 16,
      assignment: { equipmentId: 'e1', startDate: MONDAY, endDate: MONDAY, pinned: true, days: [] },
    });
    const split = job('split', {
      lockedEquipmentId: 'e1', // job-level; must be ignored entirely
      hoursTotal: 16,
      dueDate: '2026-03-19',
      parts: [
        { id: 'p1', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null },
        { id: 'p2', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null, lockedEquipmentId: 'e1' },
      ],
    });
    const out = runScheduler([blocker, split], [equip('e1'), equip('e2')], [person('s1'), person('s2')], d);
    const parts = byId(out, 'split').parts;
    assert.equal(parts[0].assignment.equipmentId, 'e2',
      'unlocked part follows ordinary placement — the job-level lock must not leak onto it');
    assert.equal(parts[1].assignment.equipmentId, 'e1',
      "this part's own lock is honoured independently, waiting for e1 rather than defaulting to e2");
  });

  test('a batch only carries the lock forward if every member agreed on the same machine', () => {
    const d = days();
    const agreed = runScheduler(
      [
        job('b1', { hoursTotal: 8, batchId: 'batchLock', batchOrder: 0, lockedEquipmentId: 'e1' }),
        job('b2', { hoursTotal: 8, batchId: 'batchLock', batchOrder: 1, lockedEquipmentId: 'e1' }),
      ],
      [equip('e1'), equip('e2')], [person('s1')], d,
    );
    assert.equal(byId(agreed, 'b1').assignment.equipmentId, 'e1');
    assert.equal(byId(agreed, 'b2').assignment.equipmentId, 'e1');

    const mixed = runScheduler(
      [
        job('c1', { hoursTotal: 8, batchId: 'batchLock2', batchOrder: 0, lockedEquipmentId: 'e1' }),
        job('c2', { hoursTotal: 8, batchId: 'batchLock2', batchOrder: 1, lockedEquipmentId: 'e2' }),
      ],
      [equip('e1'), equip('e2')], [person('s1')], d,
    );
    // No unanimous lock, so the group places automatically, same as no lock at all.
    assert.ok(byId(mixed, 'c1').assignment, 'the mismatched group should still be schedulable, just unrestricted');
    assert.equal(byId(mixed, 'c1').assignment.equipmentId, byId(mixed, 'c2').assignment.equipmentId);
  });
});

describe('ordering', () => {
  test('equal due dates break toward the job needing further processing', () => {
    const d = days();
    const out = runScheduler(
      [
        job('ships', { dueDate: '2026-03-10', hoursTotal: 8 }),
        job('more-to-do', { dueDate: '2026-03-10', hoursTotal: 8, needsFurtherProcessing: true }),
      ],
      [equip('e1')], [person('s1')], d,
    );
    assert.ok(byId(out, 'more-to-do').assignment.startDate <= byId(out, 'ships').assignment.startDate);
  });

  test('a manually assigned job is placed before automatic ones', () => {
    const d = days();
    // Both want the same single machine and the same person; the locked one
    // has only s1 to draw on, so it gets first call despite the later due date.
    const out = runScheduler(
      [
        job('auto', { dueDate: '2026-03-09', hoursTotal: 8 }),
        job('locked', { dueDate: '2026-03-12', hoursTotal: 8, staffId: 's1' }),
      ],
      [equip('e1')], [person('s1')], d,
    );
    assert.ok(byId(out, 'locked').assignment.startDate <= byId(out, 'auto').assignment.startDate);
  });
});

describe('roster availability', () => {
  test('a non-production day is unavailable to the scheduler', () => {
    const roster = rosterOn(['mon', 'tue', 'wed', 'thu', 'fri']);
    roster.mon = { working: true, production: false, shift: 'day', hours: 8 };
    const info = getStaffDayInfo(person('s1', { roster }), MONDAY);
    assert.equal(info.working, false, 'rostered on but not producing must read as unavailable');

    const out = runScheduler([job('j')], [equip('e1')], [person('s1', { roster })], days());
    assert.ok(byId(out, 'j').assignment.startDate > MONDAY, 'no work should land on the non-production day');
  });

  test('leave of any kind makes the person unavailable', () => {
    for (const kind of ['leave', 'sick', 'training', 'other']) {
      const p = person('s1', { leavePeriods: [{ id: 'lv', kind, startDate: MONDAY, endDate: MONDAY }] });
      assert.equal(getStaffDayInfo(p, MONDAY).working, false, `${kind} should block the day`);
    }
  });

  test('an absent production flag means available (data saved before the flag existed)', () => {
    const roster = rosterOn(['mon']);
    delete roster.mon.production;
    assert.equal(getStaffDayInfo(person('s1', { roster }), MONDAY).working, true);
  });

  test('someone rostered longer than the default 8h shift can work all of it on one job', () => {
    const d = days();
    const longDay = rosterOn(['mon', 'tue', 'wed', 'thu', 'fri'], 'day', 12);
    const out = runScheduler(
      [job('j', { hoursTotal: 12, dueDate: '2026-03-10' })],
      [equip('e1')], [person('s1', { roster: longDay })], d,
    );
    const a = byId(out, 'j').assignment;
    assert.equal(hoursOn(a, MONDAY), 12,
      'the full 12h roster day should go to this one job, not be capped at the default 8h and spill to Tuesday');
    assert.equal(a.startDate, MONDAY);
    assert.equal(a.endDate, MONDAY);
  });

  test('a job under the roster cap keeps its operator all day instead of handing off to a second job', () => {
    const d = days();
    const longDay = rosterOn(['mon', 'tue', 'wed', 'thu', 'fri'], 'day', 12);
    const out = runScheduler(
      [
        job('a', { hoursTotal: 12, dueDate: '2026-03-10' }),
        job('b', { hoursTotal: 12, dueDate: '2026-03-11' }),
      ],
      [equip('e1'), equip('e2')], [person('s1', { roster: longDay })], d,
    );
    const aAssign = byId(out, 'a').assignment;
    assert.equal(hoursOn(aAssign, MONDAY), 12,
      'job a should keep the operator for their whole rostered day before job b gets any of it — the old fixed ' +
      '8h equipment-shift ceiling used to bounce the last 4h onto job b for no reason');
    assert.equal(staffOn(aAssign).length, 1, 'one continuous operator, no mid-day handover forced by a fake cap');
  });

  test('the default 8h ceiling still applies when nobody eligible is rostered longer', () => {
    const d = days();
    const out = runScheduler(
      [job('j', { hoursTotal: 12, dueDate: '2026-03-12' })],
      [equip('e1')], [person('s1')], d, // default person() roster is 8h/day
    );
    const a = byId(out, 'j').assignment;
    assert.equal(hoursOn(a, MONDAY), 8, 'unchanged behaviour for an ordinary 8h-rostered person');
    assert.ok(a.endDate > MONDAY, 'the remaining 4h spill to the next working day, same as before');
  });

  test("two ordinarily-rostered people on the same shift don't get stacked into someone else's longer day (#45)", () => {
    const d = days();
    const longRoster = rosterOn(['mon', 'tue', 'wed', 'thu', 'fri'], 'day', 12);
    const out = runScheduler(
      [
        // s1's entire 12h Monday goes to a different job on different
        // equipment — it's here purely so a longer roster genuinely exists
        // in job j's compatible pool, same as it would on a real shop floor
        // running more than one process that day.
        job('hog', { process: 'Weld', hoursTotal: 12, staffId: 's1', dueDate: '2026-03-10' }),
        job('j', { process: 'Coat', hoursTotal: 12, dueDate: '2026-03-11' }),
      ],
      [equip('e1', { processes: ['Weld'] }), equip('e2', { processes: ['Coat'] })],
      [
        person('s1', { roster: longRoster, processes: ['Weld', 'Coat'] }),
        person('s2', { processes: ['Weld', 'Coat'] }),
        person('s3', { processes: ['Weld', 'Coat'] }),
      ],
      d,
    );
    const a = byId(out, 'j').assignment;
    assert.equal(hoursOn(a, MONDAY), 8,
      "job j should get the ordinary 8h shift on Monday, not 12 stitched together from s2's 8h and s3's 4h just " +
      'because s1 (fully spoken for on a different job) happens to be rostered 12h that day');
    const mondayStaff = new Set(a.days.filter((dd) => dd.date === MONDAY).map((dd) => dd.staffId));
    assert.equal(mondayStaff.size, 1, 'only one person should be needed to cover the ordinary 8h Monday shift');
    assert.ok(a.endDate > MONDAY, 'the remaining 4h spill to the next working day rather than being squeezed into Monday');
  });
});

describe('batches (#47)', () => {
  test('batch members land on the same equipment, back to back, not scattered across machines', () => {
    const d = days();
    const out = runScheduler(
      [
        job('b1', { hoursTotal: 8, batchId: 'batch1', batchOrder: 0 }),
        job('b2', { hoursTotal: 8, batchId: 'batch1', batchOrder: 1 }),
      ],
      [equip('e1'), equip('e2')], [person('s1')], d,
    );
    const a1 = byId(out, 'b1').assignment;
    const a2 = byId(out, 'b2').assignment;
    assert.ok(a1 && a2, 'both members should be placed');
    assert.equal(a1.equipmentId, a2.equipmentId, 'a batch runs on one piece of equipment, not scattered across whichever is free first');
    assert.ok(a2.startDate > a1.endDate, 'the second member starts only once the first is done (one operator, 8h/day)');
  });

  test('batch members can share one day back to back when the hours fit', () => {
    const d = days();
    const out = runScheduler(
      [
        job('b1', { hoursTotal: 5, batchId: 'batch2', batchOrder: 0 }),
        job('b2', { hoursTotal: 3, batchId: 'batch2', batchOrder: 1 }),
      ],
      [equip('e1')], [person('s1')], d,
    );
    const a1 = byId(out, 'b1').assignment;
    const a2 = byId(out, 'b2').assignment;
    assert.equal(a1.startDate, MONDAY);
    assert.equal(a2.startDate, MONDAY, 'the second member picks up the same day the first finishes, not the next one');
    assert.equal(hoursOn(a1, MONDAY) + hoursOn(a2, MONDAY), 8, 'together they use the whole shift');
  });

  test("a mismatched process doesn't get force-combined — falls back to independent scheduling", () => {
    const d = days();
    const out = runScheduler(
      [
        job('b1', { process: 'Weld', hoursTotal: 8, batchId: 'batch3', batchOrder: 0 }),
        job('b2', { process: 'Coat', hoursTotal: 8, batchId: 'batch3', batchOrder: 1 }),
      ],
      [equip('e1', { processes: ['Weld', 'Coat'] })],
      [person('s1', { processes: ['Weld', 'Coat'] })], d,
    );
    assert.ok(byId(out, 'b1').assignment, 'b1 should still be scheduled on its own');
    assert.ok(byId(out, 'b2').assignment, 'b2 should still be scheduled on its own');
  });

  test('a member already pinned on its own breaks it out of the group', () => {
    const d = days();
    const out = runScheduler(
      [
        job('b1', {
          hoursTotal: 8, batchId: 'batch4', batchOrder: 0,
          assignment: { equipmentId: 'e2', startDate: d[3], endDate: d[3], pinned: true, days: [] },
        }),
        job('b2', { hoursTotal: 8, batchId: 'batch4', batchOrder: 1 }),
      ],
      [equip('e1'), equip('e2')], [person('s1')], d,
    );
    const a1 = byId(out, 'b1').assignment;
    const a2 = byId(out, 'b2').assignment;
    assert.equal(a1.equipmentId, 'e2', 'the pinned member keeps its own slot');
    assert.ok(a2, 'the other member is still scheduled, independently');
  });

  test("an unplaceable batch leaves every member unscheduled together, not partially placed", () => {
    const d = days();
    const out = runScheduler(
      [
        job('b1', { hoursTotal: 8, batchId: 'batch5', batchOrder: 0 }),
        job('b2', { hoursTotal: 8, batchId: 'batch5', batchOrder: 1, readyDate: '2099-01-01' }),
      ],
      [equip('e1')], [person('s1')], d,
    );
    assert.equal(byId(out, 'b1').assignment, null);
    assert.equal(byId(out, 'b2').assignment, null);
    assert.ok(byId(out, 'b1').unschedReason, 'should say why, same as any other unplaced job');
  });

  test("one member with no readyDate blocks the whole batch, not just that member (#59)", () => {
    const d = days();
    const out = runScheduler(
      [
        job('b1', { hoursTotal: 8, batchId: 'batch6', batchOrder: 0, readyDate: MONDAY }),
        job('b2', { hoursTotal: 8, batchId: 'batch6', batchOrder: 1, readyDate: null }),
      ],
      [equip('e1')], [person('s1')], d,
    );
    assert.equal(byId(out, 'b1').assignment, null,
      "b1 has a real ready date but is still batched with b2, which doesn't — a blank date must not be silently " +
      'treated as "earliest" and outvoted by the other member\'s real one');
    assert.equal(byId(out, 'b2').assignment, null);
  });
});

describe('split jobs', () => {
  test('parts are placed independently and collapsed back onto the parent', () => {
    const d = days();
    const split = job('split', {
      hoursTotal: 16,
      parts: [
        { id: 'p1', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null },
        { id: 'p2', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null },
      ],
    });
    const out = runScheduler([split], [equip('e1'), equip('e2')], [person('s1'), person('s2')], d);
    const parent = byId(out, 'split');

    assert.equal(parent.assignment, null, "the parent carries no assignment of its own");
    assert.equal(parent.parts.length, 2);
    assert.ok(parent.parts.every((p) => p.assignment), 'both parts should be placed');
    assert.equal(parent.hoursTotal, 16, 'parent hours are the sum of its parts');
  });

  test('parts inherit the parent capability tags', () => {
    const d = days();
    const split = job('split', {
      tags: ['5T Positioner'],
      hoursTotal: 8,
      parts: [{ id: 'p1', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null }],
    });
    const out = runScheduler(
      [split],
      [equip('plain'), equip('big', { tags: ['5T Positioner'] })],
      [person('s1')], d,
    );
    assert.equal(byId(out, 'split').parts[0].assignment.equipmentId, 'big',
      'a part must not be placed on equipment that lacks the parent’s required tag');
  });

  test('a parent is complete only when every part is', () => {
    const d = days();
    const split = job('split', {
      hoursTotal: 16,
      parts: [
        { id: 'p1', hoursTotal: 8, percentComplete: 100, status: 'complete', assignment: null },
        { id: 'p2', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null },
      ],
    });
    assert.equal(byId(runScheduler([split], [equip('e1')], [person('s1')], d), 'split').status, 'active');

    split.parts[1] = { ...split.parts[1], percentComplete: 100, status: 'complete' };
    assert.equal(byId(runScheduler([split], [equip('e1')], [person('s1')], d), 'split').status, 'complete');
  });

  // #18: each part can carry its own name, independent of the parent's and of
  // the other part's. The engine doesn't use it for anything — the risk is
  // purely that flatten/collapse silently drops it, which would erase a
  // user-typed name on the very next recompute (drag, save, anything).
  test('a custom part name survives repeated recomputes', () => {
    const d = days();
    const split = job('split', {
      hoursTotal: 16,
      parts: [
        { id: 'p1', name: 'My Custom Part Name', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null },
        { id: 'p2', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: null }, // no name — legacy part
      ],
    });
    const equipment = [equip('e1'), equip('e2')];
    const staff = [person('s1'), person('s2')];

    const out1 = runScheduler([split], equipment, staff, d);
    const p1 = byId(out1, 'split');
    assert.equal(p1.parts[0].name, 'My Custom Part Name');
    assert.equal(p1.parts[1].name, undefined,
      'a part that never had a name must not have one backfilled — the UI '
      + 'falls back to a computed "(Part N)" label exactly when this is absent');

    // A second pass (what a drag or any other edit triggers) must not lose it.
    const out2 = runScheduler(out1, equipment, staff, d);
    const p2 = byId(out2, 'split');
    assert.equal(p2.parts[0].name, 'My Custom Part Name');
    assert.equal(p2.parts[1].name, undefined);
  });
});

describe('pinned jobs', () => {
  const pin = (date, equipmentId = 'e1') =>
    ({ equipmentId, startDate: date, endDate: date, pinned: true, days: [] });

  test('a pin placed before the job is ready keeps its slot and is flagged', () => {
    const out = runScheduler(
      [job('early', { readyDate: '2026-03-10', assignment: pin(MONDAY) })],
      [equip('e1')], [person('s1')], days(),
    );
    const a = byId(out, 'early').assignment;
    assert.equal(a.startDate, MONDAY, 'the user’s slot is kept');
    assert.equal(a.conflict, true, 'and the problem is surfaced rather than silently resolved');
  });

  test('a pin with nobody signed off on the process keeps its slot and is flagged', () => {
    const out = runScheduler(
      [job('nostaff', { assignment: pin(MONDAY) })],
      [equip('e1')], [person('s1', { processes: ['Spray'] })], days(),
    );
    const a = byId(out, 'nostaff').assignment;
    assert.equal(a.startDate, MONDAY);
    assert.equal(a.conflict, true);
  });

  test('a pin onto equipment that no longer exists is flagged', () => {
    const out = runScheduler(
      [job('gone', { assignment: pin(MONDAY, 'deleted-machine') })],
      [equip('e1')], [person('s1')], days(),
    );
    assert.equal(byId(out, 'gone').assignment.conflict, true);
  });

  // Dropping a job onto an occupied day is the user saying it matters more
  // than what is already there, so the incumbent slides rather than the drop
  // being refused. Only a pin that is *impossible* (above) is flagged instead.
  test('dropping onto an occupied day gives the day to the dropped job', () => {
    // A fresh drop has no claimOrder — the scheduler has not seen it yet.
    const dropped = { ...pin(MONDAY), seedStaffId: null };
    const settled = (claimOrder) => ({ ...pin(MONDAY), claimOrder });

    for (const incumbentOrder of [0, 3]) {
      for (const arrayOrder of [['old', 'new'], ['new', 'old']]) {
        const jobs = arrayOrder.map((k) => (k === 'old'
          ? job('old', { hoursTotal: 8, assignment: settled(incumbentOrder) })
          : job('new', { hoursTotal: 8, assignment: { ...dropped } })));
        const out = runScheduler(jobs, [equip('e1')], [person('s1')], days());

        assert.equal(byId(out, 'new').assignment.startDate, MONDAY,
          `dropped job should hold the day (incumbent claimOrder ${incumbentOrder}, array ${arrayOrder})`);
        assert.ok(byId(out, 'old').assignment.startDate > MONDAY,
          'the job already there should slide, not stay overlapped');
      }
    }
  });

  test('the job that slides is rescheduled cleanly, not flagged as a conflict', () => {
    const out = runScheduler(
      [
        job('old', { hoursTotal: 8, assignment: { ...pin(MONDAY), claimOrder: 0 } }),
        job('new', { hoursTotal: 8, assignment: pin(MONDAY) }),
      ],
      [equip('e1')], [person('s1')], days(),
    );
    const slid = byId(out, 'old').assignment;
    assert.equal(slid.conflict, false, 'sliding is the intended outcome, not an error state');
    assert.equal(slid.pinned, true, 'and it stays pinned — the user still placed it deliberately');
  });
});

describe('whyUnscheduled', () => {
  const d = days();
  test('explains a job with no hours', () => {
    assert.match(whyUnscheduled(job('j', { hoursTotal: 0 }), [equip('e1')], [person('s1')], d), /hours/i);
  });
  test('explains when no equipment runs the process', () => {
    assert.match(whyUnscheduled(job('j', { process: 'Spray' }), [equip('e1')], [person('s1')], d), /Spray/);
  });
  test('explains when no staff are signed off', () => {
    const msg = whyUnscheduled(job('j'), [equip('e1')], [person('s1', { processes: ['Spray'] })], d);
    assert.match(msg, /staff|no one/i);
  });
  test('explains a ready date beyond the horizon', () => {
    assert.match(whyUnscheduled(job('j', { readyDate: '2027-01-01' }), [equip('e1')], [person('s1')], d), /ready/i);
  });
});

describe('stamping', () => {
  test('same-day segments carry a claimOrder so they render in the order claimed', () => {
    const d = days();
    const out = runScheduler(
      [job('five', { hoursTotal: 5, dueDate: '2026-03-10' }), job('three', { hoursTotal: 3, dueDate: '2026-03-11' })],
      [equip('e1')], [person('s1')], d,
    );
    const a = byId(out, 'five').assignment;
    const b = byId(out, 'three').assignment;
    assert.equal(typeof a.claimOrder, 'number');
    assert.equal(typeof b.claimOrder, 'number');
    assert.ok(a.claimOrder < b.claimOrder);
  });

  test('the returned list keeps the input order', () => {
    const d = days();
    const ids = ['c', 'a', 'b'];
    const out = runScheduler(ids.map((i) => job(i)), [equip('e1')], [person('s1')], d);
    assert.deepEqual(out.map((j) => j.id), ids);
  });
});

describe('parallel processing (#30)', () => {
  const pin = (date, equipmentId) => ({ equipmentId, startDate: date, endDate: date, pinned: true, days: [] });
  // One operator, two machines: both jobs are only ever eligible for s1, so
  // pinning both to the same day is a genuine double-booking, not a fixture
  // quirk.
  const equipment = () => [equip('e1'), equip('e2')];
  const oneStaff = () => [person('s1')];

  // A 1-day horizon in these two tests specifically: a pinned job that can't
  // fit its exact day spills forward to the next day it can (that's what the
  // "does not let a job skip equipment exclusivity" test below relies on) —
  // with the usual 20-day horizon j2 would just quietly land on Tuesday
  // instead of genuinely conflicting. Pinning it down to a single day is what
  // makes this a real double-booking with nowhere to spill to.

  test('by default, two jobs pinned to the same day both needing the only operator conflict', () => {
    const out = runScheduler(
      [
        job('j1', { hoursTotal: 8, assignment: pin(MONDAY, 'e1') }),
        job('j2', { hoursTotal: 8, assignment: pin(MONDAY, 'e2') }),
      ],
      equipment(), oneStaff(), days(1),
    );
    const a1 = byId(out, 'j1').assignment;
    const a2 = byId(out, 'j2').assignment;
    assert.equal(a1.conflict, false, 'whoever claims the operator first schedules cleanly');
    assert.equal(a2.conflict, true, 'the second is left overbooked, not silently unassigned with no signal');
    assert.equal(staffOn(a2).length, 0, 'no operator is force-assigned to the one that lost the contest');
  });

  test('findStaffConflictJobs names the job actually holding the needed operator', () => {
    const out = runScheduler(
      [
        job('j1', { name: 'First job', hoursTotal: 8, assignment: pin(MONDAY, 'e1') }),
        job('j2', { name: 'Second job', hoursTotal: 8, assignment: pin(MONDAY, 'e2') }),
      ],
      equipment(), oneStaff(), days(1),
    );
    const conflicted = byId(out, 'j2');
    const culprits = findStaffConflictJobs(conflicted, out, oneStaff());
    assert.deepEqual(culprits.map((j) => j.id), ['j1']);
  });

  test('findStaffConflictJobs returns nothing for a job that isn\'t actually conflicted', () => {
    const out = runScheduler(
      [job('solo', { hoursTotal: 8, assignment: pin(MONDAY, 'e1') })],
      equipment(), oneStaff(), days(),
    );
    assert.deepEqual(findStaffConflictJobs(byId(out, 'solo'), out, oneStaff()), []);
  });

  test('tagging the losing job parallelProcessing resolves the conflict for both', () => {
    const out = runScheduler(
      [
        job('j1', { hoursTotal: 8, assignment: pin(MONDAY, 'e1') }),
        job('j2', { hoursTotal: 8, parallelProcessing: true, assignment: pin(MONDAY, 'e2') }),
      ],
      equipment(), oneStaff(), days(),
    );
    const a1 = byId(out, 'j1').assignment;
    const a2 = byId(out, 'j2').assignment;
    assert.equal(a1.conflict, false);
    assert.equal(a2.conflict, false, 'parallelProcessing lets it share the operator instead of being overbooked');
    assert.deepEqual(staffOn(a1), ['s1']);
    assert.deepEqual(staffOn(a2), ['s1'], 'the same operator genuinely covers both at once');
  });

  test('parallelProcessing does not let a job skip equipment exclusivity', () => {
    // Two jobs pinned to the SAME equipment, same day — a machine can't run
    // two jobs at once regardless of the tag. A pinned job that can't fit its
    // exact day spills forward to the next day it can (same as any pinned
    // job — see the "pinned jobs" tests above), so the signal to check here
    // isn't `conflict` (spilling forward is a clean, non-conflict outcome);
    // it's that the tag didn't let it phase through j1 and keep MONDAY.
    const out = runScheduler(
      [
        job('j1', { hoursTotal: 8, assignment: pin(MONDAY, 'e1') }),
        job('j2', { hoursTotal: 8, parallelProcessing: true, assignment: pin(MONDAY, 'e1') }),
      ],
      equipment(), oneStaff(), days(),
    );
    const a2 = byId(out, 'j2').assignment;
    assert.notEqual(a2.startDate, MONDAY, 'the equipment is still exclusive — j2 must move to a day e1 is actually free');
  });

  test('the tag survives a move and still allows parallel processing against a different job', () => {
    const equip3 = [equip('e1'), equip('e2'), equip('e3')];
    // j2 (tagged) first proved itself against j1 on e2; now re-pin it to e3
    // against a brand-new j3 it has never met before.
    const out = runScheduler(
      [
        job('j1', { hoursTotal: 8, assignment: pin(MONDAY, 'e1') }),
        job('j2', { hoursTotal: 8, parallelProcessing: true, assignment: pin(MONDAY, 'e3') }),
        job('j3', { hoursTotal: 8, assignment: pin(MONDAY, 'e2') }),
      ],
      equip3, oneStaff(), days(),
    );
    const a2 = byId(out, 'j2').assignment;
    assert.equal(a2.conflict, false, 'the tag is a property of the job, not of a specific pairing');
    assert.deepEqual(staffOn(a2), ['s1']);
  });

  test('a split job\'s parts all inherit the parent\'s parallelProcessing tag', () => {
    const split = job('split', {
      hoursTotal: 16,
      parallelProcessing: true,
      parts: [
        { id: 'p1', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: pin(MONDAY, 'e2') },
        { id: 'p2', hoursTotal: 8, percentComplete: 0, status: 'active', assignment: pin(MONDAY, 'e3') },
      ],
    });
    const out = runScheduler(
      [
        job('blocker1', { hoursTotal: 8, assignment: pin(MONDAY, 'e1') }),
        split,
      ],
      [equip('e1'), equip('e2'), equip('e3')], oneStaff(), days(),
    );
    const parent = byId(out, 'split');
    assert.equal(parent.parts[0].assignment.conflict, false);
    assert.equal(parent.parts[1].assignment.conflict, false);
  });
});

describe('completed jobs (#49)', () => {
  test("a completed job's slot stays reserved by default — nothing slides into it", () => {
    const d = days();
    const out = runScheduler(
      [
        job('done', {
          hoursTotal: 8, status: 'complete', completedDate: MONDAY,
          assignment: {
            equipmentId: 'e1', startDate: MONDAY, endDate: MONDAY, pinned: true, conflict: false,
            days: [{ date: MONDAY, shift: 'day', staffId: 's1', hours: 8 }],
          },
        }),
        job('next', { hoursTotal: 8, dueDate: '2026-03-10' }),
      ],
      [equip('e1')], [person('s1')], d,
    );
    const a = byId(out, 'next').assignment;
    assert.ok(a.startDate > MONDAY, "the still-active job must not slide into the completed job's slot");
  });

  test('finishing early frees only the time actually saved, not the whole slot', () => {
    const d = days();
    const out = runScheduler(
      [
        job('done', {
          hoursTotal: 8, actualHours: 5, status: 'complete', completedDate: MONDAY,
          assignment: {
            equipmentId: 'e1', startDate: MONDAY, endDate: MONDAY, pinned: true, conflict: false,
            days: [{ date: MONDAY, shift: 'day', staffId: 's1', hours: 8 }],
          },
        }),
        job('next', { hoursTotal: 3, dueDate: '2026-03-10' }),
      ],
      [equip('e1')], [person('s1')], d,
    );
    const a = byId(out, 'next').assignment;
    assert.equal(a.startDate, MONDAY, 'the 3h saved should be free for the next job to use the same day');
    assert.equal(hoursOn(a, MONDAY), 3);
  });

  test('actualHours greater than or equal to the estimate reserves the full original slot, same as no actualHours at all', () => {
    const d = days();
    const out = runScheduler(
      [
        job('done', {
          hoursTotal: 8, actualHours: 10, status: 'complete', completedDate: MONDAY,
          assignment: {
            equipmentId: 'e1', startDate: MONDAY, endDate: MONDAY, pinned: true, conflict: false,
            days: [{ date: MONDAY, shift: 'day', staffId: 's1', hours: 8 }],
          },
        }),
        job('next', { hoursTotal: 8, dueDate: '2026-03-10' }),
      ],
      [equip('e1')], [person('s1')], d,
    );
    const a = byId(out, 'next').assignment;
    assert.ok(a.startDate > MONDAY, 'taking longer than estimated is not a reason to free up any of the slot');
  });
});

describe('equipment blocked out for a day (#53)', () => {
  test('an unpinned job is never auto-placed onto a day marked unavailable for that equipment', () => {
    const d = days();
    const out = runScheduler(
      [job('j', { hoursTotal: 8, dueDate: '2026-03-10' })],
      [equip('e1', { unavailableDates: [MONDAY] })], [person('s1')], d,
    );
    const a = byId(out, 'j').assignment;
    assert.ok(a, 'the job should still be scheduled — just not on the blocked day');
    assert.notEqual(a.startDate, MONDAY, "must not land on the equipment's blocked day");
  });

  test('a second machine is used when the first is blocked out on the day that would otherwise be earliest', () => {
    const d = days();
    const out = runScheduler(
      [job('j', { hoursTotal: 8, dueDate: '2026-03-10' })],
      [equip('e1', { unavailableDates: [MONDAY] }), equip('e2')], [person('s1')], d,
    );
    const a = byId(out, 'j').assignment;
    assert.equal(a.equipmentId, 'e2', 'e1 is blocked on the earliest day, so the free machine should be used instead');
    assert.equal(a.startDate, MONDAY);
  });

  test('a pinned job whose day becomes blocked is flagged conflicted, not silently moved', () => {
    const d = days();
    const out = runScheduler(
      [job('j', {
        hoursTotal: 8,
        assignment: { equipmentId: 'e1', startDate: MONDAY, endDate: MONDAY, pinned: true, days: [] },
      })],
      [equip('e1', { unavailableDates: [MONDAY] })], [person('s1')], d,
    );
    const a = byId(out, 'j').assignment;
    assert.equal(a.conflict, true, "a pin onto a now-blocked day must be flagged, not just disappear or quietly relocate");
    assert.equal(a.startDate, MONDAY, 'it stays visible where the user left it, same as any other overbooked pin');
  });
});

describe('shift handovers stay physically plausible (#57)', () => {
  test("two people ordinarily rostered a SHORTENED day (e.g. a 6h Saturday) can't combine for more than that day's real window (#59)", () => {
    // A wide horizon and modest total: what's under test is whether the
    // FIRST Saturday caps at 6h despite two people being available, not
    // whether the whole job fits — the remaining 4h is expected to spill to
    // the following Saturday (there's only one working day a week here).
    const d = days(60);
    const saturday = '2026-03-07'; // the Saturday following MONDAY
    const shortSat = rosterOn(['sat'], 'day', 6);
    const out = runScheduler(
      [job('j', { process: 'Coat', hoursTotal: 10, readyDate: MONDAY, dueDate: '2026-06-01' })],
      [equip('e1', { processes: ['Coat'] })],
      [
        person('s1', { roster: shortSat, processes: ['Coat'] }),
        person('s2', { roster: shortSat, processes: ['Coat'] }),
      ],
      d,
    );
    const a = byId(out, 'j').assignment;
    assert.equal(hoursOn(a, saturday), 6,
      "s1 and s2 are each individually rostered a real 6h Saturday — combined they still can't exceed 6h that day, " +
      'the same bug #57 fixed for weekdays (a flat 8h shared ceiling let two different people combine for more ' +
      "hours than the day's own window actually allows), just triggered here by the shared ceiling itself being " +
      "wrong for a shortened day instead of by a leftover personal extension");
    const satStaff = a.days.filter((dd) => dd.date === saturday).map((dd) => dd.staffId);
    assert.equal(new Set(satStaff).size, 1, 'only one of them should be needed to cover the real 6h Saturday window');
  });


  test("a long-rostered person's own extra hours can't be topped up by a second, ordinarily-rostered person past the shared 8h", () => {
    const d = days();
    const longRoster = rosterOn(['mon', 'tue', 'wed', 'thu', 'fri'], 'day', 12);
    const out = runScheduler(
      [
        // Eats 2h of s1's Monday on a different job/process first, so s1
        // shows up for job j with 10h left on their 12h roster instead of
        // the full 12 — still enough to outrank s2's ordinary 8h on
        // contribution (so s1 fills the shift first, same as before), but
        // not enough to cover the whole extended day alone.
        job('other', { process: 'Weld', hoursTotal: 2, staffId: 's1', dueDate: '2026-03-05' }),
        job('j', { process: 'Coat', hoursTotal: 20, dueDate: '2026-03-20' }),
      ],
      [equip('e1', { processes: ['Weld'] }), equip('e2', { processes: ['Coat'] })],
      [
        person('s1', { roster: longRoster, processes: ['Weld', 'Coat'] }),
        person('s2', { processes: ['Weld', 'Coat'] }),
      ],
      d,
    );
    const a = byId(out, 'j').assignment;
    assert.equal(hoursOn(a, MONDAY), 10,
      "s1 should get their own 10h remaining on their 12h roster, but s2 shouldn't be able to add anything on top " +
      'of it once the ordinary 8h shared shift is spoken for — s1 used 8 of it plus 2 of their own personal ' +
      "extension, so there's nothing shared left for a second, different person to draw on. Letting it through " +
      "would mean two people logging 12h between them on one job in one day, which isn't physically possible: an " +
      "8h shift covers the FIRST 8 hours of the day, not whichever hours happen to be left over.");
    const mondayStaff = a.days.filter((dd) => dd.date === MONDAY).map((dd) => dd.staffId);
    assert.ok(!mondayStaff.includes('s2'), 's2 should not appear on Monday at all — there was no shared capacity left for them');
  });

  test("a longer-rostered person still gets their own overtime hours even when an ordinarily-rostered person fills the shared shift first", () => {
    const d = days();
    const longRoster = rosterOn(['mon', 'tue', 'wed', 'thu', 'fri'], 'day', 12);
    const out = runScheduler(
      [
        // Trims s1 (the 12h-rostered one) to only 6h left on Monday, so their
        // contribution() that day (6) comes in under s2's full ordinary 8 —
        // s2 sorts first and fills the whole shared 8h. s1 must still be able
        // to pick up their own 4h of individually-justified overtime after
        // that, purely on their own roster's merits, not on having gone first.
        job('other', { process: 'Weld', hoursTotal: 6, staffId: 's1', dueDate: '2026-03-05' }),
        job('j', { process: 'Coat', hoursTotal: 30, dueDate: '2026-03-20' }),
      ],
      [equip('e1', { processes: ['Weld'] }), equip('e2', { processes: ['Coat'] })],
      [
        person('s1', { roster: longRoster, processes: ['Weld', 'Coat'] }),
        person('s2', { processes: ['Weld', 'Coat'] }),
      ],
      d,
    );
    const a = byId(out, 'j').assignment;
    assert.equal(hoursOn(a, MONDAY), 12,
      "s2's ordinary 8h plus s1's own 4h of overtime should both land on Monday (12h total) — s1 individually " +
      'rostered 12h that day, so nothing stops them covering the back end of the shift themselves even though s2, ' +
      'not them, happened to fill the shared portion first');
    const mondayStaff = a.days.filter((dd) => dd.date === MONDAY).map((dd) => dd.staffId);
    assert.deepEqual(mondayStaff, ['s2', 's1'], 's2 fills the shared 8h first (higher contribution that day), then s1 picks up their own remaining overtime');
  });

  test("a sub-4h handover is skipped when neither the person nor the job actually needs it that short", () => {
    const d = days();
    const out = runScheduler(
      [
        // Trims s1 to 7h and s2 to 6h left on their ordinary 8h Mondays, so
        // the shift fills 7 (s1) + a mere 1h leftover — not worth handing to
        // s2 when s2 still has plenty of their own day left and the job has
        // plenty more work to give them.
        job('trim1', { process: 'Weld', hoursTotal: 1, staffId: 's1', dueDate: '2026-03-05' }),
        job('trim2', { process: 'Weld', hoursTotal: 2, staffId: 's2', dueDate: '2026-03-05' }),
        job('j', { process: 'Coat', hoursTotal: 30, dueDate: '2026-03-20' }),
      ],
      [equip('e1', { processes: ['Weld'] }), equip('e2', { processes: ['Coat'] })],
      [
        person('s1', { processes: ['Weld', 'Coat'] }),
        person('s2', { processes: ['Weld', 'Coat'] }),
      ],
      d,
    );
    const a = byId(out, 'j').assignment;
    assert.equal(hoursOn(a, MONDAY), 7, 'only s1\'s 7h should land on Monday — the 1h left in the shift should sit idle rather than force a handover');
    const mondayStaff = a.days.filter((dd) => dd.date === MONDAY).map((dd) => dd.staffId);
    assert.deepEqual(mondayStaff, ['s1'], 's2 should not be pulled in for a 1h sliver when their own day and the job both have plenty more to give');
    assert.ok(a.endDate > MONDAY, "the unused hour isn't recovered elsewhere that day — the rest of the job's need spills to the next working day");
  });

  test('exception: a short handover still happens when the second person is themselves near the end of their day', () => {
    const d = days();
    const out = runScheduler(
      [
        job('trim1', { process: 'Weld', hoursTotal: 2, staffId: 's1', dueDate: '2026-03-05' }),
        job('trim2', { process: 'Weld', hoursTotal: 6, staffId: 's2', dueDate: '2026-03-05' }),
        job('j', { process: 'Coat', hoursTotal: 30, dueDate: '2026-03-20' }),
      ],
      [equip('e1', { processes: ['Weld'] }), equip('e2', { processes: ['Coat'] })],
      [
        person('s1', { processes: ['Weld', 'Coat'] }),
        person('s2', { processes: ['Weld', 'Coat'] }),
      ],
      d,
    );
    const a = byId(out, 'j').assignment;
    assert.equal(hoursOn(a, MONDAY), 8,
      "s1's 6h plus s2's last 2h of their own day should both land on job j — s2 only had 2h of their own shift " +
      "left regardless, so a short stint is genuinely all they had to give, not a workaround being routed around");
    const mondayStaff = a.days.filter((dd) => dd.date === MONDAY).map((dd) => dd.staffId);
    assert.deepEqual(mondayStaff, ['s1', 's2']);
  });

  test("exception: a short handover still happens when the job's own remaining need is genuinely under 4h", () => {
    const d = days();
    const out = runScheduler(
      [
        // Trims both s1 and s2 to the same 6h remaining and the same load,
        // so s1 (alphabetically first) fills the shift first, same as any
        // other genuine tie — leaving s2 a well-earned but small 2h leftover
        // once the 8h job itself, not either person's day, runs out.
        job('trim1', { process: 'Weld', hoursTotal: 2, staffId: 's1', dueDate: '2026-03-05' }),
        job('trim2', { process: 'Weld', hoursTotal: 2, staffId: 's2', dueDate: '2026-03-05' }),
        job('j', { process: 'Coat', hoursTotal: 8, dueDate: '2026-03-20' }),
      ],
      [equip('e1', { processes: ['Weld'] }), equip('e2', { processes: ['Coat'] })],
      [
        person('s1', { processes: ['Weld', 'Coat'] }),
        person('s2', { processes: ['Weld', 'Coat'] }),
      ],
      d,
    );
    const a = byId(out, 'j').assignment;
    assert.equal(hoursOn(a, MONDAY), 8,
      "s1's 6h plus s2's last 2h should both land on Monday and finish the job outright — the job only had 2h " +
      'left to give after s1, so there was never a bigger stint to offer s2 instead');
    const mondayStaff = a.days.filter((dd) => dd.date === MONDAY).map((dd) => dd.staffId);
    assert.deepEqual(mondayStaff, ['s1', 's2']);
    assert.equal(a.endDate, MONDAY, 'the job finishes the same day, not spilling for no reason');
  });
});
