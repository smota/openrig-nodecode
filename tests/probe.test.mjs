import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeSession } from '../src/session-probe.mjs';

async function fixture(t, status = 200, body = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(req); res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  fs.mkdirSync(path.join(home, 'store'));
  fs.writeFileSync(path.join(home, 'operator-token'), 'test-token\n');
  const owner = () => fs.writeFileSync(path.join(home, 'store', 'main.owner'), JSON.stringify({ pid: process.pid, port: server.address().port }));
  return { home, owner, seen };
}
test('probe recognizes existing session and sends encoded ref and token', async t => {
  const f = await fixture(t); f.owner();
  assert.equal(await probeSession({ ref: 'a/b', home: f.home }), 'exists');
  assert.equal(f.seen[0].url, '/api/gateway/sessions/a%2Fb/header');
  assert.equal(f.seen[0].headers.authorization, 'Bearer test-token');
});
test('only unknown_session 404 means missing', async t => {
  const f = await fixture(t, 404, { error: { code: 'unknown_session' } }); f.owner();
  assert.equal(await probeSession({ ref: 'gone', home: f.home }), 'missing');
});
test('no owner starts gateway once then discovers owner', async t => {
  const f = await fixture(t); const calls = [];
  fs.rmSync(path.join(f.home, 'operator-token'));
  assert.equal(await probeSession({ ref: 'r', home: f.home, profile: 'seat', exec: async (...args) => { calls.push(args); fs.writeFileSync(path.join(f.home, 'operator-token'), 'new-token'); f.owner(); }, timeoutMs: 500 }), 'exists');
  assert.deepEqual(calls[0].slice(0, 2), ['nodecode', ['-p', 'seat', 'gateway', 'on']]);
  assert.equal(calls.length, 1);
  assert.equal(f.seen[0].headers.authorization, 'Bearer new-token');
});
test('explicit store owner and unreachable cases', async t => {
  const f = await fixture(t, 404, { code: 'other' });
  const store = path.join(f.home, 'custom');
  fs.writeFileSync(`${store}.owner`, JSON.stringify({ port: 1 }));
  assert.equal(await probeSession({ ref: 'r', home: f.home, store, timeoutMs: 25 }), 'unreachable');
  f.owner();
  assert.equal(await probeSession({ ref: 'r', home: f.home, timeoutMs: 25 }), 'unreachable');
  assert.ok(f.seen.length > 0);
  fs.rmSync(path.join(f.home, 'store', 'main.owner'));
  assert.equal(await probeSession({ ref: 'r', home: f.home, timeoutMs: 25, exec: async () => {} }), 'unreachable');
});

test('2 direct probe blocks gateway bootstrap whenever the launch wrapper is set', async t => {
  const f = await fixture(t);
  const previous = process.env.OPENRIG_LAUNCH_WRAPPER;
  t.after(() => { if (previous === undefined) delete process.env.OPENRIG_LAUNCH_WRAPPER; else process.env.OPENRIG_LAUNCH_WRAPPER = previous; });
  const notes = []; t.mock.method(process.stderr, 'write', text => { notes.push(text); return true; });
  const marker = path.join(f.home, 'started');
  const program = path.join(f.home, 'gateway.mjs');
  fs.writeFileSync(program, `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'started');\n`);
  fs.chmodSync(program, 0o755);
  const previousBin = process.env.NODECODE_BIN;
  t.after(() => { if (previousBin === undefined) delete process.env.NODECODE_BIN; else process.env.NODECODE_BIN = previousBin; });
  process.env.NODECODE_BIN = program;
  let injectedCalls = 0;
  for (const wrapper of ['["/usr/bin/env"]', '']) {
    process.env.OPENRIG_LAUNCH_WRAPPER = wrapper;
    assert.equal(await probeSession({ ref: 'r', home: f.home, timeoutMs: 100 }), 'unreachable');
    assert.equal(await probeSession({ ref: 'r', home: f.home, timeoutMs: 100, exec: async () => { injectedCalls++; } }), 'unreachable');
  }
  assert.equal(injectedCalls, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.match(notes.join(''), /wrapper/i);
});

test('2 direct default probe spawns a detached gateway with clean env and ignored stdio', async t => {
  const f = await fixture(t);
  const keys = ['OPENRIG_LAUNCH_WRAPPER', 'OPENRIG_PROBE_TEST', 'NODECODE_BIN'];
  const previous = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }));
  delete process.env.OPENRIG_LAUNCH_WRAPPER;
  process.env.OPENRIG_PROBE_TEST = 'must-not-reach-gateway';
  const marker = path.join(f.home, 'started.json');
  const program = path.join(f.home, 'gateway.mjs');
  f.owner();
  const owner = fs.readFileSync(path.join(f.home, 'store/main.owner'), 'utf8');
  fs.rmSync(path.join(f.home, 'store/main.owner'));
  fs.writeFileSync(program, `#!${process.execPath}\nimport fs from 'node:fs';\nlet detached = false; try { process.kill(-process.pid, 0); detached = true; } catch {}\nfs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), home: process.env.NODECODE_HOME, openrigKeys: Object.keys(process.env).filter(key => key.startsWith('OPENRIG_')), detached, stdio: [0,1,2].map(fd => fs.fstatSync(fd).isCharacterDevice()) }));\nfs.writeFileSync(${JSON.stringify(path.join(f.home, 'store/main.owner'))}, ${JSON.stringify(owner)});\n`);
  fs.chmodSync(program, 0o755); process.env.NODECODE_BIN = program;
  assert.equal(await probeSession({ ref: 'r', home: f.home, profile: 'seat', timeoutMs: 1000 }), 'exists');
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { argv: ['-p', 'seat', 'gateway', 'on'], home: f.home, openrigKeys: [], detached: true, stdio: [true, true, true] });
});
