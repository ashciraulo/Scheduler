/* Issue #61: two Costing-tab modal usability gaps.
   - ProcedureEditor's per-row sections (Powder, Electricity, and the
     generic sec() rows for gases/spares/maintenance/consumables/labour/qa)
     only ever labelled a field with its input placeholder — which
     disappears the instant a value is typed, and never showed at all for
     the numeric columns, since they default to a real 0, not an empty
     string. Every section now has a persistent header row above it.
   - The capital-assets editor (originally CostCentreEditor's own modal,
     now folded into EquipmentModal — see "Costing: equipment is the cost
     centre" in scheduler/CLAUDE.md) used the default (448px) width even
     though its table has 4 real columns plus a delete button — cramped
     next to the rest of the Costing view's available space. EquipmentModal
     now opens at the same "wide" (1024px) size as the procedure modal. */

export default async function run({ page, check, errors, baseUrl }) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Costing');
  await page.waitForTimeout(500);

  const modal = () => page.locator('div.fixed.inset-0 > div').first();

  // ---- Equipment modal (carries the old cost centre's capital-assets
  // editor) is wide, not the cramped default ----
  await page.locator('h2', { hasText: 'Equipment' }).locator('xpath=..').locator('button', { hasText: /Add/ }).click();
  await page.waitForSelector('div.fixed.inset-0');
  await page.waitForTimeout(300);
  check('#61 the equipment modal (capital assets editor) is wider than the old cramped default (448px)',
        (await modal().boundingBox()).width > 900, (await modal().boundingBox()).width);
  const eqModalText = await modal().innerText();
  check('the capital-assets fields (moved from the old cost centre editor) are present', /Interest rate|Annual operating hours|Capital assets/i.test(eqModalText), eqModalText.slice(0, 300));
  await page.locator('div.fixed.inset-0 > div > div:first-child button').first().click();
  await page.waitForTimeout(300);

  // ---- Procedure modal: every column has a persistent header, not just
  // a placeholder that vanishes once a prefilled 0 is sitting in the field ----
  // "New procedure" opens CreateChoiceModal first (blank vs. copy an
  // existing one) — "Create new" reaches the same blank editor this test
  // already expects.
  await page.locator('button', { hasText: /new procedure/i }).first().click();
  await page.waitForSelector('div.fixed.inset-0');
  await page.waitForTimeout(200);
  await page.locator('text=Create new').click();
  await page.waitForTimeout(300);

  const bodyText = await modal().innerText();
  check('#61 the Powder section has visible column headers, not just placeholders',
        /MATERIAL/.test(bodyText) && /\$\/KG/.test(bodyText) && /G\/MIN/.test(bodyText), bodyText.slice(0, 400));
  check('#61 the Electricity section has visible column headers',
        /\bKW\b/.test(bodyText) && /\$\/KWH/.test(bodyText), bodyText.slice(0, 600));
  check('#61 no "Cost centre" field remains — procedures are equipment-independent now', !/Cost centre/i.test(bodyText));

  // Add a row to each remaining section and confirm its header row rendered
  // (present even with zero rows, but this also proves it lines up with a
  // real row rather than just floating above an empty section).
  await modal().locator('text=+ Add process gas').click();
  await modal().locator('text=+ Add spares').click();
  await modal().locator('text=+ Add labour').click();
  await page.waitForTimeout(200);

  const afterRows = await modal().innerText();
  check('#61 process gas columns are labelled (including the unlabelled Role select)',
        /GAS/.test(afterRows) && /ROLE/.test(afterRows) && /\$\/UNIT/.test(afterRows) && /L\/MIN/.test(afterRows) && /UNIT/.test(afterRows),
        afterRows.slice(afterRows.indexOf('PROCESS GAS'), afterRows.indexOf('PROCESS GAS') + 200));
  check('#61 spares columns are labelled', /PART/.test(afterRows) && /COST \$/.test(afterRows) && /LIFE HR/.test(afterRows));
  check('#61 labour columns are labelled', /FTE/.test(afterRows));

  // The numeric fields default to a real 0 — the exact case a
  // placeholder-only label silently failed on.
  const zeroInputs = await modal().locator('input[type=number]').evaluateAll(
    (els) => els.filter((el) => el.value === '0').length
  );
  check('#61 there are prefilled-zero numeric fields in this form (the case being fixed)', zeroInputs > 0, zeroInputs);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'costing-modal-labels-and-width';
