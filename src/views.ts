// Status bar ("N files · M changes" + prev/next, "Claude editing <file>"),
// Explorer/tab badges, CodeLens Accept/Reject, and the "Claude Changes" /
// "Claude Steps" trees in the Source Control container.
import * as vscode from 'vscode';
import * as path from 'path';
import * as S from './core/store';
import { Hunk } from './core/diff';
import { hunkStat, summaryText, hunkAnchorLine, plural } from './core/model';
import { ReviewManager, cfg } from './review';

const isMac = process.platform === 'darwin';
const KEY = {
  y: isMac ? '⌘Y' : 'Ctrl+Y',
  n: isMac ? '⌘N' : 'Ctrl+N',
  sy: isMac ? '⇧⌘Y' : 'Ctrl+Shift+Y',
  sn: isMac ? '⇧⌘N' : 'Ctrl+Shift+N',
};

// ---------- status bar ----------

export class StatusBar implements vscode.Disposable {
  private main = vscode.window.createStatusBarItem('claudeInlineDiff.summary', vscode.StatusBarAlignment.Left, 1000);
  private prev = vscode.window.createStatusBarItem('claudeInlineDiff.prev', vscode.StatusBarAlignment.Left, 999);
  private next = vscode.window.createStatusBarItem('claudeInlineDiff.next', vscode.StatusBarAlignment.Left, 998);
  private editing = vscode.window.createStatusBarItem('claudeInlineDiff.editing', vscode.StatusBarAlignment.Left, 1001);
  private disposables: vscode.Disposable[];

  constructor(private readonly review: ReviewManager) {
    this.main.name = 'Claude Inline Diff: changes to review';
    this.prev.name = 'Claude Inline Diff: previous change';
    this.next.name = 'Claude Inline Diff: next change';
    this.editing.name = 'Claude Inline Diff: Claude is editing';
    this.prev.text = '$(chevron-up)';
    this.prev.tooltip = 'Previous Claude change (Shift+Alt+F5)';
    this.prev.command = 'claudeInlineDiff.prevHunk';
    this.next.text = '$(chevron-down)';
    this.next.tooltip = 'Next Claude change (Alt+F5)';
    this.next.command = 'claudeInlineDiff.nextHunk';
    this.main.command = 'claudeInlineDiff.listFiles';
    this.disposables = [
      this.main,
      this.prev,
      this.next,
      this.editing,
      review.onDidChange(() => this.update()),
      review.onActivity(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
    ];
    this.update();
  }

  update(): void {
    const { files, changes } = this.review.totals();
    if (files) {
      this.main.text = `$(sparkle) ${summaryText(files, changes)}`;
      const fb = this.review.pendingFeedbackCount();
      const md = new vscode.MarkdownString(
        `**Claude changes to review**\n\n${KEY.y} accept · ${KEY.n} reject (cursor in a change)\n\n${KEY.sy} / ${KEY.sn} accept / reject file` +
          (fb ? `\n\n$(comment) ${plural(fb, 'feedback note')} waiting for Claude's next turn` : ''),
        true
      );
      this.main.tooltip = md;
      this.main.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.main.show();
      this.prev.show();
      this.next.show();
    } else {
      this.main.hide();
      this.prev.hide();
      this.next.hide();
    }
    const act = this.review.activity.find((a) => Date.now() - a.ts < 60_000);
    if (act) {
      this.editing.text = `$(loading~spin) Claude editing ${path.basename(act.path)}`;
      this.editing.tooltip = act.path;
      this.editing.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(act.path)] };
      this.editing.show();
    } else this.editing.hide();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

// ---------- Explorer / tab badges ----------

export class Badges implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private reg: vscode.Disposable;
  private sub: vscode.Disposable;

  constructor(private readonly review: ReviewManager) {
    this.reg = vscode.window.registerFileDecorationProvider(this);
    this.sub = review.onDidChange(() => this._onDidChange.fire(undefined));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    const key = S.keyOf(uri.fsPath);
    if (!this.review.entries.has(key)) return undefined;
    const n = this.review.hunks(key).length;
    if (!n) return undefined;
    const e = this.review.entries.get(key)!;
    const d = new vscode.FileDecoration(
      n > 9 ? '9+' : String(n),
      `Claude: ${plural(n, 'change')} to review${e.existed ? '' : ' (new file)'}`,
      new vscode.ThemeColor('claudeInlineDiff.badgeForeground')
    );
    d.propagate = true;
    return d;
  }

  dispose(): void {
    this.reg.dispose();
    this.sub.dispose();
    this._onDidChange.dispose();
  }
}

// ---------- CodeLens ----------

export class Lenses implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;
  private disposables: vscode.Disposable[];

  constructor(
    private readonly review: ReviewManager,
    private readonly insetsActive: () => boolean
  ) {
    this.disposables = [
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
      review.onDidChange(() => this._onDidChange.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('claudeInlineDiff') && this._onDidChange.fire()),
      this._onDidChange,
    ];
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!cfg('showCodeLens', true)) return [];
    const key = S.keyOf(doc.uri.fsPath);
    const hunks = this.review.entries.has(key) ? this.review.hunks(key) : [];
    if (!hunks.length) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    const out: vscode.CodeLens[] = [
      new vscode.CodeLens(top, { title: `$(sparkle) Claude: ${plural(hunks.length, 'change')}`, command: 'claudeInlineDiff.nextHunk' }),
      new vscode.CodeLens(top, { title: `Accept file ${KEY.sy}`, command: 'claudeInlineDiff.acceptFile', arguments: [doc.uri] }),
      new vscode.CodeLens(top, { title: `Reject file ${KEY.sn}`, command: 'claudeInlineDiff.rejectFile', arguments: [doc.uri] }),
    ];
    if (this.review.pendingKeys().length > 1)
      out.push(new vscode.CodeLens(top, { title: 'Next file →', command: 'claudeInlineDiff.nextFile' }));
    const insets = this.insetsActive();
    for (const h of hunks) {
      if (insets && h.aLines.length) continue; // the red block carries its own Accept / Reject buttons
      const line = Math.min(hunkAnchorLine(h), doc.lineCount - 1);
      const r = new vscode.Range(line, 0, line, 0);
      const ref = { key, aStart: h.aStart, bStart: h.bStart };
      out.push(
        new vscode.CodeLens(r, { title: `$(check) Accept ${KEY.y}`, command: 'claudeInlineDiff.acceptHunk', arguments: [ref] }),
        new vscode.CodeLens(r, { title: `$(discard) Reject ${KEY.n}`, command: 'claudeInlineDiff.rejectHunk', arguments: [ref] }),
        new vscode.CodeLens(r, {
          title: '$(comment) Reject with feedback',
          command: 'claudeInlineDiff.rejectHunkWithFeedback',
          arguments: [ref],
        }),
        new vscode.CodeLens(r, { title: hunkStat(h), command: '' })
      );
    }
    return out;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

// ---------- Claude Changes tree ----------

type Node =
  | { kind: 'session'; id: string; keys: string[] }
  | { kind: 'file'; key: string }
  | { kind: 'hunk'; key: string; hunk: Hunk; index: number };

export class ChangesTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  readonly view: vscode.TreeView<Node>;
  private sub: vscode.Disposable;

  constructor(private readonly review: ReviewManager) {
    this.view = vscode.window.createTreeView('claudeInlineDiff.changes', { treeDataProvider: this, showCollapseAll: true });
    this.sub = review.onDidChange(() => {
      this._onDidChange.fire(undefined);
      const t = review.totals();
      this.view.badge = t.changes ? { value: t.changes, tooltip: summaryText(t.files, t.changes) } : undefined;
      this.view.description = t.files ? summaryText(t.files, t.changes) : undefined;
    });
  }

  private sessions(): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const k of this.review.pendingKeys()) {
      const sid = this.review.entries.get(k)?.sessionId || 'unknown';
      m.set(sid, [...(m.get(sid) || []), k]);
    }
    return m;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const s = this.sessions();
      if (s.size <= 1) return this.review.pendingKeys().map((key) => ({ kind: 'file', key }));
      return [...s].map(([id, keys]) => ({ kind: 'session', id, keys }));
    }
    if (node.kind === 'session') return node.keys.map((key) => ({ kind: 'file', key }));
    if (node.kind === 'file') return this.review.hunks(node.key).map((hunk, index) => ({ kind: 'hunk', key: node.key, hunk, index }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'session') {
      const first = Math.min(...node.keys.map((k) => this.review.entries.get(k)?.createdAt || Date.now()));
      const it = new vscode.TreeItem(`Session ${node.id.slice(0, 8)}`, vscode.TreeItemCollapsibleState.Expanded);
      it.description = `${plural(node.keys.length, 'file')} · since ${new Date(first).toLocaleTimeString()}`;
      it.iconPath = new vscode.ThemeIcon('comment-discussion');
      it.contextValue = 'session';
      return it;
    }
    if (node.kind === 'file') {
      const e = this.review.entries.get(node.key)!;
      const hunks = this.review.hunks(node.key);
      const it = new vscode.TreeItem(vscode.Uri.file(e.path), vscode.TreeItemCollapsibleState.Collapsed);
      const rel = vscode.workspace.asRelativePath(path.dirname(e.path));
      it.description = `${rel === path.dirname(e.path) ? '' : rel + ' · '}${plural(hunks.length, 'change')}${e.existed ? '' : ' · new'}${e.source === 'bash' ? ' · via Bash' : ''}`;
      it.contextValue = 'file';
      it.command = { command: 'claudeInlineDiff.openFile', title: 'Open', arguments: [node.key] };
      return it;
    }
    const h = node.hunk;
    const firstLine = (h.bLines.find((l) => l.trim()) || h.aLines.find((l) => l.trim()) || '').trim();
    const it = new vscode.TreeItem(`L${hunkAnchorLine(h) + 1}  ${firstLine.slice(0, 60)}`, vscode.TreeItemCollapsibleState.None);
    it.description = hunkStat(h);
    it.iconPath = new vscode.ThemeIcon(
      h.aLines.length && h.bLines.length ? 'diff-modified' : h.bLines.length ? 'diff-added' : 'diff-removed'
    );
    it.contextValue = 'hunk';
    it.command = {
      command: 'claudeInlineDiff.revealHunk',
      title: 'Show',
      arguments: [{ key: node.key, aStart: h.aStart, bStart: h.bStart }],
    };
    return it;
  }

  dispose(): void {
    this.sub.dispose();
    this.view.dispose();
    this._onDidChange.dispose();
  }
}

/** Tree node → command argument (tree inline actions pass the node). */
export function refFromNode(n: any): { key: string; aStart: number; bStart: number } | undefined {
  if (n && n.kind === 'hunk') return { key: n.key, aStart: n.hunk.aStart, bStart: n.hunk.bStart };
  return undefined;
}
export function keysFromNode(n: any): string[] | undefined {
  if (n?.kind === 'file') return [n.key];
  if (n?.kind === 'session') return n.keys;
  return undefined;
}

// ---------- Claude Steps tree ----------

export class StepsTree implements vscode.TreeDataProvider<S.Step>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  readonly view: vscode.TreeView<S.Step>;
  private sub: vscode.Disposable;

  constructor(private readonly review: ReviewManager) {
    this.view = vscode.window.createTreeView('claudeInlineDiff.steps', { treeDataProvider: this });
    this.sub = review.onDidChange(() => this._onDidChange.fire());
  }

  getChildren(node?: S.Step): S.Step[] {
    if (node) return [];
    return this.review.steps.filter((s) => s.files.some((f) => this.review.inScope(S.keyOf(f.path))));
  }

  getTreeItem(s: S.Step): vscode.TreeItem {
    const it = new vscode.TreeItem(s.prompt.replace(/\s+/g, ' ').slice(0, 80) || '(no prompt)');
    it.description = `${new Date(s.ts).toLocaleTimeString()} · ${plural(s.files.length, 'file')}`;
    it.tooltip = new vscode.MarkdownString(
      `**Step** ${new Date(s.ts).toLocaleString()} · session \`${s.sessionId.slice(0, 8)}\`\n\n${s.prompt}\n\n` +
        s.files.map((f) => `- ${vscode.workspace.asRelativePath(f.path)}`).join('\n')
    );
    it.iconPath = new vscode.ThemeIcon('history');
    it.contextValue = 'step';
    return it;
  }

  dispose(): void {
    this.sub.dispose();
    this.view.dispose();
    this._onDidChange.dispose();
  }
}
