/* Runs every suite against a already-running server and reports one aggregate
   result. Each suite gets its own browser context — see harness.mjs. */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSpec, BASE_URL } from './lib/harness.mjs';

import importAndModals from './specs/import-and-modals.mjs';
import parkedList from './specs/parked-list.mjs';
import templatesRosterTimelog from './specs/templates-roster-timelog.mjs';
import splitJobParts from './specs/split-job-parts.mjs';
import staffCostingMerge from './specs/staff-costing-merge.mjs';
import scheduleAndModalUx from './specs/schedule-and-modal-ux.mjs';
import parallelProcessing from './specs/parallel-processing.mjs';
import shiftCapacity from './specs/shift-capacity.mjs';
import jobModalLayout from './specs/job-modal-layout.mjs';
import scheduleAndJobmodalPolish from './specs/schedule-and-jobmodal-polish.mjs';
import templateProcessEditing from './specs/template-process-editing.mjs';
import staffColorAndLeaveEditing from './specs/staff-color-and-leave-editing.mjs';
import jobmodalStylingAndDeptdue from './specs/jobmodal-styling-and-deptdue.mjs';
import manualAssignOverride from './specs/manual-assign-override.mjs';
import batching from './specs/batching.mjs';
import scheduleZoomDragAndCompletion from './specs/schedule-zoom-drag-and-completion.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(HERE, 'artifacts');

const SUITES = [
  ['import + modals (#7, #10, #8)', importAndModals],
  ['parked list (#8)', parkedList],
  ['templates, roster, time log (#9, #11, #12)', templatesRosterTimelog],
  ['split-job parts (#18)', splitJobParts],
  ['staff + costing merge (#20)', staffCostingMerge],
  ['schedule view + job modal UX (#25, #26, #27, #28)', scheduleAndModalUx],
  ['parallel processing (#30)', parallelProcessing],
  ['shift capacity scales with roster (#32)', shiftCapacity],
  ['job modal layout (#33)', jobModalLayout],
  ['schedule + job modal polish (#35, #36, #37)', scheduleAndJobmodalPolish],
  ['template process editing (#38, #39)', templateProcessEditing],
  ['staff colour + leave editing (#40, #41)', staffColorAndLeaveEditing],
  ['job modal styling + department due date (#43, #44)', jobmodalStylingAndDeptdue],
  ['manual assignment override (#46)', manualAssignOverride],
  ['batching (#47)', batching],
  ['schedule zoom persistence, name-drag, completion safety (#49, #50, #51)', scheduleZoomDragAndCompletion],
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
