/* Rework + Quality tab: marking a completed job as needing rework creates a
   new, independently-schedulable job (job.isRework/reworkOfJobId) rather
   than reopening the original — see "Rework" in scheduler/CLAUDE.md and
   createRework() in WeldingScheduler.jsx. Reworks are ordinary jobs in
   every other respect, so hours logging and completion reuse the existing
   machinery untouched; what's actually new, and worth guarding here, is:
   - "Mark for rework" only appears on a completed, non-split job
   - the original job's own record (status/completedDate/actualHours) is
     never touched by creating a rework
   - the new job carries the link back, and the original shows the link
     forward, both clickable
   - the Quality tab lists rework jobs with hours logged and cost, computed
     with the same loggedHours/jobCost helpers as any other job
   - isRework/reworkOfJobId survive an unrelated edit + save from JobModal,
     not just the initial creation (#59-style "fresh object" trap) */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');

  // ---- seed a completed job with a procedure assigned, so cost calculates ----
  await page.evaluate(() => {
    const staff = [{
      id: 'st_1', name: 'Alex', processes: ['Robotic MIG Welding'],
      weeklyRoster: {
        mon: { working: true, production: true, shift: 'day', hours: 8 },
        tue: { working: true, production: true, shift: 'day', hours: 8 },
        wed: { working: true, production: true, shift: 'day', hours: 8 },
        thu: { working: true, production: true, shift: 'day', hours: 8 },
        fri: { working: true, production: true, shift: 'day', hours: 8 },
        sat: { working: false, production: true, shift: 'day', hours: 0 },
        sun: { working: false, production: true, shift: 'day', hours: 0 },
      },
      leavePeriods: [], color: null,
    }];
    const equipment = [{ id: 'eq_1', name: 'Cell 1', type: 'Welding Robot', tags: [], processes: ['Robotic MIG Welding'], unavailableDates: [] }];
    const procedures = [{
      id: 'proc_1', name: 'Standard MIG procedure', process: 'Robotic MIG Welding', costCentreId: '', substrate: '', notes: '',
      powder: {}, gases: [], electricity: {}, spares: [], maintenance: [], consumables: [],
      labour: [{ name: 'Welder', rate: 50, count: 1 }], qa: [],
    }];
    const jobs = [{
      id: 'job_orig', name: 'Bracket Weld Batch 12', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: '2026-01-01', templateId: null, notes: '',
      totalValue: 0, departmentValue: 0, percentComplete: 100, needsFurtherProcessing: false,
      status: 'complete', completedDate: '2026-07-01', actualHours: 9, batchId: null, batchOrder: null,
      tags: [], procedureId: 'proc_1', bcJobNo: '', bcJobTaskNo: '', staffId: null,
      updatedAt: new Date().toISOString(), assignment: null,
    }];
    localStorage.setItem('wf::wf_staff', JSON.stringify(staff));
    localStorage.setItem('wf::wf_equipment', JSON.stringify(equipment));
    localStorage.setItem('wf::wf_procedures', JSON.stringify(procedures));
    localStorage.setItem('wf::wf_costcentres', JSON.stringify([]));
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(400);

  // ---- "Mark for rework" only shows on a completed job ----
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(300);
  await page.click('button:text-is("complete")'); // filter defaults to "active"; the seed job is complete
  await page.waitForTimeout(200);
  const row = page.locator('tr', { hasText: 'Bracket Weld Batch 12' });
  await row.locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);

  const modal = () => page.locator(modalSel);
  check('Mark for rework is offered on a completed job', (await modal().locator('button:has-text("Mark for rework")').count()) === 1);

  await modal().locator('button:has-text("Mark for rework")').click();
  await page.waitForTimeout(300);
  check('the job modal closes and the rework modal opens in its place',
        (await page.locator('text=Mark for rework').count()) > 0 && (await page.locator('h2:has-text("Mark for rework")').count()) === 1
        || (await page.locator(modalSel, { hasText: 'Creates a new job' }).count()) === 1);

  const reworkModal = page.locator(modalSel, { hasText: 'Creates a new job' });
  await reworkModal.locator('textarea').fill('Porosity found on final inspection');
  const hoursInput = reworkModal.locator('input[type=number]');
  await hoursInput.fill('2');
  await reworkModal.getByRole('button', { name: /Create rework job/i }).click();
  await page.waitForTimeout(700);

  const state = await page.evaluate(() => {
    const jobs = JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]');
    return { orig: jobs.find((j) => j.id === 'job_orig'), rework: jobs.find((j) => j.isRework) };
  });

  check('a new linked rework job was created', !!state.rework, JSON.stringify(state.rework));
  check('the rework links back to the original', state.rework?.reworkOfJobId === 'job_orig');
  check('the rework carries the reason into its notes', state.rework?.notes === 'Porosity found on final inspection');
  check('the rework inherits the process and procedure', state.rework?.process === 'Robotic MIG Welding' && state.rework?.procedureId === 'proc_1');
  check('the rework got its own hours, not the original\'s', state.rework?.hoursTotal === 2);
  check('the original job\'s status is untouched', state.orig?.status === 'complete');
  check('the original job\'s completedDate is untouched', state.orig?.completedDate === '2026-07-01');
  check('the original job\'s actualHours is untouched', state.orig?.actualHours === 9);

  // ---- the Quality tab lists it, with cost from the procedure ----
  await page.click('nav >> text=Quality');
  await page.waitForTimeout(400);
  const qualityText = await page.locator('main').innerText();
  check('the Quality tab shows the rework job', qualityText.includes('Bracket Weld Batch 12 — Rework'));
  check('the Quality tab shows the linked original', qualityText.includes('Bracket Weld Batch 12'));
  // 2h × $50/hr labour, blended at the default 75% efficiency (no average
  // labour cost seeded) — see "Costing: efficiency and average labour
  // cost" in scheduler/CLAUDE.md — so 2h × $37.50/hr = $75.00, not a flat
  // 2h × $50.
  check('the Quality tab calculates cost from the procedure', qualityText.includes('75.00'), qualityText);

  // ---- rework badge shows on the Backlog ----
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(300);
  check('the rework job is badged on the Backlog', (await page.locator('tr', { hasText: 'Bracket Weld Batch 12 — Rework' }).locator('text=rework').count()) === 1);

  // ---- forward/back links in the job modal ----
  await page.locator('tr', { hasText: 'Bracket Weld Batch 12 — Rework' }).locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  check('the rework job shows a link back to the original', (await modal().locator('text=Rework of').count()) === 1);

  await modal().locator('button:has-text("Bracket Weld Batch 12")').click();
  await page.waitForTimeout(500);
  check('clicking the link opens the original job',
        (await page.locator(modalSel).locator('input[value="Bracket Weld Batch 12"]').count()) > 0);
  check('the original shows a link forward to its rework', (await page.locator(modalSel).locator('text=Rework logged against this job').count()) === 1);

  // ---- hours logged against the rework flow through the same daily log as any job ----
  await page.evaluate(() => {
    const jobs = JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]');
    const rw = jobs.find((j) => j.isRework);
    localStorage.setItem('wf::wf_timelog', JSON.stringify([
      { id: 'tl_1', jobId: rw.id, date: '2026-07-05', hours: 1.5, staffId: 'st_1', note: '' },
    ]));
  });
  await page.keyboard.press('Escape');
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Quality');
  await page.waitForTimeout(400);
  const qualityAfterLog = await page.locator('main').innerText();
  check('logged hours against the rework show up on the Quality tab', /1\.5h/.test(qualityAfterLog), qualityAfterLog);

  // ---- editing ANY field on the rework and saving must not silently drop
  // isRework/reworkOfJobId — JobModal's handleSave builds a fresh `data`
  // object rather than merging into the existing job (same trap as
  // batchId/batchOrder, #59), so a field added here without an explicit
  // carry-through vanishes the moment the job is next saved. Reported from
  // testing: adding a procedure to a rework job made it disappear from the
  // Quality tab and show up only as an ordinary job. ----
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(300);
  await page.locator('tr', { hasText: 'Bracket Weld Batch 12 — Rework' }).locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  await modal().locator('textarea').first().fill('Edited during testing — unrelated change');
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(500);

  const afterEdit = await page.evaluate((id) => {
    const jobs = JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]');
    return jobs.find((j) => j.id === id);
  }, state.rework.id);
  check('isRework survives an unrelated edit + save', afterEdit?.isRework === true, JSON.stringify(afterEdit));
  check('reworkOfJobId survives an unrelated edit + save', afterEdit?.reworkOfJobId === 'job_orig', JSON.stringify(afterEdit?.reworkOfJobId));

  await page.click('nav >> text=Quality');
  await page.waitForTimeout(400);
  check('the rework job is STILL listed on the Quality tab after being edited',
        (await page.locator('main').innerText()).includes('Bracket Weld Batch 12 — Rework'));

  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(300);
  check('the rework badge is STILL on the Backlog row after being edited',
        (await page.locator('tr', { hasText: 'Bracket Weld Batch 12 — Rework' }).locator('text=rework').count()) === 1);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'rework-quality';
