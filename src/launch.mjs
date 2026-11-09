import fs from 'node:fs';

export const PRODUCER = 'openrig-nodecode-runner 1.0';
export const HARNESS = 'nodecode';

export function parseArgs(argv) {
  const opts = { startupFiles: [], agentYaml: null, workspaceRoot: null, profile: null, store: null, nodecodeArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${arg} needs a value`); return v; };
    if (arg === '--startup-file') opts.startupFiles.push(value());
    else if (arg === '--agent-yaml') opts.agentYaml = value();
    else if (arg === '--workspace-root') opts.workspaceRoot = value();
    else if (arg === '--profile') opts.profile = value();
    else if (arg === '--store') opts.store = value();
    else if (arg === '--') { opts.nodecodeArgs = argv.slice(i + 1); break; }
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

export function composeFirstPrompt(firstInputText, startupFiles, readFile = p => fs.readFileSync(p, 'utf8')) {
  const parts = [];
  if (firstInputText && firstInputText.trim()) parts.push(firstInputText.replace(/\s+$/, ''));
  for (const file of startupFiles) {
    let text;
    try { text = readFile(file); } catch { continue; }
    if (text.trim()) parts.push(`Startup file ${file} (delivered by the nodecode runner):\n\n${text.replace(/\s+$/, '')}`);
  }
  return parts.join('\n\n');
}

/** Reject malformed handoffs so callers never silently launch without the wrapper. */
export function launchWrapperArgv(value) {
  if (value === undefined) return [];
  const invalid = () => new Error('OPENRIG_LAUNCH_WRAPPER must be a JSON array of strings with a non-empty program');
  let argv;
  try { argv = JSON.parse(value); } catch { throw invalid(); }
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !argv[0]) throw invalid();
  return argv;
}

/** Write once with O_EXCL, including refusal to follow an existing symlink. */
export function writeLaunchRecord(file, record) {
  if (!file) return false;
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeSync(fd, `${JSON.stringify({ format: 1, harness: HARNESS, producer: PRODUCER, ...record })}\n`); } finally { fs.closeSync(fd); }
  return true;
}

export function nodecodeArgv({ bin = 'nodecode', profile, store, resumeRef, extra = [], wrapper = [] }) {
  return [...wrapper, bin, ...(profile ? ['-p', profile] : []), ...(store ? ['--store', store] : []), 'rpc', ...(resumeRef ? [resumeRef] : []), ...extra];
}
