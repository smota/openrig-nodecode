import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/** Read complete appended JSON lines once, without ever modifying the channel. */
export function watchCommandFile(path, onCommand, note = message => process.stderr.write(`[nodecode-runner] ${message}\n`)) {
  let offset = 0, pending = '', warned = false, closed = false;
  const decoder = new StringDecoder('utf8');
  const read = () => {
    if (closed) return;
    let fd;
    try {
      fd = fs.openSync(path, 'r');
      const size = fs.fstatSync(fd).size;
      while (offset < size) {
        const buffer = Buffer.alloc(Math.min(size - offset, 64 * 1024));
        const length = fs.readSync(fd, buffer, 0, buffer.length, offset);
        if (!length) break;
        offset += length;
        pending += decoder.write(buffer.subarray(0, length));
        let index;
        while ((index = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, index); pending = pending.slice(index + 1);
          let command;
          try { command = JSON.parse(line); }
          catch { if (!warned) { warned = true; note('ignoring malformed command channel line'); } continue; }
          Promise.resolve().then(() => { if (!closed) return onCommand(command); }).catch(cause => note(`command channel: ${cause.message}`));
        }
      }
    } catch (cause) { if (cause.code !== 'ENOENT') note(`command channel: ${cause.message}`); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  let watcher;
  try { watcher = fs.watch(path, read); watcher.on('error', () => { watcher.close(); }); }
  catch { /* Polling also covers files not present yet and unsupported watchers. */ }
  const poll = setInterval(read, 1000).unref();
  read();
  return () => { closed = true; clearInterval(poll); watcher?.close(); };
}
