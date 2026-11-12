/** The optional Core channel owns wire custody only; the runner's native queue owns execution. */
export function createRunnerChannel({ env, enqueue, fetchImpl = globalThis.fetch }) {
  const runId = env.OPENRIG_RUN_ID, token = env.OPENRIG_ACTIVITY_HOOK_TOKEN;
  const base = env.OPENRIG_URL || (env.OPENRIG_PORT ? `http://${env.OPENRIG_HOST || '127.0.0.1'}:${env.OPENRIG_PORT}` : '');
  if (!runId || !token || !base) return null;
  const url = `${base.replace(/\/+$/, '')}/api/activity/runner-channel`;
  const controller = new AbortController();
  const entries = new Map(); // Retained for this entire managed process; never pruned on reconnect.
  let stopped = false, halted = false, quarantined = false, connectedBefore = false, maximum = 0, task, streamController;
  let capabilities = { input: false, wake: false };
  const delay = () => new Promise(resolve => {
    const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, 100); controller.signal.addEventListener('abort', finish, { once: true });
    if (stopped) finish();
  });
  const request = async body => {
    const response = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]) });
    if (!response.ok) {
      if (response.status < 500 && ![408, 429].includes(response.status)) halted = true;
      throw new Error('channel unavailable');
    }
    return response.json();
  };
  const retry = async body => {
    while (!stopped && !halted) {
      try { return await request(body); } catch { if (!stopped && !halted) await delay(); }
    }
    return null;
  };
  const report = (entry, type, extra = {}) => {
    const body = { type, runId, requestId: entry.frame.requestId, sequence: entry.frame.sequence, ...extra };
    entry.latest = body;
    entry.reports = entry.reports.then(async () => {
      const saved = await retry(body);
      if (!saved) return false;
      const receipt = saved.receipt;
      const expectedStage = { ack: 'accepted', submitted: 'submitted', result: 'completed', rejected: 'rejected' }[type];
      if (!receipt || receipt.runId !== runId || receipt.requestId !== body.requestId || receipt.sequence !== body.sequence
        || receipt.version !== 1 || receipt.kind !== entry.frame.kind || receipt.stage !== expectedStage
        || JSON.stringify(receipt.payload) !== JSON.stringify(entry.frame.payload)
        || (receipt.reconciliation && !(body.result?.ownershipUnknown === true && receipt.reconciliation === 'native_ownership_unknown')) || receipt.erasedAt) {
        halted = true; return false;
      }
      return true;
    }).catch(() => { halted = true; return false; });
    return entry.reports;
  };
  const accept = async raw => {
    if (halted || quarantined || stopped) return;
    if (!raw || raw.version !== 1 || raw.runId !== runId || typeof raw.requestId !== 'string' || !raw.requestId
      || !Number.isSafeInteger(raw.sequence) || raw.sequence < 1 || !['input', 'wake'].includes(raw.kind)
      || capabilities[raw.kind] !== true || typeof raw.payload?.[raw.kind === 'wake' ? 'question' : 'text'] !== 'string' || raw.erasedAt || raw.reconciliation) { halted = true; return; }
    const frame = { version: 1, runId, requestId: raw.requestId, sequence: raw.sequence, kind: raw.kind,
      payload: structuredClone(raw.payload) };
    const old = entries.get(frame.requestId);
    if (old) {
      if (JSON.stringify(old.frame) !== JSON.stringify(frame)) halted = true;
      return;
    }
    if (frame.sequence <= maximum || raw.stage && !['pending', 'offered'].includes(raw.stage)) { halted = true; return; }
    maximum = frame.sequence;
    const entry = { frame, reports: Promise.resolve(), nativeTurnId: null, answer: '', contaminated: false };
    entries.set(frame.requestId, entry);
    if (await report(entry, 'ack', { state: 'accepted' })) enqueue(entry);
  };
  const consume = async response => {
    if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
      if (response.status < 500) halted = true;
      await response.body?.cancel(); return;
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '';
    try {
      while (!stopped && !halted) {
        const chunk = await reader.read(); if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        pending = pending.replace(/\r\n/g, '\n');
        if (pending.length > 4 * 1024 * 1024) { halted = true; break; }
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, end); pending = pending.slice(end + 2);
          const lines = block.split('\n'), event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
          if (event !== 'request') continue;
          const frame = JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'));
          const id = lines.find(line => line.startsWith('id:'))?.slice(3).trim();
          if (id !== String(frame.sequence)) { halted = true; break; }
          await accept(frame);
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  };
  const connect = async () => {
    while (!stopped && !halted && !quarantined) {
      try {
        const hello = await request({ type: 'hello', version: 1, runId, retained: connectedBefore,
          capabilities: { input: true, wake: true, cancel: false } });
        if (hello.version !== 1 || hello.runId !== runId || !hello.capabilities
          || ['input', 'wake', 'cancel'].some(key => typeof hello.capabilities[key] !== 'boolean') || !Array.isArray(hello.receipts)
          || !Array.isArray(hello.unresolved)) { halted = true; break; }
        connectedBefore = true; capabilities = hello.capabilities;
        if (hello.receipts.some(r => r.reconciliation || !entries.has(r.requestId) && ['accepted', 'submitted'].includes(r.stage))) { halted = true; break; }
        if (!hello.capabilities.input && !hello.capabilities.wake) break;
        // Reconcile retained offers independently of the stream cursor. Known requests never execute twice.
        for (const frame of hello.unresolved) if (!frame.erasedAt && ['pending', 'offered'].includes(frame.stage)) await accept(frame);
        if (halted || stopped) break;
        streamController = new AbortController();
        const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, 'Last-Event-ID': '0' }, signal: AbortSignal.any([controller.signal, streamController.signal]) });
        await consume(response);
      } catch { /* Reconnect keeps the same in-memory custody map and report bodies. */ }
      if (!stopped && !halted) await delay();
    }
  };
  return {
    get halted() { return halted || quarantined; },
    start() { task ??= connect(); },
    submitted(entry, nativeTurnId) {
      entry.nativeTurnId = nativeTurnId;
      return report(entry, 'submitted', { acceptedTurnId: nativeTurnId, nativeTurnId });
    },
    result(entry, completion, { rejected = false, submissionUnknown = false, ownershipUnknown = false } = {}) {
      const result = { kind: entry.frame.kind, ...(entry.nativeTurnId ? { nativeTurnId: entry.nativeTurnId } : {}), completion,
        ...(entry.frame.kind === 'wake' ? { answer: completion === 'completed' ? entry.answer : null } : {}),
        ...(submissionUnknown ? { submissionUnknown: true } : {}), ...(ownershipUnknown ? { ownershipUnknown: true } : {}) };
      if (ownershipUnknown || submissionUnknown) { quarantined = true; streamController?.abort(); }
      return report(entry, rejected ? 'rejected' : 'result', { ...(entry.nativeTurnId ? { nativeTurnId: entry.nativeTurnId } : {}), result });
    },
    async close() {
      await Promise.race([Promise.all([...entries.values()].map(entry => entry.reports)), new Promise(resolve => { const timer = setTimeout(resolve, 500); timer.unref(); })]);
      stopped = true; controller.abort(); await task;
    },
  };
}
