/* "New procedure"/"New cost centre" used to open a blank editor directly.
   Some equipment/procedures are close enough to an existing one that
   retyping every field is wasted effort, so both buttons now open
   CreateChoiceModal first — "Create new" (unchanged blank editor) or
   "Create from existing" (an inline picker: a flat list for cost centres,
   grouped-by-process collapsible sections for procedures — collapsed by
   default, same reasoning CostingView's own listing now uses for its long
   procedure list). Picking an item opens the real editor prefilled from a
   COPY of that record — a fresh id, "(copy)" appended to the name, no
   Delete button (it's unsaved and new, not an edit of the source) — and
   saving it leaves the original completely untouched. See "Duplicating a
   procedure/cost centre" in scheduler/CLAUDE.md. */

import { modalSel } from '../lib/harness.mjs';

export default async function run({ page, check, errors, baseUrl }) {
  const modal = () => page.locator(modalSel);

  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(300);
  await page.click('nav >> text=Costing');
  await page.waitForTimeout(400);

  // ---- CostingView's own procedure listing is grouped + collapsed ----
  const groupHeaders = await page.locator('button', { hasText: 'Thermal Spray - HVOF' }).allTextContents();
  check('the procedure list groups by process with a count', groupHeaders.some((t) => /Thermal Spray - HVOF \(\d+\)/.test(t)), groupHeaders.join(' | '));
  check('a seeded procedure name is NOT visible before its group is expanded (collapsed by default)',
        (await page.locator('text=WC-CoCr').count()) === 0);
  await page.locator('button', { hasText: /Thermal Spray - HVOF \(\d+\)/ }).first().click();
  await page.waitForTimeout(150);
  check('...but IS visible once expanded', (await page.locator('text=WC-CoCr').count()) > 0);
  await page.locator('button', { hasText: /Thermal Spray - HVOF \(\d+\)/ }).first().click();
  await page.waitForTimeout(150);
  check('collapses again on a second click', (await page.locator('text=WC-CoCr').count()) === 0);

  // ---- New procedure -> choice modal ----
  await page.getByRole('button', { name: 'New procedure' }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(200);
  check('the choice modal opens (not straight into the blank editor)', (await modal().locator('h3').innerText()) === 'New procedure');
  check('"Create new" is offered', (await modal().locator('text=Create new').count()) > 0);
  check('"Create from existing" is offered', (await modal().locator('text=Create from existing').count()) > 0);
  check('no "New procedure"-only fields (e.g. Feedstock) leak into the choice screen itself', (await modal().locator('text=Feedstock').count()) === 0);

  await modal().locator('text=Create from existing').click();
  await page.waitForTimeout(200);
  const procGroupButtons = (await modal().locator('button').allTextContents()).filter((t) => /Thermal Spray/.test(t));
  check('the procedure picker is grouped by process, same as the CostingView listing', procGroupButtons.length >= 2, procGroupButtons.join(' | '));
  check('the picker groups are ALSO collapsed by default', (await modal().locator('text=WC-CoCr').count()) === 0);

  await modal().locator('button', { hasText: /Thermal Spray - HVOF \(\d+\)/ }).first().click();
  await page.waitForTimeout(150);
  const pickTargets = modal().locator('button', { hasText: 'WC-CoCr' });
  check('expanding the group reveals its procedures', (await pickTargets.count()) > 0);

  await pickTargets.first().click();
  await page.waitForTimeout(300);

  // ---- the real editor opens, prefilled, but reads as NEW not an edit ----
  check('the editor opens with "New procedure" as its title, not "Edit procedure"', (await modal().locator('h3').innerText()) === 'New procedure');
  const nameInput = modal().locator('input').first();
  check('the name is prefilled from the source with "(copy)" appended', (await nameInput.inputValue()) === 'WC-CoCr 86/10/4 — hydraulic rod (copy)', await nameInput.inputValue());
  check('the powder fields are copied across too', (await modal().locator('input[placeholder="Material"]').inputValue()) === 'WC-CoCr 86/10/4');
  check('no Delete button — this is an unsaved new record, not an edit of the source', (await modal().getByRole('button', { name: 'Delete' }).count()) === 0);

  await modal().getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(400);

  const procedures = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_procedures') || '[]'));
  check('a new procedure was actually added (not an overwrite)', procedures.length === 4, String(procedures.length));
  const dup = procedures.find((p) => p.name.endsWith('(copy)'));
  check('the duplicate has a fresh id, distinct from the source', !!dup && dup.id !== 'proc_wccocr', JSON.stringify(dup?.id));
  check('the duplicate carries the source\'s powder data', dup?.powder?.pricePerKg === 82 && dup?.powder?.gPerMin === 83.33);
  const original = procedures.find((p) => p.id === 'proc_wccocr');
  check('the original procedure is completely untouched', original && original.name === 'WC-CoCr 86/10/4 — hydraulic rod', JSON.stringify(original?.name));

  // ---- Cost centre duplicate flow — flat list, no grouping ----
  await page.getByRole('button', { name: 'New cost centre' }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(200);
  await modal().locator('text=Create from existing').click();
  await page.waitForTimeout(200);
  const ccButtons = (await modal().locator('button').allTextContents()).map((t) => t.trim()).filter(Boolean);
  check('the cost centre picker is a flat list, not grouped', ccButtons.some((t) => t.includes('HVOF (gas-fuel)')) && !ccButtons.some((t) => /\(\d+\)$/.test(t)), ccButtons.join(' | '));

  await modal().locator('button', { hasText: 'HVOF (gas-fuel)' }).click();
  await page.waitForTimeout(300);
  check('the cost centre editor opens titled "New cost centre"', (await modal().locator('h3').innerText()) === 'New cost centre');
  const ccNameInput = modal().locator('input').first();
  check('its name is prefilled with "(copy)" appended', (await ccNameInput.inputValue()) === 'HVOF (gas-fuel) (copy)', await ccNameInput.inputValue());
  check('no Delete button on the cost centre duplicate either', (await modal().getByRole('button', { name: 'Delete' }).count()) === 0);

  await modal().getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(400);
  const centres = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_costcentres') || '[]'));
  check('a new cost centre was added', centres.length === 4, String(centres.length));
  const ccDup = centres.find((c) => c.name.endsWith('(copy)'));
  check('the cost centre duplicate has its own fresh id and carries the source\'s assets', !!ccDup && ccDup.assets?.length > 0, JSON.stringify(ccDup?.assets));

  // ---- "Create new" still reaches the ordinary blank editor unaffected ----
  await page.getByRole('button', { name: 'New procedure' }).click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(200);
  await modal().locator('text=Create new').click();
  await page.waitForTimeout(200);
  check('"Create new" opens the ordinary blank procedure editor', (await modal().locator('h3').innerText()) === 'New procedure');
  check('the name field starts blank, not prefilled from anything', (await modal().locator('input').first().inputValue()) === '');
  await modal().locator('div.sticky.top-0 button').click(); // close via header X
  await page.waitForTimeout(200);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'duplicate-procedure-costcentre';
