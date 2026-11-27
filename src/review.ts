// ReviewManager: the single source of truth for what Claude changed and what
// is still waiting for review. Rendering, views and commands all read from it.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Hunk, splitLines, diffLines, eolOf } from './core/diff';
import { hunksFromRegions, acceptInRegions, applyEdit } from './core/regions';
import * as M from './core/model';
import * as S from './core/store';

export interface HunkRef {
  key: string;
  aStart: number;
  bStart: number;
}
interface FileUndo {
  key: string;
  path: string;
  entryBefore: S.Entry | null; // null = there was no review entry
  textBefore: string | null; // null = text unchanged by the action; '\0deleted' = file did not exist
  textAfter: string | null;
}
export interface HistoryItem {
  kind: 'accept' | 'reject' | 'revertStep';
  label: string;
  files: FileUndo[];
  docVersions: Map<string, number>; // after the action, to know if native Ctrl+Z may mean "undo this"
}

export const DELETED = '\0deleted';
const HISTORY_LIMIT = 100;
const EMPTY_GRACE_MS = 10 * 60_000; // an empty review that never landed (permission prompt) waits this long

export function cfg<T>(name: string, fallback: T): T {
  return vscode.workspace.getConfiguration('claudeInlineDiff').get<T>(name, fallback);
}

/**
 * `storage.location` only as the user set it. The registry default is not used: a window that starts
 * while Cursor still holds an older manifest (default `project` before 0.1.27) would rewrite the shared
 * config and send every project's snapshots back into the project.
 */
function explicitStorage(): string | undefined {
  const i = vscode.workspace.getConfiguration('claudeInlineDiff').inspect<string>('storage.location');
  return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
}

export class ReviewManager implements vscode.Disposable {
  /** key -> entry, for every store this window looks at */
  entries = new Map<string, S.Entry>();
  activity: S.Activity[] = [];
  steps: S.Step[] = [];
  /** Sessions of this window's own chats (see M.ownSessions), refreshed with the steps. */
  private own = new Set<string>();
  history: HistoryItem[] = [];
  private memo = new Map<string, { baseline: string; text: string; hunks: Hunk[]; regions?: S.Region[] }>();
  private diskCache = new Map<string, { mtimeMs: number; size: number; text: string }>();
  private docText = new Map<string, string>(); // last known text of open docs under review
  private ownEdits = new Map<string, number>();
  private stores: string[] = [];
  private storeStamp = '';
  private seen = new Set<string>();
  private disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private changeTimer: NodeJS.Timeout | undefined;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly _onNewFile = new vscode.EventEmitter<S.Entry>();
  /** A file entered review for the first time (for reveal-on-edit). */
  readonly onNewFile = this._onNewFile.event;
  private readonly _onActivity = new vscode.EventEmitter<void>();
  readonly onActivity = this._onActivity.event;

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.disposables.push(
      this._onDidChange,
      this._onNewFile,
      this._onActivity,
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocChange(e)),
      vscode.workspace.onDidOpenTextDocument((d) => this.rememberDoc(d)),
      // A save during a Claude Bash command must not be mistaken for the command's change.
      vscode.workspace.onDidSaveTextDocument((d) => d.uri.scheme === 'file' && S.recordEditorWrite(S.realPath(d.uri.fsPath))),
      vscode.workspace.onDidCloseTextDocument((d) => d.uri.scheme === 'file' && this.docText.delete(S.keyOf(d.uri.fsPath))),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh(true)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeInlineDiff.storage')) {
          this.syncSharedConfig();
          this.moveStores();
          this.refresh(true);
        }
      })
    );
    this.syncSharedConfig();
    this.moveStores();
    this.refresh(true);
    this.timer = setInterval(() => this.poll(), cfg('pollIntervalMs', 700));
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.disposables.forEach((d) => d.dispose());
  }

  // ---------- shared config / stores ----------

  sharedConfig(): S.SharedConfig {
    return {
      storage: explicitStorage() === 'project' ? 'project' : 'home',
      dirName: cfg('storage.projectDirName', S.STORE_DIR_NAME_DEFAULT),
      trackBash: cfg('trackBashEdits', true),
      stepRetentionDays: Math.max(1, cfg('stepRetentionDays', 7)),
    };
  }

  /**
   * The hook reads ~/.claude/inline-diff/config.json, so the editor setting reaches it. Written even when
   * it only holds defaults: an older hook's defaults may differ (it kept snapshots in the project).
   */
  syncSharedConfig(): void {
    const want = this.sharedConfig();
    const have = fs.existsSync(S.configPath()) ? S.readConfig() : null;
    if (JSON.stringify(want) !== JSON.stringify(have)) {
      try {
        S.writeConfig(want);
      } catch (e: any) {
        this.log.warn('cannot write shared config: ' + e.message);
      }
    }
  }

  /** Project roots of this window (real paths, like the hook's), each with its in-project store folders. */
  private projectRoots(): { root: string; inProject: string[] }[] {
    const dirName = this.sharedConfig().dirName;
    return (vscode.workspace.workspaceFolders || [])
      .filter((f) => f.uri.scheme === 'file')
      .map((f) => {
        const root = S.realPath(S.projectRootFor(f.uri.fsPath));
        return { root, inProject: [...new Set([path.join(root, dirName), path.join(S.realPath(f.uri.fsPath), dirName)])] };
      });
  }

  /** Both places are read, so a review started before a `storage` switch (or a failed move) still shows. */
  computeStores(): string[] {
    const out = new Set<string>([S.globalStoreDir()]);
    for (const p of this.projectRoots()) {
      out.add(S.homeProjectStoreDir(p.root));
      p.inProject.forEach((d) => out.add(d));
    }
    return [...out];
  }

  /** Moves each project's store to where `storage.location` says (e.g. an old .claude-review out of the project). */
  moveStores(): void {
    const home = this.sharedConfig().storage === 'home';
    for (const p of this.projectRoots()) {
      const homeDir = S.homeProjectStoreDir(p.root);
      for (const dir of p.inProject) {
        const [from, to] = home ? [dir, homeDir] : [homeDir, p.inProject[0]];
        try {
          if (S.moveStore(from, to)) this.log.info(`moved review store ${from} → ${to}`);
        } catch (e: any) {
          this.log.warn(`cannot move review store ${from} → ${to}: ${e?.message || e}`);
        }
      }
    }
  }

  // ---------- loading ----------

  private stamp(): string {
    const parts: string[] = [];
    for (const s of this.stores) {
      for (const sub of ['baselines', 'activity', 'steps', 'feedback', 'turns']) {
        try {
          parts.push(String(fs.statSync(path.join(s, sub)).mtimeMs));
        } catch {
          parts.push('-');
        }
      }
    }
    // Disk changes of files under review that are not open in an editor.
    for (const e of this.entries.values()) {
      if (this.openDoc(e.key)) continue;
      try {
        const st = fs.statSync(e.path);
        parts.push(st.mtimeMs + ':' + st.size);
      } catch {
        parts.push('x');
      }
    }
    return parts.join('|');
  }

  private poll(): void {
    const st = this.stamp();
    if (st !== this.storeStamp) this.refresh(false);
    // Stale activity expires on its own.
    if (this.activity.some((a) => Date.now() - a.ts > S.ACTIVITY_STALE_MS)) this.refresh(false);
    if (this.working !== this.computeWorking()) this.refresh(false);
  }

  /** Claude's turn is running (between the prompt and Stop), like Cursor's agent "generating". */
  working = false;

  private computeWorking(): boolean {
    const last = Math.max(0, ...this.stores.map((s) => S.lastTurnActivity(s)));
    return last > 0 && Date.now() - last < S.TURN_STALE_MS;
  }

  refresh(recomputeStores: boolean): void {
    if (recomputeStores) this.stores = this.computeStores();
    const global = S.globalStoreDir();
    const steps: S.Step[] = [];
    for (const s of this.stores) steps.push(...S.loadSteps(s));
    this.steps = steps.sort((a, b) => b.ts - a.ts);
    this.own = M.ownSessions(this.steps, global);
    const next = new Map<string, S.Entry>();
    for (const s of this.stores) {
      for (const e of S.loadEntries(s)) {
        // Like Cursor: a change belongs to the chat that made it. What a chat of another project changed in
        // this window's files is reviewed in that chat's window; this one does not know about it.
        if (!M.ownsEntry(e, global, this.own)) continue;
        const prev = next.get(e.key);
        if (!prev || e.createdAt < prev.createdAt) next.set(e.key, e);
      }
    }
    // Keep object identity where unchanged so caches stay warm.
    for (const [k, e] of next) {
      const old = this.entries.get(k);
      if (old && old.content === e.content && old.jsonPath === e.jsonPath) {
        old.landedAt = e.landedAt;
        // The hook adds a region per Claude edit without touching the baseline text.
        if (JSON.stringify(old.regions) !== JSON.stringify(e.regions)) old.regions = e.regions;
        next.set(k, old);
      }
    }
    this.entries = next;
    this.working = this.computeWorking();
    const acts: S.Activity[] = [];
    for (const s of this.stores) {
      for (const a of S.loadActivity(s)) if (s !== global || (!!a.sessionId && this.own.has(a.sessionId))) acts.push(a);
    }
    const actChanged = JSON.stringify(acts) !== JSON.stringify(this.activity);
    this.activity = acts.sort((a, b) => b.ts - a.ts);

    for (const e of this.entries.values()) {
      this.rememberDoc(this.openDoc(e.key));
      if (!this.seen.has(e.key)) {
        this.seen.add(e.key);
        if (this.hunks(e.key).length) this._onNewFile.fire(e);
        else this.seen.delete(e.key); // announce once it has a visible diff
      }
    }
    for (const k of this.seen) if (!this.entries.has(k)) this.seen.delete(k);
    this.cleanupResolved();
    this.storeStamp = this.stamp();
    if (actChanged) this._onActivity.fire();
    this.fireChange();
  }

  /** Entries with nothing left to review are finished: remove them. */
  private cleanupResolved(): void {
    for (const e of [...this.entries.values()]) {
      if (this.hunks(e.key).length) continue;
      const inFlight = this.activity.some((a) => S.keyOf(a.path) === e.key);
      const landed = e.landedAt > 0 || e.source === 'bash';
      if (inFlight) continue;
      // Claude's write is on disk but the open editor has not reloaded it yet: the "no changes" is stale.
      const disk = this.readDisk(e.key, e.path);
      if (e.existed ? disk !== null && disk !== e.content : disk !== null) continue;
      if (landed || Date.now() - e.createdAt > EMPTY_GRACE_MS) this.dropEntry(e);
    }
  }

  fireChange(): void {
    this._onDidChange.fire();
  }

  // ---------- texts ----------

  openDoc(key: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && !d.isClosed && S.keyOf(d.uri.fsPath) === key);
  }

  private readDisk(key: string, p: string): string | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      this.diskCache.delete(key);
      return null;
    }
    const hit = this.diskCache.get(key);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
    try {
      const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
      this.diskCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, text });
      return text;
    } catch {
      return null;
    }
  }

  /** The file as it is now; '' if it was deleted (shows as all-removed); null if unknown. */
  currentText(key: string): string | null {
    const e = this.entries.get(key);
    if (!e) return null;
    const doc = this.openDoc(key);
    if (doc) return doc.getText();
    const t = this.readDisk(key, e.path);
    if (t !== null) return t;
    return e.existed ? '' : null;
  }

  fileExists(key: string): boolean {
    const e = this.entries.get(key);
    return !!e && (!!this.openDoc(key) || fs.existsSync(e.path));
  }

  hunks(key: string): Hunk[] {
    const e = this.entries.get(key);
    if (!e) return [];
    const text = this.currentText(key);
    if (text === null) return [];
    const hit = this.memo.get(key);
    if (hit && hit.baseline === e.content && hit.text === text && hit.regions === e.regions) return hit.hunks;
    let hunks: Hunk[];
    if (!e.existed && !this.fileExists(key))
      hunks = []; // created then deleted: nothing to show
    else if (e.existed && !this.fileExists(key)) hunks = [{ aStart: 0, aLines: splitLines(e.content), bStart: 0, bLines: [] }];
    else if (!e.existed)
      hunks = diffLines([], splitLines(text)); // created by Claude: all of it is one added change (no "before" lines)
    else {
      const a = splitLines(e.content);
      const b = splitLines(text);
      // Grouped per Claude edit, like Cursor; a whole-file diff when the regions no longer fit the texts.
      hunks = (e.regions && hunksFromRegions(a, b, e.regions)) || diffLines(a, b);
    }
    this.memo.set(key, { baseline: e.content, text, hunks, regions: e.regions });
    return hunks;
  }

  eolFor(key: string): string {
    const doc = this.openDoc(key);
    if (doc) return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const e = this.entries.get(key);
    return eolOf(this.currentText(key) || e?.content || '');
  }

  /** Files with something to review in this window (only changes it owns are loaded, see refresh), sorted by path. */
  pendingKeys(): string[] {
    return [...this.entries.keys()].filter((k) => this.hunks(k).length > 0).sort((a, b) => a.localeCompare(b));
  }

  // ---------- chat history (Claude Changes once everything is reviewed, like Cursor's chat file list) ----------

  /** The chat of this window's project that got the most recent prompt (see M.currentSession). */
  currentSession(): string | undefined {
    return M.currentSession(this.steps, S.globalStoreDir()); // steps are sorted newest first
  }

  /** Steps of this window's own chats that changed a file (the Claude Steps list). */
  ownSteps(): S.Step[] {
    return this.steps.filter((s) => this.own.has(s.sessionId) && s.files.length > 0);
  }

  /**
   * Every file the current chat changed, in this project or outside it, with its text from before the chat first
   * touched it (null: the chat created it). Files whose changes were undone stay, like in Cursor.
   */
  sessionFiles(): { key: string; path: string; before: string | null }[] {
    const session = this.currentSession();
    if (!session) return [];
    const global = S.globalStoreDir();
    const first = new Map<string, { key: string; path: string; before: string | null }>();
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const s = this.steps[i];
      if (s.sessionId !== session) continue;
      for (const f of s.files) {
        // Claude Code's own working files (memory, plans) recorded by hooks before 1.0.7 are not the chat's changes.
        if (s.storeDir === global && S.isClaudeInternal(f.path, undefined)) continue;
        const key = S.keyOf(f.path);
        if (!first.has(key)) first.set(key, { key, path: f.path, before: f.existed ? f.content : null });
      }
    }
    return [...first.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  /** A history file as it is now (open editor first), or null when it does not exist. */
  textNow(key: string, p: string): string | null {
    return this.openDoc(key)?.getText() ?? this.readDisk(key, p);
  }

  /** +added/-removed of a history file: from before the chat (none when the chat created it) to now. */
  sessionDiff(before: string | null, now: string | null): Hunk[] {
    return diffLines(before === null ? [] : splitLines(before), now === null ? [] : splitLines(now));
  }

  /** The current chat's text of a file from before the chat touched it ('' when the chat created it). */
  sessionBefore(key: string): string {
    return this.sessionFiles().find((f) => f.key === key)?.before ?? '';
  }

  totals(): { files: number; changes: number } {
    const keys = this.pendingKeys();
    return { files: keys.length, changes: keys.reduce((n, k) => n + this.hunks(k).length, 0) };
  }

  /** Claude touched this file a moment ago (tool call in flight, or its write just landed). */
  claudeJustWrote(key: string, windowMs = 6000): boolean {
    const e = this.entries.get(key);
    return this.isClaudeEditing(key) || (!!e && Date.now() - Math.max(e.landedAt, e.createdAt) < windowMs);
  }

  isClaudeEditing(key: string): boolean {
    return this.activity.some((a) => S.keyOf(a.path) === key && Date.now() - a.ts < S.ACTIVITY_STALE_MS);
  }

  // ---------- user edits ----------

  private rememberDoc(doc: vscode.TextDocument | undefined): void {
    if (!doc || doc.uri.scheme !== 'file') return;
    const key = S.keyOf(doc.uri.fsPath);
    if (this.entries.has(key)) this.docText.set(key, doc.getText());
  }

  isOwn(key: string): boolean {
    return (this.ownEdits.get(key) || 0) > 0;
  }

  private onDocChange(e: vscode.TextDocumentChangeEvent): void {
    const doc = e.document;
    if (doc.uri.scheme !== 'file' || !e.contentChanges.length) return;
    const key = S.keyOf(doc.uri.fsPath);
    const entry = this.entries.get(key);
    if (!entry) return;
    const prevText = this.docText.get(key);
    this.docText.set(key, doc.getText());
    const isUndoRedo = e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo;
    if (isUndoRedo) this.syncHistoryWithNativeUndo(key, doc);
    const absorb =
      cfg('absorbUserEdits', true) &&
      !this.isOwn(key) &&
      !isUndoRedo && // undoing a reject must bring Claude's change back, not bake it into the baseline
      !this.matchesDisk(doc) && // a reload from disk (Claude's write) makes the document equal the file
      !this.isClaudeEditing(key) && // Claude Code's IDE integration may edit through the editor
      prevText !== undefined;
    if (process.env.CLAUDE_INLINE_DIFF_TRACE)
      this.log.info(
        `doc change ${path.basename(doc.uri.fsPath)}: own=${this.isOwn(key)} undo=${isUndoRedo} disk=${this.matchesDisk(doc)} claude=${this.isClaudeEditing(key)} prev=${prevText !== undefined} → absorb=${absorb}`
      );
    if (absorb) {
      const baseHunks = diffLines(splitLines(entry.content), splitLines(prevText!));
      const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      const next = M.absorbUserEdits(entry.content, baseHunks, e.contentChanges, eol);
      if (next !== null) {
        entry.content = next;
        if (entry.regions) {
          // Last change first, so earlier line numbers stay valid.
          let rs = entry.regions;
          for (const c of [...e.contentChanges].sort((x, y) => y.range.start.line - x.range.start.line)) {
            const oldLen = c.range.end.line - c.range.start.line + 1;
            const newLen = c.text.split(/\r\n|\n/).length;
            rs = applyEdit(rs, c.range.start.line, oldLen, newLen, false);
          }
          entry.regions = rs;
        }
        this.safeWrite(entry);
      }
    }
    this.scheduleChange();
  }

  /** True when the document text equals the file on disk (i.e. the change was a reload, not typing). */
  private matchesDisk(doc: vscode.TextDocument): boolean {
    try {
      return fs.readFileSync(doc.uri.fsPath, 'utf8').replace(/^\uFEFF/, '') === doc.getText();
    } catch {
      return false;
    }
  }

  /** Native Ctrl+Z after a reject restores Claude's text: drop the matching history item. */
  private syncHistoryWithNativeUndo(key: string, doc: vscode.TextDocument): void {
    const top = this.history[this.history.length - 1];
    if (!top || top.kind !== 'reject' || top.files.length !== 1) return;
    const f = top.files[0];
    if (f.key === key && f.textBefore !== null && f.textBefore === doc.getText()) {
      this.history.pop();
      if (f.entryBefore && !this.entries.has(key)) this.restoreEntry(f.entryBefore);
    }
  }

  private scheduleChange(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.cleanupResolved();
      this.fireChange();
    }, 60);
  }

  // ---------- persistence ----------

  private safeWrite(e: S.Entry): void {
    try {
      S.writeEntry(e);
    } catch (err: any) {
      this.log.error('cannot write baseline: ' + err.message);
    }
    this.storeStamp = this.stamp();
  }

  private dropEntry(e: S.Entry): void {
    S.removeEntry(e);
    if (this.entries.get(e.key) === e) this.entries.delete(e.key);
    this.memo.delete(e.key);
    this.docText.delete(e.key);
    this.storeStamp = this.stamp();
  }

  private restoreEntry(snap: S.Entry): S.Entry {
    const e = { ...snap };
    this.safeWrite(e);
    this.entries.set(e.key, e);
    this.rememberDoc(this.openDoc(e.key));
    return e;
  }

  private snapshot(key: string): S.Entry | null {
    const e = this.entries.get(key);
    return e ? { ...e } : null;
  }

  /** Writes text into the file through the editor (keeps undo history), or the disk for a missing file. */
  async setText(key: string, abs: string, text: string | typeof DELETED, save: boolean): Promise<void> {
    this.ownEdits.set(key, (this.ownEdits.get(key) || 0) + 1);
    try {
      const uri = vscode.Uri.file(abs);
      if (text === DELETED) {
        // Files Claude created go to the trash (recoverable), never a hard delete.
        await this.closeTabs(uri);
        try {
          await vscode.workspace.fs.delete(uri, { useTrash: true });
        } catch {
          try {
            await vscode.workspace.fs.delete(uri, { useTrash: false });
          } catch {
            /* already gone */
          }
        }
        S.recordEditorWrite(abs); // saved documents are recorded by onDidSaveTextDocument
        this.diskCache.delete(key);
        return;
      }
      if (!fs.existsSync(abs)) {
        // Missing on disk (e.g. undoing a trashed file): recreate it; an open document reloads from disk.
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text);
        S.recordEditorWrite(abs);
        this.diskCache.delete(key);
        return;
      }
      const doc = this.openDoc(key) || (await vscode.workspace.openTextDocument(uri));
      const before = doc.getText();
      const edit = M.minimalEdit(before, text);
      if (edit) {
        const we = new vscode.WorkspaceEdit();
        we.replace(uri, new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)), edit.text);
        await vscode.workspace.applyEdit(we);
      }
      this.docText.set(key, doc.getText());
      if (save && doc.isDirty) await doc.save();
    } finally {
      this.ownEdits.set(key, (this.ownEdits.get(key) || 1) - 1);
    }
  }

  private async closeTabs(uri: vscode.Uri): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (doc?.isDirty) await doc.save(); // avoid a "save changes?" prompt for a file we are about to trash
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath === uri.fsPath);
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }

  private pushHistory(item: Omit<HistoryItem, 'docVersions'>): void {
    const docVersions = new Map<string, number>();
    for (const f of item.files) {
      const d = this.openDoc(f.key);
      if (d) docVersions.set(f.key, d.version);
    }
    this.history.push({ ...item, docVersions });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
  }

  /**
   * True when the newest action is a Keep or an Undo on this document and the doc was not edited since:
   * Cmd/Ctrl+Z then reverts that action (the change comes back for review), not just the text.
   */
  canRevertLastAction(key: string): boolean {
    const top = this.history[this.history.length - 1];
    if (!top || (top.kind !== 'accept' && top.kind !== 'reject') || !top.files.some((f) => f.key === key)) return false;
    const d = this.openDoc(key);
    return !!d && top.docVersions.get(key) === d.version;
  }

  // ---------- review actions ----------

  resolveHunk(ref: HunkRef): Hunk | undefined {
    const hunks = this.hunks(ref.key);
    return hunks.find((h) => h.aStart === ref.aStart && h.bStart === ref.bStart) || M.hunkAtLine(hunks, ref.bStart);
  }

  async acceptHunk(ref: HunkRef): Promise<boolean> {
    const e = this.entries.get(ref.key);
    const h = this.resolveHunk(ref);
    if (!e || !h) return false;
    const before = this.snapshot(ref.key);
    // A created file is one change: keeping it makes the whole text the baseline (line maths would add an EOL).
    e.content = e.existed ? M.acceptHunkInBaseline(e.content, h, this.eolFor(ref.key)) : (this.currentText(ref.key) ?? '');
    if (e.regions) e.regions = acceptInRegions(e.regions, h);
    this.safeWrite(e);
    this.pushHistory({
      kind: 'accept',
      label: 'Accept change',
      files: [{ key: e.key, path: e.path, entryBefore: before, textBefore: null, textAfter: null }],
    });
    this.finish(e.key);
    return true;
  }

  async rejectHunk(ref: HunkRef): Promise<boolean> {
    const e = this.entries.get(ref.key);
    const h = this.resolveHunk(ref);
    if (!e || !h) return false;
    const before = this.snapshot(ref.key);
    const exists = this.fileExists(e.key);
    const cur = this.currentText(e.key) ?? '';
    let next: string | typeof DELETED;
    if (!exists)
      next = e.content; // file was deleted by Claude: bring it back
    else {
      next = M.rejectHunkInText(cur, h, this.eolFor(e.key));
      // Rejecting the last change of a file Claude created deletes it again.
      if (!e.existed && next === '' && this.hunks(e.key).length === 1) next = DELETED;
    }
    if (e.regions && exists) {
      // The baseline's lines go back inside the change's region.
      e.regions = applyEdit(e.regions, h.bStart, h.bLines.length, h.aLines.length, true);
      this.safeWrite(e);
    }
    await this.setText(e.key, e.path, next, cfg('saveAfterReject', true));
    this.pushHistory({
      kind: 'reject',
      label: 'Reject change',
      files: [{ key: e.key, path: e.path, entryBefore: before, textBefore: exists ? cur : DELETED, textAfter: next }],
    });
    this.memo.delete(e.key);
    this.finish(e.key);
    return true;
  }

  /** True when rejecting would move a file Claude created to the trash. */
  rejectDeletesFile(key: string, wholeFile: boolean): boolean {
    const e = this.entries.get(key);
    if (!e || e.existed || !this.fileExists(key)) return false;
    return wholeFile || this.hunks(key).length === 1;
  }

  async acceptFiles(keys: string[], label = 'Accept file'): Promise<number> {
    const files: FileUndo[] = [];
    for (const key of keys) {
      const e = this.entries.get(key);
      if (!e) continue;
      files.push({ key, path: e.path, entryBefore: { ...e }, textBefore: null, textAfter: null });
      this.dropEntry(e);
    }
    if (files.length) this.pushHistory({ kind: 'accept', label, files });
    this.fireChange();
    return files.length;
  }

  async rejectFiles(keys: string[], label = 'Reject file'): Promise<number> {
    const files: FileUndo[] = [];
    for (const key of keys) {
      const e = this.entries.get(key);
      if (!e) continue;
      const exists = this.fileExists(key);
      const cur = exists ? (this.currentText(key) ?? '') : DELETED;
      const target = e.existed ? e.content : DELETED;
      await this.setText(key, e.path, target, cfg('saveAfterReject', true));
      files.push({ key, path: e.path, entryBefore: { ...e }, textBefore: cur, textAfter: target });
      this.dropEntry(e);
    }
    if (files.length) this.pushHistory({ kind: 'reject', label, files });
    this.fireChange();
    return files.length;
  }

  /** Restores the files touched by `step` and every later step of the same session to how they were before `step`. */
  async revertStep(step: S.Step): Promise<number> {
    const later = this.steps.filter((s) => s.sessionId === step.sessionId && s.ts >= step.ts).sort((a, b) => a.ts - b.ts);
    const target = new Map<string, S.StepFile>();
    for (const s of later) for (const f of s.files) if (!target.has(S.keyOf(f.path))) target.set(S.keyOf(f.path), f);
    const files: FileUndo[] = [];
    for (const [key, f] of target) {
      const exists = fs.existsSync(f.path);
      const cur = exists ? (this.openDoc(key)?.getText() ?? fs.readFileSync(f.path, 'utf8')) : DELETED;
      const next = f.existed ? f.content : DELETED;
      if (cur === next) continue;
      await this.setText(key, f.path, next, true);
      files.push({ key, path: f.path, entryBefore: this.snapshot(key), textBefore: cur, textAfter: next });
    }
    for (const s of later) S.removeStep(s);
    if (files.length) this.pushHistory({ kind: 'revertStep', label: 'Revert step', files });
    this.refresh(false);
    return files.length;
  }

  async undo(): Promise<HistoryItem | undefined> {
    const item = this.history.pop();
    if (!item) return undefined;
    for (const f of item.files) {
      if (f.textBefore !== null) await this.setText(f.key, f.path, f.textBefore, cfg('saveAfterReject', true));
      const cur = this.entries.get(f.key);
      if (f.entryBefore) this.restoreEntry(f.entryBefore);
      else if (cur) this.dropEntry(cur);
      this.memo.delete(f.key);
    }
    this.fireChange();
    return item;
  }

  /** After an action: if a file has nothing left, its review is done. */
  private finish(key: string): void {
    const e = this.entries.get(key);
    if (e && this.hunks(key).length === 0) this.dropEntry(e);
    this.fireChange();
  }

  // ---------- feedback ----------

  queueFeedback(key: string, text: string, excerpt?: string): S.Feedback | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    // Same store as the file's snapshot: the hook created it there, and reads feedback from there.
    return S.queueFeedback(e.storeDir, { sessionId: e.sessionId, path: e.path, text, excerpt, ts: Date.now() });
  }

  /** Feedback waiting for Claude to pick it up (shown in the status bar tooltip). */
  pendingFeedbackCount(): number {
    return this.stores.reduce((n, s) => n + S.pendingFeedback(s).length, 0);
  }

  storeDirs(): string[] {
    return this.stores;
  }
}
