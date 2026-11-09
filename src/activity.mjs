import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function endpointFor(env) {
  let baseUrl = env.OPENRIG_URL || (env.OPENRIG_PORT ? `http://${env.OPENRIG_HOST || '127.0.0.1'}:${env.OPENRIG_PORT}` : '');
  let token = env.OPENRIG_ACTIVITY_HOOK_TOKEN || '';
  if (!baseUrl || !token) {
    try {
      const file = JSON.parse(fs.readFileSync(path.join(env.OPENRIG_HOME || path.join(os.homedir(), '.openrig'), 'activity-endpoint.json'), 'utf8'));
      baseUrl ||= file.baseUrl; token ||= file.token;
    } catch { /* no activity endpoint */ }
  }
  return baseUrl && token ? { baseUrl: baseUrl.replace(/\/+$/, ''), token } : null;
}

/** Activity failures never prevent the native session from running. */
export function createActivity({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const endpoint = endpointFor(env);
  const identity = { sessionName: env.OPENRIG_SESSION_NAME, nodeId: env.OPENRIG_NODE_ID, generation: env.OPENRIG_OCCUPANT_GENERATION, runtime: env.OPENRIG_RUNTIME || 'nodecode' };
  const asks = new Set();
  let sequence = 0;
  let chain = Promise.resolve();
  let beat;
  const occurredAt = () => new Date(now()).toISOString();
  const call = async (method, route, body, timeout = 2_000, signal) => {
    if (!endpoint) return null;
    try {
      const response = await fetchImpl(`${endpoint.baseUrl}${route}`, {
        method, headers: { authorization: `Bearer ${endpoint.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      });
      const parsed = await response.json();
      return response.ok ? parsed : null;
    } catch { return null; }
  };
  const enqueue = (route, body) => {
    const result = chain.then(() => call('POST', route, body));
    chain = result.then(() => {}, () => {});
    return result;
  };
  const post = (hookEvent, subtype, extra = {}) => {
    if (!endpoint) return Promise.resolve();
    return enqueue('/api/activity/hooks', { ...extra, ...identity, sequence: ++sequence, hookEvent, subtype, occurredAt: occurredAt() });
  };
  const stopBeats = () => { clearInterval(beat); beat = undefined; };
  const startIdleBeats = () => {
    stopBeats();
    if (endpoint) beat = setInterval(() => { if (!asks.size) void post('Stop', 'idle_heartbeat', { livenessSeconds: 60 }); }, 30_000).unref();
  };
  const startWorkBeats = turnId => {
    stopBeats();
    if (endpoint) beat = setInterval(() => { if (!asks.size) void post('active', 'liveness', { turnId, livenessSeconds: 30 }); }, 10_000).unref();
  };
  const ask = ({ question, sessionName = identity.sessionName, nodeId = identity.nodeId, generation = identity.generation, nativeRef, turnId, onAnswer } = {}) => {
    if (!endpoint) return Promise.resolve();
    const controller = new AbortController();
    const state = { ended: false, askId: null, reason: null, withdrawal: null };
    const withdraw = reason => {
      if (state.ended) return state.withdrawal || Promise.resolve();
      state.ended = true; state.reason = reason; controller.abort(); asks.delete(state);
      if (state.askId) state.withdrawal = enqueue(`/api/activity/permission-requests/${encodeURIComponent(state.askId)}/withdraw`, { reason });
      return state.withdrawal || Promise.resolve();
    };
    state.withdraw = withdraw;
    asks.add(state);
    const task = (async () => {
      const choices = Array.isArray(question?.choices) ? question.choices.slice(0, 4) : [];
      if (question?.choices?.length > 4) process.stderr.write('nodecode: permission bridge offers only the first four choices\n');
      const manual = () => process.stderr.write(`nodecode question: ${question?.title || 'Question'}${question?.detail ? `\n${question.detail}` : ''}\n${(question?.choices || []).join('\n')}\nType the exact choice to answer.\n`);
      const kinds = ['allow_once', 'reject_once', 'allow_always', 'reject_always'];
      const options = choices.map((name, index) => ({ optionId: `choice-${index}`, name, kind: kinds[index] }));
      const submitted = await enqueue('/api/activity/permission-requests', {
        sessionName, nodeId, generation, nativeRef, turnId, requestId: question?.question_id,
        toolCall: { title: question?.title, kind: 'question' }, options, occurredAt: occurredAt(),
      });
      state.askId = submitted?.ok ? submitted.askId : null;
      if (state.ended) {
        if (state.askId) await enqueue(`/api/activity/permission-requests/${encodeURIComponent(state.askId)}/withdraw`, { reason: state.reason });
        return;
      }
      let answer = submitted;
      while (!state.ended) {
        if (answer?.state === 'answered' || answer?.state === 'permitted') {
          const option = options.find(item => item.optionId === answer.optionId);
          if (option) {
            await onAnswer?.(option.name);
            if (!state.ended) await post('active', 'permission_resolved', { turnId, ...(state.askId ? { askId: state.askId } : {}) });
          } else manual();
          return;
        }
        if (!state.askId || !answer || ['refused', 'withdrawn', 'stale'].includes(answer.state)) {
          if (!answer || !state.askId || answer.state === 'refused') manual();
          if (!answer && state.askId) state.keep = true;
          return;
        }
        answer = await call('GET', `/api/activity/permission-requests/${encodeURIComponent(state.askId)}?waitSeconds=25`, null, 35_000, controller.signal);
      }
    })().finally(() => { if (!state.keep) asks.delete(state); });
    task.withdraw = withdraw;
    return task;
  };
  const withdrawAll = reason => Promise.all([...asks].map(state => state.withdraw(reason)));
  return { enabled: Boolean(endpoint), post, startIdleBeats, startWorkBeats, stopBeats, ask, withdrawAll };
}
