import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const live = process.env.OPENRIG_LIVE_RIG === '1';

if (!live) {
  test.skip('live rig proof: set OPENRIG_LIVE_RIG=1 to use the installed daemon', { skip: 'set OPENRIG_LIVE_RIG=1 to use the installed daemon' });
} else {
  test('installed OpenRig nodecode connector', { timeout: 600_000 }, async t => {
    const name = `nc-live-${process.pid}`;
    const negativeName = `${name}-bogus`;
    let cwd;
    let sessionName;
    let oriented = false;
    let wroteProof = false;
    let resumed = false;
    let negativeAttempted = false;

    function run(command, args, timeout = 30_000) {
      return spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
    }

    function checked(command, args, timeout) {
      const result = run(command, args, timeout);
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
      return result.stdout;
    }

    function rig(args, timeout) {
      const value = JSON.parse(checked('rig', [...args, '--json'], timeout));
      assert.notEqual(value.ok, false, JSON.stringify(value));
      return value;
    }

    function capture(timeout) {
      // Join wrapped lines so the echoed prompt can be matched in full.
      return checked('tmux', ['capture-pane', '-p', '-J', '-S', '-', '-t', sessionName], timeout);
    }

    async function poll(description, observe) {
      const deadline = Date.now() + 120_000;
      let last;
      while (Date.now() < deadline) {
        try {
          last = await observe(() => Math.max(1, Math.min(10_000, deadline - Date.now())));
          if (last === true) return;
        } catch (cause) {
          last = cause.message;
        }
        const remaining = deadline - Date.now();
        if (remaining > 0) await delay(Math.min(2000, remaining));
      }
      assert.fail(`${description} timed out after 120s; last observation: ${JSON.stringify(last)}`);
    }

    t.after(() => {
      // Register before creation so even a partially failed create is torn down.
      try {
        rig(['down', name, '--delete', '--force']);
      } finally {
        try {
          if (negativeAttempted) {
            // A rejected create normally leaves nothing; an accepted one must be removed.
            run('rig', ['down', negativeName, '--delete', '--force', '--json']);
          }
        } finally {
          if (cwd) rmSync(cwd, { recursive: true, force: true });
        }
      }
    });

    await t.test('creates a seat that orients and becomes ready', async () => {
      cwd = mkdtempSync(join(tmpdir(), 'nc-live-'));
      const created = rig(['create', name, '--runtime', 'nodecode', '--cwd', cwd]);
      assert.equal(created.ok, true);
      assert.ok(created.rigId);
      sessionName = created.node?.sessionName;
      assert.equal(typeof sessionName, 'string');
      assert.ok(sessionName);
      await poll('seat orientation and startup', timeout => {
        const status = rig(['seat', 'status', sessionName], timeout());
        assert.equal(status.runtime, 'nodecode');
        const pane = capture(timeout());
        // The runner emits assistant text directly; omit its diagnostic/tool lines.
        const assistantText = pane.split('\n').some(line => {
          const text = line.trim();
          return /[a-z]/i.test(text)
            && !/^(?:\[nodecode-runner\]|⚙|[$>#]|\/|(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=|(?:env|rig|node|nodecode|exec|bash|sh|tmux)\s)/.test(text)
            && !/^[^\s]+[@:][^\s]*[$#]\s/.test(text);
        });
        return status.startup_status === 'ready' && assistantText;
      });
      oriented = true;
    });

    await t.test('delivers a task and observes its filesystem effect', async () => {
      assert.ok(oriented, 'seat must have oriented');
      const proof = join(cwd, 'proof.txt');
      rig(['send', sessionName, `Create ${proof} containing exactly the word PELICAN, then reply DONE.`]);
      await poll('proof.txt containing PELICAN', () => {
        try { return readFileSync(proof, 'utf8').trim() === 'PELICAN'; }
        catch (cause) { if (cause.code === 'ENOENT') return false; throw cause; }
      });
      wroteProof = true;
    });

    await t.test('snapshots and resumes the seat', async () => {
      assert.ok(wroteProof, 'filesystem effect must have been observed');
      rig(['down', name, '--snapshot']);
      const launched = rig(['launch', name, 'main.lead']);
      assert.equal(launched.launched?.[0]?.status, 'resumed');
      await poll('resumed seat running', timeout => {
        const status = rig(['seat', 'status', sessionName], timeout());
        return status.session_status === 'running';
      });
      resumed = true;
    });

    await t.test('recalls the earlier word after the resumed prompt', async () => {
      assert.ok(resumed, 'seat must have resumed');
      const prompt = 'Without reading any file, reply with only the word you wrote to proof.txt earlier.';
      rig(['send', sessionName, prompt]);
      await poll('PELICAN response after the recall prompt', timeout => {
        const pane = capture(timeout());
        const promptAt = pane.lastIndexOf(prompt);
        if (promptAt === -1) return false;
        return pane.slice(promptAt + prompt.length).split('\n').some(line => /^pelican$/i.test(line.trim()));
      });
    });

    await t.test('rejects an unknown runtime', () => {
      negativeAttempted = true;
      const result = run('rig', ['create', negativeName, '--runtime', 'bogus-xyz', '--cwd', cwd, '--json']);
      assert.ifError(result.error);
      assert.equal(result.signal, null, 'runtime rejection must not be a killed command');
      let value;
      try { value = JSON.parse(result.stdout); } catch { /* Non-zero CLI failures may be plain text. */ }
      assert.ok(result.status !== 0 || value?.ok === false, `unknown runtime unexpectedly accepted: ${result.stdout}`);
    });
  });
}
