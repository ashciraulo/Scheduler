/* Runs every suite against a already-running server and reports one aggregate
   result. Each suite gets its own browser context — see harness.mjs. */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSpec, BASE_URL } from './lib/harness.mjs';

import importAndModals from './specs/import-and-modals.mjs';
import parkedList from './specs/parked-list.mjs';
import templatesRosterTimelog from './specs/templates-roster-timelog.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(HERE, 'artifacts');

const SUITES = [
  ['import + modals (#7, #10, #8)', importAndModals],
  ['parked list (#8)', parkedList],
  ['templates, roster, time log (#9, #11, #12)', templatesRosterTimelog],
];

const only = process.argv[2]; // optional substring filter

(async () => {
  mkdirSync(ARTIFACTS, { recursive: true });

  let total = 0;
  let failed = 0;
  const crashes = [];

  for (const [label, spec] of SUITES) {
    if (only && !label.toLowerCase().includes(only.toLowerCase())) continue;
    console.log(`\n===== ${label} =====`);
    const { results, crashed } = await runSpec(spec, { baseUrl: BASE_URL, artifactDir: ARTIFACTS });
    total += results.length;
    failed += results.filter((r) => !r.ok).length;
    if (crashed) {
      // A suite that threw part-way has not proven the checks it never reached,
      // so it counts as a failure rather than a pass with fewer assertions.
      crashes.push(`${label}: ${crashed.message.split('\n')[0]}`);
      console.error(`SUITE ERROR  ${label} — ${crashed.message.split('\n')[0]}`);
    }
    console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  }

  console.log(`\n${total - failed}/${total} checks passed overall`);
  if (crashes.length) console.error(`${crashes.length} suite(s) errored:\n  ${crashes.join('\n  ')}`);
  process.exit(failed || crashes.length ? 1 : 0);
})().catch((e) => { console.error('RUNNER ERROR', e); process.exit(2); });
