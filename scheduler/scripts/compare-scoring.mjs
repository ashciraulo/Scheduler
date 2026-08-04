/* ============================================================================
   Compare the two placement paths side by side.
   ----------------------------------------------------------------------------
   The weighted-scoring path (src/placementScore.js) is opt-in and off by
   default precisely so it can't disturb a tool that already works. That makes
   this script the point of the exercise: it runs BOTH paths over the same
   input and prints only what differs, so the change can be judged on real work
   before anyone opts into it.

   Usage:
     npm run compare-scoring                        # built-in demo workload
     npm run compare-scoring -- path/to/data.json   # your real schedule

   The file can be either:
     - a shared-mode `scheduler-data.json` from a host PC ({version, entries})
     - a plain object of the storage keys ({ wf_jobs, wf_equipment, wf_staff })
   Values may be JSON strings (as the shared store writes them) or real
   objects — both are handled.

   It is READ-ONLY. It never writes to the file it is given, and never touches
   the app's storage.
   ============================================================================ */

import { readFileSync } from 'node:fs';
import { runScheduler, generateCalendarDays, isoDate, defaultWeeklyRoster } from '../src/scheduler.js';
import { DEFAULT_WEIGHTS } from '../src/placementScore.js';

const HISTORY_DAYS = 90;
const HORIZON_DAYS = 150;

/* ---------- input ---------- */

function unwrap(v) {
  return typeof v === 'string' ? JSON.parse(v) : v;
}

function loadFromFile(path) {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const entries = raw && typeof raw === 'object' && raw.entries ? raw.entries : raw;
  const jobs = unwrap(entries.wf_jobs) || [];
  const equipment = unwrap(entries.wf_equipment) || [];
  const staff = unwrap(entries.wf_staff) || [];
  if (!jobs.length) throw new Error(`no jobs found in ${path}`);
  return { jobs, equipment, staff, label: path };
}

// A small but non-trivial workload: two interchangeable machines and one
// specialist, three operators, and a mix of jobs — some with a preference,
// some with a tight due date — which is where the two paths actually diverge.
function demoWorkload() {
  const today = isoDate(new Date());
  const plus = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return isoDate(d);
  };
  const equipment = [
    { id: 'cell_a', name: 'Weld Cell A', processes: ['Weld'], tags: [], unavailableDates: [] },
    { id: 'cell_b', name: 'Weld Cell B', processes: ['Weld'], tags: [], unavailableDates: [] },
    { id: 'cell_hd', name: 'Heavy Duty Cell', processes: ['Weld'], tags: ['5T Positioner'], unavailableDates: [] },
  ];
  const staff = ['Alex', 'Blake', 'Casey'].map((name, i) => ({
    id: `st_${i + 1}`, name, processes: ['Weld'],
    weeklyRoster: defaultWeeklyRoster('day'), leavePeriods: [],
  }));
  const mk = (id, over) => ({
    id, name: id, process: 'Weld', quantity: 1, tags: [], staffId: null,
    preferredEquipmentId: null, lockedEquipmentId: null, readyDate: today,
    dueDate: plus(30), departmentDueDate: null, status: 'active',
    percentComplete: 0, assignment: null, hoursTotal: 16, ...over,
  });
  const jobs = [
    // Occupies Cell A for a fortnight, so anything preferring it must wait.
    mk('Long Runner (fills Cell A)', {
      hoursTotal: 80,
      assignment: { equipmentId: 'cell_a', startDate: today, endDate: today, pinned: true, days: [] },
    }),
    // The headline divergence: prefers the machine that's now booked solid.
    mk('Prefers Cell A, due soon', { preferredEquipmentId: 'cell_a', dueDate: plus(10) }),
    // Same preference, but with all the time in the world.
    mk('Prefers Cell A, no rush', { preferredEquipmentId: 'cell_a', dueDate: plus(120) }),
    mk('Needs the positioner', { tags: ['5T Positioner'] }),
    mk('Ordinary job 1', { hoursTotal: 24 }),
    mk('Ordinary job 2', { hoursTotal: 8, dueDate: plus(12) }),
  ];
  return { jobs, equipment, staff, label: 'built-in demo workload' };
}

/* ---------- comparison ---------- */

function summarise(jobs) {
  const byId = new Map();
  jobs.forEach((j) => {
    const units = Array.isArray(j.parts) && j.parts.length
      ? j.parts.map((p, i) => [`${j.name} (part ${i + 1})`, p.assignment])
      : [[j.name, j.assignment]];
    units.forEach(([name, a]) => byId.set(name, a));
  });
  return byId;
}

function fmt(a, equipName) {
  if (!a) return 'unscheduled';
  return `${equipName(a.equipmentId)} ${a.startDate}→${a.endDate}`;
}

function main() {
  const path = process.argv[2];
  const { jobs, equipment, staff, label } = path ? loadFromFile(path) : demoWorkload();

  const start = new Date();
  start.setDate(start.getDate() - HISTORY_DAYS);
  const days = generateCalendarDays(isoDate(start), HISTORY_DAYS + HORIZON_DAYS);
  const todayIdx = HISTORY_DAYS;

  const equipName = (id) => equipment.find((e) => e.id === id)?.name || id || '—';

  // Deep-copy per run: runScheduler reads each job's existing assignment as
  // continuity seed, so the two runs must not see each other's output.
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const legacy = summarise(runScheduler(clone(jobs), equipment, staff, days, todayIdx));
  const trace = [];
  const scored = summarise(
    runScheduler(clone(jobs), equipment, staff, days, todayIdx, { weights: DEFAULT_WEIGHTS, trace }),
  );

  console.log(`\nComparing placement paths over: ${label}`);
  console.log(`${jobs.length} job(s), ${equipment.length} machine(s), ${staff.length} staff\n`);

  const names = [...new Set([...legacy.keys(), ...scored.keys()])];
  const changed = names.filter((n) => fmt(legacy.get(n), equipName) !== fmt(scored.get(n), equipName));

  if (!changed.length) {
    console.log('No differences — both paths place every job identically on this input.\n');
  } else {
    console.log(`${changed.length} of ${names.length} placement(s) differ:\n`);
    for (const name of changed) {
      console.log(`  ${name}`);
      console.log(`    current : ${fmt(legacy.get(name), equipName)}`);
      console.log(`    scored  : ${fmt(scored.get(name), equipName)}`);
      // Why: the term-by-term margin between what scoring picked and what the
      // current path would have picked. This is the same breakdown a learning
      // pass would read, shown to a human instead.
      const t = trace.find((x) => x.candidates.length > 1 && x.chosenEquipId === scored.get(name)?.equipmentId);
      const alt = t?.candidates.find((c) => c.equipId === legacy.get(name)?.equipmentId);
      if (t && alt) {
        const win = t.candidates[0];
        const diffs = Object.keys(win.features)
          .filter((k) => win.features[k] !== alt.features[k])
          .map((k) => `${k} ${alt.features[k]}→${win.features[k]}`);
        if (diffs.length) console.log(`    because : ${diffs.join(', ')} (margin ${(win.score - alt.score).toFixed(0)})`);
      }
      console.log('');
    }
  }

  const late = (m) => names.filter((n) => m.get(n) === null || m.get(n) === undefined).length;
  console.log(`Unscheduled — current: ${late(legacy)}, scored: ${late(scored)}`);
  console.log('\nThis script only reports. Nothing was written, and the app still runs the current path.\n');
}

main();
