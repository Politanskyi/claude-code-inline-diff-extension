// On-disk review state, shared by the Claude Code hook (dist/hook.js) and the
// extension so the two can never disagree on paths or formats.
//
// Layout of a store directory (project-local `<root>/.claude-review/` by
// default, or `~/.claude/inline-diff/store/`):
//   .gitignore                 "*"  — the store ignores itself; your .gitignore is never edited
//   baselines/<name>.json      the file as it was before Claude's first pending edit
//   baselines/<name>.landed    touched by PostToolUse: Claude's write has happened
//   activity/<name>.json       a tool call on that file is in flight (Pre seen, Post not yet)
//   steps/<session>/<turn>/meta.json         one Claude step (= one user prompt)
//   steps/<session>/<turn>/files/<name>.json the file before that step first touched it
//   bash/<id>.json             dirty-file snapshot taken before a Bash tool call
//   feedback/<id>.json         "reject with feedback" notes waiting for Claude
//   editor-writes/<name>.json  (global store only) last save made in the editor, so Bash tracking skips it
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export const STORE_DIR_NAME_DEFAULT = '.claude-review';
export const HOOK_FILE = 'claude-inline-diff-hook.js';
export const HOOK_MARKER = 'claude-inline-diff hook';

export type StorageMode = 'project' | 'home';
export interface SharedConfig {
  storage: StorageMode;
  dirName: string;
  trackBash: boolean;
}
export const DEFAULT_CONFIG: SharedConfig = { storage: 'project', dirName: STORE_DIR_NAME_DEFAULT, trackBash: true };

export interface BaselineFile {
  version: 3;
  path: string;
  existed: boolean;
  content: string;
  createdAt: number;
  sessionId?: string;
  tool?: string;
  source?: 'edit' | 'bash';
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
export function globalStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(globalDir(env), 'store');
}
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(globalDir(env), 'config.json');
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): SharedConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(env), 'utf8'));
    return {
      storage: raw.storage === 'home' ? 'home' : 'project',
      dirName: typeof raw.dirName === 'string' && /^[\w.-]+$/.test(raw.dirName) ? raw.dirName : STORE_DIR_NAME_DEFAULT,
      trackBash: raw.trackBash !== false,
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

/** The store a file's review lives in. */
export function storeDirFor(
  absFile: string,
  projectRoot: string | undefined,
  cfg: SharedConfig,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (cfg.storage === 'project' && projectRoot && isInside(absFile, projectRoot)) return path.join(projectRoot, cfg.dirName);
  return globalStoreDir(env);
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

// ---------- activity ----------

const activityPath = (storeDir: string, abs: string) => path.join(storeDir, 'activity', fileNameFor(abs) + '.json');

export function startActivity(storeDir: string, a: Activity): void {
  ensureStore(storeDir);
  writeJsonAtomic(activityPath(storeDir, a.path), a);
}
export function endActivity(storeDir: string, abs: string): void {
  rm(activityPath(storeDir, abs));
}
export function loadActivity(storeDir: string, maxAgeMs = 120_000, now = Date.now()): Activity[] {
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

/** UserPromptSubmit: open a new step for the session. */
export function beginStep(storeDir: string, sessionId: string, prompt: string, now = Date.now()): string {
  ensureStore(storeDir);
  const turnId = 't' + now.toString().padStart(14, '0');
  const dir = path.join(storeDir, 'steps', safeId(sessionId), turnId);
  writeJsonAtomic(path.join(dir, 'meta.json'), { sessionId, turnId, ts: now, prompt: prompt.slice(0, 300) } satisfies StepMeta);
  writeJsonAtomic(statePath(storeDir, sessionId), { turnId });
  return turnId;
}

export function currentStep(storeDir: string, sessionId: string): string {
  const st = readJson<{ turnId: string }>(statePath(storeDir, sessionId));
  if (st && typeof st.turnId === 'string' && fs.existsSync(path.join(storeDir, 'steps', safeId(sessionId), st.turnId))) return st.turnId;
  return beginStep(storeDir, sessionId, '(prompt not recorded)');
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

export function loadSteps(storeDir: string): Step[] {
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
      if (files.length) out.push({ ...meta, dir, storeDir, files });
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
