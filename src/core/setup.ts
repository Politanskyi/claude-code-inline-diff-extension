// Wiring Claude Code to the extension: copies the hook script to
// ~/.claude/hooks/ and adds/removes its entries in ~/.claude/settings.json.
// No editor dependency, so it is shared by the extension commands, the
// `vscode:uninstall` cleanup script and the unit tests.
//
// Safety rules:
//  - invalid JSON in settings.json is never overwritten (we throw instead);
//  - a timestamped backup is written before every change;
//  - file permissions are preserved and symlinked settings are written through;
//  - only entries whose command references our script are ever touched.
import * as fs from 'fs';
import * as path from 'path';
import { claudeDir, globalDir, HOOK_FILE, HOOK_MARKER, readJson, writeJsonAtomic } from './store';

export const TOOL_MATCHER = 'Edit|MultiEdit|Write|NotebookEdit|Bash';
export const TOOL_EVENTS = ['PreToolUse', 'PostToolUse'] as const;
export const PROMPT_EVENTS = ['UserPromptSubmit', 'Stop'] as const;
export const ALL_EVENTS = [...TOOL_EVENTS, ...PROMPT_EVENTS];

export const hookPath = (dir = claudeDir()) => path.join(dir, 'hooks', HOOK_FILE);
export const settingsPath = (dir = claudeDir()) => path.join(dir, 'settings.json');
export const isOurCommand = (cmd: unknown) => typeof cmd === 'string' && cmd.includes(HOOK_FILE);

/** Quote a path for the shell Claude Code runs hook commands in. */
function q(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`;
}

/**
 * The command for settings.json. `node` when available; otherwise the
 * editor's own Electron binary in Node mode (Claude Code's native installer
 * does not need Node, so it may be absent).
 */
export function hookCommand(script: string, opts: { nodeOnPath: boolean; execPath?: string; platform?: NodeJS.Platform }): string {
  if (opts.nodeOnPath || !opts.execPath) return `node ${q(script)}`;
  if ((opts.platform || process.platform) === 'win32') return `set ELECTRON_RUN_AS_NODE=1&& ${q(opts.execPath)} ${q(script)}`;
  return `ELECTRON_RUN_AS_NODE=1 ${q(opts.execPath)} ${q(script)}`;
}

export function readSettings(file: string): any {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`${file} is not valid JSON (${e.message}). Fix it by hand; it was not modified.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object; it was not modified.`);
  return parsed;
}

function groupsOf(settings: any, event: string): any[] {
  return settings && settings.hooks && Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
}

export function hasOurHook(settings: any, event: string): boolean {
  return groupsOf(settings, event).some((g) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => isOurCommand(h?.command)));
}

/** Adds (or repairs) our entries. Mutates `settings`; returns human-readable notes of what changed. */
export function mergeSettings(settings: any, command: string): string[] {
  const notes: string[] = [];
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
  for (const event of ALL_EVENTS) {
    const matcher = (TOOL_EVENTS as readonly string[]).includes(event) ? TOOL_MATCHER : undefined;
    const groups: any[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    settings.hooks[event] = groups;
    const ours = groups.find((g) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => isOurCommand(h?.command)));
    const entry = { type: 'command', command, timeout: 15 };
    if (!ours) {
      groups.push(matcher ? { matcher, hooks: [entry] } : { hooks: [entry] });
      notes.push(`added ${event} hook`);
      continue;
    }
    const h = ours.hooks.find((x: any) => isOurCommand(x?.command));
    if (h.command !== command) {
      h.command = command;
      notes.push(`updated ${event} hook command`);
    }
    if (matcher && ours.matcher !== matcher) {
      if (ours.hooks.length === 1) ours.matcher = matcher;
      else {
        ours.hooks = ours.hooks.filter((x: any) => !isOurCommand(x?.command));
        groups.push({ matcher, hooks: [entry] });
      }
      notes.push(`set ${event} matcher to ${matcher}`);
    }
  }
  return notes;
}

/** Removes every hook entry running our script; drops groups/events left empty. Returns true if anything was removed. */
export function unmergeSettings(settings: any): boolean {
  if (!settings || !settings.hooks || typeof settings.hooks !== 'object') return false;
  let removed = false;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!Array.isArray(g?.hooks)) continue;
      const kept = g.hooks.filter((h: any) => !isOurCommand(h?.command));
      if (kept.length !== g.hooks.length) {
        removed = true;
        g.hooks = kept;
      }
    }
    settings.hooks[event] = groups.filter((g: any) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

const BACKUP_TAG = '.bak-claude-inline-diff';

/** Our backups of `file` (`<file>.bak-claude-inline-diff-<time>`), oldest first. */
export function listBackups(file: string): string[] {
  const dir = path.dirname(file);
  const prefix = path.basename(file) + BACKUP_TAG;
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(prefix))
      .sort() // the ISO time in the name sorts by age
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** Keeps the newest `keep` backups of `file` (default: the last one) and deletes the older ones. */
export function pruneBackups(file: string, keep = 1): void {
  const all = listBackups(file);
  for (const b of all.slice(0, Math.max(0, all.length - keep))) {
    try {
      fs.unlinkSync(b);
    } catch {
      /* gone already */
    }
  }
}

/** Atomic write with one backup (older ones are removed); keeps mode, writes through symlinks. Returns the backup path (or null). */
export function writeSettings(file: string, settings: unknown, now = new Date()): string | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let target = file;
  let mode = 0o600; // settings.json may hold secrets in "env"
  let backup: string | null = null;
  if (fs.existsSync(file)) {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
    backup = `${file}${BACKUP_TAG}-${now.toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(target, backup);
    try {
      fs.chmodSync(backup, mode);
    } catch {
      /* windows */
    }
  }
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode });
  try {
    fs.chmodSync(tmp, mode);
  } catch {
    /* windows */
  }
  fs.renameSync(tmp, target);
  pruneBackups(file); // a safety net for the last change, not an archive
  return backup;
}

export function hookVersion(text: string): string | null {
  const m = new RegExp(HOOK_MARKER + ' v(\\d+\\.\\d+\\.\\d+)').exec(text);
  return m ? m[1] : null;
}

export function installHookScript(bundled: string, dir = claudeDir()): string {
  const dest = hookPath(dir);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.copyFileSync(bundled, tmp);
  try {
    fs.chmodSync(tmp, 0o755);
  } catch {
    /* windows */
  }
  fs.renameSync(tmp, dest);
  return dest;
}

export interface Status {
  hookPath: string;
  installedVersion: string | null;
  bundledVersion: string | null;
  scriptInstalled: boolean;
  configured: boolean; // every event wired
  partial: boolean; // some events wired
  settingsError: string | null;
  defaultMode?: string;
}

export function status(bundled: string, dir = claudeDir()): Status {
  const dest = hookPath(dir);
  let installedVersion: string | null = null;
  try {
    installedVersion = hookVersion(fs.readFileSync(dest, 'utf8'));
  } catch {
    /* not installed */
  }
  let bundledVersion: string | null = null;
  try {
    bundledVersion = hookVersion(fs.readFileSync(bundled, 'utf8'));
  } catch {
    /* dev */
  }
  let configured = false;
  let partial = false;
  let settingsError: string | null = null;
  let defaultMode: string | undefined;
  try {
    const s = readSettings(settingsPath(dir));
    const wired = ALL_EVENTS.filter((e) => hasOurHook(s, e)).length;
    configured = wired === ALL_EVENTS.length;
    partial = wired > 0 && !configured;
    defaultMode = s.permissions?.defaultMode;
  } catch (e: any) {
    settingsError = e.message;
  }
  return {
    hookPath: dest,
    installedVersion,
    bundledVersion,
    scriptInstalled: !!installedVersion,
    configured,
    partial,
    settingsError,
    defaultMode,
  };
}

export function install(opts: {
  bundled: string;
  dir?: string;
  nodeOnPath: boolean;
  execPath?: string;
  platform?: NodeJS.Platform;
}): string[] {
  const dir = opts.dir || claudeDir();
  const file = settingsPath(dir);
  const settings = readSettings(file); // throws before we touch anything if the JSON is broken
  const done: string[] = [];
  const dest = installHookScript(opts.bundled, dir);
  done.push('hook script → ' + dest);
  const notes = mergeSettings(settings, hookCommand(dest, opts));
  if (notes.length) {
    const backup = writeSettings(file, settings);
    if (backup) done.push('backup → ' + backup);
    done.push(...notes.map((n) => 'settings.json: ' + n));
  } else done.push('settings.json already up to date');
  return done;
}

export function uninstall(opts: { dir?: string; env?: NodeJS.ProcessEnv; removeGlobalStore?: boolean } = {}): string[] {
  const dir = opts.dir || claudeDir(opts.env);
  const env = opts.env || process.env;
  const done: string[] = [];
  try {
    done.push(...rollbackAcceptEdits(dir, env));
  } catch (e: any) {
    done.push('could not restore permissions.defaultMode: ' + e.message);
  }
  const file = settingsPath(dir);
  if (fs.existsSync(file)) {
    const settings = readSettings(file);
    if (unmergeSettings(settings)) {
      const backup = writeSettings(file, settings);
      done.push('removed hook entries from settings.json' + (backup ? ` (backup → ${backup})` : ''));
    }
  }
  const dest = hookPath(dir);
  try {
    if (hookVersion(fs.readFileSync(dest, 'utf8')) !== null) {
      fs.unlinkSync(dest);
      done.push('deleted ' + dest);
    }
  } catch {
    /* not installed */
  }
  if (opts.removeGlobalStore) {
    const g = path.join(globalDir(env), 'store');
    if (fs.existsSync(g)) {
      fs.rmSync(g, { recursive: true, force: true });
      done.push('deleted ' + g);
    }
  }
  return done;
}

// ---------- acceptEdits ("Edit automatically") — only on explicit request, always reversible ----------

interface SetupState {
  acceptEdits?: { setByUs: boolean; previous: string | null };
}
const statePath = (env: NodeJS.ProcessEnv = process.env) => path.join(globalDir(env), 'setup-state.json');
export const readSetupState = (env: NodeJS.ProcessEnv = process.env): SetupState => readJson<SetupState>(statePath(env)) || {};

/** Sets permissions.defaultMode = acceptEdits, remembering the previous value so uninstall can restore it. */
export function enableAcceptEdits(dir = claudeDir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const file = settingsPath(dir);
  const settings = readSettings(file);
  const prev = settings.permissions?.defaultMode ?? null;
  if (prev === 'acceptEdits') return ['permissions.defaultMode is already acceptEdits'];
  if (!settings.permissions || typeof settings.permissions !== 'object') settings.permissions = {};
  settings.permissions.defaultMode = 'acceptEdits';
  const backup = writeSettings(file, settings);
  writeJsonAtomic(statePath(env), { ...readSetupState(env), acceptEdits: { setByUs: true, previous: prev } });
  return [`permissions.defaultMode: ${prev ?? '(unset)'} → acceptEdits` + (backup ? ` (backup → ${backup})` : '')];
}

/** Restores permissions.defaultMode if (and only if) we set it and nobody changed it since. */
export function rollbackAcceptEdits(dir = claudeDir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const st = readSetupState(env);
  if (!st.acceptEdits?.setByUs) return [];
  const file = settingsPath(dir);
  const settings = readSettings(file);
  const done: string[] = [];
  if (settings.permissions?.defaultMode === 'acceptEdits') {
    if (st.acceptEdits.previous === null) {
      delete settings.permissions.defaultMode;
      if (Object.keys(settings.permissions).length === 0) delete settings.permissions;
    } else settings.permissions.defaultMode = st.acceptEdits.previous;
    writeSettings(file, settings);
    done.push(`permissions.defaultMode restored to ${st.acceptEdits.previous ?? '(unset)'}`);
  }
  delete st.acceptEdits;
  writeJsonAtomic(statePath(env), st);
  return done;
}
