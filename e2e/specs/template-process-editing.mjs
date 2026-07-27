/* Issues #38 (processes should be editable, not just deletable) and #39 (a
   capability requirement sometimes appeared then immediately vanished after
   clicking Add — a blur/click race on the Add button, see TagEditor). */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');

  // ---- #38: renaming a process cascades everywhere it's used ----
  await page.click('nav >> text=Templates');
  await page.waitForTimeout(400);

  const procSection = page.locator('h2:has-text("Welding & coating processes")').locator('xpath=following-sibling::div[1]');
  const procRow = procSection.locator('div.flex.items-center.justify-between', { hasText: 'Robotic MIG Welding' }).first();
  check('#38 a process row has an edit (pencil) control', (await procRow.locator('button').count()) >= 2);
  await procRow.locator('button').first().click();
  await page.waitForTimeout(200);

  const editInput = procSection.locator('input').first();
  await editInput.fill('Robotic MIG Welding Mk2');
  await editInput.press('Enter');
  await page.waitForTimeout(400);

  const processesAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_processes') || '[]'));
  check('#38 the process list has the renamed value, not a duplicate',
        processesAfter.includes('Robotic MIG Welding Mk2') && !processesAfter.includes('Robotic MIG Welding')
        && processesAfter.length === 5,
        JSON.stringify(processesAfter));

  const templatesAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_templates') || '[]').map((t) => t.process));
  check('#38 templates using the old name now use the new one',
        templatesAfter.includes('Robotic MIG Welding Mk2') && !templatesAfter.includes('Robotic MIG Welding'),
        JSON.stringify(templatesAfter));

  const equipAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_equipment') || '[]').flatMap((e) => e.processes));
  check('#38 equipment capability lists are renamed too',
        equipAfter.includes('Robotic MIG Welding Mk2') && !equipAfter.includes('Robotic MIG Welding'),
        JSON.stringify(equipAfter));

  const jobsAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]').map((j) => j.process));
  check('#38 open jobs are renamed too, not left orphaned',
        jobsAfter.includes('Robotic MIG Welding Mk2') && !jobsAfter.includes('Robotic MIG Welding'),
        JSON.stringify(jobsAfter));

  // ---- #39: adding a capability requirement doesn't flicker/vanish ----
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);
  await page.locator('table tbody tr').first().locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);

  const tagInput = modal().locator('input[list="cap-tags"]');
  await tagInput.click();
  await tagInput.type('5T Positioner', { delay: 20 });
  await modal().locator('button:has-text("Add")').first().click();
  await page.waitForTimeout(150);
  const rightAfter = await modal().locator('span', { hasText: '5T Positioner' }).count();
  await page.waitForTimeout(800); // give a delayed stale-closure write every chance to fire
  const afterSettle = await modal().locator('span', { hasText: '5T Positioner' }).count();
  check('#39 the chip appears immediately and stays — no appear-then-vanish',
        rightAfter === 1 && afterSettle === 1, `right after: ${rightAfter}, after settling: ${afterSettle}`);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'template-process-editing';
