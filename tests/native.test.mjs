import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { main } from '../bin/nodecode-runner.mjs';

const binary = '/home/sam/.local/bin/nodecode';
test('native checkpoint-aware resume rewinds a cancelled turn', { skip: !fs.existsSync(binary), timeout: 90_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecode-checkpoint-native-'));
  const store = path.join(dir, 'history.db');
  const child = spawn(binary, ['--store', store, 'rpc'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const frames = [], waiters = new Set();
  let stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => { const frame = JSON.parse(line); frames.push(frame); for (const wake of waiters) wake(); });
  const wait = (predicate) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`native frame deadline: ${stderr}`)); }, 60_000);
    function check() { const frame = frames.find(predicate); if (frame) { clearTimeout(timer); waiters.delete(check); resolve(frame); } }
    waiters.add(check); check();
  });
  t.after(async () => {
    lines.close(); child.stdin.end();
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('close', resolve)); }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const send = command => child.stdin.write(`${JSON.stringify(command)}\n`);
  const replay = await wait(f => f.payload?.type === 'session_stream_resumed');
  const ref = replay.session_id ?? replay.payload.session_id;
  send({ type: 'start_turn', command_id: 'native-complete', request: { prompt: 'Reply only OK.' } });
  const completed = await wait(f => f.payload?.frame?.event?.type === 'turn.completed');
  const completedId = completed.payload.frame.turn_id;
  send({ type: 'start_turn', command_id: 'native-cancel', request: { prompt: 'Explain all integers in exhaustive detail.' } });
  const admitted = await wait(f => f.payload?.result?.command_id === 'native-cancel');
  send({ type: 'cancel_turn', turn_id: admitted.payload.result.response.turn_id });
  await wait(f => f.payload?.frame?.event?.type === 'turn.cancelled');
  const owner = JSON.parse(fs.readFileSync(`${store}.owner`, 'utf8'));
  const token = process.env.NODECODE_GATEWAY_OPERATOR_TOKEN || process.env.NODECODE_OPERATOR_TOKEN || fs.readFileSync(path.join(process.env.NODECODE_HOME || path.join(os.homedir(), '.nodecode'), 'operator-token'), 'utf8').trim();
  const url = `http://127.0.0.1:${owner.port}/api/gateway/sessions/${ref}/checkpoints`;
  const listing = await (await fetch(url, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(listing.checkpoints.find(row => row.turn_id === listing.head_turn_id).ending, 'cancelled');
  const input = new PassThrough(), output = new PassThrough(), error = new PassThrough();
  let notes = ''; error.on('data', value => { notes += value; }); output.resume(); input.end();
  const code = await main({ argv: ['--workspace-root', path.join(dir, 'workspace'), '--store', store, '--resume-policy', 'last-completed'], env: { ...process.env, NODECODE_BIN: binary, OPENRIG_HOME: path.join(dir, 'rig'), OPENRIG_RESUME_REF: ref, OPENRIG_LAUNCH_RESULT: path.join(dir, 'launch.json') }, input, output, error });
  assert.equal(code, 0, notes);
  assert.ok(notes.includes(`resume: head moved to turn ${completedId} (last completed; last turn was cancelled)`), notes);
  const after = await (await fetch(url, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(after.head_turn_id, completedId);
});
