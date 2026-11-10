import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import http from 'node:http';
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

// The gateway has no direct form-evaluation command. This deliberately exercises
// a model prompt, then observes the native question and endpoint answer.
test('native operator question crosses the permission endpoint', { skip: !fs.existsSync(binary) || process.env.OPENRIG_NATIVE_QUESTIONS !== '1', timeout: 250_000 }, async t => {
  for (const noAnswers of [false, true]) await t.test(noAnswers ? 'NO_ANSWERS' : 'subscribed', { timeout: 125_000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecode-question-native-'));
    const home = path.join(dir, 'home'), store = path.join(dir, 'history.db');
    fs.mkdirSync(home, { mode: 0o700 });
    const providerHome = process.env.NODECODE_HOME || path.join(os.homedir(), '.nodecode');
    let child, timer;
    const requests = [], polls = [], hooks = [];
    let stdout = '', stderr = '';
    const api = http.createServer(async (req, res) => {
      let body = ''; for await (const part of req) body += part;
      let reply = { ok: true };
      if (req.url === '/api/activity/hooks') hooks.push(JSON.parse(body));
      if (req.method === 'POST' && req.url === '/api/activity/permission-requests') {
        requests.push(JSON.parse(body));
        reply = { ok: true, askId: 'native-ask', state: 'pending' };
      } else if (req.method === 'GET' && req.url.startsWith('/api/activity/permission-requests/native-ask?')) {
        polls.push(req.url);
        reply = { state: 'answered', optionId: 'choice-0' };
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply));
    });
    const kill = () => {
      // Only this proof's process group and explicit scratch-store owner.
      if (child) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      try {
        const owner = JSON.parse(fs.readFileSync(`${store}.owner`, 'utf8'));
        if (Number.isInteger(owner.pid) && owner.pid > 1 && owner.pid !== process.pid) process.kill(owner.pid, 'SIGKILL');
      } catch { /* already stopped */ }
    };
    t.after(() => {
      clearTimeout(timer); kill(); api.closeAllConnections(); api.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    // Copies, never links: native credential refresh cannot alter the live home.
    for (const name of ['config.jsonc', 'auth.json', 'secrets']) {
      const source = path.join(providerHome, name);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(home, name), { recursive: true });
    }
    const promptFile = path.join(dir, 'prompt');
    fs.writeFileSync(promptFile, `Evaluate exactly this Lisp form using your native evaluation tool, and reply ONLY with its printed result. Do not simulate the result or use a shell:
(multiple-value-list (ask-operator "openrig-test" :choices '("Allow" "Deny") :seconds 30))
`);
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPENRIG_') && !key.startsWith('NODECODE_')));
    Object.assign(env, {
      NODECODE_HOME: home, NODECODE_BIN: binary, OPENRIG_HOME: path.join(dir, 'rig'),
      OPENRIG_FIRST_INPUT: promptFile, OPENRIG_SESSION_NAME: 'native-question-proof', OPENRIG_NODE_ID: 'throwaway',
      OPENRIG_URL: `http://127.0.0.1:${api.address().port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: 'native-test-token',
      ...(noAnswers ? { OPENRIG_NODECODE_NO_ANSWERS: '1' } : {}),
    });
    child = spawn(process.execPath, ['bin/nodecode-runner.mjs', '--no-openrig-cell', '--seat-profile', 'none', '--workspace-root', path.join(dir, 'workspace'), '--store', store], {
      cwd: new URL('../', import.meta.url), env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.stdin.end();
    try {
      const code = await Promise.race([
        new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }),
        new Promise((_, reject) => { timer = setTimeout(() => { kill(); reject(new Error('native question exceeded 120 second budget')); }, 120_000); }),
      ]);
      assert.equal(code, 0, 'native runner must exit cleanly');
      assert.equal(hooks.some(hook => hook.subtype === 'runtime_error'), false, 'native model turn failed');
      assert.doesNotMatch(stderr, /protocol error|command rejected/i);
      assert.equal(requests.length, noAnswers ? 0 : 1);
      if (noAnswers) {
        assert.equal(polls.length, 0);
        assert.match(stdout, /:NOBODY/i);
        assert.doesNotMatch(stderr, /answers: subscribed/);
      } else {
        assert.equal(requests[0].toolCall.title, 'openrig-test');
        assert.deepEqual(requests[0].options.map(option => option.name), ['Allow', 'Deny']);
        assert.ok(polls.length > 0, 'Allow must come through the endpoint poll response');
        assert.match(stdout, /Allow/);
        assert.match(stdout, /:ANSWERED/i);
        assert.doesNotMatch(stdout, /:NOBODY/i);
        assert.match(stderr, /answers: subscribed/);
      }
    } finally {
      clearTimeout(timer);
      t.diagnostic(`final turn output (${noAnswers ? 'NO_ANSWERS' : 'subscribed'}): ${stdout || '(empty)'}`);
      t.diagnostic(`permission requests: ${requests.length}; answer polls: ${polls.length}; runtime errors: ${hooks.filter(hook => hook.subtype === 'runtime_error').length}`);
      t.diagnostic(`runner status: ${stderr.split('\n').filter(line => line.startsWith('[nodecode-runner]')).join('; ')}`);
    }
  });
});
