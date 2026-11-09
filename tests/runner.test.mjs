import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fake = path.join(root, 'tests/fixtures/fake-nodecode.mjs');
const ref = 'native-session-1';
const turnId = 'turn-1';
const firstInput = '  First input: café 🧪\r\nsecond line\t \n\n';
const handshake = (session = ref) => ({ session_id: session, payload: { type: 'session_stream_resumed', replay_chunk_final: true } });
const accepted = { payload: { type: 'gateway_turn_command_result', result: { command: 'start_turn', status: 'accepted', response: { turn_id: turnId } } } };
const completed = (turn = turnId) => ({ payload: { type: 'session_stream_event', frame: { event: { type: 'turn.completed', turn_id: turn } } } });
const delta = value => ({ payload: { type: 'item_delta', turn_id: turnId, delta: value } });
const simpleTurn = [handshake(), { after_stdin: '"type":"start_turn"', frames: [accepted, completed()] }];

async function harness(t, { frames = [handshake()], env: overrides = {}, gatewayStatus = 200, optionId = 'choice-1', mutation } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecode-runner-'));
  const requests = [];
  let child;
  let stdout = '', stderr = '';
  let timer;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
    requests.push(request);
    let status = 200, reply = { ok: true };
    if (req.url.startsWith('/api/gateway/sessions/')) {
      status = gatewayStatus;
      reply = status === 200 ? { session_id: ref } : { error: { code: 'unknown_session' } };
    } else if (req.method === 'POST' && req.url === '/api/activity/permission-requests') {
      reply = { ok: true, askId: 'ask/1', state: 'pending' };
    } else if (req.method === 'GET' && req.url === '/api/activity/permission-requests/ask%2F1?waitSeconds=25') {
      reply = { ok: true, state: 'answered', optionId };
    } else if (req.url !== '/api/activity/hooks' && !req.url.endsWith('/withdraw')) {
      status = 404;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
  t.after(async () => {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      await new Promise(resolve => child.once('close', resolve));
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const home = path.join(dir, 'nodecode');
  fs.mkdirSync(path.join(home, 'store'), { recursive: true });
  fs.mkdirSync(path.join(home, 'cells', 'linked-skills'), { recursive: true });
  fs.writeFileSync(path.join(home, 'store/x.owner'), JSON.stringify({ pid: process.pid, port: server.address().port }));
  fs.writeFileSync(path.join(home, 'operator-token'), 'gateway-test-token\n');
  const files = Object.fromEntries(['frames', 'stdin', 'spawn', 'record', 'first', 'preload'].map(name => [name, path.join(dir, `${name}.${name === 'preload' ? 'mjs' : 'json'}`)]));
  fs.writeFileSync(files.frames, JSON.stringify(frames));
  fs.writeFileSync(files.first, firstInput);
  // Observe the real fixture process without changing its protocol or fixture source.
  fs.writeFileSync(files.preload, `import fs from 'node:fs';\nif (process.argv[1] === ${JSON.stringify(fake)}) fs.writeFileSync(${JSON.stringify(files.spawn)}, JSON.stringify({ argv: process.argv.slice(2), wrapped: process.env.WRAPPED, wrapperPresent: Object.hasOwn(process.env, 'OPENRIG_LAUNCH_WRAPPER') }));\n`);
  let runner = path.join(root, 'bin/nodecode-runner.mjs');
  if (mutation) {
    const copy = path.join(dir, 'mutant');
    fs.mkdirSync(path.join(copy, 'bin'), { recursive: true });
    fs.cpSync(path.join(root, 'src'), path.join(copy, 'src'), { recursive: true });
    const source = fs.readFileSync(runner, 'utf8');
    assert.equal(source.split(mutation.from).length - 1, 1, 'mutation must target exactly one runner expression');
    runner = path.join(copy, 'bin/nodecode-runner.mjs');
    fs.writeFileSync(runner, source.replace(mutation.from, mutation.to));
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENRIG_|NODECODE_|FAKE_)/.test(key) && key !== 'NODE_OPTIONS' && key !== 'WRAPPED'));
  Object.assign(env, {
    OPENRIG_HOME: path.join(dir, 'openrig'), NODECODE_HOME: home, NODECODE_BIN: fake,
    OPENRIG_URL: `http://127.0.0.1:${server.address().port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: 'activity-test-token',
    OPENRIG_SESSION_NAME: 'pod-worker@rig', OPENRIG_NODE_ID: 'node-1', OPENRIG_OCCUPANT_GENERATION: '7',
    OPENRIG_LAUNCH_ATTEMPT: 'attempt-1', OPENRIG_LAUNCH_RESULT: files.record,
    FAKE_FRAMES: files.frames, FAKE_STDIN_LOG: files.stdin,
    NODE_OPTIONS: `--import=${pathToFileURL(files.preload).href}`,
    ...overrides,
  });
  // Callers use a boolean to select the actual temp file, avoiding host paths.
  if (env.OPENRIG_FIRST_INPUT === true) env.OPENRIG_FIRST_INPUT = files.first;
  child = spawn(process.execPath, [runner], { cwd: root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`runner deadline exceeded\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 8000);
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    child.stdin.end();
  });
  const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  return {
    ...result, stdout, stderr, requests,
    record: read(files.record), recordMode: fs.existsSync(files.record) ? fs.statSync(files.record).mode & 0o777 : null,
    spawned: read(files.spawn),
    stdin: fs.existsSync(files.stdin) ? fs.readFileSync(files.stdin, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
    hooks: requests.filter(r => r.method === 'POST' && r.url === '/api/activity/hooks').map(r => r.body),
  };
}

function hook(result, event, subtype) {
  const found = result.hooks.find(h => h.hookEvent === event && h.subtype === subtype);
  assert.ok(found, `missing ${event}/${subtype}: ${JSON.stringify(result.hooks)}`);
  return found;
}
function freshAssertion(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.record.nativeRef, ref);
  assert.equal(result.record.attempt, 'attempt-1');
  assert.equal(result.recordMode, 0o600);
  hook(result, 'Stop', 'nodecode_ready');
  const starts = result.stdin.filter(frame => frame.type === 'start_turn');
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].request, { prompt: firstInput, provider: 'openai', model: 'gpt-5', effort: 'high' });
  assert.deepEqual(Buffer.from(starts[0].request.prompt), Buffer.from(firstInput));
}
function missingAssertion(result) {
  assert.equal(result.code, 3, result.stderr);
  assert.equal(result.record.error, 'missing');
  assert.equal(Object.hasOwn(result.record, 'nativeRef'), false);
  assert.equal(result.stdin.some(frame => frame.type === 'start_turn'), false);
  assert.equal(result.hooks.some(h => h.subtype === 'nodecode_ready'), false);
}
function wrapperAssertion(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.spawned.wrapped, '1');
  assert.equal(result.spawned.wrapperPresent, false);
}
function textAssertion(result) {
  assert.equal(result.stdout, 'hello café 🧪\n');
}
const freshEnv = { OPENRIG_FIRST_INPUT: true, OPENRIG_MODEL: 'openai/gpt-5:high' };
const textFrames = [handshake(), { after_stdin: '"type":"start_turn"', frames: [accepted, delta({ type: 'text', text: 'hello café 🧪\n' }), delta({ type: 'tool_call', name: 'read_file', index: 0 }), delta({ type: 'tool_call', name: 'read_file', index: 0 }), completed()] }];

test('fresh handshake records a private nativeRef, ready hook and byte-exact first turn with model fields', async t => {
  const result = await harness(t, { frames: simpleTurn, env: freshEnv });
  freshAssertion(result);
  assert.deepEqual(result.spawned.argv, ['rpc']);
  assert.equal(result.record.format, 1);
  assert.equal(result.record.harness, 'nodecode');
  hook(result, 'UserPromptSubmit', 'accepted');
  for (const [index, request] of result.requests.filter(r => r.url === '/api/activity/hooks').entries()) {
    assert.equal(request.headers.authorization, 'Bearer activity-test-token');
    assert.equal(request.body.sequence, index + 1);
    assert.equal(request.body.sessionName, 'pod-worker@rig');
    assert.equal(request.body.nodeId, 'node-1');
    assert.equal(request.body.generation, '7');
    assert.equal(request.body.runtime, 'nodecode');
    assert.equal(new Date(request.body.occurredAt).toISOString(), request.body.occurredAt);
  }
});

test('resume probes gateway with owner port and operator token, then sends no first turn', async t => {
  const result = await harness(t, { env: { ...freshEnv, OPENRIG_RESUME_REF: ref } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.record.nativeRef, ref);
  assert.deepEqual(result.spawned.argv, ['rpc', ref]);
  assert.deepEqual(result.stdin, []);
  const probe = result.requests.find(r => r.url === `/api/gateway/sessions/${ref}/header`);
  assert.equal(probe.method, 'GET');
  assert.equal(probe.headers.authorization, 'Bearer gateway-test-token');
  assert.equal(result.requests[0], probe, 'probe precedes ready hook');
  hook(result, 'Stop', 'nodecode_ready');
  assert.match(result.stderr, /ignoring OPENRIG_MODEL on resume/);
});

test('missing resume records missing and exits 3 without spawning fake nodecode', async t => {
  const result = await harness(t, { gatewayStatus: 404, env: { ...freshEnv, OPENRIG_RESUME_REF: ref } });
  missingAssertion(result);
  assert.equal(result.spawned, null);
  assert.deepEqual(result.stdin, []);
  assert.equal(result.recordMode, 0o600);
  assert.equal(result.record.attempt, 'attempt-1');
  assert.equal(result.requests.length, 1);
});

test('resumed handshake with a different session id cannot record nativeRef', async t => {
  const result = await harness(t, { frames: [handshake('wrong-session')], env: { OPENRIG_RESUME_REF: ref } });
  missingAssertion(result);
  assert.ok(result.spawned);
});

test('launch wrapper is applied and removed from the actual child environment', async t => {
  wrapperAssertion(await harness(t, { env: { OPENRIG_LAUNCH_WRAPPER: JSON.stringify(['/usr/bin/env', 'WRAPPED=1']) } }));
});

test('malformed wrappers exit 2 before fake nodecode is spawned', async t => {
  for (const wrapper of ['not-json', '{}', '[]', '["/usr/bin/env",42]']) {
    await t.test(wrapper, async t => {
      const result = await harness(t, { env: { OPENRIG_LAUNCH_WRAPPER: wrapper } });
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.spawned, null);
      assert.equal(result.record, null);
      assert.deepEqual(result.stdin, []);
      assert.deepEqual(result.requests, []);
      assert.match(result.stderr, /OPENRIG_LAUNCH_WRAPPER/);
    });
  }
});

test('text deltas reach stdout and tool calls produce one PreToolUse and a turn-scoped liveness hook', async t => {
  const result = await harness(t, { frames: textFrames, env: freshEnv });
  assert.equal(result.code, 0, result.stderr);
  textAssertion(result);
  assert.equal(hook(result, 'PreToolUse', 'read_file').turnId, turnId);
  assert.equal(result.hooks.filter(h => h.hookEvent === 'PreToolUse').length, 1);
  const beat = hook(result, 'active', 'liveness');
  assert.equal(beat.turnId, turnId);
  assert.equal(beat.livenessSeconds, 30);
  assert.equal(result.hooks.filter(h => h.subtype === 'liveness').length, 1);
  assert.match(result.stderr, /⚙ read_file/);
});

test('turn.completed produces Stop/end_turn with the accepted turn id', async t => {
  const result = await harness(t, { frames: simpleTurn, env: freshEnv });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(hook(result, 'Stop', 'end_turn').turnId, turnId);
  assert.ok(result.hooks.findIndex(h => h.subtype === 'accepted') < result.hooks.findIndex(h => h.subtype === 'end_turn'));
});

test('organism questions post ordered options and map answered optionId to exact choice text on stdin', async t => {
  const choices = ['Proceed once', 'No, keep it 🧪', 'Always proceed', 'Never proceed'];
  const result = await harness(t, {
    env: freshEnv,
    frames: [handshake(), { after_stdin: '"type":"start_turn"', frames: [accepted, { payload: { type: 'organism.questions', questions: [{ question_id: 'question-1', title: 'May I proceed?', detail: 'Choose a policy', choices }] } }] }, { after_stdin: '"type":"answer_question"', frames: [completed()] }],
  });
  assert.equal(result.code, 0, result.stderr);
  const request = result.requests.find(r => r.method === 'POST' && r.url === '/api/activity/permission-requests');
  assert.ok(request);
  assert.equal(request.headers.authorization, 'Bearer activity-test-token');
  assert.deepEqual(request.body.options, choices.map((name, index) => ({ optionId: `choice-${index}`, name, kind: ['allow_once', 'reject_once', 'allow_always', 'reject_always'][index] })));
  assert.equal(request.body.nativeRef, ref);
  assert.equal(request.body.turnId, turnId);
  assert.equal(request.body.requestId, 'question-1');
  assert.equal(request.body.sessionName, 'pod-worker@rig');
  assert.equal(request.body.nodeId, 'node-1');
  assert.equal(request.body.generation, '7');
  assert.deepEqual(request.body.toolCall, { title: 'May I proceed?', kind: 'question' });
  assert.ok(result.requests.some(r => r.method === 'GET' && r.url === '/api/activity/permission-requests/ask%2F1?waitSeconds=25'));
  const answers = result.stdin.filter(frame => frame.type === 'answer_question');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].question_id, 'question-1');
  assert.equal(answers[0].answer, choices[1]);
  const resolved = hook(result, 'active', 'permission_resolved');
  assert.equal(resolved.turnId, turnId);
  assert.equal(resolved.askId, 'ask/1');
});

test('child exit posts Stop/nodecode_exited and propagates the child code', async t => {
  for (const code of [0, 17]) await t.test(`exit ${code}`, async t => {
    const result = await harness(t, { env: { FAKE_EXIT: String(code) } });
    assert.ok(result.spawned);
    assert.equal(result.code, code, result.stderr);
    assert.equal(result.signal, null);
    hook(result, 'Stop', 'nodecode_exited');
    assert.equal(result.hooks.at(-1).subtype, 'nodecode_exited');
  });
});

// These run defective copies end to end and apply the same assertions as their
// healthy siblings. A survivor makes the test fail rather than silently weakening proof.
test('planted defect: disabling resume id validation is caught by the missing-session assertion', async t => {
  const result = await harness(t, {
    frames: [handshake('wrong-session')], env: { OPENRIG_RESUME_REF: ref },
    mutation: { from: 'if (resumeRef && nativeRef !== resumeRef)', to: 'if (false && resumeRef && nativeRef !== resumeRef)' },
  });
  assert.equal(result.record.nativeRef, 'wrong-session', 'defect actually reached the launch record');
  assert.throws(() => missingAssertion(result), { code: 'ERR_ASSERTION' });
});

test('planted defect: leaking wrapper to child is caught by the wrapper assertion', async t => {
  const result = await harness(t, {
    env: { OPENRIG_LAUNCH_WRAPPER: JSON.stringify(['/usr/bin/env', 'WRAPPED=1']) },
    mutation: { from: 'delete childEnv.OPENRIG_LAUNCH_WRAPPER;', to: '// planted defect: wrapper is retained' },
  });
  assert.equal(result.spawned.wrapperPresent, true);
  assert.throws(() => wrapperAssertion(result), { code: 'ERR_ASSERTION' });
});

test('planted defect: corrupting rendered text is caught by the stdout assertion', async t => {
  const result = await harness(t, {
    frames: textFrames, env: freshEnv,
    mutation: { from: 'output.write(delta.text)', to: "output.write('corrupted text')" },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'corrupted text');
  assert.throws(() => textAssertion(result), { code: 'ERR_ASSERTION' });
});
