/* ============================================================================
   E2E harness
   ----------------------------------------------------------------------------
   These suites are plain Playwright scripts rather than @playwright/test: the
   app has no test framework and the repo deliberately stays dependency-light,
   so this keeps the whole thing to one package with one direct dependency.

   Each spec exports `run({ page, check, errors, offOrigin, baseUrl })` and gets
   a FRESH browser context, because every suite depends on the app seeding its
   demo data into an empty localStorage on first load. Sharing a context
   between suites would leave the second one looking at the first one's edits.
   ============================================================================ */

import { chromium } from 'playwright';

// In the dev sandbox Chromium is preinstalled outside the package; in CI
// Playwright manages its own. CHROMIUM_PATH lets the former override without
// the latter needing to know anything.
const EXECUTABLE_PATH = process.env.CHROMIUM_PATH || undefined;

export const BASE_URL = process.env.BASE_URL || 'http://localhost:4173';

export function createResults() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  };
  return { results, check };
}

/**
 * Run one spec in its own browser context.
 * Returns { results, crashed } — `crashed` is set when the spec threw, which
 * is a failure in its own right rather than something to swallow.
 */
export async function runSpec(spec, { baseUrl = BASE_URL, artifactDir } = {}) {
  const { results, check } = createResults();
  const browser = await chromium.launch({ executablePath: EXECUTABLE_PATH });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    // The dev/preview server has no /api — storage.js probes it and falls back
    // to localStorage, so this 404 is the expected path, not a fault.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      errors.push('console: ' + m.text());
    }
  });

  // Nothing may leave the origin: WIP data is commercially sensitive and the
  // spreadsheet is parsed entirely in-browser. A suite that loads an .xlsx and
  // sees an outbound request has caught a real regression.
  const offOrigin = [];
  page.on('request', (r) => {
    try {
      if (new URL(r.url()).origin !== new URL(baseUrl).origin) offOrigin.push(r.url());
    } catch { /* non-URL schemes (data:, blob:) are local by definition */ }
  });

  let crashed = null;
  try {
    await spec({ page, check, errors, offOrigin, baseUrl, artifactDir });
  } catch (err) {
    crashed = err;
  } finally {
    if (artifactDir) {
      await page.screenshot({ path: `${artifactDir}/${spec.suiteName || 'spec'}.png`, fullPage: true })
        .catch(() => {});
    }
    await browser.close().catch(() => {});
  }
  return { results, crashed };
}

/** Locator for the app's modal backdrop — see `Modal` in WeldingScheduler.jsx. */
export const modalSel = 'div.fixed.inset-0.bg-black\\/60';

/**
 * Nudges a Date forward to the next Mon-Fri day. Several specs pin a
 * fixture job to "today" as the one day a seeded Mon-Fri-only staff member
 * is busy, or drop a job onto whatever the leftmost visible Schedule column
 * is — both silently break whenever the suite happens to run on a weekend,
 * the same class of flake `lastDay` was nudged for in
 * parallel-processing.mjs (that one steps backward since it's picking the
 * last day of a fixed horizon; this steps forward since it's picking an
 * anchor "today").
 */
export function nextWeekday(d) {
  const nd = new Date(d);
  while (nd.getDay() === 0 || nd.getDay() === 6) nd.setDate(nd.getDate() + 1);
  return nd;
}

/** ISO (YYYY-MM-DD) for a Date, in local time — matches scheduler.js's own isoDate. */
export const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The toast names records it just changed, so wait it out before reading page text. */
export async function clearToast(page) {
  await page.locator('div.fixed.bottom-5')
    .waitFor({ state: 'detached', timeout: 6000 })
    .catch(() => {});
}
