import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { main } from '../bin/nodecode-runner.mjs';
import { createActivity } from '../src/activity.mjs';
import * as activityModule from '../src/activity.mjs';
import { probeSession } from '../src/session-probe.mjs';
import * as skills from '../src/skills.mjs';
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
    if (!res.writableEnded && !res.headersSent) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value ?? { ok: true })); }
  });
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => { s.closeAllConnections(); s.close(); });
  return { requests, url: `http://127.0.0.1:${s.address().port}`, port: s.address().port };
}

// Real child and HTTP boundaries, with temporary scripts and stream-backed TTYs.
async function runner(t, { frames = [resumed()], onCommand = [], setup = () => {}, onHook, onAsk, onPoll, onChannel, tty = false, env: overrides = {}, argv = [], start, noOwner = false, gateway, checkpoints } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecode-regression-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = new PassThrough(); input.isTTY = tty; input.setRawMode = value => { input.raw = value; };
  const output = new PassThrough(), error = new PassThrough(); let stdout = '', stderr = '';
  output.on('data', part => { stdout += part; }); error.on('data', part => { stderr += part; });
  const api = await server(t, async (r, res) => {
    if (r.url === '/api/activity/runner-channel' && onChannel) return onChannel(r, res, { input });
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
  fs.writeFileSync(bin, `#!${process.execPath}\nimport fs from 'node:fs';\nimport readline from 'node:readline';\nif (process.argv[2] === 'profile') { fs.appendFileSync(${JSON.stringify(path.join(dir, 'profile-private-env'))}, JSON.stringify({token:Object.hasOwn(process.env,'OPENRIG_ACTIVITY_HOOK_TOKEN'),run:Object.hasOwn(process.env,'OPENRIG_RUN_ID')})+'\\n'); fs.appendFileSync(process.env.TEST_PROFILE_CALLS, JSON.stringify(process.argv.slice(2))+'\\n'); const names=JSON.parse(fs.readFileSync(process.env.TEST_PROFILE_NAMES)); if(process.argv[3]==='list') console.log(names.map(name=>'  '+name+'  '+process.env.TEST_PROFILE_ROOT+'/'+name).join('\\n')); else if(process.argv[3]==='create') { names.push(process.argv[4]); fs.writeFileSync(process.env.TEST_PROFILE_NAMES,JSON.stringify(names)); fs.mkdirSync(process.env.TEST_PROFILE_ROOT+'/'+process.argv[4]+'/cells/linked-skills',{recursive:true}); } } else if (process.argv.includes('gateway')) { ${gateway || `fs.writeFileSync(${JSON.stringify(gatewayLog)}, JSON.stringify({env:process.env,argv:process.argv.slice(2),tty:process.stdout.isTTY, pipe:fs.fstatSync(1).isFIFO(),ownGroup:(()=>{try{process.kill(-process.pid,0);return true}catch{return false}})()})); fs.writeFileSync(${JSON.stringify(path.join(home, 'store/main.owner'))}, JSON.stringify({pid:${process.pid},port:${api.port}}));`} } else {\nfs.writeFileSync(${JSON.stringify(path.join(dir, 'private-env'))}, JSON.stringify({ token: Object.hasOwn(process.env,'OPENRIG_ACTIVITY_HOOK_TOKEN'), run: Object.hasOwn(process.env,'OPENRIG_RUN_ID') })); fs.writeFileSync(${JSON.stringify(path.join(dir, 'argv'))}, JSON.stringify(process.argv.slice(2))); fs.writeFileSync(${JSON.stringify(path.join(dir, 'pid'))}, String(process.pid));\nif(process.env.TEST_CLOSE_STDIN) { setTimeout(()=>{process.stdin.destroy(); try { fs.closeSync(0); } catch {}}, 100); setTimeout(()=>{process.exitCode=19;}, 1500); }\nconst send = f => process.stdout.write(JSON.stringify(f)+'\\n');\nfor (const [delay,frame] of ${JSON.stringify(frames.map(f => Array.isArray(f) ? f : [0, f]))}) setTimeout(()=>send(frame), delay);\nlet navigationPending = false;\nconst actions = ${JSON.stringify(onCommand)};\nreadline.createInterface({input:process.stdin}).on('line', line => { fs.appendFileSync(${JSON.stringify(log)}, line+'\\n'); const frame=JSON.parse(line); if(frame.type==='start_turn' && navigationPending) process.stderr.write('EARLY_START\\n'); for(const a of actions) if(a.type===frame.type && (!a.prompt || a.prompt===frame.request?.prompt)) { if(a.delay && frame.type==='navigate_checkpoint') navigationPending=true; const respond=()=>{ for(const f of a.frames) { if(a.correlate && f.payload?.type==='gateway_turn_command_result') f.payload.result.command_id=frame.command_id; send(f); } if(frame.type==='navigate_checkpoint') navigationPending=false; }; if(a.delay) setTimeout(respond,a.delay); else respond(); } });\n}`);
  fs.chmodSync(bin, 0o755);
  const env = { PATH: process.env.PATH, NODECODE_BIN: bin, NODECODE_HOME: home, OPENRIG_HOME: path.join(dir, 'rig'), OPENRIG_URL: api.url, OPENRIG_ACTIVITY_HOOK_TOKEN: onChannel && overrides.OPENRIG_RUN_ID ? 'oag_native_fixture' : 'hook-token', OPENRIG_SESSION_NAME: 'pod-worker@rig', OPENRIG_NODE_ID: 'node', OPENRIG_LAUNCH_RESULT: path.join(dir, 'record'), ...overrides };
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

test('answers subscription declares the native session before the first turn', async t => {
  const r = await runner(t, {
    frames: [resumed({ session_id: 'native-answers' }), resumed({ session_id: 'native-answers' })],
    onCommand: [{ type: 'start_turn', frames: [result(), ended()] }],
    start({ input }) { input.end('hello\n'); },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.commands[0], {
    type: 'set_session_subscriptions', answers: true, subscriptions: ['native-answers'], pid: process.pid,
  });
  assert.equal(r.commands[1].type, 'start_turn');
  assert.equal(r.commands.filter(c => c.type === 'set_session_subscriptions').length, 1);
  assert.equal(r.stderr.split('answers: subscribed').length - 1, 1);
});

test('test-only NO_ANSWERS hook suppresses the subscription', async t => {
  const r = await runner(t, {
    env: { OPENRIG_NODECODE_NO_ANSWERS: '1' },
    onCommand: [{ type: 'start_turn', frames: [result(), ended()] }],
    start({ input }) { input.end('hello\n'); },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.commands.map(c => c.type), ['start_turn']);
  assert.doesNotMatch(r.stderr, /answers: subscribed/);
});

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
  const r = await runner(t, { noOwner: true, env: { OPENRIG_RESUME_REF: 'ref', OPENRIG_RUN_ID: 'private-run', OPENRIG_OTHER_SECRET: 'remove' }, onHook: closeOnReady });
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
  assert.equal(r.code, 0, r.stderr); assert.equal(polls, 2); assert.equal(r.commands.filter(c => c.type !== 'set_session_subscriptions')[0].answer, 'No');
});

test('permission choice classifiers read meaning and reject ambiguity', () => {
  const cases = [
    ['Allow once', 'allow_once'], ['Deny', 'reject_once'], ["Don't allow", 'reject_once'],
    ['Do not permit', 'reject_once'], ['Never run', 'reject_once'], ['No, cancel', 'reject_once'],
    ['Yes, always', 'allow_always'], ['Allow for this session', 'allow_always'],
    ['Deny always', 'reject_always'], ['  OKAY!  ', 'allow_once'], ['Y', 'allow_once'],
    ['N', 'reject_once'], ['Approve all', 'allow_always'], ['Block every request', 'reject_always'],
    ["Allow, don't ask again", 'allow_always'], ['Allow and deny', null], ['Red', null],
    ['allowance', null], ['nobody', null], ["Don't allow or deny", null],
  ];
  assert.equal(typeof activityModule.classifyChoice, 'function');
  for (const [name, expected] of cases) assert.equal(activityModule.classifyChoice(name), expected, name);
  assert.deepEqual(activityModule.classifyChoices(['Deny', 'Allow']), ['reject_once', 'allow_once']);
  assert.equal(activityModule.classifyChoices(['Red', 'Blue']), null);
  assert.equal(activityModule.classifyChoices(['Yes', 'Ok']), null);
});

test('reversed permission choices retain meaning and answer the original choice', async t => {
  const r = await runner(t, {
    frames: [resumed(), question([{ ...q, choices: ['Deny', 'Allow'] }])],
    onCommand: [{ type: 'answer_question', frames: [question([])] }],
    onHook(h, { input }) { if (h.subtype === 'permission_resolved') input.end(); },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.requests.find(r => r.url === '/api/activity/permission-requests').body.options, [
    { optionId: 'choice-0', name: 'Deny', kind: 'reject_once' },
    { optionId: 'choice-1', name: 'Allow', kind: 'allow_once' },
  ]);
  assert.equal(r.commands.find(c => c.type === 'answer_question').answer, 'Deny');
});

test('permission choices classify once and always after first-four truncation', async t => {
  const api = await server(t, () => ({ ok: true, state: 'answered', optionId: 'choice-0' }));
  const notes = []; t.mock.method(process.stderr, 'write', s => { notes.push(s); return true; });
  const activity = createActivity({ env: { OPENRIG_URL: api.url, OPENRIG_ACTIVITY_HOOK_TOKEN: 't' } });
  await activity.ask({ question: { ...q, choices: ['Allow', 'Deny', 'Allow for this session', 'Deny always', 'Red'] } });
  assert.deepEqual(api.requests[0].body.options.map(o => o.kind), ['allow_once', 'reject_once', 'allow_always', 'reject_always']);
  assert.equal(api.requests[0].body.options.length, 4);
  assert.match(notes.join(''), /only the first four/);
});

for (const choices of [['Red', 'Blue'], ['Yes', 'Ok']]) {
  test(`ambiguous permission choices ${choices.join('/')} remain in the pane`, async t => {
    const api = await server(t, () => ({ ok: true, state: 'answered', optionId: 'choice-0' }));
    const notes = []; t.mock.method(process.stderr, 'write', s => { notes.push(s); return true; });
    const activity = createActivity({ env: { OPENRIG_URL: api.url, OPENRIG_ACTIVITY_HOOK_TOKEN: 't' } });
    await activity.ask({ question: { ...q, title: 'Pick a choice', choices }, onAnswer: () => assert.fail('manual choice answered through OpenRig') });
    assert.equal(api.requests.some(r => r.url === '/api/activity/permission-requests'), false);
    assert.match(notes.join(''), /Pick a choice/);
    assert.match(notes.join(''), /Type the exact choice/);
    for (const choice of choices) assert.ok(notes.join('').includes(choice));
  });
}

test('4 free text questions are answered from TTY and never posted as permission requests', async t => {
  const r = await runner(t, { tty: true, frames: [resumed(), [40, question([{ question_id: 'text', title: 'Your answer?' }])]], onCommand: [{ type: 'answer_question', frames: [question([])] }], start({ input }) { setTimeout(() => input.write('anything typed\r'), 150); setTimeout(() => input.end(), 250); } });
  assert.equal(r.code, 0, r.stderr); assert.match(r.stderr, /Your answer/);
  assert.equal(r.commands.filter(c => c.type !== 'set_session_subscriptions')[0].answer, 'anything typed'); assert.equal(r.requests.some(r => r.url === '/api/activity/permission-requests'), false);
  for (const [tty, typed] of [[true, ''], [false, ''], [true, '/abort']]) {
    const blank = await runner(t, { tty, frames: [resumed(), question([{ question_id: 'text', title: 'Blank is allowed', choices: [] }])], onCommand: [{ type: 'answer_question', frames: [question([])] }], start({ input }) { setTimeout(() => input.write(typed + '\n'), 100); setTimeout(() => input.end(), 180); } });
    assert.equal(blank.code, 0, blank.stderr); assert.equal(blank.commands.filter(c => c.type !== 'set_session_subscriptions')[0].answer, typed); assert.equal(blank.requests.some(r => r.url === '/api/activity/permission-requests'), false);
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
  assert.equal(r.commands.filter(c => c.type !== 'set_session_subscriptions').length, 0);
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
  assert.equal(r.code, 0, r.stderr); assert.equal(r.commands.filter(c => c.type !== 'set_session_subscriptions').length, 3);
  for (const c of r.commands.filter(c => c.type !== 'set_session_subscriptions').slice(0, 2)) assert.deepEqual({ ...c.request, prompt: undefined }, { prompt: undefined, provider: 'provider', model: 'model', effort: 'high' });
  assert.deepEqual(r.commands.filter(c => c.type !== 'set_session_subscriptions')[2].request, { prompt: 'three' });
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
    ids.push(r.commands.filter(c => c.type !== 'set_session_subscriptions')[0].command_id);
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
    assert.deepEqual(r.commands.filter(c => c.type !== 'set_session_subscriptions').map(c => c.request.prompt), ['one', 'two']);
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
  const cases = [
    [[], {}, [], null],
    [['--default-seat-profile', 'auto'], {}, [], 'openrig-main-lead'],
    [['--seat-profile', 'auto'], {}, ['openrig-main-lead'], 'openrig-main-lead'],
    [['--default-seat-profile', 'fallback'], {}, [], 'fallback'],
    [['--default-seat-profile', 'none'], {}, [], null],
    [['--default-seat-profile', 'fallback'], { NODECODE_SEAT_PROFILE: 'auto' }, [], 'openrig-main-lead'],
    [['--default-seat-profile', 'fallback'], { OPENRIG_NODECODE_SEAT_PROFILE: 'old' }, [], 'old'],
    [['--seat-profile', 'none'], { NODECODE_SEAT_PROFILE: '../ignored' }, [], null],
    [[], { NODECODE_SEAT_PROFILE: 'chosen', OPENRIG_NODECODE_SEAT_PROFILE: 'old' }, [], 'chosen'],
    [[], { OPENRIG_NODECODE_SEAT_PROFILE: 'old' }, [], 'old'],
    [[], { NODECODE_SEAT_PROFILE: '', OPENRIG_NODECODE_SEAT_PROFILE: 'old' }, [], 'old'],
    [[], { NODECODE_SEAT_PROFILE: '', OPENRIG_NODECODE_SEAT_PROFILE: '' }, [], null],
    [['--default-seat-profile', 'auto'], { NODECODE_SEAT_PROFILE: '', OPENRIG_NODECODE_SEAT_PROFILE: '' }, [], 'openrig-main-lead'],
    [['--default-seat-profile', 'auto'], { NODECODE_SEAT_PROFILE: 'none' }, [], null],
    [['--seat-profile', 'named'], {}, [], 'named'],
    [['--seat-profile', 'named'], {}, ['named'], 'named'],
    ...['auto', 'named', 'none'].map(selection => [
      ['--profile', 'legacy', '--seat-profile', selection, '--default-seat-profile', 'fallback'],
      { NODECODE_SEAT_PROFILE: 'chosen', OPENRIG_NODECODE_SEAT_PROFILE: 'old' }, [],
      selection === 'auto' ? 'openrig-main-lead' : selection === 'none' ? null : selection,
    ]),
    [['--seat-profile', 'none', '--profile', 'legacy'], { NODECODE_SEAT_PROFILE: 'chosen' }, [], null],
    [['--profile', 'legacy', '--default-seat-profile', 'auto'], { NODECODE_SEAT_PROFILE: 'chosen', OPENRIG_NODECODE_SEAT_PROFILE: 'old' }, [], 'legacy', true],
  ];
  for (const [argv, environment, names, expected, legacy = false] of cases) {
    const r = await runner(t, { argv, env: { OPENRIG_SESSION_NAME: 'Main Lead', ...environment, ...(expected ? {OPENRIG_RESUME_REF: 'ref'} : {}) }, setup({dir, home, env, api}) {
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
    assert.deepEqual(calls,expected && !legacy ? [['profile','list'],...(!names.includes(expected) ? [['profile','create',expected]] : [])] : []);
    if(expected) {
      assert.equal(r.requests[0].headers.authorization,'Bearer seat-token');
      if (!legacy) assert.match(r.stderr, new RegExp(expected));
      assert.equal(fs.readlinkSync(path.join(r.env.TEST_PROFILE_ROOT, expected, 'cells/sam-openrig')), openrigCell);
      assert.equal(fs.existsSync(path.join(r.home, 'cells/sam-openrig')), false);
    }
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
    assert.deepEqual(r.commands.filter(c => c.type !== 'set_session_subscriptions').map(c => c.type), navigate ? ['navigate_checkpoint', 'start_turn'] : ['start_turn']);
    if (navigate) {
      assert.equal(r.commands.filter(c => c.type !== 'set_session_subscriptions')[0].target_turn_id, 'good');
      assert.doesNotMatch(r.stderr, /EARLY_START/);
      assert.match(r.stderr, new RegExp(`resume: head moved to turn good \\(last completed; last turn was ${ending}\\)`));
    } else assert.doesNotMatch(r.stderr, /head moved/);
  });
}


test('environment-selected profile bootstraps and resumes through its own gateway', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-gateway-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => root);
  const r = await runner(t, {
    env: { NODECODE_SEAT_PROFILE: 'chosen', OPENRIG_RESUME_REF: 'ref' },
    gateway: `fs.writeFileSync(process.env.TEST_GATEWAY_LOG, JSON.stringify(process.argv.slice(2))); fs.writeFileSync(process.env.TEST_GATEWAY_OWNER, JSON.stringify({pid:Number(process.env.TEST_GATEWAY_PID),port:Number(process.env.TEST_GATEWAY_PORT)}));`,
    setup({ dir, env, api, gatewayLog, home }) {
      env.TEST_PROFILE_CALLS = path.join(dir, 'profile-calls');
      env.TEST_PROFILE_NAMES = path.join(dir, 'names');
      env.TEST_PROFILE_ROOT = path.join(root, '.nodecode/profiles');
      fs.writeFileSync(env.TEST_PROFILE_NAMES, '["chosen"]');
      const profile = path.join(env.TEST_PROFILE_ROOT, 'chosen');
      fs.mkdirSync(path.join(profile, 'store'), { recursive: true });
      fs.mkdirSync(path.join(profile, 'cells/linked-skills'), { recursive: true });
      fs.writeFileSync(path.join(profile, 'operator-token'), 'selected-token');
      env.TEST_GATEWAY_LOG = gatewayLog;
      env.TEST_GATEWAY_OWNER = path.join(profile, 'store/main.owner');
      env.TEST_GATEWAY_PID = String(process.pid);
      env.TEST_GATEWAY_PORT = String(api.port);
      fs.writeFileSync(path.join(home, 'store/main.owner'), JSON.stringify({ pid: process.pid, port: 1 }));
    },
    onHook: closeOnReady,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.gatewayLog)), ['-p', 'chosen', 'gateway', 'on']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'argv'))), ['-p', 'chosen', 'rpc', 'ref']);
  assert.equal(r.requests[0].headers.authorization, 'Bearer selected-token');
});

test('invalid selected profile names fail before any profile command or launch', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invalid-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => root);
  const setup = ({ dir, env }) => {
    env.TEST_PROFILE_CALLS = path.join(dir, 'profile-calls');
    env.TEST_PROFILE_NAMES = path.join(dir, 'names');
    env.TEST_PROFILE_ROOT = path.join(root, '.nodecode/profiles');
    fs.writeFileSync(env.TEST_PROFILE_NAMES, '[]');
  };
  for (const selection of [
    ['--seat-profile', '../bad'], ['--seat-profile', ''], ['--profile', '../bad'],
    ['--default-seat-profile', 'bad/name'], ['--default-seat-profile', ''], ['--profile', ''],
  ]) {
    const r = await runner(t, { argv: selection, setup, onHook: closeOnReady });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /invalid.*profile name/);
    assert.equal(fs.existsSync(path.join(r.dir, 'argv')), false);
    assert.equal(fs.existsSync(r.gatewayLog), false);
    assert.equal(fs.existsSync(r.env.TEST_PROFILE_CALLS), false);
  }
  for (const key of ['NODECODE_SEAT_PROFILE', 'OPENRIG_NODECODE_SEAT_PROFILE']) {
    for (const value of ['../bad', ' ']) {
      const r = await runner(t, { env: { [key]: value }, setup, onHook: closeOnReady });
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /invalid.*profile name/);
      assert.equal(fs.existsSync(path.join(r.dir, 'argv')), false);
      assert.equal(fs.existsSync(r.env.TEST_PROFILE_CALLS), false);
      assert.equal(fs.existsSync(r.gatewayLog), false);
    }
  }
});

test('installed default preset honors NODECODE_SEAT_PROFILE=chosen', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => root);
  const r = await runner(t, {
    env: { NODECODE_SEAT_PROFILE: 'chosen' },
    setup({ dir, env, argv }) {
      const installed = spawnSync(process.execPath, ['scripts/install-preset.mjs'], {
        env: { ...process.env, OPENRIG_HOME: env.OPENRIG_HOME }, encoding: 'utf8',
      });
      assert.equal(installed.status, 0, installed.stderr);
      const preset = fs.readFileSync(path.join(env.OPENRIG_HOME, 'community-harnesses/nodecode.yaml'), 'utf8');
      const command = /^command: (.*)$/m.exec(preset)[1];
      // Installer emits plain argv here: this isolated checkout path has no spaces.
      argv.push(...command.split(' ').slice(1));
      env.TEST_PROFILE_CALLS = path.join(dir, 'profile-calls');
      env.TEST_PROFILE_NAMES = path.join(dir, 'names');
      env.TEST_PROFILE_ROOT = path.join(root, '.nodecode/profiles');
      fs.writeFileSync(env.TEST_PROFILE_NAMES, '[]');
    },
    onHook: closeOnReady,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'argv'))), ['-p', 'chosen', 'rpc']);
  assert.deepEqual(fs.readFileSync(r.env.TEST_PROFILE_CALLS, 'utf8').trim().split('\n').map(JSON.parse),
    [['profile', 'list'], ['profile', 'create', 'chosen']]);
});

test('installed preset defaults to automatic seat profiles', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'seat-preset-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const installed=spawnSync(process.execPath,['scripts/install-preset.mjs'],{env:{...process.env,OPENRIG_HOME:dir},encoding:'utf8'});
  assert.equal(installed.status,0,installed.stderr);
  const preset=fs.readFileSync(path.join(dir,'community-harnesses/nodecode.yaml'),'utf8');
  assert.match(preset,/^command: .* --default-seat-profile auto --resume-policy last-completed$/m);
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
    assert.deepEqual(r.commands.filter(c => c.type !== 'set_session_subscriptions').map(c => c.type), resume ? ['navigate_checkpoint'] : []);
    assert.equal(r.requests.some(r => r.url.endsWith('/checkpoints')), resume);
  }
});


const openrigCell = fileURLToPath(new URL('../cells/openrig', import.meta.url));

test('openrig cell is linked in a temporary seat home at launch', async t => {
  const r = await runner(t, { onHook: closeOnReady });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readlinkSync(path.join(r.home, 'cells/sam-openrig')), openrigCell);
});

test('openrig cell linking is idempotent', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openrig-cell-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(typeof skills.linkOpenrigCell, 'function');
  const notes = [];
  skills.linkOpenrigCell(home, message => notes.push(message));
  const link = path.join(home, 'cells/sam-openrig');
  const before = fs.lstatSync(link);
  skills.linkOpenrigCell(home, message => notes.push(message));
  assert.equal(fs.readlinkSync(link), openrigCell);
  assert.equal(fs.lstatSync(link).ino, before.ino);
  assert.deepEqual(notes, []);
});

test('openrig cell preserves foreign directories and symlinks with one note', async t => {
  for (const kind of ['directory', 'symlink']) await t.test(kind, async t => {
    const r = await runner(t, { setup({ home, dir }) {
      const link = path.join(home, 'cells/sam-openrig');
      if (kind === 'directory') { fs.mkdirSync(link); fs.writeFileSync(path.join(link, 'keep'), 'foreign'); }
      else fs.symlinkSync(path.join(dir, 'missing-foreign'), link);
    }, onHook: closeOnReady });
    assert.equal(r.code, 0, r.stderr);
    const link = path.join(r.home, 'cells/sam-openrig');
    if (kind === 'directory') assert.equal(fs.readFileSync(path.join(link, 'keep'), 'utf8'), 'foreign');
    else assert.equal(fs.readlinkSync(link), path.join(r.dir, 'missing-foreign'));
    assert.equal(r.stderr.split('\n').filter(line => line.includes('sam-openrig')).length, 1);
  });
});

test('--no-openrig-cell skips linking and preserves an existing cell', async t => {
  for (const existing of [false, true]) {
    const r = await runner(t, { argv: ['--no-openrig-cell'], setup({ home }) {
      if (existing) fs.symlinkSync(openrigCell, path.join(home, 'cells/sam-openrig'));
    }, onHook: closeOnReady });
    assert.equal(r.code, 0, r.stderr);
    const link = path.join(r.home, 'cells/sam-openrig');
    if (existing) assert.equal(fs.readlinkSync(link), openrigCell);
    else assert.throws(() => fs.lstatSync(link), { code: 'ENOENT' });
    assert.doesNotMatch(r.stderr, /sam-openrig/);
  }
});

test('run channel accepts once, reports native IDs and returns only the dedicated wake text', async t => {
  const frame = { version: 1, runId: 'run-1', requestId: 'wake-1', sequence: 1, kind: 'wake', payload: { question: 'managed question' } };
  const posts = [];
  const r = await runner(t, {
    env: { OPENRIG_RUN_ID: 'run-1' },
    onChannel(req, res, { input }) {
      assert.equal(req.headers.authorization, 'Bearer oag_native_fixture');
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`id: 1\nevent: request\ndata: ${JSON.stringify(frame)}\n\nid: 1\nevent: request\ndata: ${JSON.stringify(frame)}\n\n`);
        return new Promise(resolve => res.on('close', resolve));
      }
      posts.push(req.body);
      if (req.body.type === 'hello') return { version: 1, runId: 'run-1', capabilities: { input: true, wake: true, cancel: false }, receipts: [], unresolved: [] };
      if (req.body.type === 'result') input.end();
      return { receipt: { ...frame, stage: req.body.type === 'ack' ? 'accepted' : req.body.type === 'submitted' ? 'submitted' : 'completed' } };
    },
    onCommand: [{ type: 'start_turn', prompt: 'managed question', correlate: true, frames: [result(), delta({ type: 'text', text: 'exact answer' }), ended()] }],
    start({ input }) { setTimeout(() => input.end(), 800).unref(); },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.commands.filter(c => c.type === 'start_turn').map(c => c.request.prompt), ['managed question']);
  assert.equal(posts.filter(p => p.type === 'ack').length, 1);
  assert.equal(posts.find(p => p.type === 'submitted').nativeTurnId, 'turn');
  assert.deepEqual(posts.find(p => p.type === 'result').result, { kind: 'wake', nativeTurnId: 'turn', completion: 'completed', answer: 'exact answer' });
  assert.deepEqual(posts[0].capabilities, { input: true, wake: true, cancel: true });
  assert.equal(posts[0].retained, false);
});

test('new run credential and run ID never reach the native child or profile helper', async t => {
  const r = await runner(t, {
    env: { OPENRIG_RUN_ID: 'private-run', OPENRIG_ACTIVITY_HOOK_TOKEN: 'private-token' },
    onHook: closeOnReady,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'private-env'))), { token: false, run: false });
});

async function channelScenario(t, { operations, onCommand, frames, start, loseAck = false, loseResult = false, reconnect = false, transient, streamFailure, mutate, expectedResults = operations.length, expectedCode = 0 }) {
  const posts = [], hellos = [], receipts = new Map();
  let streams = 0, droppedAck = false, droppedResult = false, transientHits = 0;
  const r = await runner(t, {
    env: { OPENRIG_RUN_ID: 'run-1' }, frames, onCommand, start,
    onChannel(req, res, { input }) {
      if (req.method === 'GET') {
        streams++;
        if (streamFailure && streams === 2) { res.writeHead(409); res.end(JSON.stringify({ code: streamFailure })); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const frame of operations) {
          const data = JSON.stringify(frame);
          // Exercise UTF-8/chunk/framing boundaries and duplicate delivery.
          res.write(`id: ${frame.sequence}\r\nevent: request\r\ndata: ${data}`);
          res.write('\r\n\r\n');
        }
        if (reconnect && streams === 1) res.end();
        else return new Promise(resolve => res.on('close', resolve));
        return;
      }
      const body = req.body; posts.push(body);
      if (transient && body.type === transient.type && transientHits === 0) { transientHits++; res.writeHead(409); res.end(JSON.stringify({ code: transient.code })); return; }
      if (body.type === 'hello') {
        hellos.push(body);
        return { version: 1, runId: 'run-1', capabilities: { input: true, wake: true, cancel: false },
          receipts: [...receipts.values()], unresolved: [...receipts.values()].filter(r => !['completed', 'rejected'].includes(r.stage)) };
      }
      const source = operations.find(r => r.requestId === body.requestId);
      const receipt = { ...source, stage: body.type === 'ack' ? 'accepted' : body.type === 'submitted' ? 'submitted' : body.type === 'rejected' ? 'rejected' : 'completed' };
      receipts.set(body.requestId, receipt);
      if (body.type === 'ack' && loseAck && !droppedAck) { droppedAck = true; res.destroy(); return; }
      if (body.type === 'result' && loseResult && !droppedResult) { droppedResult = true; res.destroy(); return; }
      if ([...receipts.values()].filter(r => ['completed', 'rejected'].includes(r.stage)).length === expectedResults) input.end();
      return mutate ? mutate(body, receipt) : { receipt };
    },
  });
  assert.equal(r.code, expectedCode, r.stderr);
  return { ...r, posts, hellos, streams, transientHits };
}
const managed = (sequence, kind = 'wake', text = `question-${sequence}`) => ({ version: 1, runId: 'run-1', requestId: `request-${sequence}`, sequence, kind, stage: 'offered', payload: kind === 'wake' ? { question: text } : { text } });
const nativeResult = (id, status = 'accepted') => ({ payload: { type: 'gateway_turn_command_result', result: { command: 'start_turn', status, response: { turn_id: id } } } });
const nativeEnd = (id, type = 'turn.completed') => ({ payload: { type: 'session_stream_event', frame: { event: { type, turn_id: id } } } });
const nativeText = (id, text) => ({ payload: { type: 'item_delta', turn_id: id, delta: { type: 'text', text } } });
const action = (prompt, id, extra = [], type = 'turn.completed', delay = 0) => ({ type: 'start_turn', prompt, correlate: true, delay, frames: [nativeResult(id), ...extra, nativeEnd(id, type)] });

test('busy managed inputs and two dedicated wakes reuse the native FIFO without mixing answers', async t => {
  const r = await channelScenario(t, {
    operations: [managed(1, 'input', 'ordinary'), managed(2), managed(3), managed(4, 'input', 'after')],
    start({ input }) { input.write('person\n'); },
    onCommand: [action('person', 'person', [nativeText('person', 'previous')], 'turn.completed', 80), action('ordinary', 'ordinary'),
      action('question-2', 'wake-2', [nativeText('wake-2', 'café 🧪')], 'turn.completed', 20),
      action('question-3', 'wake-3', [nativeText('wake-3', 'second')]), action('after', 'after')],
  });
  assert.deepEqual(r.commands.filter(c => c.type === 'start_turn').map(c => c.request.prompt), ['person', 'ordinary', 'question-2', 'question-3', 'after']);
  assert.deepEqual(r.posts.filter(p => p.type === 'result' && p.result.kind === 'wake').map(p => p.result.answer), ['café 🧪', 'second']);
});

test('lost ack/result responses and stream reconnect retain custody without a second native write', async t => {
  const r = await channelScenario(t, { operations: [managed(1)], loseAck: true, loseResult: true, reconnect: true,
    onCommand: [action('question-1', 'native-one', [nativeText('native-one', 'one')], 'turn.completed', 200)] });
  assert.equal(r.commands.filter(c => c.type === 'start_turn').length, 1);
  assert.ok(r.hellos.length >= 2);
  assert.equal(r.hellos[0].retained, false);
  assert.ok(r.hellos.slice(1).every(h => h.retained === true));
  const results = r.posts.filter(p => p.type === 'result');
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(r.posts.filter(p => p.type === 'ack')[0], r.posts.filter(p => p.type === 'ack')[1]);
});

test('failed, cancelled and foreign-output wakes never return an answer', async t => {
  for (const [name, extra, ending, completion] of [
    ['failed', [], 'turn.failed', 'failed'], ['cancelled', [], 'turn.cancelled', 'interrupted'],
    ['foreign', [nativeText('other-turn', 'unrelated')], 'turn.completed', 'unknown'],
  ]) await t.test(name, async t => {
    const r = await channelScenario(t, { operations: [managed(1)],
      onCommand: [action('question-1', 'native-one', [...extra, nativeText('native-one', 'partial')], ending)] });
    const result = r.posts.find(p => p.type === 'result').result;
    assert.equal(result.completion, completion); assert.equal(result.answer, null);
    if (name === 'foreign') assert.equal(result.ownershipUnknown, true);
  });
});

test('native rejection is retained without a typed or native fallback', async t => {
  const r = await channelScenario(t, { operations: [managed(1)], onCommand: [{ type: 'start_turn', correlate: true, frames: [nativeResult('never', 'rejected')] }] });
  assert.equal(r.commands.filter(c => c.type === 'start_turn').length, 1);
  assert.equal(r.posts.find(p => p.type === 'rejected').result.completion, 'failed');
});

test('older Core without the optional channel preserves ordinary pane input', async t => {
  const r = await runner(t, { env: { OPENRIG_RUN_ID: 'run-1' }, start({ input }) { input.end('ordinary\n'); },
    onChannel(req, res) { res.writeHead(404); res.end('{}'); },
    onCommand: [action('ordinary', 'person')] });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.commands.filter(c => c.type === 'start_turn').map(c => c.request.prompt), ['ordinary']);
});

test('unlabelled native admission reports submission uncertainty and cannot complete from recent output', async t => {
  const r = await channelScenario(t, { operations: [managed(1)], expectedCode: 143,
    onCommand: [{ type: 'start_turn', frames: [nativeResult('unbound'), nativeText('unbound', 'wrong'), nativeEnd('unbound')] }],
    start({ input }) { setTimeout(() => input.end(), 200).unref(); setTimeout(() => process.emit('SIGTERM'), 300).unref(); },
  });
  assert.equal(r.commands.filter(c => c.type === 'start_turn').length, 1);
  const reported = r.posts.find(p => p.type === 'result').result;
  assert.equal(reported.submissionUnknown, true);
  assert.equal(reported.completion, 'unknown'); assert.equal(reported.answer, null);
});

test('terminal wake without assistant text is unknown, then the next managed input advances', async t => {
  const r = await channelScenario(t, { operations: [managed(1), managed(2, 'input', 'next')],
    onCommand: [action('question-1', 'empty'), action('next', 'next')] });
  const wake = r.posts.find(p => p.type === 'result' && p.result.kind === 'wake').result;
  assert.equal(wake.completion, 'unknown'); assert.equal(wake.answer, null);
  assert.equal(r.commands.filter(c => c.type === 'start_turn').length, 2);
});

test('new scoped credential is absent from both profile list/create subprocesses', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecode-private-profile-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  const r = await runner(t, { env: { OPENRIG_RUN_ID: 'run-1' }, argv: ['--seat-profile', 'auto'],
    setup({ env, dir }) {
      env.TEST_PROFILE_CALLS = path.join(dir, 'calls'); env.TEST_PROFILE_NAMES = path.join(dir, 'names');
      env.TEST_PROFILE_ROOT = path.join(home, '.nodecode/profiles'); fs.writeFileSync(env.TEST_PROFILE_NAMES, '[]');
    }, onHook: closeOnReady });
  assert.equal(r.code, 0, r.stderr);
  const checks = fs.readFileSync(path.join(r.dir, 'profile-private-env'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(checks, [{ token: false, run: false }, { token: false, run: false }]);
});

test('wrong run, conflicting replay, lost map and uncommitted ack refuse before another native effect', async t => {
  for (const mode of ['wrong-run', 'sequence-conflict', 'payload-conflict', 'lost-map', 'ack-malformed', 'ack-refused', 'ack-already-completed']) await t.test(mode, async t => {
    let posts = 0, streams = 0;
    const offered = managed(1, 'input', 'only-once');
    const r = await runner(t, { env: { OPENRIG_RUN_ID: 'run-1' },
      onChannel(req, res) {
        if (req.body?.type === 'hello') return { version: 1, runId: 'run-1', capabilities: { input: true, wake: true, cancel: false },
          receipts: mode === 'lost-map' ? [{ ...offered, stage: 'submitted', reconciliation: 'receiver_state_lost' }] : [], unresolved: [] };
        if (req.method === 'GET') {
          streams++;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          let frames = mode === 'wrong-run' ? [{ ...offered, runId: 'wrong' }] : [offered];
          if (mode === 'sequence-conflict') frames.push({ ...offered, requestId: 'other-request' });
          if (mode === 'payload-conflict') frames.push({ ...offered, payload: { text: 'other-text' } });
          for (const frame of frames) res.write(`id: 1\nevent: request\ndata: ${JSON.stringify(frame)}\n\n`);
          return new Promise(resolve => res.on('close', resolve));
        }
        posts++;
        if (mode === 'ack-refused') { res.writeHead(403); res.end('{}'); return; }
        if (mode === 'ack-malformed') return { ok: true };
        if (mode === 'ack-already-completed') return { receipt: { ...offered, stage: 'completed' } };
        return { receipt: { ...offered, stage: 'accepted' } };
      },
      onCommand: [action('only-once', 'one')],
      start({ input }) { setTimeout(() => input.end(), 180).unref(); },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.commands.filter(c => c.type === 'start_turn').length <= (mode.endsWith('conflict') ? 1 : 0));
    if (mode === 'lost-map') assert.equal(streams, 0);
    if (mode === 'wrong-run') assert.equal(posts, 0);
  });
});

test('person abort remains turn scoped during a managed wake and releases the held input', async t => {
  const r = await channelScenario(t, { operations: [managed(1), managed(2, 'input', 'successor')],
    onCommand: [
      { type: 'start_turn', prompt: 'question-1', correlate: true, frames: [nativeResult('wake'), nativeText('wake', 'partial')] },
      { type: 'cancel_turn', frames: [nativeEnd('wake', 'turn.cancelled')] }, action('successor', 'successor'),
    ], start({ input }) { setTimeout(() => input.write('/abort\n'), 140).unref(); },
  });
  const cancel = r.commands.find(c => c.type === 'cancel_turn'); assert.equal(cancel.turn_id, 'wake');
  assert.equal(r.posts.find(p => p.type === 'result' && p.result.kind === 'wake').result.completion, 'interrupted');
  assert.equal(r.posts.find(p => p.type === 'result' && p.result.kind === 'wake').result.answer, null);
  assert.deepEqual(r.commands.filter(c => c.type === 'start_turn').map(c => c.request.prompt), ['question-1', 'successor']);
});

test('reconnect hello leaves pending requests for the actual offered transition', async t => {
  const operations = [managed(1, 'input', 'first'), managed(2, 'input', 'second')];
  const stages = new Map(); let gets = 0; const errors = [], hellos = [];
  const r = await runner(t, { env: { OPENRIG_RUN_ID: 'run-1' },
    onCommand: [action('first', 'first'), action('second', 'second')],
    onChannel(req, res, { input }) {
      if (req.body?.type === 'hello') {
        hellos.push(req.body.retained);
        const receipts = operations.filter(f => stages.has(f.requestId)).map(f => ({ ...f, stage: stages.get(f.requestId) }));
        return { version: 1, runId: 'run-1', capabilities: { input: true, wake: true, cancel: false }, receipts, unresolved: receipts.filter(f => f.stage !== 'completed') };
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (++gets === 1) { stages.set('request-1', 'offered'); stages.set('request-2', 'pending'); res.end(); return; }
        const frame = operations[1]; stages.set(frame.requestId, 'offered');
        res.write(`id: 2\nevent: request\ndata: ${JSON.stringify(frame)}\n\n`);
        return new Promise(resolve => res.on('close', resolve));
      }
      const body = req.body, stage = stages.get(body.requestId);
      const expected = { ack: 'offered', submitted: 'accepted', result: 'submitted' }[body.type];
      if (stage !== expected) { errors.push([body.type, stage]); res.writeHead(409); res.end(JSON.stringify({ code: 'runner_stage_conflict' })); input.end(); return; }
      const next = { ack: 'accepted', submitted: 'submitted', result: 'completed' }[body.type]; stages.set(body.requestId, next);
      if ([...stages.values()].every(value => value === 'completed')) input.end();
      return { receipt: { ...operations.find(f => f.requestId === body.requestId), stage: next } };
    }, start({ input }) { setTimeout(() => input.end(), 700).unref(); },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(errors, []); assert.deepEqual(hellos, [false, true]); assert.equal(gets, 2);
  assert.deepEqual(r.commands.filter(c => c.type === 'start_turn').map(c => c.request.prompt), ['first', 'second']);
});

test('an inherited run ID with a legacy credential preserves ordinary input without a native claim', async t => {
  const calls = [];
  const r = await runner(t, { env: { OPENRIG_RUN_ID: 'inherited', OPENRIG_ACTIVITY_HOOK_TOKEN: 'hook-token' },
    onChannel(req) { calls.push(req.method); return { version: 1, runId: 'inherited', capabilities: { input: true, wake: true, cancel: false }, receipts: [], unresolved: [] }; },
    onCommand: [action('ordinary', 'person')], start({ input }) { input.end('ordinary\n'); } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.commands.filter(c => c.type === 'start_turn').map(c => c.request.prompt), ['ordinary']);
  assert.deepEqual(calls, []);
  assert.ok(r.hooks.length > 0); assert.ok(r.hooks.every(h => !Object.hasOwn(h, 'runId') && !Object.hasOwn(h, 'nativeTurnId')));
});

test('pending and unverified channel posts retain the same report until recovery without replay', async t => {
  for (const code of ['runner_grant_pending', 'runner_grant_unverified']) for (const type of ['hello', 'ack', 'result']) await t.test(`${code} ${type}`, async t => {
    const r = await channelScenario(t, { operations: [managed(1)], transient: { type, code },
      onCommand: [action('question-1', 'one', [nativeText('one', 'answer')])],
      start({ input }) { setTimeout(() => input.end(), 1200).unref(); } });
    assert.equal(r.transientHits, 1);
    assert.equal(r.commands.filter(c => c.type === 'start_turn').length, 1);
    const retried = r.posts.filter(p => p.type === type); assert.equal(retried.length, 2);
    assert.deepEqual(retried[0], retried[1]);
    assert.equal(r.posts.filter(p => p.type === 'result').at(-1).result.answer, 'answer');
  });
});

test('pending and unverified SSE reconnect preserve retained receiver custody', async t => {
  for (const code of ['runner_grant_pending', 'runner_grant_unverified']) await t.test(code, async t => {
    const r = await channelScenario(t, { operations: [managed(1)], reconnect: true, streamFailure: code,
      onCommand: [action('question-1', 'one', [nativeText('one', 'answer')], 'turn.completed', 300)],
      start({ input }) { setTimeout(() => input.end(), 1500).unref(); } });
    assert.ok(r.streams >= 3); assert.ok(r.hellos.length >= 3);
    assert.equal(r.hellos[0].retained, false); assert.ok(r.hellos.slice(1).every(h => h.retained));
    assert.equal(r.commands.filter(c => c.type === 'start_turn').length, 1);
    assert.equal(r.posts.filter(p => p.type === 'ack').length, 1);
    assert.equal(r.posts.filter(p => p.type === 'result').length, 1);
    assert.equal(r.posts.find(p => p.type === 'result').result.answer, 'answer');
  });
});

test('permanent SSE authority and protocol refusals do not reconnect or execute', async t => {
  for (const [status, code] of [[401, 'runner_grant_revoked'], [409, 'runner_grant_stale'], [409, 'unknown_conflict'], [400, 'runner_grant_unverified']]) await t.test(code, async t => {
    let posts = 0, gets = 0;
    const r = await runner(t, { env: { OPENRIG_RUN_ID: 'run-1' }, onChannel(req, res) {
      if (req.method === 'POST') { posts++; return { version: 1, runId: 'run-1', capabilities: { input: true, wake: true, cancel: false }, receipts: [], unresolved: [] }; }
      gets++; res.writeHead(status); res.end(JSON.stringify({ code }));
    }, start({ input }) { setTimeout(() => input.end(), 200).unref(); } });
    assert.equal(r.code, 0, r.stderr); assert.equal(posts, 1); assert.equal(gets, 1);
    assert.equal(r.commands.some(c => c.type === 'start_turn'), false);
  });
});

test('startup retries only explicit pending-grant standing with the same run credential', async t => {
  let hellos = 0; const posts = [], frame = managed(1, 'input', 'after-activation');
  const r = await runner(t, { env: { OPENRIG_RUN_ID: 'run-1' }, onCommand: [action('after-activation', 'activated')],
    onChannel(req, res, { input }) {
      assert.equal(req.headers.authorization, 'Bearer oag_native_fixture');
      if (req.body?.type === 'hello') {
        posts.push(req.body);
        if (++hellos === 1) { res.writeHead(409); res.end(JSON.stringify({ code: 'runner_grant_pending' })); return; }
        return { version: 1, runId: 'run-1', capabilities: { input: true, wake: true, cancel: false }, receipts: [], unresolved: [] };
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`id: 1\nevent: request\ndata: ${JSON.stringify(frame)}\n\n`);
        return new Promise(resolve => res.on('close', resolve));
      }
      if (req.body.type === 'result') input.end();
      return { receipt: { ...frame, stage: { ack: 'accepted', submitted: 'submitted', result: 'completed' }[req.body.type] } };
    }, start({ input }) { setTimeout(() => input.end(), 700).unref(); },
  });
  assert.equal(r.code, 0, r.stderr); assert.equal(hellos, 2); assert.deepEqual(posts[0], posts[1]);
  assert.deepEqual(r.commands.filter(c => c.type === 'start_turn').map(c => c.request.prompt), ['after-activation']);
});

test('managed quarantine retains its successor while later manual prompts and abort remain usable', async t => {
  for (const tty of [false, true]) await t.test(tty ? 'Ctrl-C' : '/abort', async t => {
  const operations = [managed(1), managed(2, 'input', 'held-managed')], posts = [];
  const r = await runner(t, { tty, env: { OPENRIG_RUN_ID: 'run-1' },
    onCommand: [action('question-1', 'wake', [nativeText('foreign', 'other'), nativeText('wake', 'unsafe')], 'turn.completed', 80),
      { type: 'start_turn', prompt: 'manual-one', correlate: true, frames: [nativeResult('person-one')] },
      { type: 'cancel_turn', frames: [nativeEnd('person-one', 'turn.cancelled')] }, action('manual-two', 'person-two')],
    onChannel(req, res, { input }) {
      if (req.body?.type === 'hello') return { version: 1, runId: 'run-1', capabilities: { input: true, wake: true, cancel: false }, receipts: [], unresolved: [] };
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const f of operations) res.write(`id: ${f.sequence}\nevent: request\ndata: ${JSON.stringify(f)}\n\n`);
        return new Promise(resolve => res.on('close', resolve));
      }
      posts.push(req.body);
      if (req.body.type === 'result') { input.write('manual-one\nmanual-two\n'); setTimeout(() => { input.write(tty ? '\u0003' : '/abort\n'); input.end(); }, 80).unref(); }
      return { receipt: { ...operations.find(f => f.requestId === req.body.requestId), stage: { ack: 'accepted', submitted: 'submitted', result: 'completed' }[req.body.type] } };
    }, start({ input }) { setTimeout(() => input.end(), 600).unref(); },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.commands.filter(c => c.type === 'start_turn').map(c => c.request.prompt), ['question-1', 'manual-one', 'manual-two']);
  assert.equal(r.commands.find(c => c.type === 'cancel_turn').turn_id, 'person-one');
  assert.equal(posts.find(p => p.type === 'result').result.ownershipUnknown, true);
  assert.equal(posts.filter(p => p.requestId === 'request-2').length, 1);
  assert.equal(posts.find(p => p.requestId === 'request-2').type, 'ack');
  });
});

test('non-pending authority and protocol failures stay permanent rather than retrying every 409', async t => {
  for (const [status, code] of [[401, 'runner_grant_revoked'], [409, 'runner_grant_stale'], [409, 'runner_run_mismatch'],
    [409, 'runner_stage_conflict'], [409, 'unknown_conflict'], [400, 'runner_grant_pending']]) await t.test(code, async t => {
    let posts = 0, gets = 0;
    const r = await runner(t, { env: { OPENRIG_RUN_ID: 'run-1' }, onChannel(req, res) {
      if (req.method === 'GET') gets++; else posts++;
      res.writeHead(status); res.end(JSON.stringify({ code }));
    }, start({ input }) { setTimeout(() => input.end(), 180).unref(); } });
    assert.equal(r.code, 0, r.stderr); assert.equal(posts, 1); assert.equal(gets, 0);
    assert.equal(r.commands.some(c => c.type === 'start_turn'), false);
  });
});

const nativeCancelResult = (id, status = 'accepted', code = 'ok') => ({ payload: { type: 'gateway_turn_command_result', result: { command: 'cancel_turn', status, code, response: { turn_id: id } } } });
async function cancelScenario(t, { frames = [resumed(), [450, nativeEnd('E')]], onCommand, prepare, onPost, onAsk, onPoll, start, duplicate = false, env: overrides = {}, expectedCode = 0 } = {}) {
  const posts = [], request = { version: 1, runId: 'run-1', requestId: 'cancel-E', sequence: 1, kind: 'cancel', stage: 'offered', payload: { target: { runId: 'run-1', nativeTurnId: 'E' } } };
  let stream, offered = false, opened = false;
  const offer = () => { if (stream && opened && !offered) { offered = true; const frame = `id: 1\nevent: request\ndata: ${JSON.stringify(request)}\n\n`; stream.write(frame); if (duplicate) stream.write(frame); } };
  const r = await runner(t, { env: { OPENRIG_RUN_ID: 'run-1', ...overrides }, frames, onAsk, onPoll,
    onCommand: onCommand ?? [
      { type: 'start_turn', prompt: 'E', correlate: true, frames: [nativeResult('E')] },
      { type: 'cancel_turn', correlate: true, frames: [nativeCancelResult('E'), nativeEnd('E', 'turn.cancelled')] },
    ],
    onChannel: async (req, res, context) => {
      if (req.method === 'GET') { stream = res; res.writeHead(200, { 'content-type': 'text/event-stream' }); offer(); return new Promise(resolve => res.on('close', resolve)); }
      const body = req.body; posts.push(body);
      const custom = await onPost?.(body, res, context); if (custom !== undefined || res.writableEnded || res.destroyed) return custom;
      if (body.type === 'hello') return { version: 1, runId: 'run-1', capabilities: { input: true, wake: true, cancel: true }, receipts: [], unresolved: [] };
      if (body.type === 'turn') { if (body.state === 'opened' && body.nativeTurnId === 'E') { opened = true; offer(); } return { accepted: true }; }
      if (body.type === 'cancel-prepare') return prepare ? prepare(body, context) : { receipt: { ...request, stage: 'accepted' }, withdrawal: { confirmed: true, pendingSubmissions: 0, withdrawn: 0 } };
      if (body.type === 'result') context.input.end();
      return { receipt: { ...request, stage: { ack: 'accepted', submitted: 'submitted', result: 'completed' }[body.type] } };
    },
    start(context) { context.input.write('E\n'); setTimeout(() => context.input.end(), 550).unref(); start?.(context); },
  });
  assert.equal(r.code, expectedCode, r.stderr); return { ...r, posts };
}

test('named cancellation reports the exact native epoch and confirms only its cancelled terminal', async t => {
  const r = await cancelScenario(t);
  assert.equal(r.commands.filter(c => c.type === 'cancel_turn').length, 1);
  assert.equal(r.commands.find(c => c.type === 'cancel_turn').turn_id, 'E');
  assert.deepEqual(r.posts.filter(p => p.type === 'turn').map(p => [p.nativeTurnId, p.state, p.acceptedTurnIds]), [['E', 'opened', ['E']], ['E', 'closed', ['E']]]);
  assert.equal(r.posts.find(p => p.type === 'result').result.outcome, 'cancelled');
  assert.equal(r.posts.find(p => p.type === 'result').result.confirmed, true);
  assert.ok(r.posts.findIndex(p => p.type === 'cancel-prepare') < r.posts.findIndex(p => p.type === 'submitted'));
});

test('cancel fences successors before a delayed ack and never targets naturally ended E or successor F', async t => {
  let log;
  const r = await cancelScenario(t, {
    frames: [resumed(), [110, nativeEnd('E')]],
    onCommand: [{ type: 'start_turn', prompt: 'E', correlate: true, frames: [nativeResult('E')] }, action('F', 'F')],
    onPost: async body => {
      if (body.type === 'ack') {
        await pause(180);
        const commands = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
        assert.deepEqual(commands.filter(c => c.type === 'start_turn').map(c => c.request.prompt), ['E']);
      }
    }, start(context) { log = context.log; context.input.write('F\n'); },
  });
  assert.deepEqual(r.commands.filter(c => c.type === 'start_turn').map(c => c.request.prompt), ['E', 'F']);
  assert.equal(r.commands.filter(c => c.type === 'cancel_turn').length, 0);
  assert.equal(r.posts.find(p => p.type === 'result').result.outcome, 'not-this-turn');
});

test('cancel rechecks E after confirmed withdrawal and preserves a no-effect result when E ended during preparation', async t => {
  const r = await cancelScenario(t, {
    frames: [resumed(), [130, nativeEnd('E')]],
    onCommand: [{ type: 'start_turn', prompt: 'E', correlate: true, frames: [nativeResult('E')] }, action('F', 'F')],
    async prepare(body) { await pause(180); return { receipt: { version: 1, runId: 'run-1', requestId: body.requestId, sequence: body.sequence, kind: 'cancel', stage: 'accepted', payload: { target: { runId: 'run-1', nativeTurnId: 'E' } }, withdrawal: { stage: 'confirmed' } }, withdrawal: { confirmed: true, pendingSubmissions: 0, withdrawn: 1 } }; },
    start({ input }) { input.write('F\n'); },
  });
  assert.ok(r.posts.some(p => p.type === 'cancel-prepare'));
  assert.equal(r.commands.filter(c => c.type === 'cancel_turn').length, 0);
  assert.equal(r.posts.find(p => p.type === 'result').result.outcome, 'not-this-turn');
  assert.deepEqual(r.commands.filter(c => c.type === 'start_turn').map(c => c.request.prompt), ['E', 'F']);
});

test('cancellation RPC acceptance or normal completion cannot confirm cancellation', async t => {
  const r = await cancelScenario(t, { onCommand: [
    { type: 'start_turn', prompt: 'E', correlate: true, frames: [nativeResult('E')] },
    { type: 'cancel_turn', correlate: true, frames: [nativeCancelResult('E')] },
  ] });
  assert.equal(r.commands.filter(c => c.type === 'cancel_turn').length, 1);
  assert.equal(r.posts.find(p => p.type === 'submitted').result.outcome, 'requested');
  assert.equal(r.posts.find(p => p.type === 'result').result.outcome, 'requested');
  assert.equal(r.posts.find(p => p.type === 'result').result.confirmed, false);
  assert.equal(r.posts.find(p => p.type === 'result').result.operationAccepted, true);
});

test('definite native turn mismatch remains not-this-turn without a fabricated submitted cancellation', async t => {
  const r = await cancelScenario(t, { onCommand: [
    { type: 'start_turn', prompt: 'E', correlate: true, frames: [nativeResult('E')] },
    { type: 'cancel_turn', correlate: true, frames: [nativeCancelResult('E', 'rejected', 'turn_mismatch')] },
  ] });
  assert.equal(r.commands.filter(c => c.type === 'cancel_turn').length, 1);
  assert.equal(r.posts.find(p => p.type === 'result').result.outcome, 'not-this-turn');
  assert.equal(r.posts.some(p => p.type === 'submitted'), false);
});

test('known unbound native questions refuse managed cancellation without invented scoped metadata', async t => {
  const r = await cancelScenario(t, {
    frames: [resumed(), [350, nativeEnd('E')], [420, question([])]],
    onCommand: [{ type: 'start_turn', prompt: 'E', correlate: true, frames: [question([{ ...q, session_id: 'ref' }]), nativeResult('E')] }],
    onAsk: () => ({ ok: true, askId: 'unbound', state: 'pending' }), onPoll: async () => { await pause(300); return { state: 'pending' }; },
  });
  assert.equal(r.commands.some(c => c.type === 'cancel_turn'), false);
  assert.equal(r.posts.find(p => p.type === 'result').result.outcome, 'not-supported');
  const permission = r.requests.find(r => r.url === '/api/activity/permission-requests').body;
  assert.equal(Object.hasOwn(permission, 'runId'), false); assert.equal(Object.hasOwn(permission, 'nativeTurnId'), false);
  assert.equal(r.posts.some(p => p.type === 'cancel-prepare'), false);
});

test('late unbound question during cancellation is held and cannot forward an answer', async t => {
  const r = await cancelScenario(t, {
    frames: [resumed(), [110, question([{ ...q, session_id: 'ref' }])], [180, question([])], [450, nativeEnd('E')]],
    async prepare(body, { input }) {
      await pause(90); input.write('Yes\n'); await pause(110);
      return { receipt: { version: 1, runId: 'run-1', requestId: body.requestId, sequence: body.sequence, kind: 'cancel', stage: 'accepted', payload: { target: { runId: 'run-1', nativeTurnId: 'E' } } }, withdrawal: { confirmed: true, pendingSubmissions: 0, withdrawn: 0 } };
    },
  });
  assert.equal(r.commands.some(c => c.type === 'answer_question'), false);
  assert.equal(r.requests.some(r => r.url === '/api/activity/permission-requests'), false);
  assert.equal(r.commands.filter(c => c.type === 'cancel_turn').length, 1);
  assert.equal(r.posts.find(p => p.type === 'result').result.outcome, 'cancelled');
});

test('duplicate cancel offers and lost ack/result responses do not repeat the native cancel', async t => {
  let ack = false, result = false;
  const r = await cancelScenario(t, { duplicate: true,
    onPost(body, res) {
      if (body.type === 'ack' && !ack) { ack = true; res.destroy(); return null; }
      if (body.type === 'result' && !result) { result = true; res.destroy(); return null; }
    },
  });
  assert.equal(r.commands.filter(c => c.type === 'cancel_turn').length, 1);
  assert.equal(r.posts.filter(p => p.type === 'ack').length, 2);
  const results = r.posts.filter(p => p.type === 'result'); assert.equal(results.length, 2); assert.deepEqual(results[0], results[1]);
});

test('native RPC client exit after a cancel write remains requested with unknown effect and no retry', async t => {
  const r = await cancelScenario(t, { env: { TEST_CLOSE_STDIN: '1' }, expectedCode: 19, frames: [resumed()], onCommand: [
    { type: 'start_turn', prompt: 'E', correlate: true, frames: [nativeResult('E')] },
  ] });
  assert.equal(r.commands.filter(c => c.type === 'cancel_turn').length, 1);
  const result = r.posts.find(p => p.type === 'result').result;
  assert.equal(result.outcome, 'requested'); assert.equal(result.confirmed, false); assert.equal(result.operationAccepted, false);
  assert.equal(r.posts.some(p => p.type === 'turn' && p.state === 'closed'), false);
});

test('failed accepted acknowledgement cleans the local cancel fence without a native or receipt completion effect', async t => {
  const r = await cancelScenario(t, {
    onCommand: [{ type: 'start_turn', prompt: 'E', correlate: true, frames: [nativeResult('E')] }, action('F', 'F')],
    onPost: async (body, res) => { if (body.type === 'ack') { await pause(60); res.writeHead(403); res.end('{}'); return null; } },
    start({ input }) { input.write('F\n'); },
  });
  assert.equal(r.commands.some(c => c.type === 'cancel_turn'), false);
  assert.equal(r.posts.some(p => p.type === 'cancel-prepare' || p.type === 'submitted' || p.type === 'result'), false);
  assert.deepEqual(r.commands.filter(c => c.type === 'start_turn').map(c => c.request.prompt), ['E', 'F']);
});

test('unconfirmed withdrawal remains pending with no native write until E actually terminates', async t => {
  const r = await cancelScenario(t, {
    onCommand: [{ type: 'start_turn', prompt: 'E', correlate: true, frames: [nativeResult('E')] }, action('F', 'F')],
    prepare(body) { return { receipt: { version: 1, runId: 'run-1', requestId: body.requestId, sequence: body.sequence, kind: 'cancel', stage: 'accepted', payload: { target: { runId: 'run-1', nativeTurnId: 'E' } }, withdrawal: { stage: 'pending' } }, withdrawal: { confirmed: false, pendingSubmissions: 1, withdrawn: 0 } }; },
    start({ input }) { input.write('F\n'); },
  });
  assert.ok(r.posts.filter(p => p.type === 'cancel-prepare').length >= 2);
  assert.equal(r.commands.some(c => c.type === 'cancel_turn'), false); assert.equal(r.posts.some(p => p.type === 'submitted'), false);
  assert.equal(r.posts.find(p => p.type === 'result').result.outcome, 'not-this-turn');
  assert.deepEqual(r.commands.filter(c => c.type === 'start_turn').map(c => c.request.prompt), ['E', 'F']);
});

test('foreign-session cancelled event cannot confirm a cancellation even with the same native turn ID', async t => {
  const r = await cancelScenario(t, { onCommand: [
    { type: 'start_turn', prompt: 'E', correlate: true, frames: [nativeResult('E')] },
    { type: 'cancel_turn', correlate: true, frames: [nativeCancelResult('E'), { session_id: 'foreign-session', ...nativeEnd('E', 'turn.cancelled') }] },
  ] });
  const result = r.posts.find(p => p.type === 'result').result;
  assert.equal(result.outcome, 'requested'); assert.equal(result.confirmed, false);
  assert.equal(r.commands.filter(c => c.type === 'cancel_turn').length, 1);
});

test('queued native admission does not fabricate an opened current cancellation epoch', async t => {
  const r = await cancelScenario(t, { frames: [resumed(), [160, nativeEnd('queued-native')]],
    onCommand: [{ type: 'start_turn', prompt: 'E', correlate: true, frames: [nativeResult('queued-native', 'queued')] }],
  });
  assert.equal(r.posts.some(p => p.type === 'turn'), false);
  assert.equal(r.commands.some(c => c.type === 'cancel_turn'), false);
});

test('persistent unbound post-write question survives the managed cancelled terminal and keeps manual answer custody', async t => {
  for (const earlyChoice of [false, true]) await t.test(earlyChoice ? 'choice also attempted while fenced' : 'choice after terminal', async t => {
    let operator;
    const r = await cancelScenario(t, {
      frames: earlyChoice ? [resumed(), [300, nativeEnd('E', 'turn.cancelled')]] : [resumed()],
      onCommand: [
        { type: 'start_turn', prompt: 'E', correlate: true, frames: [nativeResult('E')] },
        { type: 'cancel_turn', correlate: true, frames: [nativeCancelResult('E'), question([{ ...q, question_id: 'persistent-Q', session_id: 'ref' }]), ...(earlyChoice ? [] : [nativeEnd('E', 'turn.cancelled')])] },
        action('Yes', 'wrong-successor'),
      ],
      onAsk: () => { setTimeout(() => operator.write('Yes\n'), 25).unref(); return { ok: true, askId: 'persistent-unbound', state: 'pending' }; },
      onPoll: async () => { await pause(30); return { state: 'pending' }; },
      onPost(body) { if (body.type === 'result') return { receipt: { version: 1, runId: 'run-1', requestId: 'cancel-E', sequence: 1, kind: 'cancel', stage: 'completed', payload: { target: { runId: 'run-1', nativeTurnId: 'E' } } } }; },
      start({ input, error }) {
        operator = input;
        if (earlyChoice) { let sent = false; error.on('data', bytes => { if (!sent && bytes.toString().includes('Question')) { sent = true; input.write('Yes\n'); } }); }
      },
    });
    assert.equal(r.commands.some(c => c.type === 'start_turn' && c.request.prompt === 'Yes'), false, 'question answer became a successor prompt');
    assert.deepEqual(r.commands.filter(c => c.type === 'answer_question').map(c => [c.question_id, c.answer]), [['persistent-Q', 'Yes']]);
    assert.equal(r.commands.filter(c => c.type === 'cancel_turn').length, 1);
    assert.equal(r.requests.some(req => req.url.endsWith('/withdraw') && req.body?.reason === 'turn_cancelled'), false);
    const permission = r.requests.find(req => req.url === '/api/activity/permission-requests').body;
    assert.equal(Object.hasOwn(permission, 'runId'), false); assert.equal(Object.hasOwn(permission, 'nativeTurnId'), false);
  });
});
