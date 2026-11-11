#!/usr/bin/env node
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { parseArgs, composeFirstPrompt, launchWrapperArgv, writeLaunchRecord, nodecodeArgv } from '../src/launch.mjs';
import { memberOf, placeSkills, linkHomeSkills, linkOpenrigCell } from '../src/skills.mjs';
import { parseModelSpec } from '../src/model-spec.mjs';
import { probeSession, readSessionCheckpoints } from '../src/session-probe.mjs';
import { createActivity } from '../src/activity.mjs';
import { createFramer, createTurnTracker } from '../src/protocol.mjs';

/** Nodecode profiles live under the operator home, even with NODECODE_HOME set. */
export function resolveSeatHome(home, profile) {
  return profile ? path.join(os.homedir(), '.nodecode', 'profiles', profile) : home;
}

async function ensureSeatProfile(bin, profile, env) {
  const run = promisify(execFile);
  const { stdout } = await run(bin, ['profile', 'list'], { env, timeout: 30000 });
  const names = stdout.split(/\r?\n/).map(line => /^\s*\*?\s*(\S+)\s+\//.exec(line)?.[1]).filter(Boolean);
  if (!names.includes(profile)) await run(bin, ['profile', 'create', profile], { env, timeout: 30000 });
}

/** Port of the Apache-2.0 agy runner's bracketed-paste aware raw line editor. */
export function createInputParser(onSubmit, echo = () => {}, onInterrupt = () => {}, acceptEmpty = () => false) {
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
        if (text.trim() || acceptEmpty()) onSubmit(text, { pasted });
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
  try { opts = parseArgs(argv); wrapper = launchWrapperArgv(env.OPENRIG_LAUNCH_WRAPPER); if (opts.store) opts.store = path.resolve(opts.store); }
  catch (cause) { note(cause.message); return 2; }
  const resumePolicy = opts.resumePolicy ?? env.OPENRIG_NODECODE_RESUME_POLICY ?? 'head';
  if (!['head', 'last-completed'].includes(resumePolicy)) { note('--resume-policy must be head or last-completed'); return 2; }
  let resumeCheckpoint = null;
  const sessionName = env.OPENRIG_SESSION_NAME ?? '';
  const seatName = sessionName.replace(/[^A-Za-z0-9._-]/g, '_') || 'session';
  const openrigHome = env.OPENRIG_HOME || path.join(os.homedir(), '.openrig');
  const workspace = path.resolve(opts.workspaceRoot || path.join(openrigHome, 'state', 'openrig-nodecode', seatName));
  const home = env.NODECODE_HOME || path.join(os.homedir(), '.nodecode');
  const bin = env.NODECODE_BIN || 'nodecode';
  // Explicit legacy profiles are existing-only and must not be replaced by env.
  // Empty environment values are unset; explicit empty flags fail validation.
  const envSeatProfile = env.NODECODE_SEAT_PROFILE || env.OPENRIG_NODECODE_SEAT_PROFILE || undefined;
  const seatProfile = opts.seatProfile ?? (opts.profile !== null ? 'none'
    : (envSeatProfile ?? opts.defaultSeatProfile ?? 'none'));
  if (opts.seatProfile !== undefined) opts.profile = null;
  if (seatProfile !== 'none') {
    const profile = seatProfile === 'auto' ? `openrig-${sessionName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'session'}` : seatProfile;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(profile)) { note('invalid seat profile name'); return 2; }
    opts.profile = profile;
    try { await ensureSeatProfile(bin, profile, env); }
    catch (cause) { note(`seat profile: ${cause.message}`); return 2; }
    note(`seat profile: ${profile}`);
  }
  if (opts.profile !== null && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(opts.profile)) { note('invalid profile name'); return 2; }
  const profileHome = resolveSeatHome(home, opts.profile);
  const resumeRef = env.OPENRIG_RESUME_REF || null;
  const childEnv = { ...env };
  delete childEnv.OPENRIG_LAUNCH_WRAPPER;
  const activity = createActivity({ env: { ...env, OPENRIG_RUNTIME: env.OPENRIG_RUNTIME || 'nodecode' } });
  let ending = false;
  const post = (event, subtype, extra = {}) => ending ? Promise.resolve() : Promise.resolve(activity.post(event, subtype, extra)).catch(cause => note(`activity: ${cause.message}`));
  const record = value => {
    try { writeLaunchRecord(env.OPENRIG_LAUNCH_RESULT, { attempt: env.OPENRIG_LAUNCH_ATTEMPT, ...value }); }
    catch (cause) { note(`launch record: ${cause.message}`); }
  };
  if (resumeRef) {
    if (env.OPENRIG_MODEL) note('ignoring OPENRIG_MODEL on resume; model is pinned to the session');
    const exec = (_program, args, options = {}) => {
      if (wrapper.length) { note('cannot start gateway without the configured launch wrapper'); throw new Error('gateway bootstrap blocked by launch wrapper'); }
      // Probe owns when to start the gateway; preserve the selected binary/profile here.
      const actual = [...(opts.profile ? ['-p', opts.profile] : []), ...(opts.store ? ['--store', opts.store] : []), ...(args?.length ? args : ['gateway', 'on'])];
      const gatewayEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('OPENRIG_')));
      return new Promise((resolve, reject) => {
        const starter = spawn(bin, actual, { ...options, env: { ...gatewayEnv, NODECODE_HOME: home }, detached: true, stdio: 'ignore' });
        starter.once('error', reject);
        starter.once('spawn', () => { starter.unref(); resolve(); });
      });
    };
    let status;
    try { status = await probeSession({ ref: resumeRef, home: profileHome, store: opts.store, exec, allowStart: !wrapper.length }); }
    catch (cause) { note(`resume probe: ${cause.message}`); return 2; }
    if (status === 'missing') { record({ error: 'missing' }); return 3; }
    if (status !== 'exists') { note(`cannot reach nodecode gateway to verify session ${resumeRef}${wrapper.length ? '; gateway bootstrap disabled by launch wrapper' : ''}`); return 2; }
  }
  if (resumeRef && resumePolicy === 'last-completed') {
    try {
      const listing = await readSessionCheckpoints({ ref: resumeRef, home: profileHome, store: opts.store });
      const chain = listing.checkpoints.filter(row => row.kind === 'user_message' && row.on_head_chain === true).sort((a, b) => a.log_position - b.log_position);
      const last = chain.find(row => row.turn_id === listing.head_turn_id);
      if (last && ['failed', 'cancelled', 'interrupted'].includes(last.ending)) {
        const completed = [...chain].reverse().find(row => row.ending === 'completed' && row.log_position < last.log_position);
        if (completed?.turn_id) resumeCheckpoint = { turnId: completed.turn_id, ending: last.ending };
      }
    } catch (cause) { note(`resume checkpoints: ${cause.message}`); return 2; }
  }
  let firstPrompt = '';
  try {
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    if (opts.agentYaml) { try { placeSkills(workspace, path.resolve(opts.agentYaml), memberOf(sessionName)); } catch (cause) { note(`skills: ${cause.message}`); } }
    else fs.mkdirSync(path.join(workspace, '.agents', 'skills'), { recursive: true, mode: 0o700 });
    if (opts.profile) {
      if (fs.existsSync(profileHome) && fs.statSync(profileHome).isDirectory()) { try { linkHomeSkills(profileHome, sessionName, workspace); } catch (cause) { note(`skills: ${cause.message}`); } }
      else note(`skipping home skills link; profile directory ${profileHome} is missing`);
    } else { try { linkHomeSkills(home, sessionName, workspace); } catch (cause) { note(`skills: ${cause.message}`); } }
    if (!opts.noOpenrigCell) {
      try { linkOpenrigCell(profileHome, note, fileURLToPath(new URL('../', import.meta.url))); }
      catch (cause) { note(`openrig cell: ${cause.message}`); }
    }
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
  const completedTurns = new Set();
  const commandNonce = randomUUID().slice(0, 8);
  const questions = new Map();
  const tools = new Set();
  const reasoning = new Set();
  let child, nativeRef = null, ready = false, firstTurn = true, inputEnded = false;
  let commandNumber = 0, lastInterrupt = 0, lastBeat = -Infinity, cancelRequested = false;
  let frameChain = Promise.resolve();
  let navigationCommand = null;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const write = (frame, onWritten) => {
    if (ending || !child?.stdin?.writable || child.stdin.destroyed) return false;
    try { child.stdin.write(`${JSON.stringify(frame)}\n`, cause => onWritten?.(!cause)); return true; }
    catch (cause) { streamError(cause); return false; }
  };
  const nextCommand = () => `cmd-${commandNonce}-${++commandNumber}`;
  const cancel = () => {
    if (turns.turnId) write({ type: 'cancel_turn', command_id: nextCommand(), turn_id: turns.turnId });
    else if (turns.busy) { if (turns.submitted) cancelRequested = true; note('cannot abort yet: active turn has no turn id'); }
  };
  const idle = () => { activity.stopBeats(); activity.startIdleBeats({ nativeRef }); };
  const work = () => { if (!ending) activity.startWorkBeats(turns.turnId); };
  const maybeCloseInput = () => {
    if (inputEnded && ready && !resumeCheckpoint && !navigationCommand && !turns.busy && !turns.queue.length && ![...questions.values()].some(entry => !entry.answered) && child?.stdin?.writable) child.stdin.end();
  };
  const start = prompt => {
    const commandId = nextCommand();
    if (!turns.submit(commandId)) { turns.enqueue(prompt); return; }
    const model = !resumeRef && firstTurn ? parseModelSpec(env.OPENRIG_MODEL) : {};
    write({ type: 'start_turn', command_id: commandId, request: { prompt, ...model } });
    activity.stopBeats();
  };
  const drain = () => {
    if (!ready || ending || resumeCheckpoint || navigationCommand || turns.busy) return;
    const prompt = turns.dequeue();
    if (prompt !== undefined) start(prompt);
    else { idle(); maybeCloseInput(); }
  };
  const printQuestion = question => {
    const choices = Array.isArray(question.choices) ? question.choices : [];
    note(`${question.title}${question.detail ? `\n${question.detail}` : ''}\n${choices.join('\n')}\n${choices.length ? 'Type an exact choice' : 'Type any line'} to answer.`);
  };
  const answer = async (questionId, choice, fromActivity = false) => {
    const pending = questions.get(questionId);
    const choices = pending?.question.choices;
    if (!pending || pending.answered || pending.answering || (Array.isArray(choices) && choices.length && !choices.includes(choice))) return false;
    pending.answering = true;
    const written = await new Promise(resolve => {
      if (!write({ type: 'answer_question', command_id: nextCommand(), question_id: questionId, answer: choice }, resolve)) resolve(false);
    });
    pending.answering = false;
    if (!written || ending) return false;
    pending.answered = true;
    if (!fromActivity) {
      void pending.handle?.withdraw?.('turn_ended');
      void post('active', 'permission_resolved', { turnId: turns.turnId });
    }
    maybeCloseInput();
    return true;
  };
  const ask = entry => {
    const question = entry.question;
    const onAnswer = choice => {
      if (questions.get(question.question_id) !== entry || ending) return false;
      return answer(question.question_id, choice, true);
    };
    if (!activity.enabled || !Array.isArray(question.choices) || !question.choices.length) { printQuestion(question); return; }
    try {
      entry.handle = activity.ask({ question, nativeRef, turnId: turns.turnId, onAnswer });
      entry.handle?.catch(() => { if (questions.get(question.question_id) === entry && !ending) printQuestion(question); });
    } catch { printQuestion(question); }
  };
  const submit = (prompt, { pasted = false } = {}) => {
    if (ending) return;
    for (const [id, entry] of questions) if (!entry.answered && (!Array.isArray(entry.question.choices) || !entry.question.choices.length || entry.question.choices.includes(prompt))) { answer(id, prompt); return; }
    if (!pasted && prompt.trim() === '/abort' && !prompt.includes('\n') && !prompt.includes('\r')) { cancel(); return; }
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
    await activity.post('Stop', 'nodecode_exited');
    for (const stream of [output, input]) {
      if (stream.closed) stream.off('error', streamError);
      else stream.once('close', () => stream.off('error', streamError));
    }
    resolveDone(code);
  };
  const interrupt = () => {
    if (turns.turnId) { cancel(); return; }
    if (turns.submitted) cancelRequested = true;
    const now = Date.now();
    if (lastInterrupt && now - lastInterrupt <= 2000) { void finish(130, { kill: true }); return; }
    lastInterrupt = now;
    note('press Ctrl-C again within 2s to stop the seat');
  };
  function onInputEnd() { inputEnded = true; maybeCloseInput(); }
  const handleFrame = async frame => {
    if (ending || !frame || typeof frame !== 'object') return;
    const payload = frame.payload ?? frame;
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'session_stream_resumed') {
      if (ready) return;
      nativeRef = frame.session_id || payload.session_id || payload.header?.session_id || resumeRef;
      if (resumeRef && nativeRef !== resumeRef) { record({ error: 'missing' }); await finish(3, { kill: true }); return; }
      if (!nativeRef) { note('session replay did not identify a native session'); return; }
      if (env.OPENRIG_NODECODE_NO_ANSWERS !== '1') {
        write({ type: 'set_session_subscriptions', answers: true, subscriptions: [nativeRef], pid: process.pid });
        note('answers: subscribed');
      }
      const frames = Array.isArray(payload.accumulated_frames) ? payload.accumulated_frames : [];
      for (const value of frames) {
        const frame = value?.frame ?? value;
        if (frame?.event?.type === 'turn.completed') completedTurns.add(frame.event.turn_id ?? frame.turn_id);
      }
      ready = true;
      if (resumeCheckpoint) {
        navigationCommand = nextCommand();
        write({ type: 'navigate_checkpoint', command_id: navigationCommand, target_turn_id: resumeCheckpoint.turnId, restore_files: false });
      }
      record({ nativeRef });
      await post('Stop', 'nodecode_ready');
      if (ending) return;
      await activity.identity(nativeRef);
      if (ending) return;
      if (payload.admission_state === 'active') {
        const latest = [...frames].reverse().find(value => value?.turn_id || value?.event?.turn_id);
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
      if (navigationCommand && (commandId === navigationCommand || (!commandId && result.command === 'navigate_checkpoint'))) {
        if (result.status !== 'accepted') { note(`resume checkpoint navigation failed: ${JSON.stringify(result)}`); await finish(2, { kill: true }); return; }
        note(`resume: head moved to turn ${resumeCheckpoint.turnId} (last completed; last turn was ${resumeCheckpoint.ending})`);
        navigationCommand = null;
        resumeCheckpoint = null;
        drain();
        return;
      }
      const startResult = (!result.command || result.command === 'start_turn') && (!commandId || commandId === turns.commandId);
      const turnId = result.response?.turn_id ?? result.turn_id;
      const duplicate = startResult && result.status === 'accepted' && (result.message === 'turn already admitted' || (turnId && completedTurns.has(turnId)));
      if (duplicate || result.status === 'rejected') {
        note(`command rejected: ${JSON.stringify(result)}`);
        if (startResult && turns.reject(commandId)) {
          cancelRequested = false;
          if (!turns.busy && !turns.queue.length) await post('Stop', 'error');
          drain();
        }
      } else if (result.status === 'accepted' || result.status === 'queued') {
        if (startResult && turns.accept(commandId, turnId)) {
          firstTurn = false;
          await post('UserPromptSubmit', 'accepted', { turnId: turns.turnId });
          work();
          if (cancelRequested) { cancelRequested = false; cancel(); }
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
        const line = typeof delta.text === 'string' ? delta.text.split(/\r?\n/).find(Boolean) : null;
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
      if (ending) return;
      activity.stopBeats();
      if (subtype === 'error') await post('Notification', 'runtime_error', { turnId: turns.turnId });
      if (subtype === 'cancelled') { await activity.withdrawAll('turn_cancelled'); questions.clear(); }
      turns.end();
      tools.clear(); reasoning.clear(); lastBeat = -Infinity; cancelRequested = false;
      drain();
      return;
    }
    if (payload.type === 'organism.questions') {
      if (!Array.isArray(payload.questions)) return;
      const fresh = new Map(payload.questions.filter(question => question && typeof question === 'object' && typeof question.question_id === 'string' && (!question.session_id || question.session_id === nativeRef)).map(question => [question.question_id, question]));
      for (const [id, entry] of questions) if (!fresh.has(id)) {
        questions.delete(id);
        if (!entry.answered) void entry.handle?.withdraw?.('turn_ended');
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
    frameChain = frameChain.then(() => handleFrame(frame)).catch(cause => { note(`frame error: ${cause.message}`); });
  }, line => error.write(`${line}\n`));
  child.stdout.on('data', framer);
  child.stdout.on('end', () => framer.end());
  child.stderr.on('data', chunk => error.write(chunk));
  function streamError(cause) { if (!ending) { if (cause.code !== 'EPIPE') note(`stream: ${cause.message}`); void finish(cause.code === 'EPIPE' ? 0 : 1, { kill: true }); } }
  child.stdin.on('error', streamError);
  output.on('error', streamError); input.on('error', streamError);
  child.on('error', cause => { note(`could not start nodecode: ${cause.message}`); void finish(127); });
  child.on('close', code => { frameChain.finally(() => finish(code ?? 1)); });
  if (input.isTTY) {
    input.setRawMode(true);
    output.write('\u001b[?2004h');
    rawHandler = createInputParser(submit, value => output.write(value), interrupt, () => [...questions.values()].some(entry => !entry.answered && (!Array.isArray(entry.question.choices) || !entry.question.choices.length)));
    input.on('data', rawHandler);
  } else {
    inputInterface = readline.createInterface({ input, crlfDelay: Infinity });
    inputInterface.on('line', line => { if (line.trim() || [...questions.values()].some(entry => !entry.answered && (!Array.isArray(entry.question.choices) || !entry.question.choices.length))) submit(line); });
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
