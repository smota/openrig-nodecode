import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const presetPath = path.join(root, 'presets', 'nodecode.yaml');
const installer = path.join(root, 'scripts', 'install-preset.mjs');

const FLAG_KEYS = [
  'launch_result',
  'runner',
  'resume',
  'first_input',
  'passes_model',
  'launch_wrapper',
];

/** Minimal Format-1 reader: scalars and a block list of strings. */
function parsePreset(text) {
  const doc = {};
  let listKey = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const item = line.match(/^  - (.*)$/);
    if (item && listKey) {
      doc[listKey].push(unquote(item[1].trim()));
      continue;
    }
    listKey = null;
    const field = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!field) continue;
    const [, key, value] = field;
    if (value === '') {
      doc[key] = [];
      listKey = key;
      continue;
    }
    doc[key] = coerce(unquote(value.trim()));
  }
  return doc;
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function coerce(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function quotesBalanced(command) {
  let single = false;
  let double = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === "'" && !double) single = !single;
    else if (ch === '"' && !single) double = !double;
  }
  return !single && !double;
}

test('preset name is nodecode and capability flags are true', () => {
  const preset = parsePreset(readFileSync(presetPath, 'utf8'));
  assert.equal(preset.format, 1);
  assert.equal(preset.name, 'nodecode');
  for (const key of FLAG_KEYS) {
    assert.equal(preset[key], true, key);
  }
});

test('preset command has no shell syntax', () => {
  const preset = parsePreset(readFileSync(presetPath, 'utf8'));
  assert.equal(typeof preset.command, 'string');
  assert.doesNotMatch(preset.command, /[|&;<>()]/);
  assert.doesNotMatch(preset.command, /\$\(/);
  assert.equal(preset.command.includes('`'), false);
  assert.equal(quotesBalanced(preset.command), true);
});

test('install-preset renders the absolute runner path and extra args', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'openrig-nodecode-'));
  const args = ['--agent-yaml', 'X', '--startup-file', 'Y', '--profile', 'Z'];
  const run = spawnSync(process.execPath, [installer, ...args], {
    env: { ...process.env, OPENRIG_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const dest = path.join(home, 'community-harnesses', 'nodecode.yaml');
  assert.equal(run.stdout.trim(), dest);
  const installed = parsePreset(readFileSync(dest, 'utf8'));
  const runner = path.join(root, 'bin', 'nodecode-runner.mjs');
  assert.equal(installed.command, `${runner} --agent-yaml X --startup-file Y --profile Z --resume-policy last-completed`);
  assert.equal(installed.name, 'nodecode');
  for (const key of FLAG_KEYS) assert.equal(installed[key], true, key);

  const again = spawnSync(process.execPath, [installer], {
    env: { ...process.env, OPENRIG_HOME: home },
    encoding: 'utf8',
  });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /overwrite|--force/);
});
