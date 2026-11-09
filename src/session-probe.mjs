import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

function startGateway(program, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { ...options, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function ownerFile(home, store) {
  if (store) return `${store}.owner`;
  const sidecar = path.join(home, 'history.db.owner'); // nodecode's default store is <home>/history.db
  if (fs.existsSync(sidecar)) return sidecar;
  try {
    const owners = fs.readdirSync(path.join(home, 'store')).filter(name => name.endsWith('.owner'));
    return owners.length === 1 ? path.join(home, 'store', owners[0]) : null;
  } catch { return null; }
}

async function bounded(operation, timeout) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('probe timed out')), timeout); })]);
  } finally { clearTimeout(timer); }
}

/** Only the gateway's explicit unknown_session response proves a resume is missing. */
export async function probeSession({ ref, home = process.env.NODECODE_HOME || path.join(os.homedir(), '.nodecode'), store, profile, exec = startGateway, fetchImpl = globalThis.fetch, timeoutMs = 15_000, allowStart = true }) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let started = false;
  do {
    let token = process.env.NODECODE_GATEWAY_OPERATOR_TOKEN || process.env.NODECODE_OPERATOR_TOKEN;
    if (!token) { try { token = fs.readFileSync(path.join(home, 'operator-token'), 'utf8').trim(); } catch { /* gateway may create it */ } }
    const remaining = Math.max(1, deadline - Date.now());
    let owner;
    try { owner = JSON.parse(fs.readFileSync(ownerFile(home, store), 'utf8')); } catch { /* gateway may be starting */ }
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); } catch (cause) { if (cause.code === 'ESRCH') owner = null; }
    }
    if (owner && Number.isInteger(owner.port) && owner.port > 0 && owner.port <= 65535) {
      try {
        const result = await bounded(async () => {
          const response = await fetchImpl(`http://127.0.0.1:${owner.port}/api/gateway/sessions/${encodeURIComponent(ref)}/header`, {
            headers: { authorization: `Bearer ${token || ''}` }, signal: AbortSignal.timeout(remaining),
          });
          if (response.status === 200) return 'exists';
          if (response.status === 404) {
            const body = await response.json().catch(() => ({}));
            // nodecode answers {"error":{"code":"unknown_session",...}}; flat {code} tolerated
            if ((body?.error?.code ?? body?.code) === 'unknown_session') return 'missing';
          }
        }, remaining);
        if (result) return result;
      } catch { /* transport failures never mean missing */ }
    } else if (!started) {
      if (process.env.OPENRIG_LAUNCH_WRAPPER !== undefined) {
        process.stderr.write('nodecode: gateway bootstrap disabled by launch wrapper\n');
        return 'unreachable';
      }
      if (!allowStart) return 'unreachable';
      started = true;
      try {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPENRIG_')));
        await bounded(() => exec(process.env.NODECODE_BIN || 'nodecode', [...(profile ? ['-p', profile] : []), 'gateway', 'on'], { timeout: remaining, env: { ...env, NODECODE_HOME: home } }), remaining);
      } catch { /* retry discovery even if the starter failed */ }
    }
    const delay = Math.min(100, deadline - Date.now());
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  } while (Date.now() < deadline);
  return 'unreachable';
}
