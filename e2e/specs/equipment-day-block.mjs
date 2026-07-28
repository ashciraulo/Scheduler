/* Issue #53: no way to leave a piece of equipment genuinely idle for a day —
   dragging a job off it just let the scheduler backfill the slot with the
   next job in line on the very next recompute. Adds a per-day toggle button
   in each equipment's header row (reusing equipment.unavailableDates, which
   the engine already treats as fully closed) so a day can be blocked out on
   purpose and stays that way. */

export default async function run({ page, check, errors, baseUrl }) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(600);

  const headerRow = page.locator('div.border-b.border-slate-800\\/60.bg-slate-950\\/70.flex').first();
  const dayButtons = headerRow.locator('button');
  check('#53 the equipment header row has one toggle button per visible day', (await dayButtons.count()) > 20, `${await dayButtons.count()}`);

  const beforeAssign = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
    .find((j) => j.name === 'Bracket Weld - Standard')?.assignment);

  // Block the first visible day on the first piece of equipment.
  await dayButtons.nth(0).click();
  await page.waitForTimeout(400);

  const eqAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_equipment') || '[]')[0]);
  const firstDay = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  check('#53 clicking the toggle adds the date to unavailableDates', eqAfter.unavailableDates.includes(firstDay), JSON.stringify(eqAfter.unavailableDates));

  const afterAssign = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
    .find((j) => j.name === 'Bracket Weld - Standard')?.assignment);
  check('#53 a job auto-scheduled on that day/equipment is rescheduled off it, not left there',
        afterAssign.equipmentId !== beforeAssign.equipmentId || afterAssign.startDate !== beforeAssign.startDate,
        `${JSON.stringify(beforeAssign)} -> ${JSON.stringify(afterAssign)}`);

  // Toggling again clears it.
  await dayButtons.nth(0).click();
  await page.waitForTimeout(400);
  const eqCleared = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_equipment') || '[]')[0]);
  check('#53 clicking the toggle again clears the block', !eqCleared.unavailableDates.includes(firstDay), JSON.stringify(eqCleared.unavailableDates));

  // Dragging a job onto a blocked day/equipment is rejected outright, not
  // silently accepted as an overbooked pin.
  await page.evaluate(() => {
    const eq = JSON.parse(localStorage.getItem('wf::wf_equipment'));
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    eq[2].unavailableDates = [iso]; // Weld Robot 3 — an empty lane, simple drop target
    localStorage.setItem('wf::wf_equipment', JSON.stringify(eq));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(600);

  const eq3Label = page.locator('span.text-sm.font-semibold', { hasText: 'Weld Robot 3' });
  await eq3Label.scrollIntoViewIfNeeded();
  const labelBox = await eq3Label.boundingBox();
  const dropX = labelBox.x - 20 + 320 + 40;
  const dropY = labelBox.y + 40;
  const nameCell = page.locator('div', { hasText: 'Bracket Weld - Standard' }).filter({ has: page.locator('span.font-mono') }).last();
  await nameCell.hover();
  await page.mouse.down();
  await page.mouse.move(dropX, dropY, { steps: 10 });
  await page.mouse.move(dropX, dropY, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const toastText = await page.locator('div.fixed.bottom-5').textContent().catch(() => '');
  check('#53 dropping a job onto a blocked day shows a rejection toast', /blocked/.test(toastText || ''), toastText);
  const stillNotThere = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]')
    .find((j) => j.name === 'Bracket Weld - Standard')?.assignment?.equipmentId);
  check('#53 the drop is genuinely rejected — the job never lands on the blocked equipment', stillNotThere !== 'eq_3', stillNotThere);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'equipment-day-block';
