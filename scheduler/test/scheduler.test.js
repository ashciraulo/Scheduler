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
  findStaffConflictJobs,
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
