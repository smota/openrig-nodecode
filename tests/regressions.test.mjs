import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { main } from '../bin/nodecode-runner.mjs';
import { createActivity } from '../src/activity.mjs';
import { probeSession } from '../src/session-probe.mjs';
import { placeSkills, linkHomeSkills } from '../src/skills.mjs';

const resumed = (extra = {}) => ({ payload: { type: 'session_stream_resumed', session_id: 'ref', ...extra } });
const result = (status = 'accepted', id = 'turn') => ({ payload: { type: 'gateway_turn_command_result', result: { status, response: { turn_id: id } } } });
const ended = type => ({ payload: { type: 'session_stream_event', frame: { event: { type: type || 'turn.completed', turn_id: 'turn' } } } });
const question = (questions) => ({ payload: { type: 'organism.questions', questions } });
const q = { question_id: 'q', title: 'Question', choices: ['Yes', 'No'] };
const delta = delta => ({ payload: { type: 'item_delta', turn_id: 'turn', delta } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function server(t, reply) {
  const requests = [];
  const s = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const r = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
    requests.push(r);
    const value = await reply(r, res);
    if (!res.writableEnded) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value ?? { ok: true })); }
  });
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => { s.closeAllConnections(); s.close(); });
  return { requests, url: `http://127.0.0.1:${s.address().port}`, port: s.address().port };
}

// Real child and HTTP boundaries, with temporary scripts and stream-backed TTYs.
async function runner(t, { frames = [resumed()], onCommand = [], setup = () => {}, onHook, onAsk, onPoll, tty = false, env: overrides = {}, argv = [], start, noOwner = false, gateway, checkpoints } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecode-regression-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = new PassThrough(); input.isTTY = tty; input.setRawMode = value => { input.raw = value; };
  const output = new PassThrough(), error = new PassThrough(); let stdout = '', stderr = '';
  output.on('data', part => { stdout += part; }); error.on('data', part => { stderr += part; });
  const api = await server(t, async (r, res) => {
    if (r.url.endsWith('/checkpoints')) return checkpoints;
    if (r.url.startsWith('/api/gateway/')) return { session_id: 'ref' };
    if (r.url === '/api/activity/hooks') { await onHook?.(r.body, { input, output, error }); return { ok: true }; }
    if (r.method === 'GET') return onPoll ? onPoll(r, res) : { state: 'answered', optionId: 'choice-0' };
    if (r.url === '/api/activity/permission-requests') return onAsk ? onAsk(r) : { ok: true, askId: 'ask', state: 'pending' };
    return { ok: true };
  });
  const home = path.join(dir, 'home'); fs.mkdirSync(path.join(home, 'store'), { recursive: true });
  fs.mkdirSync(path.join(home, 'cells/linked-skills'), { recursive: true });
  if (!noOwner) fs.writeFileSync(path.join(home, 'store/main.owner'), JSON.stringify({ pid: process.pid, port: api.port }));
  fs.writeFileSync(path.join(home, 'operator-token'), 'token');
  const log = path.join(dir, 'stdin'), gatewayLog = path.join(dir, 'gateway');
  const bin = path.join(dir, 'fake.mjs');
  fs.writeFileSync(bin, `#!${process.execPath}\nimport fs from 'node:fs';\nimport readline from 'node:readline';\nif (process.argv[2] === 'profile') { fs.appendFileSync(process.env.TEST_PROFILE_CALLS, JSON.stringify(process.argv.slice(2))+'\\n'); const names=JSON.parse(fs.readFileSync(process.env.TEST_PROFILE_NAMES)); if(process.argv[3]==='list') console.log(names.map(name=>'  '+name+'  '+process.env.TEST_PROFILE_ROOT+'/'+name).join('\\n')); else if(process.argv[3]==='create') { names.push(process.argv[4]); fs.writeFileSync(process.env.TEST_PROFILE_NAMES,JSON.stringify(names)); fs.mkdirSync(process.env.TEST_PROFILE_ROOT+'/'+process.argv[4]+'/cells/linked-skills',{recursive:true}); } } else if (process.argv.includes('gateway')) { ${gateway || `fs.writeFileSync(${JSON.stringify(gatewayLog)}, JSON.stringify({env:process.env,argv:process.argv.slice(2),tty:process.stdout.isTTY, pipe:fs.fstatSync(1).isFIFO(),ownGroup:(()=>{try{process.kill(-process.pid,0);return true}catch{return false}})()})); fs.writeFileSync(${JSON.stringify(path.join(home, 'store/main.owner'))}, JSON.stringify({pid:${process.pid},port:${api.port}}));`} } else {\nfs.writeFileSync(${JSON.stringify(path.join(dir, 'argv'))}, JSON.stringify(process.argv.slice(2))); fs.writeFileSync(${JSON.stringify(path.join(dir, 'pid'))}, String(process.pid));\nif(process.env.TEST_CLOSE_STDIN) { setTimeout(()=>{process.stdin.destroy(); try { fs.closeSync(0); } catch {}}, 100); setTimeout(()=>{process.exitCode=19;}, 1500); }\nconst send = f => process.stdout.write(JSON.stringify(f)+'\\n');\nfor (const [delay,frame] of ${JSON.stringify(frames.map(f => Array.isArray(f) ? f : [0, f]))}) setTimeout(()=>send(frame), delay);\nlet navigationPending = false;\nconst actions = ${JSON.stringify(onCommand)};\nreadline.createInterface({input:process.stdin}).on('line', line => { fs.appendFileSync(${JSON.stringify(log)}, line+'\\n'); const frame=JSON.parse(line); if(frame.type==='start_turn' && navigationPending) process.stderr.write('EARLY_START\\n'); for(const a of actions) if(a.type===frame.type && (!a.prompt || a.prompt===frame.request?.prompt)) { if(a.delay && frame.type==='navigate_checkpoint') navigationPending=true; const respond=()=>{ for(const f of a.frames) send(f); if(frame.type==='navigate_checkpoint') navigationPending=false; }; if(a.delay) setTimeout(respond,a.delay); else respond(); } });\n}`);
  fs.chmodSync(bin, 0o755);
  const env = { PATH: process.env.PATH, NODECODE_BIN: bin, NODECODE_HOME: home, OPENRIG_HOME: path.join(dir, 'rig'), OPENRIG_URL: api.url, OPENRIG_ACTIVITY_HOOK_TOKEN: 'hook-token', OPENRIG_SESSION_NAME: 'pod-worker@rig', OPENRIG_NODE_ID: 'node', OPENRIG_LAUNCH_RESULT: path.join(dir, 'record'), ...overrides };
  const context = { dir, home, env, input, output, error, api, gatewayLog, log, argv };
  await setup(context);
  let timer;
  const running = main({ argv: ['--workspace-root', path.join(dir, 'ws'), ...argv], env, input, output, error });
  start?.(context);
  let code;
  try { code = await Promise.race([running, new Promise((_, reject) => { timer = setTimeout(() => { process.emit('SIGTERM'); reject(new Error(`runner timed out: ${stderr}`)); }, 4500); })]); }
  finally { clearTimeout(timer); }
  return { ...context, code, stdout, stderr, requests: api.requests, hooks: api.requests.filter(r => r.url === '/api/activity/hooks').map(r => r.body), commands: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
}

const closeOnReady = (h, { input }) => { if (h.subtype === 'nodecode_ready') input.end(); };

test('1 profile resume reads the profile owner and token, not the default gateway', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-root-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => dir);
  const r = await runner(t, { argv: ['--profile', 'p'], env: { OPENRIG_RESUME_REF: 'ref' }, setup({ home, api }) {
    const profile = path.join(dir, '.nodecode/profiles/p'); fs.mkdirSync(path.join(profile, 'store'), { recursive: true });
    fs.mkdirSync(path.join(profile, 'cells/linked-skills'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'operator-token'), 'profile-token');
    fs.writeFileSync(path.join(profile, 'store/main.owner'), JSON.stringify({ pid: process.pid, port: api.port }));
    fs.writeFileSync(path.join(home, 'store/main.owner'), JSON.stringify({ pid: process.pid, port: 1 }));
  }, onHook: closeOnReady });
  assert.equal(r.code, 0); assert.equal(r.requests[0].headers.authorization, 'Bearer profile-token');
  assert.equal(fs.readlinkSync(path.join(dir, '.nodecode/profiles/p/cells/linked-skills/openrig-pod-worker_rig')), path.join(r.dir, 'ws/.agents/skills'));
});

test('2 wrapper forbids gateway bootstrap; unwrapped bootstrap has clean env and detached stdio', async t => {
  const blocked = await runner(t, { noOwner: true, env: { OPENRIG_RESUME_REF: 'ref', OPENRIG_LAUNCH_WRAPPER: '["/usr/bin/env"]' } });
  assert.equal(blocked.code, 2); assert.match(blocked.stderr, /wrapper/i); assert.equal(fs.existsSync(blocked.gatewayLog), false);
  const r = await runner(t, { noOwner: true, env: { OPENRIG_RESUME_REF: 'ref', OPENRIG_OTHER_SECRET: 'remove' }, onHook: closeOnReady });
  assert.equal(r.code, 0, r.stderr); const started = JSON.parse(fs.readFileSync(r.gatewayLog));
  assert.deepEqual(Object.keys(started.env).filter(k => k.startsWith('OPENRIG_')), []); assert.equal(started.pipe, false); assert.equal(started.ownGroup, true);
});

test('3 poll recovers from transient HTTP errors and gives up only after the retry deadline', async t => {
  let gets = 0, elapsed = 0;
  const api = await server(t, (r, res) => {
    if (r.method === 'POST') return { ok: true, askId: 'a', state: 'pending' };
    gets++; if (gets === 1) { res.writeHead(502); res.end('bad gateway'); return; }
    return { state: 'answered', optionId: 'choice-0' };
  });
  const env = { OPENRIG_URL: api.url, OPENRIG_ACTIVITY_HOOK_TOKEN: 't' };
  const a = createActivity({ env, now: () => elapsed, sleep: async ms => { elapsed += ms; } });
  const answers = []; await a.ask({ question: q, onAnswer: x => { answers.push(x); return true; } });
  assert.deepEqual(answers, ['Yes']); assert.equal(gets, 2); assert.ok(elapsed > 0);
  let calls = 0; elapsed = 0;
  const notes = []; t.mock.method(process.stderr, 'write', s => { notes.push(s); return true; });
  const b = createActivity({ env, now: () => elapsed, sleep: async ms => { elapsed += ms; }, fetchImpl: async (_url, options) => {
    calls++; return options.method === 'POST' ? { ok: true, json: async () => ({ ok: true, askId: 'b' }) } : { ok: false, json: async () => ({}) };
  } });
  await b.ask({ question: q }); assert.ok(elapsed >= 120000 && elapsed < 125000); assert.ok(calls > 2); assert.match(notes.join(''), /Type the exact choice/);
  await b.withdrawAll('exited');
  let polls = 0;
  const r = await runner(t, { frames: [resumed(), question([q])], onPoll(_request, res) {
    if (++polls === 1) { res.writeHead(503); res.end('temporary'); return; }
    return { state: 'answered', optionId: 'choice-1' };
  }, onCommand: [{ type: 'answer_question', frames: [question([])] }], onHook(h, { input }) { if (h.subtype === 'permission_resolved') input.end(); } });
  assert.equal(r.code, 0, r.stderr); assert.equal(polls, 2); assert.equal(r.commands[0].answer, 'No');
});

test('4 free text questions are answered from TTY and never posted as permission requests', async t => {
  const r = await runner(t, { tty: true, frames: [resumed(), [40, question([{ question_id: 'text', title: 'Your answer?' }])]], onCommand: [{ type: 'answer_question', frames: [question([])] }], start({ input }) { setTimeout(() => input.write('anything typed\r'), 150); setTimeout(() => input.end(), 250); } });
  assert.equal(r.code, 0, r.stderr); assert.match(r.stderr, /Your answer/);
  assert.equal(r.commands[0].answer, 'anything typed'); assert.equal(r.requests.some(r => r.url === '/api/activity/permission-requests'), false);
  for (const [tty, typed] of [[true, ''], [false, ''], [true, '/abort']]) {
    const blank = await runner(t, { tty, frames: [resumed(), question([{ question_id: 'text', title: 'Blank is allowed', choices: [] }])], onCommand: [{ type: 'answer_question', frames: [question([])] }], start({ input }) { setTimeout(() => input.write(typed + '\n'), 100); setTimeout(() => input.end(), 180); } });
    assert.equal(blank.code, 0, blank.stderr); assert.equal(blank.commands[0].answer, typed); assert.equal(blank.requests.some(r => r.url === '/api/activity/permission-requests'), false);
  }
});

test('5 finishing during an awaited failed-turn hook suppresses follow-up hooks', async t => {
  const r = await runner(t, { frames: [resumed(), ended('turn.failed')], onHook: async h => { if (h.subtype === 'error') { process.emit('SIGTERM'); await pause(30); } } });
  assert.equal(r.code, 143); assert.equal(r.hooks.at(-1).subtype, 'nodecode_exited'); assert.equal(r.hooks.some(h => h.subtype === 'runtime_error'), false);
  await pause(30); assert.equal(r.api.requests.filter(r => r.url === '/api/activity/hooks').at(-1).body.subtype, 'nodecode_exited');
  const tool = await runner(t, { frames: [resumed(), delta({ type: 'tool_call', name: 'tool' })], onHook: async h => { if (h.hookEvent === 'PreToolUse') { process.emit('SIGTERM'); await pause(30); } } });
  await pause(40); assert.equal(tool.api.requests.filter(r => r.url === '/api/activity/hooks').at(-1).body.subtype, 'nodecode_exited'); assert.equal(tool.api.requests.some(r => r.body?.subtype === 'liveness'), false);
});

test('6 accepted silent turns start periodic work beats and stop them on completion', async t => {
  const interval = globalThis.setInterval; const periods = []; const realNow = Date.now;
  t.mock.method(Date, 'now', () => realNow() * 400);
  t.mock.method(globalThis, 'setInterval', (fn, ms, ...args) => { periods.push(ms); return interval(fn, ms === 10000 ? 30 : ms, ...args); });
  let beats = 0;
  const r = await runner(t, { frames: [resumed()], onCommand: [{ type: 'start_turn', frames: [result()] }, { type: 'cancel_turn', frames: [ended()] }], onHook(h, { input }) {
    if (h.subtype === 'nodecode_ready') input.write('work\n');
    if (h.subtype === 'liveness' && ++beats === 2) input.write('/abort\n');
    if (h.subtype === 'end_turn') input.end();
  } });
  assert.equal(r.code, 0); assert.ok(periods.includes(10000)); assert.equal(beats, 2); assert.ok(r.hooks.filter(h => h.subtype === 'liveness').every(h => h.turnId === 'turn'));
  const before = r.api.requests.length; await pause(80); assert.equal(r.api.requests.length, before);
});

test('7 only this session questions bridge and open questions survive turn completion until removed', async t => {
  let stillOpen;
  const r = await runner(t, { frames: [resumed(), question([{ ...q, session_id: 'other' }, { ...q, question_id: 'ours', session_id: 'ref' }]), [80, ended()], [200, question([])]], onPoll: async () => { await pause(300); return { state: 'pending' }; }, onHook(h) { if (h.subtype === 'end_turn') setTimeout(() => { stillOpen = true; }, 30); }, start({ input, api }) { setTimeout(() => { stillOpen = stillOpen && !api.requests.some(r => r.url.endsWith('/withdraw')); }, 180); setTimeout(() => input.end(), 250); } });
  assert.equal(r.code, 0, r.stderr);
  const asks = r.requests.filter(r => r.url === '/api/activity/permission-requests'); assert.deepEqual(asks.map(r => r.body.requestId), ['ours']);
  const withdrawal = r.requests.findIndex(r => r.url.endsWith('/withdraw')); const endedAt = r.requests.findIndex(r => r.body?.subtype === 'end_turn');
  assert.ok(withdrawal > endedAt); assert.equal(r.requests[withdrawal].body.reason, 'turn_ended');
  assert.equal(stillOpen, true);
});

test('8 busy without turn id reports abort limitation and double Ctrl-C exits 130', async t => {
  const r = await runner(t, { tty: true, frames: [resumed({ admission_state: 'active' })], start({ input }) { setTimeout(() => input.write('/abort\r\x03\x03'), 150); } });
  assert.equal(r.code, 130, r.stderr); assert.match(r.stderr, /turn id/i); assert.equal(r.input.raw, false);
  const submitted = await runner(t, { tty: true, frames: [resumed()], start({ input }) { setTimeout(() => input.write('start\r/abort\r\x03\x03'), 120); } });
  assert.equal(submitted.code, 130, submitted.stderr); assert.match(submitted.stderr, /turn id/i);
});

test('9 resume id-less handshake uses probed ref; fresh waits for header id', async t => {
  const a = await runner(t, { env: { OPENRIG_RESUME_REF: 'ref' }, frames: [{ payload: { type: 'session_stream_resumed' } }], onHook: closeOnReady });
  assert.equal(a.code, 0, a.stderr); assert.equal(JSON.parse(fs.readFileSync(a.env.OPENRIG_LAUNCH_RESULT)).nativeRef, 'ref');
  const b = await runner(t, { frames: [{ payload: { type: 'session_stream_resumed' } }, [40, { payload: { type: 'session_stream_resumed', header: { session_id: 'header-ref' } } }]], onHook: closeOnReady });
  assert.equal(b.code, 0, b.stderr); assert.equal(JSON.parse(fs.readFileSync(b.env.OPENRIG_LAUNCH_RESULT)).nativeRef, 'header-ref');
});

test('10 dead owner is ignored and gateway is restarted', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-owner-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'store')); const owner = path.join(dir, 'store/main.owner'); fs.writeFileSync(owner, JSON.stringify({ pid: 2147483647, port: 1 }));
  const api = await server(t, () => ({})); let starts = 0;
  assert.equal(await probeSession({ ref: 'ref', home: dir, timeoutMs: 500, exec: async () => { starts++; fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, port: api.port })); } }), 'exists'); assert.equal(starts, 1);
});

test('11 relative store is resolved once for probe and RPC spawn', async t => {
  const store = path.relative(process.cwd(), path.join(os.tmpdir(), `relative-nodecode-${process.pid}`)); const owner = path.resolve(`${store}.owner`); t.after(() => fs.rmSync(owner, { force: true }));
  const r = await runner(t, { argv: ['--store', store], env: { OPENRIG_RESUME_REF: 'ref' }, setup({ api, env }) { fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, port: api.port })); env.NODE_OPTIONS = ''; }, onHook: closeOnReady,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.commands.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, 'argv')))[1], path.resolve(store));
});

test('12 malformed frame fields do not finish the runner and later text still renders', async t => {
  const r = await runner(t, { frames: [resumed(), question({ bad: true }), question([null, 'bad']), delta({ type: 'reasoning', text: 12 }), delta({ type: 'text', text: 'alive' }), ended()], start({ input }) { setTimeout(() => input.end(), 150); } });
  assert.equal(r.code, 0, r.stderr); assert.equal(r.stdout, 'alive');
});

test('13 answered asks are never withdrawn and failed answer writes do not resolve permissions', async t => {
  const r = await runner(t, { frames: [resumed(), question([q])], onCommand: [{ type: 'answer_question', frames: [question([])] }], start({ input }) { setTimeout(() => input.end(), 180); } });
  assert.equal(r.code, 0, r.stderr); assert.equal(r.requests.some(r => r.url.endsWith('/withdraw')), false);
  const api = await server(t, r => r.method === 'GET' ? { state: 'answered', optionId: 'choice-0' } : { ok: true, askId: 'a' });
  const activity = createActivity({ env: { OPENRIG_URL: api.url, OPENRIG_ACTIVITY_HOOK_TOKEN: 't' } });
  await activity.ask({ question: q, onAnswer: () => false }); await activity.withdrawAll('exited');
  assert.equal(api.requests.some(r => r.body?.subtype === 'permission_resolved'), false);
  const failed = await runner(t, { env: { TEST_CLOSE_STDIN: '1' }, frames: [resumed(), [180, question([q])]] });
  assert.equal(failed.code, 0, failed.stderr);
  assert.ok(failed.requests.some(r => r.method === 'GET' && r.url.includes('/permission-requests/')));
  assert.equal(failed.hooks.some(h => h.subtype === 'permission_resolved'), false);
  assert.equal(failed.hooks.at(-1).subtype, 'nodecode_exited');
  const duringAnswer = await server(t, r => r.method === 'GET' ? { state: 'answered', optionId: 'choice-0' } : { ok: true, askId: 'race' });
  const racing = createActivity({ env: { OPENRIG_URL: duringAnswer.url, OPENRIG_ACTIVITY_HOOK_TOKEN: 't' } });
  await racing.ask({ question: q, onAnswer: async () => { await racing.withdrawAll('exited'); return true; } });
  assert.equal(duringAnswer.requests.some(r => r.url.endsWith('/withdraw')), false);
  assert.equal(duringAnswer.requests.some(r => r.body?.subtype === 'permission_resolved'), false);
});

test('14 stdout, operator stdin and child stdin EPIPE finish gracefully and restore TTY', async t => {
  for (const stream of ['output', 'input', 'child']) await t.test(stream, async t => {
    const listeners = ['SIGTERM', 'SIGHUP', 'SIGINT'].map(signal => process.listenerCount(signal));
    const r = await runner(t, { tty: true, env: stream === 'child' ? { TEST_CLOSE_STDIN: '1' } : {}, frames: [resumed(), question([q])], onPoll: async () => { await pause(250); return { state: 'pending' }; }, start(ctx) { setTimeout(() => { if (stream === 'child') { // close the child read side, then provoke a write
      ctx.input.write('prompt\r');
    } else ctx[stream].emit('error', Object.assign(new Error('closed pipe'), { code: 'EPIPE' })); }, 150); } });
    assert.equal(r.code, 0, r.stderr); assert.equal(r.input.raw, false); assert.equal(r.hooks.at(-1).subtype, 'nodecode_exited');
    assert.ok(r.requests.some(r => r.url.endsWith('/withdraw')));
    assert.deepEqual(['SIGTERM', 'SIGHUP', 'SIGINT'].map(signal => process.listenerCount(signal)), listeners);
    assert.equal(r.input.listenerCount('data'), 0);
    const pid = Number(fs.readFileSync(path.join(r.dir, 'pid')));
    for (let attempt = 0; attempt < 20; attempt++) {
      try { process.kill(pid, 0); await pause(10); } catch (cause) { assert.equal(cause.code, 'ESRCH'); return; }
    }
    assert.fail('nodecode child survived EPIPE cleanup');
  });
});

test('14 delayed Writable EPIPE after finish is handled until stream close with no activity endpoint', async t => {
  for (const mode of ['tty-restore', 'queued-text']) await t.test(mode, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecode-late-pipe-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = path.join(dir, 'fake.mjs');
    fs.writeFileSync(fake, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(resumed()) + '\n' + (mode === 'queued-text' ? JSON.stringify(delta({ type: 'text', text: 'queued output' })) + '\n' : ''))}); process.stdin.resume();\n`);
    fs.chmodSync(fake, 0o755);
    const script = path.join(dir, 'run.mjs');
    fs.writeFileSync(script, `import { Writable, PassThrough } from 'node:stream';
import { main } from ${JSON.stringify(new URL('../bin/nodecode-runner.mjs', import.meta.url).href)};
const input = new PassThrough(); input.isTTY = true; input.setRawMode = value => { input.raw = value; };
const chunks = [];
const output = new Writable({ write(chunk, encoding, callback) {
  const text = String(chunk); chunks.push(text);
  if (text === ${JSON.stringify(mode === 'tty-restore' ? '\u001b[?2004l' : 'queued output')}) setTimeout(() => callback(Object.assign(new Error('delayed pipe failure'), { code: 'EPIPE' })), 40);
  else callback();
} });
const closed = new Promise(resolve => output.once('close', resolve));
const running = main({ argv: ['--workspace-root', ${JSON.stringify(path.join(dir, 'ws'))}], env: { PATH: process.env.PATH, NODECODE_BIN: ${JSON.stringify(fake)}, NODECODE_HOME: ${JSON.stringify(path.join(dir, 'home'))}, OPENRIG_HOME: ${JSON.stringify(path.join(dir, 'rig'))} }, input, output, error: new PassThrough() });
input.end();
const code = await running;
const returnedBeforeError = !output.errored;
await closed;
process.stdout.write(JSON.stringify({ code, raw: input.raw, returnedBeforeError, errorCode: output.errored?.code, outputErrorListeners: output.listenerCount('error'), inputDataListeners: input.listenerCount('data'), chunks }));
`);
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
    let timer;
    t.after(() => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const code = await new Promise((resolve, reject) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('delayed EPIPE subprocess timed out')); }, 3000);
      child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(code, 0, stderr);
    const report = JSON.parse(stdout);
    assert.equal(report.code, 0); assert.equal(report.raw, false); assert.equal(report.returnedBeforeError, true);
    assert.equal(report.errorCode, 'EPIPE'); assert.equal(report.outputErrorListeners, 0); assert.equal(report.inputDataListeners, 0);
    assert.ok(report.chunks.includes(mode === 'tty-restore' ? '\u001b[?2004l' : 'queued output'));
  });
});

test('15 rejected first start retains model fields until an accepted start', async t => {
  let ends = 0;
  const r = await runner(t, { env: { OPENRIG_MODEL: 'provider/model:high' }, frames: [resumed()], onCommand: [{ type: 'start_turn', prompt: 'one', frames: [result('rejected')] }, { type: 'start_turn', prompt: 'two', frames: [result(), ended()] }, { type: 'start_turn', prompt: 'three', frames: [result(), ended()] }], onHook(h, { input }) { if (h.subtype === 'nodecode_ready') input.write('one\ntwo\n'); if (h.subtype === 'end_turn') { if (++ends === 1) input.write('three\n'); else input.end(); } } });
  assert.equal(r.code, 0, r.stderr); assert.equal(r.commands.length, 3);
  for (const c of r.commands.slice(0, 2)) assert.deepEqual({ ...c.request, prompt: undefined }, { prompt: undefined, provider: 'provider', model: 'model', effort: 'high' });
  assert.deepEqual(r.commands[2].request, { prompt: 'three' });
});

test('16 bad skills warn, preserve ordinary directories and allow runner launch', async t => {
  const notes = []; t.mock.method(process.stderr, 'write', x => { notes.push(x); return true; });
  const r = await runner(t, { argv: ['--agent-yaml', 'unused'], setup({ dir, env, argv }) {
    const agent = path.join(dir, 'agent.yaml'); fs.writeFileSync(agent, 'resources:\n  skills:\n    - { id: missing, path: ./missing }\n    - { id: good, path: ./good }\nprofiles:\n  worker:\n    uses:\n      skills:\n        - missing\n        - good\n');
    fs.mkdirSync(path.join(dir, 'good')); fs.writeFileSync(path.join(dir, 'good/SKILL.md'), 'ok');
    fs.mkdirSync(path.join(dir, 'ws/.agents/skills/good'), { recursive: true }); fs.writeFileSync(path.join(dir, 'ws/.agents/skills/good/keep'), 'preserve');
    argv[1] = agent;
  }, onHook: closeOnReady });
  assert.equal(r.code, 0, r.stderr); assert.ok(notes.length || /skill/i.test(r.stderr));
  assert.equal(fs.readFileSync(path.join(r.dir, 'ws/.agents/skills/good/keep'), 'utf8'), 'preserve');
  const home = path.join(r.dir, 'other'); const link = path.join(home, 'cells/linked-skills/openrig-seat'); fs.mkdirSync(link, { recursive: true }); fs.writeFileSync(path.join(link, 'keep'), 'yes');
  assert.equal(linkHomeSkills(home, 'seat', path.join(r.dir, 'ws')), false); assert.equal(fs.readFileSync(path.join(link, 'keep'), 'utf8'), 'yes');
  assert.doesNotThrow(() => placeSkills(path.join(r.dir, 'ws'), path.join(r.dir, 'agent.yaml'), 'worker'));
});

test('17 separate main runs use distinct first start command ids', async t => {
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const r = await runner(t, { frames: [resumed()], onCommand: [{ type: 'start_turn', frames: [result(), ended()] }], onHook(h, { input }) {
      if (h.subtype === 'nodecode_ready') input.write('work\n');
      if (h.subtype === 'end_turn') input.end();
    } });
    assert.equal(r.code, 0, r.stderr);
    ids.push(r.commands[0].command_id);
  }
  assert.notEqual(ids[0], ids[1]);
});

test('18 duplicate admissions reject the stale turn and drain queued prompts', async t => {
  for (const reason of ['message', 'completed replay', 'wrapped completed replay']) await t.test(reason, async t => {
    const duplicate = result('accepted', 'old-turn');
    if (reason === 'message') duplicate.payload.result.message = 'turn already admitted';
    const completed = { event: { type: 'turn.completed', turn_id: 'old-turn' } };
    const r = await runner(t, { frames: [resumed({ accumulated_frames: [reason === 'wrapped completed replay' ? { frame: completed } : completed] })], onCommand: [
      { type: 'start_turn', prompt: 'one', frames: [duplicate] },
      { type: 'start_turn', prompt: 'two', frames: [result(), ended()] },
    ], onHook(h, { input }) {
      if (h.subtype === 'nodecode_ready') input.write('one\ntwo\n');
      if (h.subtype === 'end_turn') input.end();
    } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /command rejected.*old-turn/);
    assert.deepEqual(r.commands.map(c => c.request.prompt), ['one', 'two']);
    assert.deepEqual(r.hooks.filter(h => h.subtype === 'accepted').map(h => h.turnId), ['turn']);
  });
});

test('19 ready publishes the recorded native session identity in hook order', async t => {
  const r = await runner(t, { env: { OPENRIG_OCCUPANT_GENERATION: '7', OPENRIG_RUNTIME: 'other' }, onHook: closeOnReady });
  assert.equal(r.code, 0, r.stderr);
  const identities = r.hooks.filter(h => h.eventFamily === 'session_identity');
  assert.equal(identities.length, 1);
  const identity = identities[0];
  assert.equal(identity.sessionId, JSON.parse(fs.readFileSync(r.env.OPENRIG_LAUNCH_RESULT)).nativeRef);
  assert.deepEqual({ ...identity, sequence: undefined, occurredAt: undefined }, {
    eventFamily: 'session_identity', sessionId: 'ref', sessionName: 'pod-worker@rig', nodeId: 'node', generation: '7', runtime: 'nodecode', sequence: undefined, occurredAt: undefined,
  });
  assert.ok(identity.sequence > r.hooks.find(h => h.subtype === 'nodecode_ready').sequence);
  assert.ok(Number.isFinite(Date.parse(identity.occurredAt)));
});

test('20 identity HTTP failures are ignored and noted only once; disabled activity is a no-op', async t => {
  const notes = []; t.mock.method(process.stderr, 'write', s => { notes.push(s); return true; });
  const api = await server(t, (_r, res) => { res.writeHead(503); res.end('unavailable'); });
  const activity = createActivity({ env: { OPENRIG_URL: api.url, OPENRIG_ACTIVITY_HOOK_TOKEN: 't' } });
  await activity.identity('ref'); await activity.identity('ref');
  assert.equal(api.requests.length, 2);
  assert.equal(notes.length, 1); assert.match(notes[0], /identity/i);
  const disabled = createActivity({ env: { OPENRIG_HOME: '/nonexistent-nodecode-test-home' }, fetchImpl: () => assert.fail('disabled activity fetched') });
  await disabled.identity('ref');
  assert.equal(notes.length, 1);
});


test('stale OpenRig skill links are pruned while live and foreign entries survive', async t => {
  const r = await runner(t, { setup({ home, dir }) {
    const root = path.join(home, 'cells/linked-skills');
    for (const [name, workspace] of [['openrig-stale', path.join(dir, 'missing')], ['openrig-live', dir], ['foreign', path.join(dir, 'missing')]]) {
      fs.mkdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name, '.openrig-seat.json'), JSON.stringify({ sessionName: name, workspace, writtenAt: new Date().toISOString() }));
    }
    fs.symlinkSync(path.join(dir, 'missing-target'), path.join(root, 'openrig-dangling'));
    fs.symlinkSync(path.join(dir, 'missing-target'), path.join(root, 'foreign-dangling'));
  }, onHook: closeOnReady });
  assert.equal(r.code, 0, r.stderr);
  const root = path.join(r.home, 'cells/linked-skills');
  assert.equal(fs.existsSync(path.join(root, 'openrig-stale')), false);
  assert.throws(() => fs.lstatSync(path.join(root, 'openrig-dangling')), { code: 'ENOENT' });
  assert.ok(fs.existsSync(path.join(root, 'openrig-live')));
  assert.ok(fs.existsSync(path.join(root, 'foreign')));
  assert.ok(fs.lstatSync(path.join(root, 'foreign-dangling')).isSymbolicLink());
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'openrig-pod-worker_rig/.openrig-seat.json')));
  assert.equal(marker.workspace, path.join(r.dir, 'ws')); assert.equal(marker.sessionName, 'pod-worker@rig'); assert.ok(Number.isFinite(Date.parse(marker.writtenAt)));
});

test('seat profiles select argv, create only absent profiles and resolve profile gateway home', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-profiles-')); t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  t.mock.method(os, 'homedir', () => root);
  for (const [selection, names, expected] of [['auto', [], 'openrig-main-lead'], ['auto', ['openrig-main-lead'], 'openrig-main-lead'], ['named', [], 'named'], ['none', [], null], [null, [], 'env-profile']]) {
    const r = await runner(t, { argv: selection ? ['--seat-profile', selection] : [], env: { OPENRIG_SESSION_NAME: 'Main Lead', OPENRIG_NODECODE_SEAT_PROFILE: 'env-profile', ...(expected ? {OPENRIG_RESUME_REF: 'ref'} : {}) }, setup({dir, home, env, api}) {
      env.TEST_PROFILE_CALLS=path.join(dir,'profile-calls'); env.TEST_PROFILE_NAMES=path.join(dir,'names'); env.TEST_PROFILE_ROOT=path.join(root,'.nodecode/profiles');
      fs.writeFileSync(env.TEST_PROFILE_NAMES,JSON.stringify(names));
      if(expected) {
        const target=path.join(env.TEST_PROFILE_ROOT,expected); fs.mkdirSync(path.join(target,'store'),{recursive:true}); fs.mkdirSync(path.join(target,'cells/linked-skills'),{recursive:true});
        fs.writeFileSync(path.join(target,'store/main.owner'), JSON.stringify({pid:process.pid,port:api.port})); fs.writeFileSync(path.join(target,'operator-token'),'seat-token');
        fs.writeFileSync(path.join(home,'store/main.owner'),JSON.stringify({pid:process.pid,port:1}));
      }
    }, onHook: closeOnReady });
    assert.equal(r.code,0,r.stderr);
    const args=JSON.parse(fs.readFileSync(path.join(r.dir,'argv')));
    assert.deepEqual(args.slice(0,expected ? 3 : 1),expected ? ['-p',expected,'rpc'] : ['rpc']);
    const calls=fs.existsSync(r.env.TEST_PROFILE_CALLS) ? fs.readFileSync(r.env.TEST_PROFILE_CALLS,'utf8').trim().split('\n').map(JSON.parse) : [];
    assert.deepEqual(calls,expected ? [['profile','list'],...(!names.includes(expected) ? [['profile','create',expected]] : [])] : []);
    if(expected) { assert.equal(r.requests[0].headers.authorization,'Bearer seat-token'); assert.match(r.stderr,new RegExp(expected)); }
  }
  const bare=await runner(t,{onHook:closeOnReady}); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bare.dir,'argv'))),['rpc']);
});

for (const [ending, policy, navigate] of [['failed', 'last-completed', true], ['completed', 'last-completed', false], ['failed', 'head', false], ['cancelled', 'last-completed', true], ['interrupted', 'last-completed', true]]) {
  test(`checkpoint resume: ${ending} with ${policy}`, async t => {
    const r = await runner(t, {
      argv: ['--resume-policy', policy], env: { OPENRIG_RESUME_REF: 'ref' },
      checkpoints: { head_turn_id: 'last', checkpoints: [
        { kind: 'user_message', turn_id: 'good', ending: 'completed', on_head_chain: true, log_position: 1 },
        { kind: 'user_message', turn_id: 'last', ending, on_head_chain: true, is_head: true, log_position: 2 },
      ] },
      onCommand: [
        { type: 'navigate_checkpoint', delay: 80, frames: [{ payload: { type: 'gateway_turn_command_result', result: { command: 'navigate_checkpoint', status: 'accepted' } } }] },
        { type: 'start_turn', frames: [result(), ended()] },
      ],
      start({ input }) { input.end('queued first prompt\n'); },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.commands.map(c => c.type), navigate ? ['navigate_checkpoint', 'start_turn'] : ['start_turn']);
    if (navigate) {
      assert.equal(r.commands[0].target_turn_id, 'good');
      assert.doesNotMatch(r.stderr, /EARLY_START/);
      assert.match(r.stderr, new RegExp(`resume: head moved to turn good \\(last completed; last turn was ${ending}\\)`));
    } else assert.doesNotMatch(r.stderr, /head moved/);
  });
}


test('installed preset defaults to automatic seat profiles', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'seat-preset-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const installed=spawnSync(process.execPath,['scripts/install-preset.mjs'],{env:{...process.env,OPENRIG_HOME:dir},encoding:'utf8'});
  assert.equal(installed.status,0,installed.stderr);
  const preset=fs.readFileSync(path.join(dir,'community-harnesses/nodecode.yaml'),'utf8');
  assert.match(preset,/^command: .* --seat-profile auto --resume-policy last-completed$/m);
  assert.doesNotMatch(preset,/default home shares/);
});

test('checkpoint resume policy from env applies only to a verified resume', async t => {
  for (const resume of [false, true]) {
    const r = await runner(t, {
      env: { OPENRIG_NODECODE_RESUME_POLICY: 'last-completed', ...(resume ? { OPENRIG_RESUME_REF: 'ref' } : {}) },
      checkpoints: { head_turn_id: 'bad', checkpoints: [
        { kind: 'user_message', turn_id: 'good', ending: 'completed', on_head_chain: true, log_position: 1 },
        { kind: 'user_message', turn_id: 'bad', ending: 'failed', on_head_chain: true, log_position: 2 },
      ] },
      onCommand: [{ type: 'navigate_checkpoint', frames: [{ payload: { type: 'gateway_turn_command_result', result: { command: 'navigate_checkpoint', status: 'accepted' } } }] }],
      onHook: closeOnReady,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.commands.map(c => c.type), resume ? ['navigate_checkpoint'] : []);
    assert.equal(r.requests.some(r => r.url.endsWith('/checkpoints')), resume);
  }
});
