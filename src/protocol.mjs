import { StringDecoder } from 'node:string_decoder';

/** Feed arbitrary stdout chunks; end() also dispatches an unterminated final line. */
export function createFramer(onFrame, onText = () => {}) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const line = value => {
    if (value.endsWith('\r')) value = value.slice(0, -1);
    let frame;
    try { frame = JSON.parse(value); } catch { feed.onText(value); return; }
    onFrame(frame);
  };
  const split = text => {
    pending += text;
    let index;
    while ((index = pending.indexOf('\n')) !== -1) {
      const value = pending.slice(0, index);
      pending = pending.slice(index + 1);
      line(value);
    }
  };
  const feed = chunk => split(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  feed.onText = onText;
  feed.push = feed;
  feed.write = feed;
  feed.end = chunk => {
    if (chunk !== undefined) feed(chunk);
    split(decoder.end());
    if (pending.length) { const value = pending; pending = ''; line(value); }
  };
  feed.flush = feed.end;
  return feed;
}

/** One outstanding start command/turn, with operator prompts held in FIFO order. */
export function createTurnTracker() {
  return {
    submitted: false,
    accepted: false,
    commandId: null,
    turnId: null,
    queue: [],
    get busy() { return this.submitted || this.accepted || this.turnId !== null; },
    submit(commandId) {
      if (this.busy) return false;
      this.submitted = true;
      this.accepted = false;
      this.commandId = commandId;
      return true;
    },
    accept(commandId, turnId) {
      if (!this.submitted || (commandId && commandId !== this.commandId)) return false;
      this.submitted = false;
      this.accepted = true;
      this.turnId = turnId ?? this.turnId;
      return true;
    },
    reject(commandId) {
      if (!this.submitted || (commandId && commandId !== this.commandId)) return false;
      this.submitted = false;
      this.commandId = null;
      return true;
    },
    observe(turnId) {
      if (turnId && !this.turnId) this.turnId = turnId;
    },
    end(turnId) {
      if (turnId && this.turnId && turnId !== this.turnId) return false;
      this.submitted = false;
      this.accepted = false;
      this.commandId = null;
      this.turnId = null;
      return true;
    },
    enqueue(prompt) { this.queue.push(prompt); },
    dequeue() { return this.busy ? undefined : this.queue.shift(); },
  };
}
