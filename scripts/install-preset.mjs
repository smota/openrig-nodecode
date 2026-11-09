#!/usr/bin/env node
// Renders presets/nodecode.yaml into $OPENRIG_HOME/community-harnesses/nodecode.yaml.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'presets', 'nodecode.yaml');
const runner = path.join(root, 'bin', 'nodecode-runner.mjs');

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const extra = argv.filter((arg) => arg !== '--force');

const openrigHome = process.env.OPENRIG_HOME
  ? path.resolve(process.env.OPENRIG_HOME)
  : path.join(homedir(), '.openrig');
const dest = path.join(openrigHome, 'community-harnesses', 'nodecode.yaml');

if (existsSync(dest) && !force) {
  console.error(`refusing to overwrite ${dest} (pass --force)`);
  process.exit(1);
}

const rendered = readFileSync(source, 'utf8').replace(
  /^command:.*$/m,
  `command: ${yamlCommand(runner, extra)}`,
);

mkdirSync(path.dirname(dest), { recursive: true });
writeFileSync(dest, rendered.endsWith('\n') ? rendered : `${rendered}\n`);
console.log(dest);

function yamlCommand(program, args) {
  return [program, ...args].map(quoteYamlScalar).join(' ');
}

function quoteYamlScalar(token) {
  if (token === '') return '""';
  if (/[:#&*!|>%@`"'\\]|[|&;<>()]|\s/.test(token) || token.includes('$(')) {
    return `"${token.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return token;
}
