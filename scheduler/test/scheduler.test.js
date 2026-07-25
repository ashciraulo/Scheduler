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
