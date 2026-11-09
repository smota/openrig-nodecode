import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseModelSpec } from '../src/model-spec.mjs';
import { memberOf, profileSkills, placeSkills, linkHomeSkills } from '../src/skills.mjs';
import { parseArgs, composeFirstPrompt, launchWrapperArgv, writeLaunchRecord, nodecodeArgv } from '../src/launch.mjs';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecode-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const yaml = `resources:
  skills:
    - { id: alpha, path: ./alias }
    - { id: beta, path: ./beta }
    - { id: no-doc, path: ./no-doc }
profiles:
  worker:
    uses:
      skills:
        - alpha
        - beta
        - no-doc
        - unknown
      tools:
        - alpha
  other:
    uses:
      skills:
        - beta
`;

test('parseModelSpec splits syntactically and recognizes only effort suffixes', () => {
  for (const [input, expected] of [
    [undefined, {}], [null, {}], ['', {}], ['  ', {}], [' model ', { model: 'model' }],
    ['model', { model: 'model' }], ['new-provider/org/model:high', { provider: 'new-provider', model: 'org/model', effort: 'high' }],
    ['model:tag:MAX', { model: 'model:tag', effort: 'MAX' }], ['model:other', { model: 'model:other' }],
    ['p/model:other', { provider: 'p', model: 'model:other' }],
    ...['low', 'medium', 'high', 'max', 'minimal', 'xhigh'].map(e => [`p/m:${e}`, { provider: 'p', model: 'm', effort: e }]),
  ]) assert.deepEqual(parseModelSpec(input), expected, String(input));
});

test('memberOf table', () => {
  for (const [input, expected] of [['growth-dyson@mtn', 'dyson'], ['pod-a-b@Rig.1', 'a-b'], ['x-y@rtx-1', 'y'], ['bad', null], [undefined, null], ['Pod-y@rig', null], ['x-@rig', null]]) {
    assert.equal(memberOf(input), expected);
  }
});

test('profileSkills resolves only selected known resource ids', () => {
  for (const [text, profile, expected] of [[yaml, 'worker', ['alpha', 'beta', 'no-doc']], [yaml, 'other', ['beta']], [yaml, 'missing', []], ['', 'worker', []], [yaml.replace('profiles:', 'seats:'), 'worker', []]]) {
    assert.deepEqual(profileSkills(text, profile).map(s => s.id), expected);
  }
  assert.deepEqual(profileSkills(yaml, 'other'), [{ id: 'beta', path: './beta' }]);
  assert.deepEqual(profileSkills(yaml.replace('  worker:', '  work.r:'), 'work.r').map(s => s.id), ['alpha', 'beta', 'no-doc']);
  assert.deepEqual(profileSkills(yaml.replace('  worker:', '  workar:'), 'work.r'), []);
  assert.deepEqual(profileSkills(yaml.replace('profiles:', 'profiles:\nelsewhere:'), 'worker'), []);
  assert.deepEqual(profileSkills(yaml.replace('  worker:', '  outer:\n    worker:'), 'worker'), []);
});

test('placeSkills realpaths, replaces links, prunes stale links and preserves ordinary entries', t => {
  const dir = temp(t);
  const ws = path.join(dir, 'ws');
  for (const id of ['alpha', 'beta', 'no-doc']) fs.mkdirSync(path.join(dir, id));
  for (const id of ['alpha', 'beta']) fs.writeFileSync(path.join(dir, id, 'SKILL.md'), id);
  fs.symlinkSync(path.join(dir, 'alpha'), path.join(dir, 'alias'));
  const agent = path.join(dir, 'agent.yaml'); fs.writeFileSync(agent, yaml);
  assert.deepEqual(placeSkills(ws, agent, 'worker'), ['alpha', 'beta']);
  const skills = path.join(ws, '.agents', 'skills');
  assert.equal(fs.statSync(skills).mode & 0o777, 0o700);
  assert.equal(fs.readlinkSync(path.join(skills, 'alpha')), fs.realpathSync(path.join(dir, 'alpha')));
  fs.unlinkSync(path.join(skills, 'beta'));
  fs.symlinkSync('/does-not-exist', path.join(skills, 'beta'));
  fs.symlinkSync('/does-not-exist', path.join(skills, 'stale'));
  fs.writeFileSync(path.join(skills, 'local-file'), 'keep'); fs.mkdirSync(path.join(skills, 'local-dir'));
  assert.deepEqual(placeSkills(ws, agent, 'worker'), ['alpha', 'beta']);
  assert.equal(fs.readlinkSync(path.join(skills, 'beta')), path.join(dir, 'beta'));
  assert.equal(fs.existsSync(path.join(skills, 'stale')), false);
  assert.ok(!fs.readdirSync(skills).includes('stale'));
  assert.equal(fs.readFileSync(path.join(skills, 'local-file'), 'utf8'), 'keep');
  assert.ok(fs.statSync(path.join(skills, 'local-dir')).isDirectory());
  assert.deepEqual(placeSkills(ws, agent, null), []);
  assert.deepEqual(fs.readdirSync(skills).sort(), ['local-dir', 'local-file']);
});

test('linkHomeSkills skips absent discovery directory and replaces stale seat link', t => {
  const dir = temp(t); const home = path.join(dir, 'home'); const ws = path.join(dir, 'workspace');
  const notes = []; const write = process.stderr.write;
  process.stderr.write = chunk => { notes.push(String(chunk)); return true; };
  try { assert.equal(linkHomeSkills(home, 'pod-seat@rig', ws), false); } finally { process.stderr.write = write; }
  assert.match(notes.join(''), /linked-skills/);
  fs.mkdirSync(path.join(home, 'cells'), { recursive: true });
  fs.writeFileSync(path.join(home, 'cells', 'linked-skills'), 'not a directory');
  process.stderr.write = chunk => { notes.push(String(chunk)); return true; };
  try { assert.equal(linkHomeSkills(home, 'pod-seat@rig', ws), false); } finally { process.stderr.write = write; }
  assert.equal(notes.length, 2);
  fs.unlinkSync(path.join(home, 'cells', 'linked-skills'));
  const links = path.join(home, 'cells', 'linked-skills'); fs.mkdirSync(links, { recursive: true });
  fs.mkdirSync(path.join(ws, '.agents', 'skills'), { recursive: true });
  const link = path.join(links, 'openrig-pod-seat_rig');
  fs.symlinkSync('/stale', link);
  assert.equal(linkHomeSkills(home, 'pod-seat@rig', ws), true);
  assert.equal(fs.readlinkSync(link), path.join(ws, '.agents', 'skills'));
  assert.equal(linkHomeSkills(home, 'pod-seat@rig', ws), true);
  assert.deepEqual(fs.readdirSync(links), ['openrig-pod-seat_rig']);
});

test('parseArgs defaults, repeated startup files, profile/store and passthrough', () => {
  assert.deepEqual(parseArgs([]), { startupFiles: [], agentYaml: null, workspaceRoot: null, profile: null, store: null, nodecodeArgs: [] });
  assert.deepEqual(parseArgs(['--agent-yaml', 'a', '--startup-file', 's1', '--startup-file', 's2', '--workspace-root', 'w', '--profile', 'p', '--store', 'db', '--', '--literal', 'space arg']), {
    startupFiles: ['s1', 's2'], agentYaml: 'a', workspaceRoot: 'w', profile: 'p', store: 'db', nodecodeArgs: ['--literal', 'space arg'],
  });
  for (const flag of ['--agent-yaml', '--startup-file', '--workspace-root', '--profile', '--store']) assert.throws(() => parseArgs([flag]), /needs a value/);
  for (const arg of ['--unknown', 'positional']) assert.throws(() => parseArgs([arg]), /unknown argument/);
});

test('composeFirstPrompt preserves order, skips blank/unreadable files, uses nodecode label', t => {
  const dir = temp(t); const file = path.join(dir, 'startup.md'); fs.writeFileSync(file, 'Startup\n');
  assert.equal(composeFirstPrompt('First\n ', [file]), `First\n\nStartup file ${file} (delivered by the nodecode runner):\n\nStartup`);
  for (const first of [null, '', '  ']) assert.equal(composeFirstPrompt(first, []), '');
  assert.equal(composeFirstPrompt('First', ['blank', 'missing', 'yes'], p => { if (p === 'missing') throw Error('missing'); return p === 'blank' ? '  ' : 'Text\n'; }), 'First\n\nStartup file yes (delivered by the nodecode runner):\n\nText');
});

test('launchWrapperArgv accepts literal argv and rejects every malformed handoff', () => {
  assert.deepEqual(launchWrapperArgv(undefined), []);
  assert.deepEqual(launchWrapperArgv('["/wrapper path","","$(literal); > file"]'), ['/wrapper path', '', '$(literal); > file']);
  for (const value of ['', 'not-json', 'null', '{}', '"wrapper"', '[]', '[""]', '["", "arg"]', '[42]', '["wrapper",null]', '["wrapper",42]', '["wrapper","\\u0000"]', '["\\u0000"]']) {
    assert.throws(() => launchWrapperArgv(value), { message: 'OPENRIG_LAUNCH_WRAPPER must be a JSON array of strings with a non-empty program' });
  }
});

test('nodecodeArgv orders wrapper, binary, global flags, rpc, ref and extras', () => {
  for (const [opts, expected] of [[{}, ['nodecode', 'rpc']], [{ bin: '/node code', profile: 'p', store: '/db path', resumeRef: 'ref', extra: ['--literal', 'two words'], wrapper: ['wrap', '--arg'] }, ['wrap', '--arg', '/node code', '-p', 'p', '--store', '/db path', 'rpc', 'ref', '--literal', 'two words']], [{ resumeRef: '', profile: '', store: '' }, ['nodecode', 'rpc']]]) {
    assert.deepEqual(nodecodeArgv(opts), expected);
  }
  const wrapper = ['wrap']; const extra = ['x']; nodecodeArgv({ wrapper, extra }); assert.deepEqual(wrapper, ['wrap']); assert.deepEqual(extra, ['x']);
});

test('writeLaunchRecord creates 0600 exclusive records, never overwrites or follows a symlink', t => {
  const dir = temp(t); const file = path.join(dir, 'record.json');
  assert.equal(writeLaunchRecord(undefined, {}), false);
  assert.equal(writeLaunchRecord(file, { attempt: 'a', nativeRef: 'ref' }), true);
  const original = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(original), { format: 1, harness: 'nodecode', producer: 'openrig-nodecode-runner 1.0', attempt: 'a', nativeRef: 'ref' });
  assert.ok(original.endsWith('\n')); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => writeLaunchRecord(file, { error: 'missing' }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  const link = path.join(dir, 'link'); fs.symlinkSync(file, link);
  assert.throws(() => writeLaunchRecord(link, { error: 'missing' }), { code: 'EEXIST' });
  const missing = path.join(dir, 'missing.json'); writeLaunchRecord(missing, { attempt: 'b', error: 'missing' });
  assert.equal(JSON.parse(fs.readFileSync(missing)).error, 'missing');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
