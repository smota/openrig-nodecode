import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createActivity } from '../src/activity.mjs';
async function fixture(t, reply) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const entry = { method: req.method, url: req.url, headers: req.headers, body: text ? JSON.parse(text) : null }; requests.push(entry);
    const body = await reply(entry);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body ?? { ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { OPENRIG_URL: `http://127.0.0.1:${server.address().port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: 'secret', OPENRIG_SESSION_NAME: 'seat', OPENRIG_NODE_ID: 'node', OPENRIG_OCCUPANT_GENERATION: '2' };
  return { requests, activity: createActivity({ env, now: () => 0 }) };
}
test('hooks have identity, ISO time and serialized monotonic sequence', async t => {
  const f = await fixture(t, async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  await Promise.all([f.activity.post('Stop', 'ready'), f.activity.post('active', 'liveness', { turnId: 't', livenessSeconds: 30, sequence: 99 })]);
  assert.deepEqual(f.requests.map(r => r.body.sequence), [1, 2]);
  assert.deepEqual(f.requests[0].body, { sessionName: 'seat', nodeId: 'node', generation: '2', runtime: 'nodecode', sequence: 1, hookEvent: 'Stop', subtype: 'ready', occurredAt: '1970-01-01T00:00:00.000Z' });
  assert.equal(f.requests[0].headers.authorization, 'Bearer secret');
});
test('answered ask maps option text and posts permission_resolved', async t => {
  const f = await fixture(t, r => r.method === 'GET' ? { state: 'answered', optionId: 'choice-1' } : { ok: true, askId: 'ask/1', state: 'pending' });
  const answers = [];
  await f.activity.ask({ question: { question_id: 'q', title: 'Choose', choices: ['Yes', 'No'] }, nativeRef: 'ref', turnId: 'turn', onAnswer: text => answers.push(text) });
  assert.deepEqual(answers, ['No']);
  assert.equal(f.requests[1].url, '/api/activity/permission-requests/ask%2F1?waitSeconds=25');
  assert.deepEqual(f.requests[0].body.options, [{ optionId: 'choice-0', name: 'Yes', kind: 'allow_once' }, { optionId: 'choice-1', name: 'No', kind: 'reject_once' }]);
  assert.equal(f.requests[2].body.subtype, 'permission_resolved');
  assert.equal(f.requests[2].body.askId, 'ask/1');
});
test('refused ask leaves question unanswered', async t => {
  const f = await fixture(t, r => r.method === 'GET' ? { state: 'refused' } : { ok: true, askId: 'a' });
  const output = []; t.mock.method(process.stderr, 'write', text => { output.push(text); return true; });
  let answered = false;
  await f.activity.ask({ question: { question_id: 'q', title: 'Q', choices: ['yes'] }, onAnswer: () => { answered = true; } });
  assert.equal(answered, false);
  assert.match(output.join(''), /Type the exact choice/);
  assert.equal(f.requests.length, 2);
});
test('withdrawAll cancels polling and posts withdrawal', async t => {
  let polling; const reached = new Promise(resolve => { polling = resolve; });
  const f = await fixture(t, async r => { if (r.method === 'GET') { polling(); await new Promise(resolve => setTimeout(resolve, 100)); return { state: 'pending' }; } return { ok: true, askId: 'a' }; });
  const ask = f.activity.ask({ question: { question_id: 'q', title: 'Q', choices: ['yes'] }, onAnswer: () => assert.fail('withdrawn ask answered') });
  await reached; await f.activity.withdrawAll('turn_ended'); await ask;
  assert.deepEqual(f.requests.find(r => r.url.endsWith('/withdraw')).body, { reason: 'turn_ended' });
});
test('missing endpoint is a no-op', async () => {
  const a = createActivity({ env: { OPENRIG_HOME: '/tmp/openrig-nodecode-no-endpoint' }, fetchImpl: () => assert.fail('unexpected fetch') });
  assert.equal(a.enabled, false); await a.post('Stop', 'ready'); await a.ask({ question: { choices: [] } }); await a.withdrawAll('exited');
  a.startIdleBeats(); a.startWorkBeats('t'); a.stopBeats();
});
