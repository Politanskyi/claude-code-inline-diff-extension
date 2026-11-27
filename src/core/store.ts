// On-disk review state, shared by the Claude Code hook (dist/hook.js) and the
// extension so the two can never disagree on paths or formats.
//
// Where a store lives (see storeDirFor):
//   ~/.claude/inline-diff/projects/<name>-<hash>/  one per project, outside it (default, `storage: home`)
//   <git root>/.claude-review/                     inside the project (`storage: project`)
//   ~/.claude/inline-diff/store/                   files outside any project, and editor-writes/
// Layout of a store directory:
//   .gitignore                 "*"  — the store ignores itself; your .gitignore is never edited
//   baselines/<name>.json      the file as it was before Claude's first pending edit
//   baselines/<name>.landed    touched by PostToolUse: Claude's write has happened
//   activity/<name>.json       a tool call on that file is in flight (Pre seen, Post not yet)
//   steps/<session>/<turn>/meta.json         one Claude step (= one user prompt)
//   steps/<session>/<turn>/files/<name>.json the file before that step first touched it
//   bash/<id>.json             dirty-file snapshot taken before a Bash tool call
//   before/<name>.txt          the file as it was when an edit tool call started (Pre → Post)
//   feedback/<id>.json         "reject with feedback" notes waiting for Claude
//   editor-writes/<name>.json  (global store only) last save made in the editor, so Bash tracking skips it
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Region } from './regions';
export type { Region };

export const STORE_DIR_NAME_DEFAULT = '.claude-review';
export const HOOK_FILE = 'claude-inline-diff-hook.js';
export const HOOK_MARKER = 'claude-inline-diff hook';

export type StorageMode = 'project' | 'home';
export interface SharedConfig {
  storage: StorageMode;
  dirName: string;
  trackBash: boolean;
  /** Days to keep per-step snapshots (the hook prunes older ones). */
  stepRetentionDays: number;
}
export const DEFAULT_CONFIG: SharedConfig = { storage: 'home', dirName: STORE_DIR_NAME_DEFAULT, trackBash: true, stepRetentionDays: 7 };

export interface BaselineFile {
  version: 3;
  path: string;
  existed: boolean;
  content: string;
  createdAt: number;
  sessionId?: string;
  tool?: string;
  source?: 'edit' | 'bash';
  /** Where Claude's edits landed (see core/regions.ts); absent for Bash changes and older baselines. */
  regions?: Region[];
}
export interface Entry extends BaselineFile {
  jsonPath: string;
  key: string;
  storeDir: string;
  landedAt: number;
}
export interface Activity {
  path: string;
  tool: string;
  sessionId?: string;
  ts: number;
}
export interface StepMeta {
  sessionId: string;
  turnId: string;
  ts: number;
  prompt: string;
}
export interface StepFile {
  path: string;
  existed: boolean;
  content: string;
  ts: number;
}
export interface Step extends StepMeta {
  dir: string;
  storeDir: string;
  files: StepFile[];
}
export interface Feedback {
  id: string;
  sessionId?: string;
  path: string;
  text: string;
  excerpt?: string;
  ts: number;
}

export const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
export const MAX_BYTES = 8 * 1024 * 1024;

// ---------- locations ----------

export function claudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
/** Global home for this tool: config, and the store for files outside any project. */
export function globalDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_INLINE_DIFF_HOME || path.join(claudeDir(env), 'inline-diff');
}
/** The store for files outside any project (and the editor-writes log). */
export function globalStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(globalDir(env), 'store');
}
/**
 * A project's own store outside the project: `projects/<folder name>-<hash of its path>`. Hook and
 * extension derive it from the (real) project root alone, so they always agree without a registry.
 */
export function homeProjectStoreDir(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const name =
    path
      .basename(projectRoot)
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 40) || 'project';
  const hash = crypto.createHash('sha256').update(cmpForm(projectRoot)).digest('hex').slice(0, 12);
  return path.join(globalDir(env), 'projects', `${name}-${hash}`);
}
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(globalDir(env), 'config.json');
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): SharedConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(env), 'utf8'));
    return {
      storage: raw.storage === 'project' ? 'project' : 'home',
      dirName: typeof raw.dirName === 'string' && /^[\w.-]+$/.test(raw.dirName) ? raw.dirName : STORE_DIR_NAME_DEFAULT,
      trackBash: raw.trackBash !== false,
      stepRetentionDays: typeof raw.stepRetentionDays === 'number' && raw.stepRetentionDays >= 1 ? raw.stepRetentionDays : 7,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(cfg: SharedConfig, env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(configPath(env), cfg);
}

/** Nearest ancestor (inclusive) holding .git, else `start` itself. */
export function projectRootFor(start: string): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(start);
}

/** Path comparison form: absolute, normalized, case-folded on case-insensitive file systems. */
function cmpForm(p: string): string {
  const r = path.resolve(p);
  return CASE_INSENSITIVE ? r.toLowerCase() : r;
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(cmpForm(parent), cmpForm(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The store a file's review lives in: its project's store, or the global one for files outside the project. */
export function storeDirFor(
  absFile: string,
  projectRoot: string | undefined,
  cfg: SharedConfig,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!projectRoot || !isInside(absFile, projectRoot)) return globalStoreDir(env);
  return cfg.storage === 'project' ? path.join(projectRoot, cfg.dirName) : homeProjectStoreDir(projectRoot, env);
}

/** Folders under ~/.claude that Claude Code writes for itself: memory and transcripts, plans, todo lists. */
const CLAUDE_INTERNAL_DIRS = ['projects', 'plans', 'todos'];

/**
 * Claude Code's own working files outside the project (see CLAUDE_INTERNAL_DIRS, under ~/.claude or
 * CLAUDE_CONFIG_DIR): not changes to review. What you write there yourself (settings.json, CLAUDE.md,
 * skills, agents, hooks, commands) is reviewed like any other file.
 */
export function isClaudeInternal(absFile: string, projectRoot: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (projectRoot && isInside(absFile, projectRoot)) return false;
  const dir = claudeDir(env);
  return [dir, realPath(dir)].some((d) => CLAUDE_INTERNAL_DIRS.some((n) => isInside(absFile, path.join(d, n))));
}

/** Our own store (it carries our self-ignoring .gitignore), not some unrelated folder of the same name. */
export function isOurStore(dir: string): boolean {
  try {
    return fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').includes('Claude Inline Diff');
  } catch {
    return false;
  }
}

/**
 * Moves a store to another place (switching `storage` between project and home), merging into an
 * existing target. Returns true when something moved. Only ever touches a folder that is ours.
 */
export function moveStore(from: string, to: string): boolean {
  if (cmpForm(from) === cmpForm(to) || !isOurStore(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (!fs.existsSync(to)) {
    try {
      fs.renameSync(from, to);
      return true;
    } catch {
      /* another disk: copy below */
    }
  }
  fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
  fs.rmSync(from, { recursive: true, force: true });
  return true;
}

// ---------- naming ----------

export function fileNameFor(absPath: string): string {
  const b64 = Buffer.from(absPath).toString('base64url');
  return b64.length <= 180 ? b64 : 'h-' + crypto.createHash('sha256').update(absPath).digest('hex');
}

export function safeId(s: string | undefined): string {
  return (s || 'unknown').replace(/[^\w-]/g, '_').slice(0, 80) || 'unknown';
}

/**
 * Canonical path: symlinks and Windows 8.3 names resolved. For a path that does
 * not exist yet (Claude writing src/new/file.ts), the nearest existing ancestor
 * is resolved and the missing segments are appended.
 */
export function realPath(p: string): string {
  const abs = path.resolve(p);
  const missing: string[] = [];
  let cur = abs;
  for (let i = 0; i < 256; i++) {
    try {
      const real = fs.realpathSync.native(cur);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return abs;
      missing.push(path.basename(cur));
      cur = up;
    }
  }
  return abs;
}

export function keyOf(p: string): string {
  const k = path.normalize(realPath(p));
  return CASE_INSENSITIVE ? k.toLowerCase() : k;
}

// ---------- fs helpers ----------

export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/** Writes only if `file` does not exist yet (atomic first-writer-wins). Returns true if written. */
export function writeJsonExclusive(file: string, data: unknown): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e: any) {
    if (e && e.code === 'EEXIST') return false;
    // Filesystems without hard links: fall back to an exclusive create.
    try {
      fs.writeFileSync(file, JSON.stringify(data), { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* gone */
    }
  }
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function rm(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Creates the store with a self-ignoring .gitignore. */
export function ensureStore(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) {
    try {
      fs.writeFileSync(gi, '# Created by Claude Inline Diff: review state, never commit.\n*\n');
    } catch {
      /* read-only? ignore */
    }
  }
}

/** Reads a text file the way a baseline stores it; null when missing, binary or too large. ENOENT → {existed:false}. */
export function readTextForBaseline(abs: string): { existed: boolean; content: string } | null {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return null;
    return { existed: true, content: buf.toString('utf8').replace(/^\uFEFF/, '') };
  } catch (e: any) {
    if (e && e.code === 'ENOENT') return { existed: false, content: '' };
    return null;
  }
}

// ---------- writes made in the editor (user saves, Undo/Keep) ----------
// A Bash tool call compares files before and after the command. Anything the user (or this
// extension) writes to disk while the command runs would otherwise look like Claude's change,
// so the extension records each such write and the hook skips files whose content still matches.

const editorWritePath = (abs: string, env: NodeJS.ProcessEnv) =>
  path.join(globalStoreDir(env), 'editor-writes', fileNameFor(keyOf(abs)) + '.json');

/** sha256 of the file's bytes, '-' when it does not exist, null when unreadable. */
export function fileHash(abs: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch (e: any) {
    return e && e.code === 'ENOENT' ? '-' : null;
  }
}

export function recordEditorWrite(abs: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): void {
  const hash = fileHash(abs);
  if (hash === null) return;
  try {
    writeJsonAtomic(editorWritePath(abs, env), { path: abs, hash, ts: now });
  } catch {
    /* best effort */
  }
}

/** True when the editor wrote exactly the current content of `abs` at or after `since`. */
export function isEditorWrite(abs: string, since: number, env: NodeJS.ProcessEnv = process.env): boolean {
  const rec = readJson<{ hash: string; ts: number }>(editorWritePath(abs, env));
  return !!rec && rec.ts >= since && rec.hash === fileHash(abs);
}

export function pruneEditorWrites(maxAgeMs: number, now = Date.now(), env: NodeJS.ProcessEnv = process.env): void {
  const dir = path.join(globalStoreDir(env), 'editor-writes');
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { force: true });
    }
  } catch {
    /* none yet */
  }
}

// ---------- baselines ----------

export const baselinePath = (storeDir: string, abs: string) => path.join(storeDir, 'baselines', fileNameFor(abs) + '.json');

export function hasBaseline(storeDir: string, abs: string): boolean {
  return fs.existsSync(baselinePath(storeDir, abs));
}

/** First pending edit wins: creates the baseline only if none exists. */
export function createBaseline(storeDir: string, b: BaselineFile): boolean {
  ensureStore(storeDir);
  return writeJsonExclusive(baselinePath(storeDir, b.path), b);
}

export function markLanded(storeDir: string, abs: string): void {
  const p = baselinePath(storeDir, abs);
  if (fs.existsSync(p)) fs.writeFileSync(p.replace(/\.json$/, '.landed'), String(Date.now()));
}

function landedAt(jsonPath: string): number {
  try {
    return fs.statSync(jsonPath.replace(/\.json$/, '.landed')).mtimeMs;
  } catch {
    return 0;
  }
}

export function loadEntries(storeDir: string): Entry[] {
  const dir = path.join(storeDir, 'baselines');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Entry[] = [];
  for (const name of names) {
    const jsonPath = path.join(dir, name);
    const raw = readJson<BaselineFile>(jsonPath);
    if (!raw || typeof raw.path !== 'string' || typeof raw.content !== 'string') continue;
    out.push({
      ...raw,
      version: 3,
      existed: raw.existed !== false,
      createdAt: Number(raw.createdAt) || 0,
      content: raw.content.replace(/^\uFEFF/, ''),
      jsonPath,
      key: keyOf(raw.path),
      storeDir,
      landedAt: landedAt(jsonPath),
    });
  }
  return out;
}

export function serializeEntry(e: Entry): BaselineFile {
  const { jsonPath: _j, key: _k, storeDir: _s, landedAt: _l, ...rest } = e;
  return rest;
}

export function writeEntry(e: Entry): void {
  ensureStore(e.storeDir);
  writeJsonAtomic(e.jsonPath, serializeEntry(e));
}

export function removeEntry(e: Entry): void {
  rm(e.jsonPath);
  rm(e.jsonPath.replace(/\.json$/, '.landed'));
}

/**
 * Drops baselines nobody reviewed within `maxAgeMs` (and any `drop` matches), keeping the files as they
 * are. Only for the global store: a forgotten change outside any project is taken as kept.
 */
export function pruneEntries(storeDir: string, maxAgeMs: number, now = Date.now(), drop?: (e: Entry) => boolean): void {
  for (const e of loadEntries(storeDir)) {
    if (now - Math.max(e.createdAt, e.landedAt) > maxAgeMs || drop?.(e)) removeEntry(e);
  }
}

// ---------- turns (Claude is working) ----------

/** A Claude turn in progress: set on the prompt, refreshed by every tool call, cleared by Stop. */
export const TURN_STALE_MS = 180_000; // Stop does not fire when the user interrupts Claude: a quiet turn expires
const turnPath = (storeDir: string, sessionId: string) => path.join(storeDir, 'turns', safeId(sessionId) + '.json');

export function markTurn(storeDir: string, sessionId: string, now = Date.now()): void {
  try {
    fs.mkdirSync(path.join(storeDir, 'turns'), { recursive: true });
    writeJsonAtomic(turnPath(storeDir, sessionId), { sessionId, ts: now });
  } catch {
    /* best effort */
  }
}

export function endTurn(storeDir: string, sessionId: string): void {
  rm(turnPath(storeDir, sessionId));
}

/** Newest turn activity (ms) of any session in this store, or 0. */
export function lastTurnActivity(storeDir: string): number {
  const dir = path.join(storeDir, 'turns');
  let best = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const t = readJson<{ ts: number }>(path.join(dir, f));
      if (t && typeof t.ts === 'number' && t.ts > best) best = t.ts;
    }
  } catch {
    /* none */
  }
  return best;
}

// ---------- activity ----------

const activityPath = (storeDir: string, abs: string) => path.join(storeDir, 'activity', fileNameFor(abs) + '.json');

export function startActivity(storeDir: string, a: Activity): void {
  ensureStore(storeDir);
  writeJsonAtomic(activityPath(storeDir, a.path), a);
}
const beforePath = (storeDir: string, abs: string) => path.join(storeDir, 'before', fileNameFor(abs) + '.txt');

/** The file's text when Claude's tool call started (kept apart from activity/, which is polled). */
export function saveBefore(storeDir: string, abs: string, content: string): void {
  try {
    fs.mkdirSync(path.join(storeDir, 'before'), { recursive: true });
    fs.writeFileSync(beforePath(storeDir, abs), content);
  } catch {
    /* best effort: without it the change is grouped by a whole-file diff */
  }
}

export function takeBefore(storeDir: string, abs: string): string | null {
  const p = beforePath(storeDir, abs);
  try {
    const t = fs.readFileSync(p, 'utf8');
    fs.rmSync(p, { force: true });
    return t;
  } catch {
    return null;
  }
}

/** Read-modify-write of a baseline's edit regions. */
export function updateRegions(storeDir: string, abs: string, fn: (r: Region[]) => Region[]): void {
  const p = baselinePath(storeDir, abs);
  const b = readJson<BaselineFile>(p);
  if (!b) return;
  b.regions = fn(Array.isArray(b.regions) ? b.regions : []);
  writeJsonAtomic(p, b);
}

export function endActivity(storeDir: string, abs: string): void {
  rm(activityPath(storeDir, abs));
}
/** How long a "Claude is editing <file>" marker counts after its last write (PostToolUse normally ends it sooner). */
export const ACTIVITY_STALE_MS = 60_000;
export function loadActivity(storeDir: string, maxAgeMs = ACTIVITY_STALE_MS, now = Date.now()): Activity[] {
  const dir = path.join(storeDir, 'activity');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Activity[] = [];
  for (const n of names) {
    const a = readJson<Activity>(path.join(dir, n));
    if (!a) continue;
    if (now - a.ts > maxAgeMs) {
      rm(path.join(dir, n)); // a tool call that never reported back (denied, crashed)
      continue;
    }
    out.push(a);
  }
  return out.sort((x, y) => y.ts - x.ts);
}

// ---------- steps (one per user prompt) ----------

const statePath = (storeDir: string, sessionId: string) => path.join(storeDir, 'steps', safeId(sessionId), 'current.json');

const NO_PROMPT = '(prompt not recorded)';

/**
 * The prompt as the user typed it: Claude Code's IDE integration prepends context in tags
 * (`<ide_opened_file>…</ide_opened_file>`, `<ide_selection>…`), which is not what the step should be called.
 */
export function cleanPrompt(prompt: string): string {
  const text = prompt.replace(/<(ide_[a-z_]+|system-reminder)>[\s\S]*?<\/\1>/g, '').trim();
  return (text || prompt.trim()).slice(0, 300);
}

const turnIdOf = (now: number) => 't' + now.toString().padStart(14, '0');
const tsOfTurn = (turnId: string) => {
  const n = Number(turnId.slice(1));
  return Number.isFinite(n) ? n : Date.now();
};

function writeStepMeta(storeDir: string, sessionId: string, turnId: string, prompt: string): void {
  const dir = path.join(storeDir, 'steps', safeId(sessionId), turnId);
  writeJsonAtomic(path.join(dir, 'meta.json'), { sessionId, turnId, ts: tsOfTurn(turnId), prompt } satisfies StepMeta);
}

/** UserPromptSubmit: open a new step for the session. */
export function beginStep(storeDir: string, sessionId: string, prompt: string, now = Date.now()): string {
  ensureStore(storeDir);
  const turnId = turnIdOf(now);
  const text = cleanPrompt(prompt) || NO_PROMPT;
  writeStepMeta(storeDir, sessionId, turnId, text);
  writeJsonAtomic(statePath(storeDir, sessionId), { turnId, prompt: text });
  return turnId;
}

/**
 * Makes `turnId` (begun in the project's store) the current step of this session in another store too, without
 * creating it there: files outside the project then join the same step (same prompt and time, reverted together)
 * instead of one unnamed step. Only the small state file is written.
 */
export function shareStep(storeDir: string, sessionId: string, turnId: string, prompt: string): void {
  ensureStore(storeDir);
  writeJsonAtomic(statePath(storeDir, sessionId), { turnId, prompt: cleanPrompt(prompt) || NO_PROMPT });
}

export function currentStep(storeDir: string, sessionId: string): string {
  const st = readJson<{ turnId?: string; prompt?: string }>(statePath(storeDir, sessionId));
  if (st && typeof st.turnId === 'string' && /^t\d+$/.test(st.turnId)) {
    // Not created yet (shared from the project's store), or removed by a step revert while the prompt goes on:
    // (re)create it under the same prompt.
    if (!fs.existsSync(path.join(storeDir, 'steps', safeId(sessionId), st.turnId, 'meta.json')))
      writeStepMeta(storeDir, sessionId, st.turnId, typeof st.prompt === 'string' && st.prompt ? st.prompt : NO_PROMPT);
    return st.turnId;
  }
  return beginStep(storeDir, sessionId, NO_PROMPT);
}

/** Records the file's content before this step first touched it (first writer wins). */
export function recordStepFile(
  storeDir: string,
  sessionId: string,
  abs: string,
  before: { existed: boolean; content: string },
  now = Date.now()
): void {
  const turnId = currentStep(storeDir, sessionId);
  const file = path.join(storeDir, 'steps', safeId(sessionId), turnId, 'files', fileNameFor(abs) + '.json');
  writeJsonExclusive(file, { path: abs, existed: before.existed, content: before.content, ts: now } satisfies StepFile);
}

/** Paths of the files a session's steps recorded in this store (cheap: only that session's folder is read). */
export function sessionStepPaths(storeDir: string, sessionId: string): string[] {
  const root = path.join(storeDir, 'steps', safeId(sessionId));
  const out = new Set<string>();
  try {
    for (const t of fs.readdirSync(root)) {
      if (!t.startsWith('t')) continue;
      let files: string[] = [];
      try {
        files = fs.readdirSync(path.join(root, t, 'files'));
      } catch {
        continue;
      }
      for (const f of files) {
        const sf = readJson<StepFile>(path.join(root, t, 'files', f));
        if (sf && typeof sf.path === 'string') out.add(sf.path);
      }
    }
  } catch {
    /* no steps */
  }
  return [...out];
}

/**
 * The steps in a store, newest first. A prompt that changed no file leaves an empty step; it is left out unless
 * `withEmpty` (the window needs it to know which chat got the latest prompt: a new chat starts an empty list).
 */
export function loadSteps(storeDir: string, withEmpty = false): Step[] {
  const root = path.join(storeDir, 'steps');
  const out: Step[] = [];
  let sessions: string[] = [];
  try {
    sessions = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const s of sessions) {
    let turns: string[] = [];
    try {
      turns = fs.readdirSync(path.join(root, s)).filter((t) => t.startsWith('t'));
    } catch {
      continue;
    }
    for (const t of turns) {
      const dir = path.join(root, s, t);
      const meta = readJson<StepMeta>(path.join(dir, 'meta.json'));
      if (!meta) continue;
      const files: StepFile[] = [];
      try {
        for (const f of fs.readdirSync(path.join(dir, 'files'))) {
          const sf = readJson<StepFile>(path.join(dir, 'files', f));
          if (sf && typeof sf.path === 'string') files.push(sf);
        }
      } catch {
        /* no files */
      }
      if (files.length || withEmpty) out.push({ ...meta, dir, storeDir, files });
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

export function removeStep(step: Step): void {
  rm(step.dir);
}

/** Drops steps older than `maxAgeMs` (housekeeping). */
export function pruneSteps(storeDir: string, maxAgeMs: number, now = Date.now()): void {
  for (const s of loadSteps(storeDir)) if (now - s.ts > maxAgeMs) removeStep(s);
  // A chat's folder with only its state file left (every prompt writes one, also in the global store for chats
  // that never touch a file outside their project): without this they would pile up for good.
  const root = path.join(storeDir, 'steps');
  let sessions: string[] = [];
  try {
    sessions = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const s of sessions) {
    try {
      const dir = path.join(root, s);
      if (fs.readdirSync(dir).some((t) => t.startsWith('t'))) continue;
      if (now - fs.statSync(dir).mtimeMs > maxAgeMs) rm(dir);
    } catch {
      /* not a folder, or gone meanwhile */
    }
  }
}

// ---------- feedback ----------

export function queueFeedback(storeDir: string, fb: Omit<Feedback, 'id'>): Feedback {
  ensureStore(storeDir);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const full = { ...fb, id };
  writeJsonAtomic(path.join(storeDir, 'feedback', id + '.json'), full);
  return full;
}

/** Takes (reads and deletes) the feedback meant for this session (or for any session). */
export function takeFeedback(storeDir: string, sessionId?: string): Feedback[] {
  const dir = path.join(storeDir, 'feedback');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Feedback[] = [];
  for (const n of names.sort()) {
    const p = path.join(dir, n);
    const fb = readJson<Feedback>(p);
    if (!fb) continue;
    if (fb.sessionId && sessionId && fb.sessionId !== sessionId) continue;
    try {
      fs.unlinkSync(p); // whoever unlinks first delivers it
    } catch {
      continue;
    }
    out.push(fb);
  }
  return out;
}

export function pendingFeedback(storeDir: string): Feedback[] {
  const dir = path.join(storeDir, 'feedback');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson<Feedback>(path.join(dir, f)))
      .filter((f): f is Feedback => !!f);
  } catch {
    return [];
  }
}

export function formatFeedback(items: Feedback[]): string {
  const lines = [
    'The user reviewed your recent file edits in their editor and REJECTED some of them, with feedback. ' +
      'The rejected changes have already been reverted on disk — re-read the files before editing them again.',
  ];
  for (const f of items) {
    lines.push('', `File: ${f.path}`, `Feedback: ${f.text}`);
    if (f.excerpt) lines.push('Rejected change:', '```', f.excerpt, '```');
  }
  return lines.join('\n');
}
