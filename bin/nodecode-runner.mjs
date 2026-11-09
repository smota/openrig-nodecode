#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import readline from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { parseArgs, composeFirstPrompt, launchWrapperArgv, writeLaunchRecord, nodecodeArgv } from '../src/launch.mjs';
import { memberOf, placeSkills, linkHomeSkills } from '../src/skills.mjs';
import { parseModelSpec } from '../src/model-spec.mjs';
import { probeSession } from '../src/session-probe.mjs';
import { createActivity } from '../src/activity.mjs';
import { createFramer, createTurnTracker } from '../src/protocol.mjs';

/** Port of the Apache-2.0 agy runner's bracketed-paste aware raw line editor. */
export function createInputParser(onSubmit, echo = () => {}, onInterrupt = () => {}) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let inPaste = false;
  let pending = '';
  let previousCR = false;
  let pasted = false;
  return chunk => {
    let data = pending + (typeof chunk === 'string' ? chunk : decoder.write(chunk));
    pending = '';
    while (data.length) {
      if (data.startsWith('\u001b[200~')) { inPaste = true; pasted = true; data = data.slice(6); continue; }
      if (data.startsWith('\u001b[201~')) { inPaste = false; data = data.slice(6); continue; }
      if (data[0] === '\u001b' && ['\u001b[200~', '\u001b[201~'].some(mark => mark.startsWith(data))) { pending = data; break; }
      const c = data[0];
      data = data.slice(1);
      if (inPaste) { buffer += c === '\r' ? '\n' : c; echo(c === '\r' ? '\n' : c); continue; }
      if (c === '\r' || c === '\n') {
        if (c === '\n' && previousCR) { previousCR = false; continue; }
        previousCR = c === '\r';
        const text = buffer;
        buffer = '';
        echo('\n');
        if (text.trim()) onSubmit(text, { pasted });
        pasted = false;
      } else {
        previousCR = false;
        if (c === '\u007f' || c === '\b') {
          if (buffer.length) { buffer = [...buffer].slice(0, -1).join(''); echo('\b \b'); }
        } else if (c === '\u0003') {
          buffer = '';
          pasted = false;
          onInterrupt();
        } else if (c === '\u001b') {
          const match = /^\[[0-9;?]*[ -/]*[@-~]/.exec(data);
          if (match) data = data.slice(match[0].length);
        } else if (c >= ' ' || c === '\t') { buffer += c; echo(c); }
      }
    }
  };
}

export async function main({ argv = process.argv.slice(2), env = process.env, input = process.stdin, output = process.stdout, error = process.stderr } = {}) {
  const note = message => error.write(`[nodecode-runner] ${message}\n`);
  let opts, wrapper;
  try { opts = parseArgs(argv); wrapper = launchWrapperArgv(env.OPENRIG_LAUNCH_WRAPPER); }
  catch (cause) { note(cause.message); return 2; }
  const sessionName = env.OPENRIG_SESSION_NAME ?? '';
  const seatName = sessionName.replace(/[^A-Za-z0-9._-]/g, '_') || 'session';
  const openrigHome = env.OPENRIG_HOME || path.join(os.homedir(), '.openrig');
  const workspace = path.resolve(opts.workspaceRoot || path.join(openrigHome, 'state', 'openrig-nodecode', seatName));
  const home = env.NODECODE_HOME || path.join(os.homedir(), '.nodecode');
  const bin = env.NODECODE_BIN || 'nodecode';
  const resumeRef = env.OPENRIG_RESUME_REF || null;
  const childEnv = { ...env };
  delete childEnv.OPENRIG_LAUNCH_WRAPPER;
  const activity = createActivity({ env: { ...env, OPENRIG_RUNTIME: env.OPENRIG_RUNTIME || 'nodecode' } });
  const post = (event, subtype, extra = {}) => Promise.resolve(activity.post(event, subtype, extra)).catch(cause => note(`activity: ${cause.message}`));
  const record = value => {
    try { writeLaunchRecord(env.OPENRIG_LAUNCH_RESULT, { attempt: env.OPENRIG_LAUNCH_ATTEMPT, ...value }); }
    catch (cause) { note(`launch record: ${cause.message}`); }
  };
  if (resumeRef) {
    if (env.OPENRIG_MODEL) note('ignoring OPENRIG_MODEL on resume; model is pinned to the session');
    const exec = (_program, args, options = {}) => {
      // Probe owns when to start the gateway; preserve the selected binary/profile here.
      const actual = [...(opts.profile ? ['-p', opts.profile] : []), ...(args?.length ? args : ['gateway', 'on'])];
      return new Promise((resolve, reject) => execFile(bin, actual, { ...options, env: { ...childEnv, NODECODE_HOME: home } }, (cause, stdout) => cause ? reject(cause) : resolve(stdout)));
    };
    let status;
    try { status = await probeSession({ ref: resumeRef, home, store: opts.store, exec }); }
    catch (cause) { note(`resume probe: ${cause.message}`); return 2; }
    if (status === 'missing') { record({ error: 'missing' }); return 3; }
    if (status !== 'exists') { note(`cannot reach nodecode gateway to verify session ${resumeRef}`); return 2; }
  }
  let firstPrompt = '';
  try {
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    if (opts.agentYaml) placeSkills(workspace, path.resolve(opts.agentYaml), memberOf(sessionName));
    else fs.mkdirSync(path.join(workspace, '.agents', 'skills'), { recursive: true, mode: 0o700 });
    if (opts.profile) {
      const profileHome = path.join(os.homedir(), '.nodecode', 'profiles', opts.profile);
      if (fs.existsSync(profileHome) && fs.statSync(profileHome).isDirectory()) linkHomeSkills(profileHome, sessionName, workspace);
      else note(`skipping home skills link; profile directory ${profileHome} is missing`);
    } else linkHomeSkills(home, sessionName, workspace);
    if (!resumeRef) {
      let firstInput = '';
      if (env.OPENRIG_FIRST_INPUT) {
        try { firstInput = fs.readFileSync(env.OPENRIG_FIRST_INPUT, 'utf8'); }
        catch (cause) { note(`first input: ${cause.message}`); }
      }
      // A standalone first-input handoff is byte-preserving; composition may trim.
      firstPrompt = opts.startupFiles.length ? composeFirstPrompt(firstInput, opts.startupFiles) : firstInput;
    }
  } catch (cause) { note(cause.message); return 2; }
  const args = nodecodeArgv({ bin, profile: opts.profile, store: opts.store, resumeRef, extra: opts.nodecodeArgs, wrapper });
  const turns = createTurnTracker();
  const questions = new Map();
  const tools = new Set();
  const reasoning = new Set();
  let child, nativeRef = null, ready = false, firstTurn = true, ending = false, inputEnded = false;
  let commandNumber = 0, lastInterrupt = 0, lastBeat = -Infinity, cancelRequested = false;
  let frameChain = Promise.resolve();
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const write = frame => {
    if (ending || !child?.stdin?.writable || child.stdin.destroyed) return false;
    child.stdin.write(`${JSON.stringify(frame)}\n`);
    return true;
  };
  const nextCommand = () => `cmd-${++commandNumber}`;
  const cancel = () => {
    if (turns.turnId) write({ type: 'cancel_turn', command_id: nextCommand(), turn_id: turns.turnId });
    else if (turns.submitted) cancelRequested = true;
  };
  const idle = () => { activity.stopBeats(); activity.startIdleBeats({ nativeRef }); };
  // Deltas share lastBeat below; a second interval would bypass that throttle.
  const work = () => { activity.stopBeats(); };
  const maybeCloseInput = () => {
    if (inputEnded && ready && !turns.busy && !turns.queue.length && !questions.size && child?.stdin?.writable) child.stdin.end();
  };
  const start = prompt => {
    const commandId = nextCommand();
    if (!turns.submit(commandId)) { turns.enqueue(prompt); return; }
    const model = !resumeRef && firstTurn ? parseModelSpec(env.OPENRIG_MODEL) : {};
    firstTurn = false;
    write({ type: 'start_turn', command_id: commandId, request: { prompt, ...model } });
    activity.stopBeats();
  };
  const drain = () => {
    if (!ready || ending || turns.busy) return;
    const prompt = turns.dequeue();
    if (prompt !== undefined) start(prompt);
    else { idle(); maybeCloseInput(); }
  };
  const printQuestion = question => {
    note(`${question.title}${question.detail ? `\n${question.detail}` : ''}\n${question.choices.join('\n')}\nType an exact choice to answer.`);
  };
  const answer = (questionId, choice, fromActivity = false) => {
    const pending = questions.get(questionId);
    if (!pending || pending.answered || !pending.question.choices.includes(choice)) return false;
    if (!write({ type: 'answer_question', command_id: nextCommand(), question_id: questionId, answer: choice })) return false;
    pending.answered = true;
    if (!fromActivity) {
      void pending.handle?.withdraw?.('turn_ended');
      void post('active', 'permission_resolved', { turnId: turns.turnId });
    }
    return true;
  };
  const ask = entry => {
    const question = entry.question;
    const onAnswer = choice => {
      if (questions.get(question.question_id) !== entry || ending) return;
      answer(question.question_id, choice, true);
    };
    if (!activity.enabled) { printQuestion(question); return; }
    try {
      entry.handle = activity.ask({ question, nativeRef, turnId: turns.turnId, onAnswer });
      entry.handle?.catch(() => { if (questions.get(question.question_id) === entry && !ending) printQuestion(question); });
    } catch { printQuestion(question); }
  };
  const submit = (prompt, { pasted = false } = {}) => {
    if (ending) return;
    if (!pasted && prompt.trim() === '/abort' && !prompt.includes('\n') && !prompt.includes('\r')) { cancel(); return; }
    for (const [id, entry] of questions) if (!entry.answered && entry.question.choices.includes(prompt)) { answer(id, prompt); return; }
    turns.enqueue(prompt);
    drain();
  };
  let inputInterface, rawHandler;
  const signalHandlers = new Map();
  const restoreInput = () => {
    if (rawHandler) input.off('data', rawHandler);
    inputInterface?.close();
    input.off('end', onInputEnd);
    if (input.isTTY) { try { input.setRawMode(false); output.write('\u001b[?2004l'); } catch { /* closed pane */ } }
    input.pause();
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  };
  const finish = async (code, { kill = false } = {}) => {
    if (ending) return;
    if (kill) cancel();
    ending = true;
    restoreInput();
    activity.stopBeats();
    questions.clear();
    if (kill && child && child.exitCode === null) {
      child.kill('SIGTERM');
      const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 500);
      force.unref();
    }
    try { await activity.withdrawAll('exited'); } catch (cause) { note(`permission withdrawal: ${cause.message}`); }
    await post('Stop', 'nodecode_exited');
    resolveDone(code);
  };
  const interrupt = () => {
    if (turns.busy) { cancel(); return; }
    const now = Date.now();
    if (lastInterrupt && now - lastInterrupt <= 2000) { void finish(130, { kill: true }); return; }
    lastInterrupt = now;
    note('press Ctrl-C again within 2s to stop the seat');
  };
  function onInputEnd() { inputEnded = true; maybeCloseInput(); }
  const handleFrame = async frame => {
    if (ending || !frame || typeof frame !== 'object') return;
    const payload = frame.payload ?? frame;
    if (payload.type === 'session_stream_resumed') {
      if (ready) return;
      nativeRef = frame.session_id || payload.session_id;
      if (resumeRef && nativeRef !== resumeRef) { record({ error: 'missing' }); await finish(3, { kill: true }); return; }
      if (!nativeRef) { note('session replay did not identify a native session'); return; }
      ready = true;
      record({ nativeRef });
      await post('Stop', 'nodecode_ready');
      if (payload.admission_state === 'active') {
        const frames = payload.accumulated_frames ?? [];
        const latest = [...frames].reverse().find(value => value.turn_id || value.event?.turn_id);
        turns.observe(payload.turn_id ?? latest?.turn_id ?? latest?.event?.turn_id);
        if (!turns.turnId) turns.accepted = true;
        work();
      }
      if (firstPrompt) { turns.queue.unshift(firstPrompt); firstPrompt = ''; }
      drain();
      return;
    }
    if (payload.type === 'gateway_turn_command_result') {
      const result = payload.result ?? {};
      const commandId = result.command_id ?? payload.command_id;
      const startResult = (!result.command || result.command === 'start_turn') && (!commandId || commandId === turns.commandId);
      if (result.status === 'accepted' || result.status === 'queued') {
        if (startResult && turns.accept(commandId, result.response?.turn_id ?? result.turn_id)) {
          await post('UserPromptSubmit', 'accepted', { turnId: turns.turnId });
          work();
          if (cancelRequested) { cancelRequested = false; cancel(); }
        }
      } else if (result.status === 'rejected') {
        note(`command rejected: ${JSON.stringify(result)}`);
        if (startResult && turns.reject(commandId)) {
          cancelRequested = false;
          if (!turns.busy && !turns.queue.length) await post('Stop', 'error');
          drain();
        }
      }
      return;
    }
    if (payload.type === 'sync_protocol_error') { note(`protocol error: ${payload.message ?? JSON.stringify(payload)}`); return; }
    if (payload.type === 'item_delta') {
      turns.observe(payload.turn_id);
      const delta = payload.delta ?? {};
      if (delta.type === 'text' && typeof delta.text === 'string') output.write(delta.text);
      if (delta.type === 'reasoning' && !reasoning.has(payload.turn_id)) {
        const line = delta.text?.split(/\r?\n/).find(Boolean);
        if (line) { reasoning.add(payload.turn_id); error.write(`\u001b[2m${line}\u001b[0m\n`); }
      }
      if (delta.type === 'tool_call' && delta.name) {
        const key = JSON.stringify([payload.turn_id, delta.name, delta.index]);
        if (!tools.has(key)) { tools.add(key); error.write(`⚙ ${delta.name}\n`); await post('PreToolUse', delta.name, { turnId: turns.turnId }); }
      }
      if (Date.now() - lastBeat >= 10000) {
        lastBeat = Date.now();
        await post('active', 'liveness', { turnId: turns.turnId, livenessSeconds: 30 });
      }
      return;
    }
    if (payload.type === 'session_stream_event') {
      const event = payload.frame?.event;
      const subtype = { 'turn.completed': 'end_turn', 'turn.failed': 'error', 'turn.cancelled': 'cancelled' }[event?.type];
      if (!subtype || (turns.turnId && (event.turn_id ?? payload.frame.turn_id) && turns.turnId !== (event.turn_id ?? payload.frame.turn_id))) return;
      await post('Stop', subtype, { turnId: turns.turnId });
      if (subtype === 'error') await post('Notification', 'runtime_error', { turnId: turns.turnId });
      await activity.withdrawAll(subtype === 'cancelled' ? 'turn_cancelled' : 'turn_ended');
      questions.clear();
      turns.end();
      tools.clear(); reasoning.clear(); lastBeat = -Infinity; cancelRequested = false;
      drain();
      return;
    }
    if (payload.type === 'organism.questions') {
      const fresh = new Map((payload.questions ?? []).map(question => [question.question_id, question]));
      for (const [id, entry] of questions) if (!fresh.has(id)) {
        questions.delete(id);
        void entry.handle?.withdraw?.('turn_ended');
      }
      for (const [id, question] of fresh) {
        if (questions.has(id)) continue;
        const entry = { question, answered: false, handle: null };
        questions.set(id, entry);
        ask(entry);
      }
      maybeCloseInput();
    }
  };
  try { child = spawn(args[0], args.slice(1), { cwd: workspace, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (cause) { note(`could not start nodecode: ${cause.message}`); await finish(127); return done; }
  const framer = createFramer(frame => {
    frameChain = frameChain.then(() => handleFrame(frame)).catch(cause => { note(`frame error: ${cause.message}`); return finish(2, { kill: true }); });
  }, line => error.write(`${line}\n`));
  child.stdout.on('data', framer);
  child.stdout.on('end', () => framer.end());
  child.stderr.on('data', chunk => error.write(chunk));
  child.stdin.on('error', cause => { if (!ending && cause.code !== 'EPIPE') note(`stdin: ${cause.message}`); });
  child.on('error', cause => { note(`could not start nodecode: ${cause.message}`); void finish(127); });
  child.on('close', code => { frameChain.finally(() => finish(code ?? 1)); });
  if (input.isTTY) {
    input.setRawMode(true);
    output.write('\u001b[?2004h');
    rawHandler = createInputParser(submit, value => output.write(value), interrupt);
    input.on('data', rawHandler);
  } else {
    inputInterface = readline.createInterface({ input, crlfDelay: Infinity });
    inputInterface.on('line', line => { if (line.trim()) submit(line); });
    inputInterface.on('close', onInputEnd);
  }
  input.on('end', onInputEnd);
  if (input.readableEnded) onInputEnd();
  input.resume();
  for (const signal of ['SIGTERM', 'SIGHUP']) {
    const handler = () => { void finish(143, { kill: true }); };
    signalHandlers.set(signal, handler); process.on(signal, handler);
  }
  signalHandlers.set('SIGINT', interrupt); process.on('SIGINT', interrupt);
  return done;
}

let directlyInvoked = false;
try { directlyInvoked = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { /* import has no executable path */ }
if (directlyInvoked) {
  main().then(code => { process.exitCode = code; }).catch(cause => { process.stderr.write(`[nodecode-runner] ${cause.message}\n`); process.exitCode = 2; });
}
