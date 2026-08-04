/* The Patterns tab — step 2 of learning from corrections. A REVIEW surface:
   it reads wf_overrides and shows what the history implies, so a person can
   judge whether the pattern is real before anything is trusted. It applies
   nothing; the only thing it can write is clearing the history.

   What's worth guarding at browser level rather than in unit tests:
   - the two opposite conclusions (set-a-preference vs preference-being-ignored)
     actually render differently, since they come from identical-looking counts
   - de-duplication holds end to end, because a template has exactly one
     process and an un-deduped view would show every pattern two or three times
   - clearing works and is confirmed first
   - the page still says nothing is being acted on */

import { modalSel } from '../lib/harness.mjs';

const OVERRIDES = 'wf::wf_overrides';

// Two groups with deliberately identical counts and shares, differing ONLY in
// whether the job already carried a preference for the machine it keeps being
// moved to. They must not read the same.
function seed(page) {
  return page.evaluate((key) => {
    const F = (o = {}) => ({
      finishDelay: 0, startDelay: 0, lateness: 0, preferredEquipment: 0,
      exclusiveDemand: 0, staffContinuity: 0, handover: 0, fragmentation: 0, ...o,
    });
    const recs = [];
    const push = (i, jobName, job, from, to, source, changed, delta) => recs.push({
      id: 'ovr_' + i, at: `2026-07-${String((i % 28) + 1).padStart(2, '0')}T09:00:00Z`,
      source, jobId: 'j' + i, jobName, job, changed,
      scheduler: { equipmentId: from, startDate: '2026-08-04', endDate: '2026-08-04', features: F(), score: 0 },
      user: {
        equipmentId: to, startDate: '2026-08-04', features: F(delta), score: 0,
        consideredFeasible: true, atCandidateStart: true,
      },
      comparable: true, delta: F(delta),
    });
    // No preference set — should read as "consider setting one".
    for (let i = 0; i < 7; i++) {
      push(i, 'Bracket Weld ' + i, {
        templateId: 'tp_1', process: 'Robotic MIG Welding', procedureId: null,
        tags: [], preferredEquipmentId: null, lockedEquipmentId: null,
      }, 'eq_1', 'eq_2', 'drag', ['equipment'], { staffContinuity: 1, finishDelay: 2 });
    }
    // Preference ALREADY set to the machine it keeps being moved to — same
    // shape of evidence, opposite conclusion.
    for (let i = 7; i < 13; i++) {
      push(i, 'Impeller Coat ' + i, {
        templateId: 'tp_3', process: 'Thermal Spray - HVOF', procedureId: null,
        tags: ['5T Positioner'], preferredEquipmentId: 'eq_6', lockedEquipmentId: null,
      }, 'eq_5', 'eq_6', 'drag', ['equipment'], { preferredEquipment: 1, finishDelay: 4 });
    }
    localStorage.setItem(key, JSON.stringify(recs));
  }, OVERRIDES);
}

export default async function run({ page, check, errors, baseUrl }) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.waitForTimeout(400);

  // ---- empty state ----
  await page.click('nav >> text=Patterns');
  await page.waitForTimeout(400);
  const empty = await page.locator('main').innerText();
  check('with no corrections it explains what will be collected rather than showing a blank page',
        /No corrections recorded yet/i.test(empty));
  check('and it says up front that nothing is being acted on',
        /changes how the scheduler behaves/i.test(empty));

  // ---- with a history ----
  await seed(page);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('text=WELDCELL SCHEDULER');
  await page.click('nav >> text=Patterns');
  await page.waitForTimeout(600);
  const body = await page.locator('main').innerText();

  check('the headline counts the corrections', /13 corrections recorded/.test(body), body.slice(0, 120));
  check('it carries the small-sample caveat, not an air of statistical authority',
        /not statistics/i.test(body));

  // The two conclusions come from identical counts and shares. If they ever
  // render alike, the whole point of capturing the job's existing preference
  // has been lost.
  check('a template with no preference reads as "consider setting one"',
        /Consider setting this template’s preferred equipment to Weld Robot 2/.test(body), body);
  check('a template that ALREADY prefers that machine reads as the preference being outvoted',
        /already prefers .*Thermal Spray Cell 2.*move it there by hand/s.test(body), body);
  check('the two conclusions are genuinely different text, despite identical evidence shapes',
        /Consider setting/.test(body) && /keeps being outvoted/.test(body));

  // Every template has exactly one process, so without de-duplication the same
  // corrections would be reported again under Process and again under tag.
  const mig = (body.match(/Robotic MIG Welding/g) || []).length;
  const hvofTag = (body.match(/5T Positioner/g) || []).length;
  check('a process finding that merely restates a template finding is not shown twice',
        mig === 0, `"Robotic MIG Welding" appeared ${mig} time(s) — expected 0 once deduped`);
  check('nor is the capability tag that covers the same corrections',
        hvofTag === 0, `"5T Positioner" appeared ${hvofTag} time(s)`);

  check('it reports which machines work moves off and onto', /Weld Robot 1/.test(body) && /MOVED ONTO|Moved onto/i.test(body));
  check('trade-offs are stated in plain language, not raw term names',
        /You accept a later finish/i.test(body), body);
  check('the sample size travels with the trade-off readings',
        /From 13 corrections/.test(body), body);

  // ---- clearing is confirmed, not immediate ----
  await page.locator('button:has-text("Clear history")').first().click();
  await page.waitForSelector(modalSel);
  await page.waitForTimeout(300);
  check('clearing asks first — the history is not trivially recoverable',
        (await page.locator('text=Clear correction history').count()) > 0);
  const stillThere = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]').length, OVERRIDES);
  check('and nothing is discarded while the prompt is open', stillThere === 13, `${stillThere}`);

  await page.locator(modalSel).locator('button:has-text("Clear history")').click();
  await page.waitForTimeout(600);
  const after = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '[]').length, OVERRIDES);
  check('confirming empties the history', after === 0, `${after}`);
  check('and the page returns to its empty state',
        /No corrections recorded yet/i.test(await page.locator('main').innerText()));

  // The schedule itself is untouched by any of this.
  const jobsIntact = await page.evaluate(() => JSON.parse(localStorage.getItem('wf::wf_jobs') || '[]').length);
  check('clearing the history does not touch the schedule', jobsIntact > 0, `${jobsIntact} jobs`);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}

run.suiteName = 'patterns-view';
