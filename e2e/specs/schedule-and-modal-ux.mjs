/* Issues #25 (modal scroll-chaining), #26 (sticky day header / job column on
   the Schedule view), #27 (Schedule view zoom) and #28 (equipment + planned
   start date editable from the job modal). */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');

  // ---- #25: scrolling inside a modal must not scroll the page behind it ----
  await page.click('nav >> text=Job Backlog');
  await page.waitForTimeout(400);
  await page.locator('table tbody tr').first().locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(200);

  const dialog = modal().locator('> div').first();
  const box = await dialog.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 400);
  await page.waitForTimeout(200);
  let bodyScroll = await page.evaluate(() => window.scrollY);
  check('#25 wheeling inside the modal past its own scroll extent leaves the page unscrolled',
        bodyScroll === 0, `scrollY=${bodyScroll}`);

  await page.mouse.move(5, 5); // over the backdrop, outside the dialog
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 400);
  await page.waitForTimeout(200);
  bodyScroll = await page.evaluate(() => window.scrollY);
  check('#25 wheeling over the backdrop also leaves the page unscrolled',
        bodyScroll === 0, `scrollY=${bodyScroll}`);

  // ---- #28: equipment + planned start date are editable in the job modal ----
  // Exact label match, not has-text: "Preferred equipment (optional)" and
  // "Locked equipment (optional)" also contain the substring "Equipment"
  // and would make this ambiguous.
  const equipSelect = modal().locator('label:has(span:text-is("Equipment")) select');
  check('#28 the job modal has an Equipment field', (await equipSelect.count()) === 1);
  const dateInput = modal().locator('label:has-text("Planned start date") input[type=date]');
  check('#28 the job modal has a Planned start date field', (await dateInput.count()) === 1);

  const before = await page.evaluate(() => {
    const jobs = JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]');
    const j = jobs.find((x) => x.assignment && !x.assignment.pinned);
    return j ? { id: j.id, name: j.name, equipmentId: j.assignment.equipmentId } : null;
  });
  check('#28 found an auto-scheduled job to test against', !!before, JSON.stringify(before));
  await page.mouse.click(5, 5);
  await page.waitForTimeout(300);

  // leaving the fields untouched must not force a pin
  await page.locator(`tr:has-text("${before.name}")`).first().locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(200);
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(600);
  let after = await page.evaluate((id) => {
    const j = JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]').find((x) => x.id === id);
    return j ? { pinned: j.assignment?.pinned, equipmentId: j.assignment?.equipmentId } : null;
  }, before.id);
  check('#28 saving without touching the field leaves an auto job unpinned',
        after.pinned === false && after.equipmentId === before.equipmentId, JSON.stringify(after));

  // changing equipment pins the job to it — same as a drag
  await page.locator(`tr:has-text("${before.name}")`).first().locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(200);
  const sel = modal().locator('label:has(span:text-is("Equipment")) select');
  const values = await sel.locator('option').evaluateAll((opts) => opts.map((o) => o.value));
  const otherId = values.find((v) => v && v !== before.equipmentId);
  check('#28 another compatible equipment option exists to switch to', !!otherId, JSON.stringify(values));
  await sel.selectOption(otherId);
  await page.waitForTimeout(150);
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(600);
  after = await page.evaluate((id) => {
    const j = JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]').find((x) => x.id === id);
    return j ? { pinned: j.assignment?.pinned, equipmentId: j.assignment?.equipmentId } : null;
  }, before.id);
  check('#28 changing equipment in the modal pins the job to it',
        after.pinned === true && after.equipmentId === otherId, JSON.stringify(after));

  // clearing back to "Automatic" unpins it
  await page.locator(`tr:has-text("${before.name}")`).first().locator('button[title="Edit"]').click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(200);
  await modal().locator('label:has(span:text-is("Equipment")) select').selectOption('');
  await page.waitForTimeout(150);
  await modal().getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(600);
  after = await page.evaluate((id) => {
    const j = JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]').find((x) => x.id === id);
    return j ? { pinned: j.assignment?.pinned } : null;
  }, before.id);
  check('#28 clearing the equipment field back to Automatic unpins the job',
        after.pinned === false, JSON.stringify(after));

  // ---- #26 / #27: Schedule view zoom + sticky day header / job column ----
  // A small viewport guarantees the grid actually overflows both axes at the
  // default zoom/range, regardless of the harness's normal window size — the
  // stickiness checks below are meaningless if there's nothing to scroll.
  await page.setViewportSize({ width: 900, height: 500 });
  await page.click('nav >> text=Schedule');
  await page.waitForTimeout(400);

  const zoomBox = page.locator('[title="Zoom the schedule grid"]');
  check('#27 a zoom control is present on the Schedule view', (await zoomBox.count()) === 1);
  const zoomOut = zoomBox.locator('button').first();
  const zoomLabel = zoomBox.locator('span');
  const initialZoom = await zoomLabel.innerText();
  // The default (60%) sits exactly ONE step above the floor (40%) — unlike
  // the old default/floor pair, which were two steps apart — so a single
  // click already lands on the (now disabled) floor button; a second click
  // here would hang waiting for it to become clickable again.
  await zoomOut.click();
  await page.waitForTimeout(150);
  const zoomedOut = await zoomLabel.innerText();
  check('#27 zooming out shrinks the reported zoom level', zoomedOut !== initialZoom && parseInt(zoomedOut) < parseInt(initialZoom),
        `${initialZoom} -> ${zoomedOut}`);
  const zoomIn = zoomBox.locator('button').nth(1);
  await zoomIn.click();
  await page.waitForTimeout(150);
  const zoomedBack = await zoomLabel.innerText();
  check('#27 zooming back in restores the level', zoomedBack === initialZoom, `${initialZoom} vs ${zoomedBack}`);

  // widen the visible range so there's real horizontal + vertical overflow
  // to test stickiness against
  await page.locator('select[title="How much of the schedule to show at once"]').selectOption({ label: '2 months' });
  await page.waitForTimeout(300);

  const scroller = page.locator('.overflow-auto').first();
  const overflowsY = await scroller.evaluate((el) => el.scrollHeight > el.clientHeight);
  const overflowsX = await scroller.evaluate((el) => el.scrollWidth > el.clientWidth);
  check('#26 the schedule grid actually overflows both axes at this range (so the check below is real)',
        overflowsX && overflowsY, `x:${overflowsX} y:${overflowsY}`);

  await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth; el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(200);

  const cornerVisible = await page.locator('text=Equipment / Jobs').first().isVisible();
  check('#26 the corner "Equipment / Jobs" header stays visible when scrolled fully right and down', cornerVisible);

  // a day-of-week label from the header row should still be on-screen at the
  // top of the scroller, not scrolled away, even though we scrolled all the
  // way down
  const scrollerBox = await scroller.boundingBox();
  // The header text is "Mon"/"Tue"/etc. in the DOM — CSS uppercase only
  // changes how it renders, not the actual text content.
  const headerCellBox = await page.locator('div', { hasText: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/ }).last().boundingBox();
  check('#26 a day header cell stays pinned at the top of the scroller after scrolling down',
        headerCellBox && Math.abs(headerCellBox.y - scrollerBox.y) < 40,
        JSON.stringify({ headerY: headerCellBox?.y, scrollerY: scrollerBox.y }));

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'schedule-and-modal-ux';
