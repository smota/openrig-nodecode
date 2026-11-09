import fs from 'node:fs';
import path from 'node:path';

/** Member id from an OpenRig session name <pod>-<member>@<rig>. */
export function memberOf(sessionName) {
  const match = /^[a-z0-9]+-([a-z0-9-]+)@[A-Za-z0-9._-]+$/.exec(sessionName ?? '');
  return match ? match[1] : null;
}

/** Read the reference runner's supported inline resources and profile uses.skills YAML layout. */
export function profileSkills(agentYamlText, profile) {
  const lines = agentYamlText.split(/\r?\n/);
  const resources = new Map();
  for (const line of lines) {
    const match = /^\s*-\s*\{\s*id:\s*([A-Za-z0-9._-]+)\s*,\s*path:\s*([^\s}]+)\s*\}\s*$/.exec(line);
    if (match) resources.set(match[1], match[2]);
  }
  const indent = line => line.length - line.trimStart().length;
  const profiles = lines.findIndex(line => /^profiles:\s*$/.test(line));
  if (profiles < 0) return [];
  let start = -1;
  let profileIndent = null;
  for (let i = profiles + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const level = indent(line);
    if (level === 0) break;
    profileIndent ??= level;
    if (level === profileIndent && line.trim() === `${profile}:`) { start = i; break; }
  }
  if (start < 0) return [];
  const base = indent(lines[start]);
  let inUses = false; let inSkills = false; let skillsIndent = -1; let usesIndent = -1;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const level = indent(line);
    if (level <= base) break;
    if (/^\s+uses:\s*$/.test(line)) { inUses = true; usesIndent = level; continue; }
    if (inUses && level <= usesIndent) { inUses = false; inSkills = false; }
    if (inUses && /^\s+skills:\s*$/.test(line)) { inSkills = true; skillsIndent = level; continue; }
    if (inSkills && level <= skillsIndent) inSkills = false;
    const item = inSkills ? /^\s+-\s+([A-Za-z0-9._-]+)\s*$/.exec(line) : null;
    if (item && resources.has(item[1])) out.push({ id: item[1], path: resources.get(item[1]) });
  }
  return out;
}

/** Place realpath links for selected skills, pruning only stale symlinks. */
export function placeSkills(workspace, agentYaml, member) {
  const skillsDir = path.join(workspace, '.agents', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  const wanted = member ? profileSkills(fs.readFileSync(agentYaml, 'utf8'), member) : [];
  const agentDir = path.dirname(agentYaml);
  const keep = new Set();
  const placed = [];
  for (const skill of wanted) {
    keep.add(skill.id);
    try {
      const target = fs.realpathSync(path.resolve(agentDir, skill.path));
      if (!fs.existsSync(path.join(target, 'SKILL.md'))) continue;
      const link = path.join(skillsDir, skill.id);
      let current = null;
      try { current = fs.readlinkSync(link); } catch { /* absent or not a link */ }
      if (current !== target) {
        fs.rmSync(link, { force: true, recursive: false });
        fs.symlinkSync(target, link);
      }
      placed.push(skill.id);
    } catch (cause) { process.stderr.write(`nodecode: skill ${skill.id}: ${cause.message}\n`); }
  }
  for (const entry of fs.readdirSync(skillsDir)) {
    const full = path.join(skillsDir, entry);
    if (!keep.has(entry) && fs.lstatSync(full).isSymbolicLink()) fs.rmSync(full);
  }
  return placed;
}

/** Expose the workspace's skills through nodecode's existing discovery directory. */
export function linkHomeSkills(home, seatName, workspace) {
  const directory = path.join(home, 'cells', 'linked-skills');
  let available = false;
  try { available = fs.statSync(directory).isDirectory(); } catch { /* not initialized */ }
  if (!available) {
    process.stderr.write(`nodecode: skipping home skills link; ${directory} directory is missing\n`);
    return false;
  }
  const name = String(seatName ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  const link = path.join(directory, `openrig-${name}`);
  const target = path.resolve(workspace, '.agents', 'skills');
  let current = null;
  try { current = fs.readlinkSync(link); } catch { /* absent or not a link */ }
  if (current !== target) {
    try {
      fs.rmSync(link, { force: true, recursive: false });
      fs.symlinkSync(target, link);
    } catch (cause) { process.stderr.write(`nodecode: home skills link: ${cause.message}\n`); return false; }
  }
  return true;
}
