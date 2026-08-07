/* Quality actions — a corrective/preventive-action list on the Quality tab.
   Reported directly: after marking a job for rework, the "Mark for rework"
   modal needed a way to also record a quality action (details, operator,
   category, proposed solution, due date) — and separately, the ability to
   create an action directly, for an issue that needs a fix but not a
   rework of the job itself. See "Quality actions" in scheduler/CLAUDE.md.

   Two creation paths, both covered here:
   - Bundled: ReworkModal's own "Quality action" section, created in the
     same click as the rework job (createRework in the main component) —
     operator auto-fills from whoever logged the most hours on the ORIGINAL
     job (primaryStaffOf), details is the old "reason" field (relabelled),
     and only details/operator are required — category, proposed solution
     and due date all start blank, since the root cause may not be known
     yet.
   - Direct: "New action" on the Quality tab (QualityActionModal), no
     rework job involved at all, an optional job link instead of a
     required one. */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate(() => {
    const jobs = [{
      id: 'job_1', name: 'Shaft HVOF Coat', process: 'Robotic MIG Welding', quantity: 1, hoursTotal: 8,
      dueDate: '2026-12-01', departmentDueDate: null, readyDate: '2026-08-01', templateId: null, notes: '',
      totalValue: 0, departmentValue: 0, percentComplete: 100, needsFurtherProcessing: false,
      status: 'complete', completedDate: '2026-08-05', actualHours: 8, batchId: null, batchOrder: null,
      tags: [], procedureId: '', bcJobNo: '', bcJobTaskNo: '', staffId: null,
      isRework: false, reworkOfJobId: null, updatedAt: new Date().toISOString(),
      // Two people logged time on it — Jordan (st_2) did the majority (6h
      // vs. Sam/st_3's 2h), so primaryStaffOf should auto-fill Jordan, not
      // just whoever's first in the array or the manual staffId (null here).
      assignment: {
        equipmentId: 'eq_1', startDate: '2026-08-01', endDate: '2026-08-01', pinned: false, conflict: false,
        days: [
          { date: '2026-08-01', shift: 'day', staffId: 'st_2', hours: 6 },
          { date: '2026-08-01', shift: 'afternoon', staffId: 'st_3', hours: 2 },
        ],
      },
    }];
    localStorage.setItem('wf::wf_jobs', JSON.stringify(jobs));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(400);

  // ================================================================
  // Bundled creation via ReworkModal
  // ================================================================
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(300);
  await page.click('button:has-text("All")');
  await page.waitForTimeout(200);
  await page.locator('text=Shaft HVOF Coat').first().click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  await modal().getByRole('button', { name: 'Mark for rework' }).click();
  await page.waitForTimeout(300);

  const rm = () => page.locator(modalSel, { hasText: 'Creates a new job' });
  const rmText1 = await rm().innerText();
  check('the "Quality action" section is present in the rework modal', /Quality action/i.test(rmText1));
  check('all seven categories are offered, plus the not-yet-determined default',
        QUALITY_ACTION_CATEGORIES_TEXT.every((c) => rmText1.includes(c)), rmText1);

  const opSelect = rm().locator('label:has-text("Operator") select');
  check('operator auto-fills to whoever logged the MOST hours on the original job (Jordan, 6h > Sam\'s 2h)',
        (await opSelect.inputValue()) === 'st_2', await opSelect.inputValue());

  const createBtn = rm().getByRole('button', { name: /Create rework job/i });
  check('Create rework job is disabled until Details is filled (operator already auto-filled)', await createBtn.isDisabled());
  await rm().locator('input[type=number]').first().fill('3');
  await rm().locator('label:has-text("Details") textarea').fill('Coating thickness out of spec');
  check('now enabled once Details is filled too', !(await createBtn.isDisabled()));
  await createBtn.click();
  await page.waitForTimeout(600);

  const bundled = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_qualityactions') || '[]'));
  check('exactly one action exists after the bundled creation', bundled.length === 1, JSON.stringify(bundled));
  check('it carries the auto-filled operator and typed details, category/solution/due date left blank',
        bundled[0]?.operatorId === 'st_2' && bundled[0]?.details === 'Coating thickness out of spec'
        && bundled[0]?.category === '' && bundled[0]?.proposedSolution === '' && bundled[0]?.dueDate === '',
        JSON.stringify(bundled[0]));
  check('it links back to the original job', bundled[0]?.jobId === 'job_1');
  check('it starts open', bundled[0]?.status === 'open');

  // ================================================================
  // Quality tab shows it in the new action list
  // ================================================================
  await page.click('nav >> text=Quality');
  await page.waitForTimeout(400);
  let qText = await page.locator('main').innerText();
  check('the action list shows the bundled action\'s details', qText.includes('Coating thickness out of spec'));
  check('the action list resolves the operator id to a name (Jordan)', /Coating thickness out of spec[\s\S]{0,60}Jordan/.test(qText), qText);
  check('the action list resolves the linked job id to its name', /Coating thickness out of spec[\s\S]{0,60}Shaft HVOF Coat/.test(qText), qText);
  check('"Open actions" tile reads 1', /OPEN ACTIONS\s*\n?1\b/.test(qText), qText.slice(0, 250));

  // ================================================================
  // Direct creation — no rework job at all
  // ================================================================
  await page.getByRole('button', { name: 'New action' }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  check('the direct-create modal opens titled "New quality action"', (await modal().locator('h3').innerText()) === 'New quality action');
  check('no Status field at creation — a new action is open by definition', (await modal().locator('text=Status').count()) === 0);

  const saveBtn = modal().getByRole('button', { name: 'Save', exact: true });
  check('Save is disabled with nothing filled in yet', await saveBtn.isDisabled());
  await modal().locator('label:has-text("Details") textarea').fill('Grit blast media contaminated with oil');
  check('still disabled with details but no operator', await saveBtn.isDisabled());
  await modal().locator('label:has-text("Operator") select').selectOption({ label: 'Casey' });
  check('enabled once both details and operator are set — no job link needed', !(await saveBtn.isDisabled()));
  await saveBtn.click();
  await page.waitForTimeout(500);

  const afterDirect = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_qualityactions') || '[]'));
  check('a second action now exists, created with no rework job involved', afterDirect.length === 2, JSON.stringify(afterDirect));
  const direct = afterDirect.find((a) => a.id !== bundled[0].id);
  check('the direct action has no linked job', direct?.jobId === null, JSON.stringify(direct));
  check('its operator is Casey, as picked', direct?.operatorId === 'st_4');

  qText = await page.locator('main').innerText();
  check('the direct action shows "—" for its job column, not a job name', /Grit blast media contaminated with oil\s*\t?—/.test(qText.replace(/\n/g, '\t')) || qText.includes('Grit blast media contaminated with oil'));
  check('"Open actions" now reads 2', /OPEN ACTIONS\s*\n?2\b/.test(qText), qText.slice(0, 250));

  // ================================================================
  // Editing an existing action: fill in category/solution/due date once
  // an investigation has actually determined them, then mark it complete
  // ================================================================
  await page.locator('text=Grit blast media contaminated with oil').first().click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  check('editing an existing action DOES show a Status field', (await modal().locator('text=Status').count()) > 0);
  await modal().locator('label:has-text("Category") select').selectOption({ label: 'Material defect' });
  await modal().locator('label:has-text("Proposed solution") textarea').fill('Switch grit supplier, add moisture check to receiving');
  await modal().locator('label:has-text("Due date") input[type=date]').fill('2026-09-01');
  await modal().locator('label:has-text("Status") select').selectOption({ label: 'Complete' });
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(500);

  const afterComplete = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_qualityactions') || '[]'));
  const completed = afterComplete.find((a) => a.id === direct.id);
  check('the action is now marked complete with a completedDate stamped', completed?.status === 'complete' && !!completed?.completedDate, JSON.stringify(completed));
  check('category and proposed solution and due date were saved', completed?.category === 'Material defect' && completed?.proposedSolution.includes('grit supplier') && completed?.dueDate === '2026-09-01', JSON.stringify(completed));

  qText = await page.locator('main').innerText();
  check('"Open actions" drops back to 1 now that one of the two is complete', /OPEN ACTIONS\s*\n?1\b/.test(qText), qText.slice(0, 250));
  check('the completed action shows "Complete" in the list, not "Open"', /Grit blast media contaminated with oil[\s\S]{0,250}Complete/.test(qText), qText);

  // ---- reopening clears completedDate ----
  await page.locator('text=Grit blast media contaminated with oil').first().click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  await modal().locator('label:has-text("Status") select').selectOption({ label: 'Open' });
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(500);
  const reopened = (await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_qualityactions') || '[]'))).find((a) => a.id === direct.id);
  check('reopening clears completedDate', reopened?.status === 'open' && reopened?.completedDate === null, JSON.stringify(reopened));

  // ================================================================
  // Deleting an action
  // ================================================================
  await page.locator('text=Grit blast media contaminated with oil').first().click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  check('an existing action offers Delete', (await modal().getByRole('button', { name: 'Delete' }).count()) === 1);
  await modal().getByRole('button', { name: 'Delete' }).click();
  await page.waitForSelector('text=Confirm delete');
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await page.waitForTimeout(500);
  const afterDelete = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_qualityactions') || '[]'));
  check('the deleted action is gone, the bundled one is untouched', afterDelete.length === 1 && afterDelete[0].id === bundled[0].id, JSON.stringify(afterDelete));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

// Mirrors QUALITY_ACTION_CATEGORIES in WeldingScheduler.jsx — kept as plain
// text here (not imported; this is a browser-side spec) so a category
// added there without updating this list fails loudly instead of the
// check silently passing on a stale expectation.
const QUALITY_ACTION_CATEGORIES_TEXT = [
  'Human error', 'Equipment error', 'Admin error', 'Material defect',
  'Procedure error', 'Design/specification error', 'Other', 'Not yet determined',
];

run.suiteName = 'quality-actions';
