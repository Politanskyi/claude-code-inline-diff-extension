// Claude Inline Diff — activation and commands.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as S from './core/store';
import * as setup from './core/setup';
import * as M from './core/model';
import { Hunk } from './core/diff';
import { addProposedApi, argvPathFor, hasProposedApi } from './core/argv';
import { findConflicts, addUserKeybindings, keyFor, Conflict } from './core/keybindings';
import { chatContainer } from './core/layout';
import { ReviewManager, HunkRef, cfg } from './review';
import { Renderer } from './render';
import { InsetManager, insetApi } from './insets';
import { StatusBar, Badges, Lenses, ChangesTree, StepsTree, refFromNode, keysFromNode } from './views';
import { resetPalette } from './theme';

export const EXTENSION_ID = 'inlinediff.claude-inline-diff';
const BASE_SCHEME = 'claude-inline-diff-base';

let review: ReviewManager;
let renderer: Renderer;
let log: vscode.LogOutputChannel;
let ctx: vscode.ExtensionContext;
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
      accept: (ref) => void runHunk('accept', ref, true),
      reject: (ref) => void runHunk('reject', ref, true),
      feedback: (ref) => void rejectWithFeedback(ref),
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
  context.subscriptions.push(
    log,
    review,
    renderer,
    insets,
    new StatusBar(review),
    new Badges(review),
    new Lenses(
      review,
      () => renderer.useInsets(),
      () => renderer.useToolbars()
    ),
    new ChangesTree(review),
    new StepsTree(review),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, {
      provideTextDocumentContent: (uri) => review.entries.get(new URLSearchParams(uri.query).get('k') || '')?.content ?? '',
    }),
    review.onDidChange(updateContexts),
    review.onNewFile((e) => void revealOnEdit(e)),
    review.onDidChange(() => followClaude()),
    vscode.window.onDidChangeActiveTextEditor(updateContexts),
    vscode.window.onDidChangeTextEditorSelection(updateContexts),
    vscode.window.onDidChangeActiveColorTheme(() => resetPalette()),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('workbench.colorTheme') && resetPalette())
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
  setContext('claudeInlineDiff.multipleFiles', pending.length > 1);
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
  setContext('claudeInlineDiff.canUndoAccept', !!key && review.canNativeUndoMeanAccept(key));
}

// ---------- helpers ----------

function keyFromArg(arg: unknown): string | undefined {
  if (arg instanceof vscode.Uri) return S.keyOf(arg.fsPath);
  const keys = keysFromNode(arg);
  if (keys) return keys[0];
  if (typeof arg === 'string') return arg;
  return activeKey();
}

function refFromArg(arg: unknown): HunkRef | undefined {
  const n = refFromNode(arg);
  if (n) return n;
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

async function runHunk(kind: 'accept' | 'reject', arg: unknown, fromEditor: boolean): Promise<void> {
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
  const active = activeKey() === ref.key;
  if (fromEditor || active) await advance(ref.key, line, kind);
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
  await runHunk('reject', ref, true);
  if (text.trim()) vscode.window.setStatusBarMessage('$(comment) Feedback queued for Claude', 4000);
}

async function revealOnEdit(e: S.Entry): Promise<void> {
  if (!cfg('revealOnEdit', true)) return;
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
    if (!prev || !cfg('followClaude', true) || !review.claudeJustWrote(key)) continue;
    const fresh = hunks.filter((h) => !prev.has(sig(h)));
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

/** The Claude Changes list stays visible while the hook is missing, to offer installing it. */
function updateHookContext(): void {
  const st = setup.status(bundledHook());
  setContext('claudeInlineDiff.hookReady', st.configured && st.scriptInstalled);
}

async function installHooks(): Promise<void> {
  review.syncSharedConfig();
  let done: string[];
  try {
    done = setup.install({ bundled: bundledHook(), nodeOnPath: nodeOnPath(), execPath: process.execPath });
  } catch (e: any) {
    void vscode.window.showErrorMessage('Claude Inline Diff: ' + e.message);
    return;
  }
  done.forEach((d) => log.info('install: ' + d));
  updateHookContext();
  await ctx.globalState.update('hookPrompted', true);
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
}

/** Offered, never silent: sets the official extension's initial mode and Claude's defaultMode, remembering both for rollback. */
async function enableAcceptEdits(): Promise<void> {
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
    return;
  }
  void vscode.window.showInformationMessage(
    'Claude will now edit automatically ("Edit automatically" / acceptEdits) in new sessions. Uninstalling the hook restores the previous mode.'
  );
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
    done = setup.uninstall();
  } catch (e: any) {
    void vscode.window.showErrorMessage('Claude Inline Diff: ' + e.message);
    return;
  }
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
    `settings.json: ${st.settingsError ? 'ERROR ' + st.settingsError : st.configured ? 'wired (PreToolUse, PostToolUse, UserPromptSubmit)' : st.partial ? 'partially wired' : 'not wired'}`,
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

async function enableInsets(): Promise<void> {
  const file = argvPathFor(vscode.env.appName);
  const snippet = `"enable-proposed-api": ["${EXTENSION_ID}"]`;
  let text = '';
  try {
    text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    /* unreadable */
  }
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
    try {
      const next = addProposedApi(text, EXTENSION_ID);
      if (text) fs.copyFileSync(file, file + '.bak-claude-inline-diff');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, next);
      void vscode.window.showInformationMessage(`Done. Fully quit ${vscode.env.appName} (Cmd/Ctrl+Q) and start it again.`);
    } catch (e: any) {
      await vscode.env.clipboard.writeText(snippet);
      void vscode.window.showErrorMessage(`Could not edit ${file} (${e.message}). The line was copied — paste it into argv.json.`);
      await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
    }
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

async function firstRunChecks(): Promise<void> {
  updateHookContext();
  if (process.env.CLAUDE_INLINE_DIFF_TEST) return;
  void checkShortcutConflicts();
  void placeChangesView(false);
  const st = setup.status(bundledHook());
  if (st.scriptInstalled && st.configured && st.installedVersion !== st.bundledVersion) {
    try {
      setup.install({ bundled: bundledHook(), nodeOnPath: nodeOnPath(), execPath: process.execPath }); // silent self-update of our own script
      log.info('hook script updated to v' + st.bundledVersion);
    } catch (e: any) {
      log.warn('hook update failed: ' + e.message);
    }
  } else if (!st.configured && !ctx.globalState.get('hookPrompted')) {
    await ctx.globalState.update('hookPrompted', true);
    const pick = await vscode.window.showInformationMessage(
      "Claude Inline Diff needs a small Claude Code hook (in ~/.claude/settings.json) to see Claude's edits. Install it?",
      'Install Hook',
      'Not Now'
    );
    if (pick === 'Install Hook') await installHooks();
  }
  if (cfg<string>('deletedLines.renderer', 'auto') !== 'decoration' && !insetApi() && !ctx.globalState.get('insetsPrompted')) {
    await ctx.globalState.update('insetsPrompted', true);
    const pick = await vscode.window.showInformationMessage(
      'Tip: removed code can be drawn as red blocks between lines (like Cursor). It needs one line in argv.json.',
      'Enable…',
      'Not Now'
    );
    if (pick === 'Enable…') await enableInsets();
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

  reg('acceptHunk', (arg) => runHunk('accept', arg, !refFromNode(arg)));
  reg('rejectHunk', (arg) => runHunk('reject', arg, !refFromNode(arg)));
  reg('rejectHunkWithFeedback', rejectWithFeedback);
  reg('acceptFile', async (arg) => {
    const keys = keysFromNode(arg) || [keyFromArg(arg)].filter((k): k is string => !!k);
    const cur = activeKey();
    await review.acceptFiles(keys);
    updateContexts();
    if (cur && keys.includes(cur)) await advance(cur, Number.MAX_SAFE_INTEGER, 'file');
  });
  reg('rejectFile', async (arg) => {
    const keys = keysFromNode(arg) || [keyFromArg(arg)].filter((k): k is string => !!k);
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
  reg('rejectAll', async () => {
    const keys = review.pendingKeys();
    if (!keys.length) return;
    if (cfg('confirmRejectAll', true)) {
      const created = keys.filter((k) => review.rejectDeletesFile(k, true)).length;
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
      // Bound to Cmd/Ctrl+Z only right after an accept; otherwise fall through to normal undo.
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
  reg('openFile', (key: string) => openAt(key, review.hunks(key)[0]));
  reg('revealHunk', (ref: HunkRef) => openAt(ref.key, review.resolveHunk(ref)));
  reg('showDiff', async (arg) => {
    const key = keyFromArg(arg);
    const e = key && review.entries.get(key);
    if (!e) return;
    const base = vscode.Uri.from({ scheme: BASE_SCHEME, path: vscode.Uri.file(e.path).path, query: 'k=' + encodeURIComponent(e.key) });
    await vscode.commands.executeCommand('vscode.diff', base, vscode.Uri.file(e.path), `${path.basename(e.path)} (before Claude ↔ now)`);
  });
  // Text-only twins used by the editor title bar and the floating bar.
  const forward =
    (id: string) =>
    (...a: any[]) =>
      vscode.commands.executeCommand('claudeInlineDiff.' + id, ...a.filter((x) => x instanceof vscode.Uri));
  reg('keepFileText', forward('acceptFile'));
  reg('keepFileTextMac', forward('acceptFile'));
  reg('keepFileTextCtrl', forward('acceptFile'));
  reg('undoFileText', forward('rejectFile'));
  reg('keepAllText', () => vscode.commands.executeCommand('claudeInlineDiff.acceptAll'));
  reg('undoOneText', () => vscode.commands.executeCommand('claudeInlineDiff.rejectAll'));
  reg('keepOneText', () => vscode.commands.executeCommand('claudeInlineDiff.acceptAll'));
  reg('keepAllChangesText', () => vscode.commands.executeCommand('claudeInlineDiff.acceptAll'));
  reg('undoAllText', () => vscode.commands.executeCommand('claudeInlineDiff.rejectAll'));
  reg('nextFileText', () => navigateFile(1));
  reg('placeChangesView', () => placeChangesView(true));
  reg('reviewText', () => vscode.commands.executeCommand('claudeInlineDiff.reviewAll'));
  // ✕ / ✓ on a row of the Claude Changes list (Cursor's Reject / Accept in the chat's file list).
  reg('undoFileItem', (n) => vscode.commands.executeCommand('claudeInlineDiff.rejectFile', n));
  reg('keepFileItem', (n) => vscode.commands.executeCommand('claudeInlineDiff.acceptFile', n));
  reg('reviewAll', async () => {
    const keys = review.pendingKeys();
    if (!keys.length) return;
    const resources = keys.map((k) => {
      const e = review.entries.get(k)!;
      const file = vscode.Uri.file(e.path);
      const base = vscode.Uri.from({ scheme: BASE_SCHEME, path: file.path, query: 'k=' + encodeURIComponent(e.key) });
      return [file, base, file];
    });
    try {
      await vscode.commands.executeCommand(
        'vscode.changes',
        `Claude changes (${M.summaryText(keys.length, review.totals().changes)})`,
        resources
      );
    } catch {
      await vscode.commands.executeCommand('claudeInlineDiff.showDiff');
    }
  });
  reg('listFiles', async () => {
    const keys = review.pendingKeys();
    if (!keys.length) {
      void vscode.window.showInformationMessage('No Claude changes to review.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      keys.map((k) => {
        const e = review.entries.get(k)!;
        return {
          label: path.basename(e.path),
          description: vscode.workspace.asRelativePath(e.path),
          detail: M.plural(review.hunks(k).length, 'change'),
          key: k,
        };
      }),
      { title: 'Claude changes to review' }
    );
    if (pick) await openAt(pick.key, review.hunks(pick.key)[0]);
  });
  reg('installHooks', installHooks);
  reg('fixKeybindings', () => fixKeybindings());
  reg('uninstallHooks', uninstallHooks);
  reg('hookStatus', hookStatus);
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
