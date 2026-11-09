#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';

const script = JSON.parse(fs.readFileSync(process.env.FAKE_FRAMES, 'utf8'));
if (!Array.isArray(script)) throw new Error('FAKE_FRAMES must contain a JSON array');
const steps = script.map(value => value && Array.isArray(value.frames) ? value : { frames: [value] });
let next = 0;
let closed = false;
const seen = [];
let consumed = 0;
function advance() {
  while (next < steps.length) {
    const step = steps[next];
    if (step.after_stdin !== undefined) {
      const matched = seen.findIndex((line, index) => index >= consumed && line.includes(step.after_stdin));
      if (matched < 0) break;
      consumed = matched + 1;
    }
    next++;
    for (const frame of step.frames) process.stdout.write(`${JSON.stringify(frame)}\n`);
  }
  if (closed) {
    if (next !== steps.length) {
      process.stderr.write(`fake-nodecode: stdin closed before step ${next + 1} matched\n`);
      process.exitCode = Number(process.env.FAKE_EXIT ?? 0) || 1;
    } else process.exitCode = Number(process.env.FAKE_EXIT ?? 0);
  }
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  if (process.env.FAKE_STDIN_LOG) fs.appendFileSync(process.env.FAKE_STDIN_LOG, `${line}\n`);
  seen.push(line);
  advance();
});
input.on('close', () => { closed = true; advance(); });
advance();
