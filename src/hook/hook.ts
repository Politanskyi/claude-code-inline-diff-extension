// claude-inline-diff hook — Claude Code hook script.
//
// Installed by the "Claude Inline Diff: Install Claude Code Hook" command as
// ~/.claude/hooks/claude-inline-diff-hook.js and wired for:
//   PreToolUse  (Edit|MultiEdit|Write|NotebookEdit|Bash) — snapshot files before Claude changes them
//   PostToolUse (same)   — mark the write as landed, detect Bash edits, deliver feedback
//   UserPromptSubmit     — start a new "step" and deliver pending reject feedback
//   Stop                 — Claude's turn ended (the review list offers Undo All / Keep All again)
// It never blocks a tool call: every error is swallowed and it always exits 0.
// No network access, no telemetry.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as S from '../core/store';
import { splitLines } from '../core/diff';
import { recordClaudeEdit } from '../core/regions';
import { commandDirs } from '../core/bashDirs';

export const HOOK_VERSION = '1.0.18';
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const BASH_MAX_FILES = 300;
const BASH_MAX_TOTAL = 16 * 1024 * 1024;
const BASH_MAX_OTHER_REPOS = 3;

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: any;
  tool_use_id?: string;
  prompt?: string;
  cursor_version?: string;
  [k: string]: unknown;
}

export interface HookContext {
  env: NodeJS.ProcessEnv;
  now: () => number;
}

const defaultCtx: HookContext = { env: process.env, now: () => Date.now() };

function projectRoot(data: HookInput, ctx: HookContext): string {
  // Real path, like the file paths: symlinked projects, macOS /tmp → /private/tmp and Windows 8.3 names
  // (C:\Users\RUNNER~1) must not make a project file look "outside the project".
  return S.realPath(S.projectRootFor(ctx.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd()));
}

function targetFile(data: HookInput): string | null {
  const input = data.tool_input || {};
  const p = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof p !== 'string' || !p) return null;
  return S.realPath(path.resolve(data.cwd || process.cwd(), p));
}

/** Runs the hook for one payload; returns what to print on stdout (or ''). */
export function handle(data: HookInput, ctx: HookContext = defaultCtx): string {
  // Cursor's own agent can run Claude-format hooks; its payload carries cursor_version. Not ours to review.
  if (!data || typeof data !== 'object' || data.cursor_version || data.conversation_id) return '';
  const cfg = S.readConfig(ctx.env);
  const root = projectRoot(data, ctx);
  const event = data.hook_event_name;
  const session = data.session_id || 'unknown';

  const projectStore = () => S.storeDirFor(path.join(root, 'x'), root, cfg, ctx.env);
  if (event === 'Stop') {
    S.endTurn(projectStore(), session);
    return '';
  }
  if (event === 'SessionStart') {
    // An earlier chat was opened from the history (or restored after a reload): it is the one on screen. A
    // `startup` may be a new chat or one of the official extension's throwaway sessions ("Loading config cache"):
    // noted with Claude's process id, and the window takes it for a chat only if that process stays.
    // Nothing is printed (it would become context).
    if (data.source !== 'startup') S.showChat(projectStore(), session, ctx.now());
    else S.noteNewChat(projectStore(), session, Number(ctx.env.CLAUDE_PID) || process.ppid, ctx.now());
    return '';
  }
  if (event === 'UserPromptSubmit') {
    const store = projectStore();
    S.showChat(store, session, ctx.now());
    S.markTurn(store, session, ctx.now());
    const prompt = typeof data.prompt === 'string' ? data.prompt : '';
    const turnId = S.beginStep(store, session, prompt, ctx.now());
    // Files outside the project (global store) belong to the same step.
    const global = S.globalStoreDir(ctx.env);
    if (path.resolve(global) !== path.resolve(store)) S.shareStep(global, session, turnId, prompt);
    housekeeping(store, ctx.now(), cfg, ctx.env);
    return feedbackOutput('UserPromptSubmit', data, root, cfg, ctx);
  }

  if (event === 'PreToolUse' || event === 'PostToolUse') S.markTurn(projectStore(), session, ctx.now());
  if (data.tool_name === 'Bash') {
    if (!cfg.trackBash) return '';
    if (event === 'PreToolUse') bashBefore(data, root, cfg, ctx);
    else if (event === 'PostToolUse') {
      bashAfter(data, root, cfg, ctx);
      return feedbackOutput('PostToolUse', data, root, cfg, ctx);
    }
    return '';
  }

  if (!data.tool_name || !EDIT_TOOLS.has(data.tool_name)) return '';
  const abs = targetFile(data);
  if (!abs || S.isClaudeInternal(abs, root, ctx.env)) return '';
  const store = S.storeDirFor(abs, root, cfg, ctx.env);

  if (event === 'PreToolUse') {
    const before = S.readTextForBaseline(abs);
    if (!before) return ''; // binary / too large / unreadable
    S.startActivity(store, { path: abs, tool: data.tool_name, sessionId: data.session_id, ts: ctx.now() });
    S.saveBefore(store, abs, before.content);
    S.recordStepFile(store, session, abs, before, ctx.now());
    if (!S.hasBaseline(store, abs)) {
      S.createBaseline(store, {
        version: 3,
        path: abs,
        existed: before.existed,
        content: before.content,
        createdAt: ctx.now(),
        sessionId: data.session_id,
        tool: data.tool_name,
        source: 'edit',
      });
    }
    return '';
  }
  if (event === 'PostToolUse') {
    S.endActivity(store, abs);
    recordRegions(store, abs);
    S.markLanded(store, abs);
    return feedbackOutput('PostToolUse', data, root, cfg, ctx);
  }
  return '';
}

/** Remembers which lines this tool call changed, so the review groups changes per edit, like Cursor. */
function recordRegions(store: string, abs: string): void {
  const before = S.takeBefore(store, abs);
  const after = S.readTextForBaseline(abs);
  if (before === null || !after) return;
  try {
    S.updateRegions(store, abs, (r) => recordClaudeEdit(r, splitLines(before), after.existed ? splitLines(after.content) : []));
  } catch {
    /* best effort */
  }
}

// ---------- Bash: compare git's view of dirty files before and after ----------

interface RepoSnapshot {
  root: string;
  files: Record<string, { existed: boolean; content: string | null }>;
}
interface DirtySnapshot extends RepoSnapshot {
  sessionId?: string;
  ts: number;
  /** Other repositories the command may change (see otherRepos). */
  more?: RepoSnapshot[];
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/** Relative paths git reports as changed (modified, added, deleted, untracked), or null outside a repo. */
export function dirtyFiles(root: string, storeDirName = S.STORE_DIR_NAME_DEFAULT): string[] | null {
  const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  if (out === null) return null;
  const files: string[] = [];
  for (const rec of out.split('\0')) {
    if (rec.length < 4) continue;
    const p = rec.slice(3);
    if (p.split('/')[0] === storeDirName || p.includes('/' + storeDirName + '/')) continue;
    files.push(p);
  }
  return files;
}

const bashSnapPath = (store: string, data: HookInput) => path.join(store, 'bash', S.safeId(data.tool_use_id || data.session_id) + '.json');

/** The git repository a folder belongs to, or null. */
function repoOf(dir: string): string | null {
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const top = S.projectRootFor(dir);
  return fs.existsSync(path.join(top, '.git')) ? S.realPath(top) : null;
}

/**
 * Repositories besides the chat's project that a Bash command may change: the folder the command names
 * (`cd <dir> && …`, `git -C <dir>`), the shell's current folder, and repositories where this chat already
 * changed files. A command that edits some other place without naming it is not seen.
 */
export function otherRepos(data: HookInput, root: string, ctx: HookContext): string[] {
  const cwd = data.cwd || process.cwd();
  const home = ctx.env.HOME || ctx.env.USERPROFILE || os.homedir();
  const command = typeof data.tool_input?.command === 'string' ? data.tool_input.command : '';
  const dirs = [...commandDirs(command, cwd, home), cwd];
  for (const p of S.sessionStepPaths(S.globalStoreDir(ctx.env), data.session_id || 'unknown')) dirs.push(path.dirname(p));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    if (out.length >= BASH_MAX_OTHER_REPOS) break;
    if (seen.has(d)) continue;
    seen.add(d);
    const r = repoOf(d);
    if (r && S.keyOf(r) !== S.keyOf(root) && !out.some((o) => S.keyOf(o) === S.keyOf(r))) out.push(r);
  }
  return out;
}

function snapRepo(root: string, cfg: S.SharedConfig, createdByClaude: (abs: string) => boolean): RepoSnapshot | null {
  const files = dirtyFiles(root, cfg.dirName);
  if (!files) return null;
  const snap: RepoSnapshot = { root, files: {} };
  let total = 0;
  for (const rel of files.slice(0, BASH_MAX_FILES)) {
    // A file Claude created that still waits for review did not exist "before Claude": if the command deletes
    // it (and the window drops its review meanwhile), that is no deletion to review; nothing is left of it.
    if (createdByClaude(S.realPath(path.join(root, rel)))) {
      snap.files[rel] = { existed: false, content: '' };
      continue;
    }
    const r = S.readTextForBaseline(path.join(root, rel));
    if (r && total + r.content.length <= BASH_MAX_TOTAL) {
      total += r.content.length;
      snap.files[rel] = r;
    } else snap.files[rel] = { existed: true, content: null }; // too big/binary: can't review it
  }
  return snap;
}

function bashBefore(data: HookInput, root: string, cfg: S.SharedConfig, ctx: HookContext): void {
  const others = otherRepos(data, root, ctx);
  const createdByClaude = (abs: string) =>
    S.readJson<{ existed?: boolean }>(S.baselinePath(S.storeDirFor(abs, root, cfg, ctx.env), abs))?.existed === false;
  const own = snapRepo(root, cfg, createdByClaude);
  if (!own && !others.length) return;
  const snap: DirtySnapshot = { ...(own ?? { root, files: {} }), sessionId: data.session_id, ts: ctx.now() };
  const store = S.storeDirFor(path.join(root, 'x'), root, cfg, ctx.env);
  S.ensureStore(store);
  const file = bashSnapPath(store, data);
  // The project's snapshot is on disk before the other repositories are looked at: a slow one must not cost it.
  if (own) S.writeJsonAtomic(file, snap);
  if (!others.length) return;
  snap.more = others.map((r) => snapRepo(r, cfg, createdByClaude)).filter((r): r is RepoSnapshot => !!r);
  if (own || snap.more.length) S.writeJsonAtomic(file, snap);
}

function latestSnapshotOfSession(store: string, sessionId: string | undefined): string | null {
  const dir = path.join(store, 'bash');
  let best: { p: string; ts: number } | null = null;
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const p = path.join(dir, f);
    const snap = S.readJson<DirtySnapshot>(p);
    if (snap && snap.sessionId === sessionId && (!best || snap.ts > best.ts)) best = { p, ts: snap.ts };
  }
  return best ? best.p : null;
}

function bashAfter(data: HookInput, root: string, cfg: S.SharedConfig, ctx: HookContext): void {
  const store = S.storeDirFor(path.join(root, 'x'), root, cfg, ctx.env);
  let snapFile = bashSnapPath(store, data);
  // Without a tool_use_id (old payloads) the Pre/Post pair is matched by the session's newest snapshot. With an id, a
  // missing snapshot means none was taken (Bash tracking was off, or the Pre hook failed): comparing with another
  // command's old snapshot would credit Claude with everything changed since then.
  if (!fs.existsSync(snapFile) && !data.tool_use_id) snapFile = latestSnapshotOfSession(store, data.session_id) || snapFile;
  const snap = S.readJson<DirtySnapshot>(snapFile);
  try {
    fs.unlinkSync(snapFile);
  } catch {
    /* none */
  }
  if (!snap) return;
  bashRepoAfter(snap, snap, false, data, root, cfg, ctx);
  for (const repo of snap.more ?? []) bashRepoAfter(repo, snap, true, data, root, cfg, ctx);
}

/** A file of another repository that the chat of that repository (its own project store) already has under review. */
function reviewedInItsProject(abs: string, repoRoot: string, cfg: S.SharedConfig, env: NodeJS.ProcessEnv): boolean {
  return [S.homeProjectStoreDir(repoRoot, env), path.join(repoRoot, cfg.dirName)].some((d) => S.hasBaseline(d, abs));
}

function bashRepoAfter(
  repo: RepoSnapshot,
  snap: DirtySnapshot,
  other: boolean,
  data: HookInput,
  root: string,
  cfg: S.SharedConfig,
  ctx: HookContext
): void {
  const now = dirtyFiles(repo.root, cfg.dirName);
  if (!now) return;
  const candidates = new Set([...now, ...Object.keys(repo.files)]);
  for (const rel of candidates) {
    const abs = S.realPath(path.join(repo.root, rel));
    if (S.isClaudeInternal(abs, root, ctx.env)) continue;
    const fileStore = S.storeDirFor(abs, root, cfg, ctx.env);
    if (S.hasBaseline(fileStore, abs)) continue; // already under review: the old baseline stays the "before"
    if (other && reviewedInItsProject(abs, repo.root, cfg, ctx.env)) continue;
    // Saved in the editor while the command ran (the user's edit, or Undo/Keep): not Claude's change.
    if (S.isEditorWrite(abs, snap.ts, ctx.env)) continue;
    let before: { existed: boolean; content: string } | null;
    const pre = repo.files[rel];
    if (pre) {
      if (pre.content === null) continue;
      before = { existed: pre.existed, content: pre.content };
    } else {
      // Clean before the command: the index holds the old content (or the file did not exist).
      const shown = git(repo.root, ['show', ':' + rel.replace(/\\/g, '/')]);
      before = shown === null ? { existed: false, content: '' } : { existed: true, content: shown.replace(/^\uFEFF/, '') };
      if (before.content.includes('\0')) continue;
    }
    const after = S.readTextForBaseline(abs);
    if (!after) continue;
    if (after.existed === before.existed && after.content === before.content) continue;
    S.recordStepFile(fileStore, data.session_id || 'unknown', abs, before, ctx.now());
    S.createBaseline(fileStore, {
      version: 3,
      path: abs,
      existed: before.existed,
      content: before.content,
      createdAt: ctx.now(),
      sessionId: data.session_id,
      tool: 'Bash',
      source: 'bash',
    });
    S.markLanded(fileStore, abs);
  }
}

// ---------- feedback back to Claude ----------

function feedbackOutput(
  event: 'UserPromptSubmit' | 'PostToolUse',
  data: HookInput,
  root: string,
  cfg: S.SharedConfig,
  ctx: HookContext
): string {
  const stores = new Set([S.storeDirFor(path.join(root, 'x'), root, cfg, ctx.env), S.globalStoreDir(ctx.env)]);
  // A subagent's tool calls carry the parent's session_id plus agent_id: the reason is for the main agent.
  if (event === 'PostToolUse' && data.agent_id) return '';
  const items: S.Feedback[] = [];
  for (const s of stores) items.push(...S.takeFeedback(s, data.session_id));
  if (!items.length) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: S.formatFeedback(items) } });
}

/**
 * Drops step snapshots older than `stepRetentionDays` and Bash snapshots of commands that never reported
 * back. In the global store (files outside any project) unreviewed baselines expire after the same time,
 * and Claude Code's own working files (from hooks before 1.0.7) go at once.
 */
export function housekeeping(store: string, now: number, cfg: S.SharedConfig, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const retention = cfg.stepRetentionDays * 24 * 3600_000;
    const global = S.globalStoreDir(env);
    S.pruneSteps(store, retention, now);
    if (path.resolve(store) !== path.resolve(global)) S.pruneSteps(global, retention, now);
    S.pruneEntries(global, retention, now, (e) => S.isClaudeInternal(e.path, undefined, env));
    S.pruneEditorWrites(24 * 3600_000, now, env);
    const dir = path.join(store, 'bash');
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const p = path.join(dir, f);
      if (now - fs.statSync(p).mtimeMs > 3600_000) fs.rmSync(p, { force: true });
    }
  } catch {
    /* best effort */
  }
}

function main(): void {
  // Hard timeout: whatever happens, never hold Claude up for more than a few seconds.
  setTimeout(() => process.exit(0), 8000).unref();
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    let out = '';
    try {
      out = handle(JSON.parse(input));
    } catch {
      /* never block Claude because of the review tool */
    }
    if (out) process.stdout.write(out);
    process.exitCode = 0;
  });
  process.stdin.on('error', () => process.exit(0));
}

if (require.main === module) main();
