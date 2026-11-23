// main.ts — the program the harness runs. It reads every case from
// /input/cases.json, answers each with run from solve.js, and writes
// /output/answers.json. V8's incremental marking is turned off before
// solve.js is imported, as the house baseline does.
import { setFlagsFromString } from 'node:v8';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

setFlagsFromString('--no-incremental-marking');

const { run } = await import('./solve.js');

function loadCases() {
  return JSON.parse(readFileSync('/input/cases.json', 'utf8'));
}

function answerAll(cases) {
  const answers = [];
  for (const c of cases) answers.push(run(c.input));
  return answers;
}

const answers = answerAll(loadCases());
mkdirSync('/output', { recursive: true });
writeFileSync('/output/answers.json', JSON.stringify(answers));
