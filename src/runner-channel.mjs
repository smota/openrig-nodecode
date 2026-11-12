/** The optional Core channel owns wire custody only; the runner's native queue owns execution. */
export function createRunnerChannel({ env, enqueue, prepareCancel, acceptCancel, fetchImpl = globalThis.fetch }) {
  const runId = env.OPENRIG_RUN_ID, token = env.OPENRIG_ACTIVITY_HOOK_TOKEN;
  const base = env.OPENRIG_URL || (env.OPENRIG_PORT ? `http://${env.OPENRIG_HOST || '127.0.0.1'}:${env.OPENRIG_PORT}` : '');
  if (!runId || !token || !base) return null;
  const url = `${base.replace(/\/+$/, '')}/api/activity/runner-channel`;
  const controller = new AbortController();
  const entries = new Map(); // Retained for this entire managed process; never pruned on reconnect.
  let stopped = false, halted = false, quarantined = false, connectedBefore = false, task, streamController;
  let turnSequence = 0, turnReports = Promise.resolve();
  const reportedTurns = new Set();
  let helloReady;
  const hello = new Promise(resolve => { helloReady = resolve; });
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
      const pendingGrant = response.status === 409 && (await response.json().catch(() => null))?.code === 'runner_grant_pending';
      if (!pendingGrant && response.status < 500 && ![408, 429].includes(response.status)) halted = true;
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
      || !Number.isSafeInteger(raw.sequence) || raw.sequence < 1 || !['input', 'wake', 'cancel'].includes(raw.kind)
      || capabilities[raw.kind] !== true || (raw.kind === 'cancel'
        ? raw.payload?.target?.runId !== runId || typeof raw.payload?.target?.nativeTurnId !== 'string' || !raw.payload.target.nativeTurnId
        : typeof raw.payload?.[raw.kind === 'wake' ? 'question' : 'text'] !== 'string') || raw.erasedAt || raw.reconciliation) { halted = true; return; }
    const frame = { version: 1, runId, requestId: raw.requestId, sequence: raw.sequence, kind: raw.kind,
      payload: structuredClone(raw.payload) };
    const old = entries.get(frame.requestId);
    if (old) {
      if (JSON.stringify(old.frame) !== JSON.stringify(frame)) halted = true;
      return;
    }
    // Core offers cancellation ahead of pending ordinary input; sequence identity is unique, not arrival order.
    if ([...entries.values()].some(entry => entry.frame.sequence === frame.sequence) || raw.stage && raw.stage !== 'offered') { halted = true; return; }
    const entry = { frame, reports: Promise.resolve(), nativeTurnId: null, answer: '', contaminated: false };
    entries.set(frame.requestId, entry);
    if (frame.kind === 'cancel') {
      entry.operation = prepareCancel?.(entry); // Fence synchronously, before even sending the accepted acknowledgement.
      const accepted = await report(entry, 'ack', { state: 'accepted' });
      void acceptCancel?.(entry, accepted);
    } else if (await report(entry, 'ack', { state: 'accepted' })) enqueue(entry);
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
          capabilities: { input: true, wake: true, cancel: Boolean(prepareCancel && acceptCancel) } });
        if (hello.version !== 1 || hello.runId !== runId || !hello.capabilities
          || ['input', 'wake', 'cancel'].some(key => typeof hello.capabilities[key] !== 'boolean') || !Array.isArray(hello.receipts)
          || !Array.isArray(hello.unresolved)) { halted = true; break; }
        connectedBefore = true; capabilities = hello.capabilities;
        helloReady(true);
        if (hello.receipts.some(r => r.reconciliation || !entries.has(r.requestId) && ['accepted', 'submitted'].includes(r.stage))) { halted = true; break; }
        if (!hello.capabilities.input && !hello.capabilities.wake) break;
        // Reconcile retained offers independently of the stream cursor. Known requests never execute twice.
        // Pending is saved work, not an offer: only GET may advance it to offered.
        for (const frame of hello.unresolved) if (!frame.erasedAt && frame.stage === 'offered') await accept(frame);
        if (halted || stopped) break;
        streamController = new AbortController();
        const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, 'Last-Event-ID': '0' }, signal: AbortSignal.any([controller.signal, streamController.signal]) });
        await consume(response);
      } catch { /* Reconnect keeps the same in-memory custody map and report bodies. */ }
      if (!stopped && !halted) await delay();
    }
    helloReady(false);
  };
  return {
    get halted() { return halted || quarantined; },
    start() { task ??= connect(); },
    turn(nativeTurnId, state, acceptedTurnIds) {
      const body = { type: 'turn', runId, sequence: ++turnSequence, nativeTurnId, state, acceptedTurnIds };
      turnReports = turnReports.then(async () => {
        if (!await hello || capabilities.cancel !== true) return false;
        if (state === 'closed' && !reportedTurns.has(nativeTurnId)) return false;
        const saved = await retry(body);
        if (saved?.accepted !== true) { halted = true; return false; }
        if (state === 'opened') reportedTurns.add(nativeTurnId); else reportedTurns.delete(nativeTurnId);
        return true;
      });
      return turnReports;
    },
    async prepareCancellation(entry) {
      await turnReports;
      if (stopped || halted) return null;
      try {
        const saved = await request({ type: 'cancel-prepare', runId, requestId: entry.frame.requestId, sequence: entry.frame.sequence });
        const receipt = saved?.receipt, withdrawal = saved?.withdrawal;
        if (receipt?.requestId !== entry.frame.requestId || receipt.runId !== runId || receipt.sequence !== entry.frame.sequence
          || receipt.kind !== 'cancel' || receipt.stage !== 'accepted' || receipt.erasedAt || receipt.reconciliation
          || JSON.stringify(receipt.payload) !== JSON.stringify(entry.frame.payload)
          || typeof withdrawal?.confirmed !== 'boolean' || !Number.isSafeInteger(withdrawal.pendingSubmissions) || withdrawal.pendingSubmissions < 0) return null;
        return withdrawal;
      } catch { return null; }
    },
    cancelSubmitted(entry, operationAccepted) { return report(entry, 'submitted', { result: { kind: 'cancel', outcome: 'requested', confirmed: false, operationAccepted } }); },
    cancelResult(entry, outcome, operationAccepted = false, detail) {
      return report(entry, 'result', { result: { kind: 'cancel', outcome, confirmed: outcome === 'cancelled', operationAccepted, ...(detail ? { detail } : {}) } });
    },
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
      await Promise.race([Promise.all([turnReports, ...[...entries.values()].map(entry => entry.reports)]), new Promise(resolve => { const timer = setTimeout(resolve, 500); timer.unref(); })]);
      stopped = true; helloReady(false); controller.abort(); await task;
    },
  };
}
