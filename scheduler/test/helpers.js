/* Builders for scheduler fixtures. The engine takes plain data, so a test only
   needs to describe the bits it cares about — everything else defaults to
   something unremarkable, which keeps each test about one invariant. */

import { generateCalendarDays, defaultWeeklyRoster } from '../src/scheduler.js';

// A fixed Monday, so weekday/weekend behaviour is deterministic rather than
// dependent on the day the suite happens to run.
export const MONDAY = '2026-03-02';

export const days = (n = 20, from = MONDAY) => generateCalendarDays(from, n);

export function equip(id, over = {}) {
  return {
    id,
    name: id,
    type: 'Welding Robot',
    tags: [],
    processes: ['Weld'],
    unavailableDates: [],
    ...over,
  };
}

export function person(id, over = {}) {
  const { roster, ...rest } = over;
  return {
    id,
    name: id,
    processes: ['Weld'],
    weeklyRoster: roster || defaultWeeklyRoster('day'),
    leavePeriods: [],
    ...rest,
  };
}

export function job(id, over = {}) {
  return {
    id,
    name: id,
    process: 'Weld',
    quantity: 1,
    hoursTotal: 8,
    readyDate: MONDAY,
    dueDate: '2026-03-20',
    templateId: null,
    tags: [],
    staffId: null,
    needsFurtherProcessing: false,
    percentComplete: 0,
    status: 'active',
    completedDate: null,
    assignment: null,
    ...over,
  };
}

/** A roster where only the named weekdays are worked. */
export function rosterOn(dayKeys, shift = 'day', hours = 8) {
  const r = defaultWeeklyRoster(shift);
  Object.keys(r).forEach((k) => {
    r[k] = dayKeys.includes(k)
      ? { working: true, production: true, shift, hours }
      : { working: false, production: true, shift: 'day', hours: 0 };
  });
  return r;
}

/** Every date a job (or a part) has hours on. */
export const datesOf = (a) => (a?.days || []).map((d) => d.date);

/** Everyone who worked on it, in the order they first appear. */
export function staffOn(a) {
  const seen = [];
  (a?.days || []).forEach((d) => { if (d.staffId && !seen.includes(d.staffId)) seen.push(d.staffId); });
  return seen;
}

export const hoursOn = (a, date) =>
  (a?.days || []).filter((d) => d.date === date).reduce((s, d) => s + d.hours, 0);

export const byId = (jobs, id) => jobs.find((j) => j.id === id);
