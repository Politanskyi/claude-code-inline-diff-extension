// claude-inline-diff hook — Claude Code hook script.
//
// Installed by the "Claude Inline Diff: Install Claude Code Hooks" command as
// ~/.claude/hooks/claude-inline-diff-hook.js and wired for:
//   PreToolUse  (Edit|MultiEdit|Write|NotebookEdit|Bash) — snapshot files before Claude changes them
//   PostToolUse (same)   — mark the write as landed, detect Bash edits, deliver feedback
//   UserPromptSubmit     — start a new "step" and deliver pending reject feedback
//   Stop                 — Claude's turn ended (the review list offers Undo All / Keep All again)
// It never blocks a tool call: every error is swallowed and it always exits 0.
// No network access, no telemetry.
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as S from '../core/store';
import { splitLines } from '../core/diff';
import { recordClaudeEdit } from '../core/regions';

export const HOOK_VERSION = '1.0.4';
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const BASH_MAX_FILES = 300;
const BASH_MAX_TOTAL = 16 * 1024 * 1024;

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
  if (event === 'UserPromptSubmit') {
    const store = projectStore();
    S.markTurn(store, session, ctx.now());
    S.beginStep(store, session, typeof data.prompt === 'string' ? data.prompt : '', ctx.now());
    housekeeping(store, ctx.now(), ctx.env);
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
  if (!abs) return '';
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

interface DirtySnapshot {
  root: string;
  sessionId?: string;
  ts: number;
  files: Record<string, { existed: boolean; content: string | null }>;
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
export function dirtyFiles(root: string): string[] | null {
  const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  if (out === null) return null;
  const files: string[] = [];
  for (const rec of out.split('\0')) {
    if (rec.length < 4) continue;
    const p = rec.slice(3);
    if (p.split('/')[0] === '.claude-review' || p.includes('/.claude-review/')) continue;
    files.push(p);
  }
  return files;
}

const bashSnapPath = (store: string, data: HookInput) => path.join(store, 'bash', S.safeId(data.tool_use_id || data.session_id) + '.json');

function bashBefore(data: HookInput, root: string, cfg: S.SharedConfig, ctx: HookContext): void {
  const files = dirtyFiles(root);
  if (!files) return;
  const snap: DirtySnapshot = { root, sessionId: data.session_id, ts: ctx.now(), files: {} };
  let total = 0;
  for (const rel of files.slice(0, BASH_MAX_FILES)) {
    const r = S.readTextForBaseline(path.join(root, rel));
    if (r && total + r.content.length <= BASH_MAX_TOTAL) {
      total += r.content.length;
      snap.files[rel] = r;
    } else snap.files[rel] = { existed: true, content: null }; // too big/binary: can't review it
  }
  const store = S.storeDirFor(path.join(root, 'x'), root, cfg, ctx.env);
  S.ensureStore(store);
  S.writeJsonAtomic(bashSnapPath(store, data), snap);
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
  if (!fs.existsSync(snapFile)) snapFile = latestSnapshotOfSession(store, data.session_id) || snapFile; // ids should match; be lenient
  const snap = S.readJson<DirtySnapshot>(snapFile);
  try {
    fs.unlinkSync(snapFile);
  } catch {
    /* none */
  }
  if (!snap) return;
  const now = dirtyFiles(snap.root);
  if (!now) return;
  const candidates = new Set([...now, ...Object.keys(snap.files)]);
  for (const rel of candidates) {
    const abs = S.realPath(path.join(snap.root, rel));
    const fileStore = S.storeDirFor(abs, root, cfg, ctx.env);
    if (S.hasBaseline(fileStore, abs)) continue; // already under review: the old baseline stays the "before"
    // Saved in the editor while the command ran (the user's edit, or Undo/Keep): not Claude's change.
    if (S.isEditorWrite(abs, snap.ts, ctx.env)) continue;
    let before: { existed: boolean; content: string } | null;
    const pre = snap.files[rel];
    if (pre) {
      if (pre.content === null) continue;
      before = { existed: pre.existed, content: pre.content };
    } else {
      // Clean before the command: the index holds the old content (or the file did not exist).
      const shown = git(snap.root, ['show', ':' + rel.replace(/\\/g, '/')]);
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

/** Drops step snapshots older than a week and Bash snapshots of commands that never reported back. */
export function housekeeping(store: string, now: number, env: NodeJS.ProcessEnv = process.env): void {
  try {
    S.pruneSteps(store, 7 * 24 * 3600_000, now);
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

// `${HOOK_MARKER} v1.0.0` must appear in the bundle so setup can recognise the installed script.
export const HOOK_BANNER = `${S.HOOK_MARKER} v${HOOK_VERSION}`;
if (require.main === module) main();
