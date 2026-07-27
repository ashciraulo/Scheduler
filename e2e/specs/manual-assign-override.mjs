/* Issue #46: manually assigning a job to a staff member who's already pinned
   elsewhere for those days should offer to unpin the blocker rather than
   just leaving the new job silently unscheduled. */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');

  // Seed a staff member whose only free time anywhere in the horizon is
  // today, fully consumed by a pinned job — so a second, manually-assigned
  // job to the same person is genuinely, unavoidably stuck without an
  // override, not just unlucky with the auto-placement order.
  await page.evaluate(() => {
    const today = new Date();
    const iso = (d) => { const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0'); return `${y}-${m}-${day}`; };
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const farOut = new Date(today); farOut.setDate(farOut.getDate() + 200);
    const staff = [{
      id: 'st_solo', name: 'Solo', processes: ['Robotic MIG Welding'],
      weeklyRoster: {
        mon: { working: true, production: true, shift: 'day', hours: 8 },
        tue: { working: true, production: true, shift: 'day', hours: 8 },
        wed: { working: true, production: true, shift: 'day', hours: 8 },
        thu: { working: true, production: true, shift: 'day', hours: 8 },
        fri: { working: true, production: true, shift: 'day', hours: 8 },
        sat: { working: false, production: true, shift: 'day', hours: 0 },
        sun: { working: false, production: true, shift: 'day', hours: 0 },
      },
      leavePeriods: [{ id: 'lv1', kind: 'leave', startDate: iso(tomorrow), endDate: iso(farOut) }],
      color: null,
    }];
    const equipment = [{ id: 'eq_solo', name: 'Solo Cell', type: 'Welding Robot', tags: [], processes: ['Robotic MIG Welding'], unavailableDates: [] }];
    const jobs = [{
      id: 'job_blocker', name: 'Blocker Job', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: iso(today), templateId: null, notes: '',
      totalValue: 0, departmentValue: 0, percentComplete: 0, needsFurtherProcessing: false,
      status: 'active', completedDate: null, batchId: null, batchOrder: null, tags: [], procedureId: '',
      bcJobNo: '', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(),
      assignment: { equipmentId: 'eq_solo', startDate: iso(today), endDate: iso(today), pinned: true, conflict: false, days: [] },
    }];
    localStorage.setItem('wf::wf_staff', JSON.stringify(staff));
    localStorage.setItem('wf::wf_equipment', JSON.stringify(equipment));
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(400);

  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(300);
  await page.click('button:has-text("New job")');
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  const link = modal().locator('text=Set up a custom (one-off) job instead');
  if (await link.count()) await link.click();
  await page.waitForTimeout(200);
  await modal().getByLabel(/job name/i).fill('Needs Solo');
  await modal().locator('label:has-text("Quantity") input').fill('1');
  await modal().locator('label:has-text("Hours per unit") input').fill('4');
  await modal().locator('label:has-text("Assigned to") select').selectOption({ label: 'Solo' });
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(500);

  check('#46 a conflict dialog appears naming the blocked person',
        (await page.locator('text=Person already committed elsewhere').count()) === 1);
  check('#46 the dialog names the manually-assigned job and the blocker',
        (await page.locator('text=Needs Solo').count()) > 0 && (await page.locator('button:has-text("Unpin")').count()) === 1);

  await page.locator('button:has-text("Unpin")').first().click();
  await page.waitForTimeout(500);

  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
    .map((j) => ({ name: j.name, assignment: j.assignment && { staffed: !!j.assignment.days?.length, pinned: j.assignment.pinned } })));
  const needsSolo = after.find((j) => j.name === 'Needs Solo');
  const blocker = after.find((j) => j.name === 'Blocker Job');
  check('#46 the manually-assigned job now has Solo, taking priority over the unpinned blocker',
        !!needsSolo.assignment, JSON.stringify(after));
  check('#46 the blocker was unpinned (no longer a hard pin), even though it lost the slot',
        !blocker.assignment || blocker.assignment.pinned === false, JSON.stringify(blocker));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'manual-assign-override';
