/* Costing page reorg: procedures are now independent of equipment, and
   "cost centres" no longer exist as their own record — equipment absorbed
   that role directly (interestRate/annualHours/assets live on the
   equipment record itself). Assigning a job to a piece of equipment
   automatically links its depreciation+interest into the job's cost,
   combined with whichever procedure is chosen — no manual cost-centre
   picking anywhere. See "Costing: equipment is the cost centre" in
   scheduler/CLAUDE.md.

   Before this reorg, a procedure carried its own costCentreId, so the same
   procedure running on two different machines had no honest way to be
   represented — this spec proves that's gone: one procedure, two
   equipment cards each with their own depreciation, and a job's cost
   changes automatically as its assigned equipment changes without
   touching the procedure at all. */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(300);
  await page.click('nav >> text=Costing');
  await page.waitForTimeout(400);

  // ---- No separate "cost centres" section or button anywhere on the page ----
  const pageText = await page.locator('main').innerText();
  check('no "Cost centres" section heading remains', !/Cost centres/i.test(pageText), pageText.slice(0, 200));
  check('no "New cost centre" button remains', (await page.getByRole('button', { name: /new cost centre/i }).count()) === 0);

  // ---- Equipment cards show their own depreciation, right on the card ----
  check('a seeded thermal-spray cell (with capital assets) shows a dep+interest $/hr figure',
        /Thermal Spray Cell 1[\s\S]{0,120}\/hr dep\+interest/.test(pageText), pageText.slice(pageText.indexOf('Thermal Spray Cell 1'), pageText.indexOf('Thermal Spray Cell 1') + 150));
  check('a seeded welding robot (no capital assets) says so plainly instead of $0.00',
        /Weld Robot 1[\s\S]{0,80}No capital assets entered yet\./.test(pageText), pageText.slice(pageText.indexOf('Weld Robot 1'), pageText.indexOf('Weld Robot 1') + 120));

  // ---- Equipment card opens EquipmentModal, which now carries the old
  // cost-centre fields (interest rate / annual hours / capital assets) ----
  await page.locator('h3', { hasText: 'Thermal Spray Cell 1' }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  check('the equipment modal opens titled "Edit equipment"', (await modal().locator('h3').innerText()) === 'Edit equipment');
  const eqText = await modal().innerText();
  check('it has the capital-assets fields moved over from the old cost centre editor',
        /Interest rate/i.test(eqText) && /Annual operating hours/i.test(eqText) && /Capital assets/i.test(eqText), eqText.slice(0, 300));
  check('it shows a live dep+interest $/hr figure', /\/hr dep\+interest/.test(eqText));
  const box = await modal().boundingBox();
  check('the modal is wide, same as the procedure editor (the assets table needs the room)', box.width > 900, box.width);
  await modal().locator('div.sticky.top-0 button').click();
  await page.waitForTimeout(200);

  // ---- Procedure editor has no cost-centre field left, and its own $/hr
  // is explicitly labelled as excluding equipment ----
  await page.locator('button', { hasText: /Thermal Spray - HVOF \(\d+\)/ }).first().click();
  await page.waitForTimeout(150);
  await page.locator('text=WC-CoCr').first().click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  const procText = await modal().innerText();
  check('no "Cost centre" field in the procedure editor', !/Cost centre/i.test(procText), procText.slice(0, 200));
  check('the procedure\'s own rate is explicitly labelled as excluding equipment', /PROCESS COST \(EXCL\. EQUIPMENT\)/.test(procText), procText.slice(0, 250));
  await modal().locator('div.sticky.top-0 button').click();
  await page.waitForTimeout(200);

  // ---- A job's cost auto-links whichever equipment it's actually placed
  // on, with no cost-centre picker anywhere on the job itself ----
  await page.evaluate(() => {
    const job = {
      id: 'job_costlink', name: 'Cost Link Test Job', process: 'Thermal Spray - HVOF', quantity: 1, hoursTotal: 10,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: '2026-08-01', templateId: null, notes: '',
      totalValue: 0, departmentValue: 0, percentComplete: 0, needsFurtherProcessing: false,
      status: 'active', completedDate: null, actualHours: null, batchId: null, batchOrder: null,
      tags: [], procedureId: 'proc_wccocr', bcJobNo: '', bcJobTaskNo: '', staffId: null, updatedAt: new Date().toISOString(),
      assignment: { equipmentId: 'eq_5', startDate: '2026-08-01', endDate: '2026-08-01', pinned: true, conflict: false, days: [] },
    };
    localStorage.setItem('wf::wf_jobs', JSON.stringify([job]));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(300);
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);
  await page.locator('text=Cost Link Test Job').first().click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);

  const jm = () => page.locator(modalSel);
  let jmText = await jm().innerText();
  check('the job modal never asks for a cost centre — only Equipment, and a Procedure for cost', !/Cost centre/i.test(jmText));
  let idx = jmText.indexOf('VALUE & COSTING');
  const rateOnCell1 = /Cost — \$([\d.]+)\/hr/.exec(jmText.slice(idx, idx + 500));
  check('a cost preview renders, blending the procedure with the assigned equipment\'s depreciation', !!rateOnCell1, jmText.slice(idx, idx + 500));

  // Switch the Equipment field from eq_5 (Thermal Spray Cell 1) to eq_6
  // (Thermal Spray Cell 2) — same procedure, different machine, and the
  // cost preview should change purely from that, with nothing else touched.
  // Located by its own option text rather than position — the Equipment
  // select's index among the modal's <select>s shifts depending on whether
  // the job has a template (a custom job like this one skips the template
  // combobox, which isn't a <select> at all, but still puts Process's own
  // <select> ahead of Equipment's).
  const equipSelect = jm().locator('select').filter({ hasText: 'Automatic — best available' });
  await equipSelect.selectOption({ label: 'Thermal Spray Cell 2' });
  await page.waitForTimeout(300);
  jmText = await jm().innerText();
  idx = jmText.indexOf('VALUE & COSTING');
  const rateOnCell2 = /Cost — \$([\d.]+)\/hr/.exec(jmText.slice(idx, idx + 500));
  check('a cost preview still renders after switching equipment', !!rateOnCell2, jmText.slice(idx, idx + 500));
  check('the calculated rate actually changed just from switching which equipment the job is on — proving cost auto-links to the assignment, not a manually picked cost centre',
        !!rateOnCell1 && !!rateOnCell2 && rateOnCell1[1] !== rateOnCell2[1],
        `cell1=${rateOnCell1?.[1]} cell2=${rateOnCell2?.[1]}`);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'equipment-is-costcentre';
