// Claude Inline Diff — activation and commands.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as S from './core/store';
import * as setup from './core/setup';
import * as M from './core/model';
import { Hunk } from './core/diff';
import { addProposedApi, argvPathFor, hasProposedApi, removeProposedApi } from './core/argv';
import { findConflicts, addUserKeybindings, removeUserKeybindings, keyFor, Conflict } from './core/keybindings';
import { chatContainer, chatSection, visibleChat, ChatLogReader, NEW_CHAT, CLAUDE_CHAT_VIEW } from './core/layout';
import { ReviewManager, HunkRef, cfg } from './review';
import { Renderer } from './render';
import { InsetManager, insetApi } from './insets';
import { StatusBar, Badges, Lenses, ChangesPanel, StepsTree } from './views';
import { Updater } from './update';

export const EXTENSION_ID = 'inlinediff.claude-inline-diff';
const BASE_SCHEME = 'claude-inline-diff-base';

let review: ReviewManager;
let renderer: Renderer;
let changesPanel: ChangesPanel | undefined;
let log: vscode.LogOutputChannel;
let ctx: vscode.ExtensionContext;
let updater: Updater | undefined;
const contextCache = new Map<string, unknown>();

/** Exposed for the e2e tests. */
export interface Api {
  review: ReviewManager;
  renderer: Renderer;
  insetsAvailable: () => boolean;
}

function setContext(name: string, value: unknown): void {
  const prev = contextCache.get(name);
  if (JSON.stringify(prev) === JSON.stringify(value)) return;
  contextCache.set(name, value);
  void vscode.commands.executeCommand('setContext', name, value);
}

export function activate(context: vscode.ExtensionContext): Api {
  ctx = context;
  log = vscode.window.createOutputChannel('Claude Inline Diff', { log: true });
  if (process.env.CLAUDE_INLINE_DIFF_TRACE) log.info('trace enabled');
  review = new ReviewManager(log);
  const insets = new InsetManager(
    {
      accept: (ref) => void runHunk('accept', ref),
      reject: (ref) => void runHunk('reject', ref),
      navigate: (ref, dir) => {
        const hunks = review.hunks(ref.key);
        if (!hunks.length) return;
        const cur = review.resolveHunk(ref);
        const i = cur ? hunks.indexOf(cur) : 0;
        void openAt(ref.key, hunks[(i + dir + hunks.length) % hunks.length], { center: true });
      },
    },
    log
  );
  renderer = new Renderer(review, insets, log);
  changesPanel = new ChangesPanel(review);
  context.subscriptions.push(
    log,
    review,
    renderer,
    insets,
    changesPanel,
    new StatusBar(review, changesPanel),
    new Badges(review),
    new Lenses(review, () => renderer.useToolbars()),
    new StepsTree(review),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, {
      provideTextDocumentContent: (uri) => {
        const q = new URLSearchParams(uri.query);
        if (q.has('h')) return review.sessionBefore(q.get('h') || ''); // the current chat's "before"
        if (q.has('gone')) return ''; // a file the chat deleted
        return review.entries.get(q.get('k') || '')?.content ?? '';
      },
    }),
    review.onDidChange(updateContexts),
    review.onNewFile((e) => void revealOnEdit(e)),
    review.onNewFile(() => void maybeOfferInsets()),
    // Set Up or Uninstall in another window: this one notices when it gets focus.
    vscode.window.onDidChangeWindowState((w) => w.focused && updateHookContext()),
    review.onDidChange(() => followClaude()),
    vscode.window.onDidChangeActiveTextEditor(updateContexts),
    vscode.window.onDidChangeTextEditorSelection(updateContexts)
  );
  registerCommands(context);
  // Diagnostics without a command palette: create <store>/debug and the state is written to <store>/debug-out.json.
  const debugTimer = setInterval(() => {
    for (const dir of review.storeDirs()) {
      const req = path.join(dir, 'debug');
      if (!fs.existsSync(req)) continue;
      try {
        fs.rmSync(req, { force: true });
        renderer.renderAll();
        const state = { at: new Date().toISOString(), app: vscode.env.appName, version: vscode.version, renderer: renderer.debugState() };
        fs.writeFileSync(path.join(dir, 'debug-out.json'), JSON.stringify(state, null, 2));
      } catch (e: any) {
        log.error('debug dump failed: ' + (e?.stack || e));
      }
    }
  }, 1000);
  context.subscriptions.push({ dispose: () => clearInterval(debugTimer) });
  updateContexts();
  // Editors restored at startup were already visible before we activated: no visible-editors event will come.
  renderer.schedule(0);
  log.info(
    `activated; editorInsets ${insetApi() ? 'available' : 'not enabled (decoration fallback)'}; stores: ${review.storeDirs().join(', ')}`
  );
  void firstRunChecks();
  updater = new Updater(context, log);
  context.subscriptions.push(updater);
  if (!process.env.CLAUDE_INLINE_DIFF_TEST) updater.start();
  try {
    for (const s of review.storeDirs()) S.pruneSteps(s, cfg('stepRetentionDays', 7) * 86400_000);
  } catch {
    /* best effort */
  }
  return { review, renderer, insetsAvailable: () => renderer.useInsets() };
}

export function deactivate(): void {
  /* disposables handle cleanup */
}

// ---------- context keys ----------

function activeKey(): string | undefined {
  const ed = vscode.window.activeTextEditor;
  return ed && ed.document.uri.scheme === 'file' ? S.keyOf(ed.document.uri.fsPath) : undefined;
}

function updateContexts(): void {
  const pending = review.pendingKeys();
  setContext('claudeInlineDiff.hasChanges', pending.length > 0);
  setContext(
    'claudeInlineDiff.files',
    pending.map((k) => review.entries.get(k)!.path)
  );
  const key = activeKey();
  const hunks = key ? review.hunks(key) : [];
  setContext('claudeInlineDiff.activeFileHasChanges', hunks.length > 0);
  // The file bar shows only in the active editor, like Cursor's.
  setContext('claudeInlineDiff.activeFiles', key && hunks.length ? [review.entries.get(key)!.path] : []);
  const ed = vscode.window.activeTextEditor;
  setContext('claudeInlineDiff.cursorInHunk', !!ed && hunks.length > 0 && !!M.hunkAtLine(hunks, ed.selection.active.line));
  // (Key name kept from when only Keep could be reverted: users' keybindings.json may refer to it.)
  setContext('claudeInlineDiff.canUndoAccept', !!key && review.canRevertLastAction(key));
}

// ---------- helpers ----------

function keyFromArg(arg: unknown): string | undefined {
  if (arg instanceof vscode.Uri) return S.keyOf(arg.fsPath);
  if (typeof arg === 'string') return arg;
  return activeKey();
}

function refFromArg(arg: unknown): HunkRef | undefined {
  if (arg && typeof arg === 'object' && 'key' in (arg as any) && 'bStart' in (arg as any)) return arg as HunkRef;
  const ed = vscode.window.activeTextEditor;
  const key = activeKey();
  if (!ed || !key) return undefined;
  const h = M.hunkAtLine(review.hunks(key), ed.selection.active.line);
  return h ? { key, aStart: h.aStart, bStart: h.bStart } : undefined;
}

function editorFor(key: string): vscode.TextEditor | undefined {
  return vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file' && S.keyOf(e.document.uri.fsPath) === key);
}

async function openAt(
  key: string,
  h: Hunk | undefined,
  opts: { preserveFocus?: boolean; preview?: boolean; center?: boolean } = {}
): Promise<vscode.TextEditor | undefined> {
  const e = review.entries.get(key);
  if (!e) return undefined;
  if (!fs.existsSync(e.path)) return undefined;
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(e.path), {
    preserveFocus: opts.preserveFocus,
    preview: opts.preview ?? false,
  });
  if (h) {
    const line = Math.min(M.hunkAnchorLine(h), ed.document.lineCount - 1);
    const pos = new vscode.Position(line, 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(
      new vscode.Range(pos, pos),
      opts.center ? vscode.TextEditorRevealType.InCenter : vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );
  }
  updateContexts();
  return ed;
}

/**
 * After resolving a change at `line` of `key`. `cursor` (default, like Cursor's jumpOnDiffAccept):
 * only Keep of a single change moves on, to the next change in the same file, never to another file.
 * `hunkThenFile` / `hunk`: every action moves on (then to the next file / within the file).
 */
async function advance(key: string, line: number, action: 'accept' | 'reject' | 'file'): Promise<void> {
  const mode = cfg<string>('autoAdvance', 'cursor');
  if (mode === 'off') return;
  const hunks = review.hunks(key);
  if (mode === 'cursor') {
    if (action !== 'accept') return;
    const h = M.hunkAfterResolve(hunks, line) || hunks[0];
    if (h) await openAt(key, h, { center: true });
    else if (!review.pendingKeys().length) vscode.window.setStatusBarMessage('$(check-all) All Claude changes reviewed', 4000);
    return;
  }
  const h = M.hunkAfterResolve(hunks, line) || (hunks.length ? hunks[0] : undefined);
  if (h) {
    await openAt(key, h);
    return;
  }
  if (mode !== 'hunkThenFile') return;
  const keys = review.pendingKeys();
  if (!keys.length) {
    vscode.window.setStatusBarMessage('$(check-all) All Claude changes reviewed', 4000);
    return;
  }
  const next = keys.find((k) => k.localeCompare(key) > 0) || keys[0];
  await openAt(next, review.hunks(next)[0]);
}

async function runHunk(kind: 'accept' | 'reject', arg: unknown): Promise<void> {
  const ref = refFromArg(arg);
  if (!ref) {
    vscode.window.setStatusBarMessage('No Claude change at the cursor', 2500);
    return;
  }
  const h = review.resolveHunk(ref);
  if (!h) return;
  if (kind === 'reject' && review.rejectDeletesFile(ref.key, false) && !(await confirmTrash(ref.key))) return;
  const line = M.hunkAnchorLine(h);
  const ok = kind === 'accept' ? await review.acceptHunk(ref) : await review.rejectHunk(ref);
  if (!ok) return;
  updateContexts();
  await advance(ref.key, line, kind);
}

/** `vscode.changes` resource: [label uri, original, modified]. */
type DiffResource = [vscode.Uri, vscode.Uri, vscode.Uri];

/** The multi-file diff editor; one plain diff of the active file if the editor has no multi-diff. */
async function openMultiDiff(title: string, resources: DiffResource[]): Promise<void> {
  try {
    await vscode.commands.executeCommand('vscode.changes', title /* the editor appends "(N files)" */, resources);
  } catch {
    await vscode.commands.executeCommand('claudeInlineDiff.showDiff');
  }
}

/** Review with nothing pending: everything the current chat changed, from before the chat to now (like Cursor). */
async function reviewChat(): Promise<void> {
  const files = review.sessionFiles();
  if (!files.length) return;
  const resources = files.map((f): DiffResource => {
    const p = vscode.Uri.file(f.path).path;
    const before = vscode.Uri.from({ scheme: BASE_SCHEME, path: p, query: 'h=' + encodeURIComponent(f.key) });
    const now = fs.existsSync(f.path) ? vscode.Uri.file(f.path) : vscode.Uri.from({ scheme: BASE_SCHEME, path: p, query: 'gone=1' });
    return [now, before, now];
  });
  await openMultiDiff('Claude chat changes', resources);
}

/** The document behind the "before Claude" side of a diff. */
function baseUri(e: S.Entry): vscode.Uri {
  return vscode.Uri.from({ scheme: BASE_SCHEME, path: vscode.Uri.file(e.path).path, query: 'k=' + encodeURIComponent(e.key) });
}

async function confirmTrash(key: string): Promise<boolean> {
  if (!cfg('confirmDeleteCreatedFile', true)) return true;
  const e = review.entries.get(key)!;
  const pick = await vscode.window.showWarningMessage(
    `Claude created ${path.basename(e.path)}. Undoing moves it to the trash.`,
    { modal: true },
    'Move to Trash'
  );
  return pick === 'Move to Trash';
}

async function rejectWithFeedback(arg: unknown): Promise<void> {
  const ref = refFromArg(arg);
  if (!ref) return;
  const h = review.resolveHunk(ref);
  if (!h) return;
  const text = await vscode.window.showInputBox({
    title: 'Undo with feedback for Claude',
    prompt: 'Why? Claude gets this with your next message (or after its next tool call if it is still working).',
    placeHolder: 'e.g. keep the old function signature, callers depend on it',
    ignoreFocusOut: true,
  });
  if (text === undefined) return;
  const excerpt = [...h.aLines.map((l) => '- ' + l), ...h.bLines.map((l) => '+ ' + l)].slice(0, 60).join('\n');
  if (text.trim()) review.queueFeedback(ref.key, text.trim(), excerpt);
  await runHunk('reject', ref);
  if (text.trim()) vscode.window.setStatusBarMessage('$(comment) Feedback queued for Claude', 4000);
}

async function revealOnEdit(e: S.Entry): Promise<void> {
  if (!cfg('revealOnEdit', false)) return;
  const visible = editorFor(e.key);
  const h = review.hunks(e.key)[0];
  if (visible) {
    if (h)
      visible.revealRange(
        new vscode.Range(M.hunkAnchorLine(h), 0, M.hunkAnchorLine(h), 0),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport
      );
    return;
  }
  await openAt(e.key, h, { preserveFocus: true, preview: true });
}

const knownHunks = new Map<string, Set<string>>();
const sig = (h: Hunk) => `${h.aLines.join('\n')}\u0000${h.bLines.join('\n')}`;

/** Like Cursor's agent: when Claude lands a new change in a visible file, scroll to it and flash it. */
function followClaude(): void {
  for (const key of review.entries.keys()) {
    const hunks = review.hunks(key);
    const prev = knownHunks.get(key);
    const now = new Set(hunks.map(sig));
    knownHunks.set(key, now);
    // A file that was not under review yet (Claude's first edit to it) counts too: every change in it is new.
    if (!cfg('followClaude', false) || !review.claudeJustWrote(key)) continue;
    const fresh = hunks.filter((h) => !prev?.has(sig(h)));
    if (!fresh.length) continue;
    const ed = editorFor(key);
    if (!ed) continue;
    const ranges = fresh.filter((h) => h.bLines.length).map((h) => new vscode.Range(h.bStart, 0, h.bStart + h.bLines.length - 1, 0));
    if (ranges.length) renderer.flash(ed, ranges);
    // Don't yank the view while the user is reviewing a change.
    const inHunk = !!M.hunkAtLine(hunks, ed.selection.active.line) && vscode.window.activeTextEditor === ed;
    if (!inHunk) {
      const line = M.hunkAnchorLine(fresh[0]);
      ed.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }
  for (const k of [...knownHunks.keys()]) if (!review.entries.has(k)) knownHunks.delete(k);
}

function navigateHunkInFile(dir: 1 | -1): void {
  const key = activeKey();
  const ed = vscode.window.activeTextEditor;
  const hunks = key ? review.hunks(key) : [];
  if (!key || !ed || !hunks.length) return;
  const line = ed.selection.active.line;
  const h = dir > 0 ? M.nextHunk(hunks, line, true) : M.prevHunk(hunks, line, true);
  if (h) void openAt(key, h, { center: true });
}

function navigateHunk(dir: 1 | -1): void {
  const key = activeKey();
  const ed = vscode.window.activeTextEditor;
  const hunks = key ? review.hunks(key) : [];
  if (key && ed && hunks.length) {
    const line = ed.selection.active.line;
    const h = dir > 0 ? M.nextHunk(hunks, line, false) : M.prevHunk(hunks, line, false);
    if (h) {
      void openAt(key, h);
      return;
    }
  }
  // Past the last change of this file (or no changes here): continue in the next/previous file.
  void navigateFile(dir, true);
}

async function navigateFile(dir: 1 | -1, edge = false): Promise<void> {
  const keys = review.pendingKeys();
  if (!keys.length) return;
  const cur = activeKey();
  let idx = cur ? keys.indexOf(cur) : -1;
  if (idx < 0) idx = dir > 0 ? -1 : keys.length;
  const next = keys[(idx + dir + keys.length) % keys.length];
  const hunks = review.hunks(next);
  await openAt(next, dir > 0 || !edge ? hunks[0] : hunks[hunks.length - 1]);
}

// ---------- hook setup ----------

function nodeOnPath(): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

const bundledHook = () => path.join(ctx.extensionPath, 'dist', 'hook.js');

/** The Claude Changes list offers installing the hook while it is missing. */
function updateHookContext(): void {
  const st = setup.status(bundledHook());
  changesPanel?.setHookReady(st.configured && st.scriptInstalled);
}

async function installHooks(quiet = false): Promise<boolean> {
  review.syncSharedConfig();
  let done: string[];
  try {
    done = setup.install({ bundled: bundledHook(), nodeOnPath: nodeOnPath(), execPath: process.execPath });
  } catch (e: any) {
    void vscode.window.showErrorMessage('Claude Inline Diff: ' + e.message);
    return false;
  }
  done.forEach((d) => log.info('install: ' + d));
  updateHookContext();
  await ctx.globalState.update('hookRemovedByUser', undefined);
  if (quiet) return true;
  const st = setup.status(bundledHook());
  const vsMode = vscode.workspace.getConfiguration('claudeCode').inspect<string>('initialPermissionMode')?.globalValue;
  const auto = st.defaultMode === 'acceptEdits' || vsMode === 'acceptEdits';
  const msg =
    'Claude Code hook installed. New Claude sessions will show edits inline.' +
    (auto ? '' : ' For a single review (no Claude diff tab), let Claude edit automatically.');
  // Not awaited: a notification must never block the command (or anything chained after it).
  void vscode.window
    .showInformationMessage(msg, ...(auto ? ['Show Details'] : ['Enable "Edit automatically"', 'Show Details']))
    .then((choice) => {
      if (choice === 'Show Details') log.show();
      if (choice === 'Enable "Edit automatically"') void enableAcceptEdits();
    });
  return true;
}

/** Offered, never silent: sets the official extension's initial mode and Claude's defaultMode, remembering both for rollback. */
async function enableAcceptEdits(quiet = false): Promise<boolean> {
  const c = vscode.workspace.getConfiguration('claudeCode');
  const prev = c.inspect<string>('initialPermissionMode')?.globalValue;
  if (prev !== 'acceptEdits') {
    try {
      await c.update('initialPermissionMode', 'acceptEdits', vscode.ConfigurationTarget.Global);
      await ctx.globalState.update('vsModeSetByUs', { previous: prev ?? null });
    } catch (e: any) {
      log.warn('could not set claudeCode.initialPermissionMode: ' + e.message);
    }
  }
  try {
    setup.enableAcceptEdits().forEach((d) => log.info(d));
  } catch (e: any) {
    void vscode.window.showErrorMessage('Claude Inline Diff: ' + e.message);
    return false;
  }
  if (quiet) return true;
  void vscode.window.showInformationMessage(
    'Claude will now edit automatically ("Edit automatically" / acceptEdits) in new sessions. Uninstalling the hook restores the previous mode.'
  );
  return true;
}

/** Our hook entries and script, and both "Edit automatically" switches if we set them. Throws when settings.json cannot be handled. */
async function removeHookAndModes(): Promise<string[]> {
  const done = setup.uninstall();
  updateHookContext();
  const vs = ctx.globalState.get<{ previous: string | null }>('vsModeSetByUs');
  if (vs) {
    const c = vscode.workspace.getConfiguration('claudeCode');
    if (c.inspect<string>('initialPermissionMode')?.globalValue === 'acceptEdits') {
      await c.update('initialPermissionMode', vs.previous ?? undefined, vscode.ConfigurationTarget.Global);
      done.push('claudeCode.initialPermissionMode restored to ' + (vs.previous ?? '(unset)'));
    }
    await ctx.globalState.update('vsModeSetByUs', undefined);
  }
  return done;
}

/**
 * Everything the extension ever wrote, in one step: the hook and modes, our argv.json line, our user
 * keybindings, every snapshot and its history, our stored state and our backup files. One backup of
 * settings.json as it was before this removal stays (it is the user's Claude Code settings file).
 */
async function removeCompletely(): Promise<void> {
  const app = vscode.env.appName;
  const ok = await vscode.window.showWarningMessage(
    'Remove Claude Inline Diff completely?',
    {
      modal: true,
      detail:
        'This removes the Claude Code hook and "Edit automatically" (if this extension set it), the argv.json line for red blocks, ' +
        "the shortcuts added by Fix Shortcuts, all review snapshots and history, and the extension's stored state and backups.\n\n" +
        'Pending Claude changes stay in your files but can no longer be reviewed or undone. One backup of settings.json is kept.',
    },
    'Remove Everything'
  );
  if (ok !== 'Remove Everything') return;
  const done: string[] = [];
  const failed: string[] = [];
  const step = async (what: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
    } catch (e: any) {
      failed.push(`${what}: ${e?.message || e}`);
    }
  };
  const settingsFile = setup.settingsPath();
  let before: string | null = null;
  try {
    before = fs.readFileSync(settingsFile, 'utf8');
  } catch {
    /* no settings.json */
  }

  await step('hook', async () => void done.push(...(await removeHookAndModes())));
  await step('argv.json', () => {
    const file = argvPathFor(app);
    const text = readArgv();
    const next = removeProposedApi(text, EXTENSION_ID);
    if (next !== text) {
      fs.writeFileSync(file, next);
      done.push(`removed our line from ${file}`);
    }
  });
  await step('keybindings.json', () => {
    const file = userKeybindingsPath();
    if (!fs.existsSync(file)) return;
    const next = removeUserKeybindings(fs.readFileSync(file, 'utf8'));
    if (next !== null) {
      fs.writeFileSync(file, next);
      done.push(`removed our shortcuts from ${file}`);
    }
  });
  await step('snapshots', () => {
    // After the hook step: it reads the setup state kept in this folder.
    const dirs = [S.globalDir(), ...review.storeDirs().filter((d) => !S.isInside(d, S.globalDir()) && S.isOurStore(d))];
    for (const d of dirs) {
      if (!fs.existsSync(d)) continue;
      fs.rmSync(d, { recursive: true, force: true });
      done.push('deleted ' + d);
    }
  });
  let kept: string | null = null;
  await step('backups', () => {
    for (const b of setup.listBackups(settingsFile)) fs.rmSync(b, { force: true });
    for (const f of [argvPathFor(app), userKeybindingsPath()]) fs.rmSync(f + '.bak-claude-inline-diff', { force: true });
    let now: string | null = null;
    try {
      now = fs.readFileSync(settingsFile, 'utf8');
    } catch {
      /* none */
    }
    if (before !== null && before !== now) {
      kept = `${settingsFile}.bak-claude-inline-diff-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.writeFileSync(kept, before, { mode: fs.statSync(settingsFile).mode & 0o777 });
    }
    done.push('deleted backup files' + (kept ? ` (kept ${kept}: settings.json before this removal)` : ''));
  });
  await step('stored state', async () => {
    for (const k of ctx.globalState.keys()) await ctx.globalState.update(k, undefined);
    fs.rmSync(ctx.globalStorageUri.fsPath, { recursive: true, force: true }); // a downloaded update, if one was left
    done.push('cleared stored state');
  });
  review.refresh(true);
  updateHookContext();
  done.forEach((d) => log.info('remove completely: ' + d));
  failed.forEach((d) => log.error('remove completely: ' + d));
  if (failed.length) {
    log.show();
    void vscode.window.showErrorMessage(`Claude Inline Diff: ${failed.length} step(s) failed, see the log. ${failed[0]}`);
  }
  const pick = await vscode.window.showInformationMessage(
    `Claude Inline Diff: everything removed.${kept ? ` One backup is kept: ${kept}.` : ''} Uninstall the extension to finish; red blocks stay on until ${app} is restarted.`,
    'Uninstall Extension',
    'Show Details'
  );
  if (pick === 'Show Details') log.show();
  if (pick === 'Uninstall Extension') {
    await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', EXTENSION_ID);
    void vscode.window
      .showInformationMessage(`Extension uninstalled. Quit ${app} to finish.`, `Quit ${app}`)
      .then((c) => c && vscode.commands.executeCommand('workbench.action.quit'));
  }
}

async function uninstallHooks(): Promise<void> {
  const ok = await vscode.window.showWarningMessage(
    'Remove the Claude Inline Diff hook from Claude Code settings?',
    { modal: true },
    'Remove'
  );
  if (ok !== 'Remove') return;
  let done: string[];
  try {
    done = await removeHookAndModes();
  } catch (e: any) {
    void vscode.window.showErrorMessage('Claude Inline Diff: ' + e.message);
    return;
  }
  await ctx.globalState.update('hookRemovedByUser', true); // a deliberate removal: Set Up does not open by itself again
  done.forEach((d) => log.info('uninstall: ' + d));
  const pick = await vscode.window.showInformationMessage(
    done.length ? 'Hook removed. ' + done.join('; ') : 'Nothing to remove.',
    'Delete review snapshots…'
  );
  if (pick) await clearSnapshots();
}

async function clearSnapshots(): Promise<void> {
  const dirs = review.storeDirs().filter((d) => fs.existsSync(d));
  if (!dirs.length) {
    void vscode.window.showInformationMessage('No review snapshots found.');
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Delete review snapshots? Pending Claude changes stay in your files but can no longer be reviewed or rejected.\n\n${dirs.join('\n')}`,
    { modal: true },
    'Delete'
  );
  if (ok !== 'Delete') return;
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  review.refresh(true);
}

async function hookStatus(): Promise<void> {
  const st = setup.status(bundledHook());
  const lines = [
    `Hook script: ${st.scriptInstalled ? 'installed v' + st.installedVersion : 'not installed'} (${st.hookPath})`,
    `Bundled hook: v${st.bundledVersion ?? '?'}`,
    `settings.json: ${st.settingsError ? 'ERROR ' + st.settingsError : st.configured ? `wired (${setup.ALL_EVENTS.join(', ')})` : st.partial ? 'partially wired' : 'not wired'}`,
    `permissions.defaultMode: ${st.defaultMode ?? '(unset)'}; claudeCode.initialPermissionMode: ${vscode.workspace.getConfiguration('claudeCode').get('initialPermissionMode') ?? '(unset)'}`,
    `Inline removed-code blocks (editorInsets): ${insetApi() ? 'enabled' : 'not enabled — using decorations'}`,
    `Stores: ${review.storeDirs().join(', ')}`,
  ];
  lines.forEach((l) => log.info(l));
  log.show();
  if (!st.configured || (st.scriptInstalled && st.installedVersion !== st.bundledVersion)) {
    const pick = await vscode.window.showWarningMessage('The Claude Code hook is missing or outdated.', 'Install / Update');
    if (pick) await installHooks();
  }
}

/** argv.json as text ('' when missing or unreadable). */
function readArgv(): string {
  try {
    const file = argvPathFor(vscode.env.appName);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

/** Adds our id to argv.json `enable-proposed-api` (comments kept, backup made); on failure copies the line and opens the file. */
async function addArgvLine(): Promise<boolean> {
  const file = argvPathFor(vscode.env.appName);
  const text = readArgv();
  try {
    const next = addProposedApi(text, EXTENSION_ID);
    if (text) fs.copyFileSync(file, file + '.bak-claude-inline-diff');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
    log.info('argv.json: enable-proposed-api added');
    return true;
  } catch (e: any) {
    await vscode.env.clipboard.writeText(`"enable-proposed-api": ["${EXTENSION_ID}"]`);
    void vscode.window.showErrorMessage(`Could not edit ${file} (${e.message}). The line was copied — paste it into argv.json.`);
    await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
    return false;
  }
}

/** argv.json is read only at startup: "Reload Window" is not enough. */
function offerQuit(prefix: string): void {
  const app = vscode.env.appName;
  void vscode.window
    .showInformationMessage(`${prefix} Quit ${app} and start it again to draw removed code as red blocks.`, `Quit ${app}`)
    .then((c) => c && vscode.commands.executeCommand('workbench.action.quit'));
}

/**
 * One step instead of three prompts, everything ticked: the hook and "Edit automatically" (both work in the
 * next Claude chat, no restart) and the red blocks (argv.json + a full restart; offered again after the first
 * change if unticked here). Opens by itself on the first run.
 */
async function setUp(): Promise<void> {
  const st = setup.status(bundledHook());
  const hookOk = st.configured && st.scriptInstalled && st.installedVersion === st.bundledVersion;
  const vsMode = vscode.workspace.getConfiguration('claudeCode').inspect<string>('initialPermissionMode')?.globalValue;
  const auto = st.defaultMode === 'acceptEdits' || vsMode === 'acceptEdits';
  const argvReady = !!insetApi() || hasProposedApi(readArgv(), EXTENSION_ID);
  type Item = vscode.QuickPickItem & { id: 'hook' | 'auto' | 'insets' };
  const items: Item[] = [];
  if (!hookOk)
    items.push({
      id: 'hook',
      label: '$(plug) Claude Code hook',
      description: 'required',
      detail: "Lets the extension see Claude's edits: a few entries in ~/.claude/settings.json, backup kept.",
      picked: true,
    });
  if (!auto)
    items.push({
      id: 'auto',
      label: '$(check-all) Let Claude edit automatically',
      description: 'recommended',
      detail: "Edits land in the file and you review them here, instead of approving each one in Claude's diff tab.",
      picked: true,
    });
  if (!argvReady)
    items.push({
      id: 'insets',
      label: '$(diff) Red removed-code blocks between lines',
      description: 'like Cursor · needs a full restart',
      detail: 'One line in argv.json. Without it, removed code shows as a red rule with the old code on hover.',
      picked: true,
    });
  if (!items.length) {
    void vscode.window.showInformationMessage(
      insetApi() || !argvReady
        ? 'Claude Inline Diff is set up. Start a new Claude chat and its edits show here.'
        : `Claude Inline Diff is set up. Quit ${vscode.env.appName} and start it again to draw removed code as red blocks.`
    );
    return;
  }
  const chosen = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    ignoreFocusOut: true,
    title: 'Set Up Claude Inline Diff',
    placeHolder: 'Everything is ticked: press Enter to apply (Space unticks an item)',
  });
  if (!chosen?.length) return;
  const ids = new Set(chosen.map((c) => c.id));
  if (ids.has('hook') && !(await installHooks(true))) return;
  if (ids.has('auto')) await enableAcceptEdits(true);
  const ready = hookOk || ids.has('hook') ? 'Ready: start a new Claude chat and its edits show here.' : 'Done.';
  if (ids.has('insets') && (await addArgvLine())) offerQuit(ready);
  else void vscode.window.showInformationMessage(ready);
}

/** After the first change was shown the simple way: offer the red blocks once. */
async function maybeOfferInsets(): Promise<void> {
  if (process.env.CLAUDE_INLINE_DIFF_TEST || insetApi() || ctx.globalState.get('insetsPrompted')) return;
  if (cfg<string>('deletedLines.renderer', 'auto') === 'decoration' || hasProposedApi(readArgv(), EXTENSION_ID)) return;
  await ctx.globalState.update('insetsPrompted', true);
  const pick = await vscode.window.showInformationMessage(
    'Removed code can be drawn as red blocks between lines, like Cursor. It needs one line in argv.json and a full restart.',
    'Enable…',
    'Not Now'
  );
  if (pick === 'Enable…') await enableInsets();
}

async function enableInsets(): Promise<void> {
  const file = argvPathFor(vscode.env.appName);
  const snippet = `"enable-proposed-api": ["${EXTENSION_ID}"]`;
  const text = readArgv();
  if (hasProposedApi(text, EXTENSION_ID)) {
    const r = await vscode.window.showInformationMessage(
      `${path.basename(file)} already enables the API. Fully quit and restart ${vscode.env.appName} (not just "Reload Window").`,
      'Open argv.json'
    );
    if (r) await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    `Draw removed code as red blocks between lines? This adds ${snippet} to ${file}. Then fully quit and restart ${vscode.env.appName}.`,
    { modal: true },
    'Add Automatically',
    'Open argv.json and Copy Line'
  );
  if (pick === 'Add Automatically') {
    if (await addArgvLine()) offerQuit('Done.');
  } else if (pick) {
    await vscode.env.clipboard.writeText(snippet);
    await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
    void vscode.window.showInformationMessage('Paste the copied line inside the { } of argv.json, save, then fully restart.');
  }
}

// ---------- keyboard-shortcut conflicts ----------

function shortcutConflicts(): Conflict[] {
  const ours = (ctx.extension.packageJSON?.contributes?.keybindings || []) as any[];
  const others = vscode.extensions.all
    .filter((e) => e.id.toLowerCase() !== EXTENSION_ID && Array.isArray(e.packageJSON?.contributes?.keybindings))
    .map((e) => ({ extension: e.packageJSON.displayName || e.id, keybindings: e.packageJSON.contributes.keybindings }));
  const found = findConflicts(ours, others, process.platform);
  log.info(
    `shortcut check: ${ours.length} own keybindings, ${others.length} other extensions with keybindings, ${found.length} conflicts` +
      (found.length ? ': ' + found.map((c) => `${c.key} (${c.theirs.map((t) => t.extension).join(', ')})`).join('; ') : '')
  );
  return found;
}

/**
 * Puts the Claude Changes list under the Claude Code chat, wherever the editor keeps that chat.
 * Done once per chat location (so a list the user moved elsewhere stays there); `force` from the command.
 */
async function placeChangesView(force: boolean): Promise<void> {
  if (!vscode.extensions.getExtension('anthropic.claude-code')) return;
  // <user data>/User/globalStorage/<ext id> → <user data>/User/globalStorage/state.vscdb
  const dest = chatContainer(path.join(path.dirname(ctx.globalStorageUri.fsPath), 'state.vscdb'));
  if (!force && ctx.globalState.get('changesViewPlacedIn') === dest) return;
  try {
    await vscode.commands.executeCommand('vscode.moveViews', { viewIds: ['claudeInlineDiff.changes'], destinationId: dest });
    await ctx.globalState.update('changesViewPlacedIn', dest);
    log.info('Claude Changes list placed under the Claude Code chat: ' + dest);
  } catch (e: any) {
    log.warn('could not move the Claude Changes list: ' + (e?.message || e));
  }
}

function userKeybindingsPath(): string {
  // <user data>/User/globalStorage/<ext id> → <user data>/User/keybindings.json
  return path.join(path.dirname(path.dirname(ctx.globalStorageUri.fsPath)), 'keybindings.json');
}

async function fixKeybindings(conflicts = shortcutConflicts()): Promise<void> {
  if (!conflicts.length) {
    void vscode.window.showInformationMessage('No other extension uses Claude Inline Diff shortcuts.');
    return;
  }
  const file = userKeybindingsPath();
  const entries = conflicts.map((c) => ({ key: keyFor(c.ours, process.platform)!, command: c.ours.command, when: c.ours.when }));
  try {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const next = addUserKeybindings(text, entries);
    if (next === null) {
      log.info('keybindings: already present in ' + file);
      void vscode.window.showInformationMessage('Your keybindings.json already gives Claude Inline Diff priority.');
      return;
    }
    if (text) fs.copyFileSync(file, file + '.bak-claude-inline-diff');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
    log.info(`keybindings: added ${entries.length} entries to ${file}`);
    void vscode.window.showInformationMessage(
      `Shortcuts fixed: ${entries.length} entries added to keybindings.json (active only inside Claude changes).`
    );
  } catch (e: any) {
    void vscode.window.showErrorMessage(`Could not update ${file}: ${e.message}`);
  }
}

async function checkShortcutConflicts(): Promise<void> {
  // Only conflicts not already settled in the user's keybindings.json (earlier "Fix Shortcuts" runs).
  const entryOf = (c: Conflict) => ({ key: keyFor(c.ours, process.platform)!, command: c.ours.command, when: c.ours.when });
  const file = userKeybindingsPath();
  let text = '';
  try {
    text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    /* unreadable: treat as empty */
  }
  const settled = (c: Conflict) => {
    try {
      return addUserKeybindings(text, [entryOf(c)]) === null;
    } catch {
      return false; // keybindings.json we cannot read: still offer
    }
  };
  const conflicts = shortcutConflicts().filter((c) => !settled(c));
  const sig = conflicts.map((c) => c.key + '>' + c.ours.command).join(',');
  if (!conflicts.length || ctx.globalState.get('shortcutConflictsSeen') === sig) return;
  const exts = [...new Set(conflicts.flatMap((c) => c.theirs.map((t) => t.extension)))].join(', ');
  const keys = [...new Set(conflicts.map((c) => c.key))].slice(0, 5).join(', ');
  const pick = await vscode.window.showWarningMessage(
    `${exts} also use ${keys}, so these Claude Inline Diff shortcuts may not work. Give Claude Inline Diff priority inside Claude changes (adds entries to your keybindings.json)?`,
    'Fix Shortcuts',
    'Not Now'
  );
  await ctx.globalState.update('shortcutConflictsSeen', sig);
  if (pick === 'Fix Shortcuts') await fixKeybindings(conflicts);
}

/**
 * Follows the chat shown in the Claude Code panel through the editor's saved workspace state: the only sign of a
 * switch back to a chat that is still loaded. Only a change counts (the first value read may be old).
 */
function watchVisibleChat(): void {
  if (!ctx.storageUri) return;
  // <user data>/User/workspaceStorage/<workspace id>/<ext id> → …/<workspace id>/state.vscdb
  const db = path.join(path.dirname(ctx.storageUri.fsPath), 'state.vscdb');
  let stamp = '';
  let last: string | null | undefined;
  let first = true;
  const tick = () => {
    let now = '';
    for (const f of [db, db + '-wal']) {
      try {
        const st = fs.statSync(f);
        now += st.mtimeMs + ':' + st.size + '|';
      } catch {
        now += '-|';
      }
    }
    if (now === stamp) return;
    stamp = now;
    const id = visibleChat(db);
    if (id === undefined || id === last) return;
    last = id;
    if (first) {
      first = false;
      return;
    }
    if (id) {
      log.info('Claude Code panel shows chat ' + id.slice(0, 8));
      review.noteShownChat(id);
    }
  };
  tick();
  first = false;
  const timer = setInterval(tick, 2000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
}

/**
 * In a workspace opened for the first time the Claude Code chat section starts collapsed (with our list under it
 * the tab has two sections, and the editor opens neither). Opens it once per workspace, and only while its tab is
 * the one on screen, so nothing is switched or revealed.
 */
function expandChatOnce(): void {
  if (!ctx.storageUri || ctx.workspaceState.get('chatOpenedOnce')) return;
  if (!vscode.extensions.getExtension('anthropic.claude-code')) return;
  const db = path.join(path.dirname(ctx.storageUri.fsPath), 'state.vscdb');
  const container = chatContainer(path.join(path.dirname(ctx.globalStorageUri.fsPath), 'state.vscdb'));
  let stamp = '';
  const stop = () => clearInterval(timer);
  const tick = () => {
    let now = '';
    for (const f of [db, db + '-wal']) {
      try {
        const st = fs.statSync(f);
        now += st.mtimeMs + ':' + st.size + '|';
      } catch {
        now += '-|';
      }
    }
    if (now === stamp) return;
    stamp = now;
    const what = chatSection(db, container);
    if (what === 'wait') return;
    stop();
    void ctx.workspaceState.update('chatOpenedOnce', true);
    if (what !== 'expand') return;
    const editing = !!vscode.window.activeTextEditor;
    vscode.commands.executeCommand(CLAUDE_CHAT_VIEW + '.focus').then(
      () => {
        log.info('Claude Code chat section opened (collapsed by default in a new workspace)');
        // Opening it took the keyboard: give it back to the file being edited.
        if (editing) void vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      },
      (e) => log.warn('could not open the Claude Code chat section: ' + (e?.message || e))
    );
  };
  const timer = setInterval(tick, 2000);
  ctx.subscriptions.push({ dispose: stop });
  tick();
}

/**
 * Follows the official extension's log for the chat the panel was switched to (see ChatLogReader): at once, where
 * the saved workspace state (watchVisibleChat) lags. The log sits next to ours, one folder per extension.
 */
function watchClaudeLog(): void {
  const dir = path.join(path.dirname(ctx.logUri.fsPath), 'Anthropic.claude-code');
  const reader = new ChatLogReader();
  let file = '';
  let pos = 0;
  let live = false;
  const newest = (): string => {
    try {
      const logs = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.log'))
        .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      return logs[0]?.f || '';
    } catch {
      return '';
    }
  };
  let ticks = 0;
  const tick = () => {
    try {
      // The log rolls over to a new file now and then.
      if (!file || ticks++ % 20 === 0) {
        const f = newest();
        if (f && f !== file) [file, pos] = [f, 0];
      }
      if (!file) return;
      const size = fs.statSync(file).size;
      if (size < pos) pos = 0;
      if (size === pos) return;
      // What is already there only teaches which channel runs which chat (at most the last 8 MB).
      const from = live ? pos : Math.max(pos, size - 8 * 1024 * 1024);
      const buf = Buffer.alloc(size - from);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buf, 0, buf.length, from);
      } finally {
        fs.closeSync(fd);
      }
      pos = size;
      const shown = reader.feed(buf.toString('utf8'));
      if (live && shown === NEW_CHAT) {
        log.info('Claude Code panel shows a new chat');
        review.confirmNewChat();
      } else if (live && shown) {
        log.info('Claude Code panel switched to chat ' + shown.slice(0, 8));
        review.noteShownChat(shown);
      }
    } catch {
      /* no log (yet) */
    } finally {
      live = true;
    }
  };
  tick();
  const timer = setInterval(tick, 500);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
}

async function firstRunChecks(): Promise<void> {
  updateHookContext();
  if (process.env.CLAUDE_INLINE_DIFF_TEST) return;
  void checkShortcutConflicts();
  void placeChangesView(false);
  watchVisibleChat();
  expandChatOnce();
  watchClaudeLog();
  const st = setup.status(bundledHook());
  // Our own script is outdated, or a newer version wires an extra event (e.g. Stop): update silently.
  if (st.scriptInstalled && (st.configured || st.partial) && (st.installedVersion !== st.bundledVersion || !st.configured)) {
    try {
      setup.install({ bundled: bundledHook(), nodeOnPath: nodeOnPath(), execPath: process.execPath }); // silent self-update of our own script
      log.info('hook script updated to v' + st.bundledVersion);
      updateHookContext();
    } catch (e: any) {
      log.warn('hook update failed: ' + e.message);
    }
  } else {
    // Installing the extension activates it in every open window at once: the list opens only in the focused one,
    // or in the first window that gets focus (globalState is shared, so the others see it was shown).
    if (vscode.window.state.focused) await maybeAutoSetUp();
    else {
      const sub = vscode.window.onDidChangeWindowState((w) => {
        if (!w.focused) return;
        sub.dispose();
        void maybeAutoSetUp();
      });
      ctx.subscriptions.push(sub);
    }
  }
}

async function maybeAutoSetUp(): Promise<void> {
  const version = String(ctx.extension.packageJSON?.version ?? '');
  const auto = M.shouldAutoSetUp({
    hookConfigured: setup.status(bundledHook()).configured,
    shownForVersion: ctx.globalState.get<string>('setUpShownFor'),
    version,
    removedByUser: ctx.globalState.get<boolean>('hookRemovedByUser'),
  });
  if (auto) {
    await ctx.globalState.update('setUpShownFor', version);
    await setUp(); // the list itself explains each item; Esc leaves it for later (Set Up in Claude Changes / the status bar)
  }
}

// ---------- commands ----------

function registerCommands(context: vscode.ExtensionContext): void {
  const reg = (id: string, fn: (...a: any[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand('claudeInlineDiff.' + id, async (...a: any[]) => {
        try {
          await fn(...a);
        } catch (e: any) {
          log.error(`${id}: ${e?.stack || e}`);
          void vscode.window.showErrorMessage(`Claude Inline Diff: ${e?.message || e}`);
        }
      })
    );

  reg('acceptHunk', (arg) => runHunk('accept', arg));
  reg('rejectHunk', (arg) => runHunk('reject', arg));
  reg('rejectHunkWithFeedback', rejectWithFeedback);
  reg('acceptFile', async (arg) => {
    const keys = [keyFromArg(arg)].filter((k): k is string => !!k);
    const cur = activeKey();
    await review.acceptFiles(keys);
    updateContexts();
    if (cur && keys.includes(cur)) await advance(cur, Number.MAX_SAFE_INTEGER, 'file');
  });
  reg('rejectFile', async (arg) => {
    const keys = [keyFromArg(arg)].filter((k): k is string => !!k);
    for (const k of keys) if (review.rejectDeletesFile(k, true) && !(await confirmTrash(k))) return;
    const cur = activeKey();
    await review.rejectFiles(keys);
    updateContexts();
    if (cur && keys.includes(cur)) await advance(cur, Number.MAX_SAFE_INTEGER, 'file');
  });
  reg('acceptAll', async () => {
    const n = await review.acceptFiles(review.pendingKeys(), 'Keep all');
    if (n)
      vscode.window.setStatusBarMessage(
        `$(check-all) Kept Claude changes in ${M.plural(n, 'file')} (Revert Last Keep/Undo to go back)`,
        4000
      );
  });
  // 'confirmed': the Claude Changes list already asked (a second click on Undo All, like Cursor).
  reg('rejectAll', async (arg?: unknown) => {
    const keys = review.pendingKeys();
    if (!keys.length) return;
    const created = keys.filter((k) => review.rejectDeletesFile(k, true)).length;
    if (arg === 'confirmed') {
      // The list asked about undoing, not about deleting the files Claude created.
      if (created && cfg('confirmDeleteCreatedFile', true)) {
        const ok = await vscode.window.showWarningMessage(
          `${M.plural(created, 'file')} Claude created will be moved to the trash.`,
          { modal: true },
          'Move to Trash'
        );
        if (ok !== 'Move to Trash') return;
      }
    } else if (cfg('confirmRejectAll', true)) {
      const ok = await vscode.window.showWarningMessage(
        `Undo all Claude changes in ${M.plural(keys.length, 'file')}?${created ? ` ${M.plural(created, 'file')} Claude created will be moved to the trash.` : ''} You can revert this.`,
        { modal: true },
        'Undo All'
      );
      if (ok !== 'Undo All') return;
    }
    await review.rejectFiles(keys, 'Undo all');
  });
  reg('undo', async () => {
    const item = await review.undo();
    if (!item) {
      // Bound to Cmd/Ctrl+Z only right after a Keep or Undo; otherwise fall through to normal undo.
      await vscode.commands.executeCommand('undo');
      return;
    }
    const f = item.files[0];
    const h = f && review.hunks(f.key)[0];
    if (f && review.entries.has(f.key)) await openAt(f.key, h);
    vscode.window.setStatusBarMessage(`$(reply) Undid: ${item.label}`, 3000);
    updateContexts();
  });
  reg('nextHunk', () => navigateHunk(1));
  // Cursor's Alt+J / Alt+K: within the file, wrapping around, centred.
  reg('nextHunkInFile', () => navigateHunkInFile(1));
  reg('prevHunkInFile', () => navigateHunkInFile(-1));
  reg('prevHunk', () => navigateHunk(-1));
  reg('nextFile', () => navigateFile(1));
  reg('prevFile', () => navigateFile(-1));
  reg('openFile', async (key: string) => {
    const e = review.entries.get(key);
    // A file Claude deleted cannot be opened: show what it was.
    if (e && !fs.existsSync(e.path)) {
      const gone = vscode.Uri.from({ scheme: BASE_SCHEME, path: vscode.Uri.file(e.path).path, query: 'gone=1' });
      await vscode.commands.executeCommand('vscode.diff', baseUri(e), gone, `${path.basename(e.path)} (deleted by Claude)`);
      return;
    }
    await openAt(key, review.hunks(key)[0]);
  });
  reg('showDiff', async (arg) => {
    const key = keyFromArg(arg);
    const e = key && review.entries.get(key);
    if (!e) return;
    await vscode.commands.executeCommand(
      'vscode.diff',
      baseUri(e),
      vscode.Uri.file(e.path),
      `${path.basename(e.path)} (before Claude ↔ now)`
    );
  });
  // Text-only twins used by the editor title bar and the floating bar. A click there takes the focus out of the
  // text, so Cmd/Ctrl+Z right after it would be the editor's own undo (Claude's text back, unsaved and unreviewed)
  // instead of Revert Last Keep/Undo: the focus goes back to the editor once the action is done.
  const forward =
    (id: string) =>
    async (...a: any[]) => {
      await vscode.commands.executeCommand('claudeInlineDiff.' + id, ...a.filter((x) => x instanceof vscode.Uri));
      if (vscode.window.activeTextEditor) await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    };
  reg('keepFileText', forward('acceptFile'));
  reg('keepFileTextMac', forward('acceptFile'));
  reg('keepFileTextCtrl', forward('acceptFile'));
  reg('undoFileText', forward('rejectFile'));
  reg('keepAllChangesText', async () => {
    await vscode.commands.executeCommand('claudeInlineDiff.acceptAll');
    if (vscode.window.activeTextEditor) await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  });
  reg('nextFileText', () => navigateFile(1));
  reg('placeChangesView', () => placeChangesView(true));
  reg('showChangesList', () => changesPanel?.show());
  // From the list: the files it shows (the chat on screen); from the palette: every waiting file.
  reg('reviewAll', async (arg?: unknown) => {
    const keys = Array.isArray(arg) ? arg.filter((k): k is string => typeof k === 'string' && review.entries.has(k)) : review.pendingKeys();
    if (!keys.length) return reviewChat();
    const resources = keys.map((k): DiffResource => {
      const e = review.entries.get(k)!;
      const file = vscode.Uri.file(e.path);
      return [file, baseUri(e), file];
    });
    const changes = keys.reduce((n, k) => n + review.hunks(k).length, 0);
    await openMultiDiff(`Claude changes · ${M.plural(changes, 'change')}`, resources);
  });
  reg('setUp', setUp);
  reg('installHooks', () => installHooks());
  reg('fixKeybindings', () => fixKeybindings());
  reg('uninstallHooks', uninstallHooks);
  reg('removeCompletely', removeCompletely);
  reg('hookStatus', hookStatus);
  reg('checkForUpdates', () => updater?.check(true));
  reg('enableInsets', enableInsets);
  reg('clearSnapshots', clearSnapshots);
  reg('refresh', () => review.refresh(true));
  reg('revertStep', async (step: S.Step) => {
    if (!step) return;
    const ok = await vscode.window.showWarningMessage(
      `Revert "${step.prompt.slice(0, 60)}" and every later step of this session? Files go back to how they were before this step. You can undo this.`,
      { modal: true },
      'Revert'
    );
    if (ok !== 'Revert') return;
    const n = await review.revertStep(step);
    vscode.window.setStatusBarMessage(`$(history) Reverted ${M.plural(n, 'file')}`, 4000);
  });
}
