// Draws a file's review in its editors: green added lines + word highlights,
// removed code as inset blocks (or a decoration fallback with hover), and
// overview-ruler (scrollbar) markers. Updates are debounced.
import * as vscode from 'vscode';
import * as S from './core/store';
import { Hunk, wordDiff } from './core/diff';
import { hunkStat, hunkAtLine } from './core/model';
import { ReviewManager, cfg } from './review';
import { InsetManager, InsetBlock } from './insets';

const color = (id: string) => new vscode.ThemeColor('claudeInlineDiff.' + id);

export class Renderer implements vscode.Disposable {
  private addedLine = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: color('addedLineBackground'),
    overviewRulerColor: color('addedGutter'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  // Cursor's .inline-diff-inner-change-added: rgba(12,233,27,.15) fill with a 1px edge in the same colour.
  private addedWord = vscode.window.createTextEditorDecorationType({
    backgroundColor: color('addedWordBackground'),
    borderColor: color('addedWordBackground'),
    borderStyle: 'solid',
    borderWidth: '0 1px',
  });
  /** Fallback: a red rule where lines were removed, with a "−N lines" hint and the old code on hover. */
  private removedAbove = vscode.window.createTextEditorDecorationType({
    borderColor: color('removedGutter'),
    borderStyle: 'solid',
    borderWidth: '2px 0 0 0',
    isWholeLine: true,
    overviewRulerColor: color('removedGutter'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private removedBelow = vscode.window.createTextEditorDecorationType({
    borderColor: color('removedGutter'),
    borderStyle: 'solid',
    borderWidth: '0 0 2px 0',
    isWholeLine: true,
    overviewRulerColor: color('removedGutter'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private removedHint = vscode.window.createTextEditorDecorationType({
    after: { color: color('removedGutter'), margin: '0 0 0 2em', fontStyle: 'italic' },
  });
  /** Marks removed-only positions on the scrollbar when insets draw the code. */
  private removedRuler = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: color('removedGutter'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  /** Brief glow on lines Claude just wrote (Cursor shows new agent edits the same way). */
  private flashDeco = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: color('addedWordBackground') });
  private flashTimers = new Map<vscode.TextEditor, NodeJS.Timeout>();
  private timer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];
  readonly insets: InsetManager;

  private lastDiag = new Map<string, string>();

  constructor(
    private readonly review: ReviewManager,
    insets: InsetManager,
    private readonly log?: vscode.LogOutputChannel
  ) {
    this.insets = insets;
    this.disposables.push(
      this.addedLine,
      this.addedWord,
      this.flashDeco,
      this.removedAbove,
      this.removedBelow,
      this.removedHint,
      this.removedRuler,
      review.onDidChange(() => this.schedule()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule(0)),
      vscode.window.tabGroups.onDidChangeTabs(() => this.schedule(0)),
      vscode.window.onDidChangeTextEditorVisibleRanges(() => this.schedule(120)),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (cfg<string>('hunkToolbar', 'all') === 'active' && this.useInsets()) this.schedule(30);
        void e;
      }),
      vscode.window.onDidChangeActiveColorTheme(() => this.schedule(0)),
      vscode.workspace.onDidChangeConfiguration(
        (e) => (e.affectsConfiguration('claudeInlineDiff') || e.affectsConfiguration('editor')) && this.schedule(0)
      )
    );
  }

  /** Whether Keep/Undo pills are drawn under changes (so CodeLens is not needed). */
  useToolbars(): boolean {
    return this.useInsets() && cfg<string>('hunkToolbar', 'all') !== 'off';
  }

  /** Whether removed code is drawn as inset blocks right now. */
  useInsets(): boolean {
    const mode = cfg<string>('deletedLines.renderer', 'auto');
    return mode !== 'decoration' && this.insets.available();
  }

  schedule(delay = 40): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.renderAll(), delay);
  }

  renderAll(): void {
    try {
      this.insets.prune(vscode.window.visibleTextEditors);
    } catch (e: any) {
      this.log?.error('prune failed: ' + (e?.stack || e));
    }
    for (const ed of vscode.window.visibleTextEditors) {
      try {
        this.render(ed);
      } catch (e: any) {
        this.log?.error(`render failed for ${ed.document.uri.fsPath}: ${e?.stack || e}`);
      }
    }
  }

  /** Snapshot of what the renderer sees, for `.claude-review/debug` requests. */
  debugState(): unknown {
    const ed = (e: vscode.TextEditor) => ({
      uri: e.document.uri.toString(),
      key: e.document.uri.scheme === 'file' ? S.keyOf(e.document.uri.fsPath) : null,
      viewColumn: e.viewColumn,
      plain: isPlainTextEditor(e),
      underReview: e.document.uri.scheme === 'file' && this.review.entries.has(S.keyOf(e.document.uri.fsPath)),
      hunks: e.document.uri.scheme === 'file' ? this.review.hunks(S.keyOf(e.document.uri.fsPath)).length : 0,
      visibleRanges: e.visibleRanges.map((r) => [r.start.line, r.end.line]),
    });
    return {
      visibleTextEditors: vscode.window.visibleTextEditors.map(ed),
      activeTextEditor: vscode.window.activeTextEditor ? ed(vscode.window.activeTextEditor) : null,
      tabGroups: vscode.window.tabGroups.all.map((g) => ({
        viewColumn: g.viewColumn,
        isActive: g.isActive,
        tabs: g.tabs.map((t) => ({
          label: t.label,
          active: t.isActive,
          input: t.input ? t.input.constructor?.name : null,
          uri: (t.input as any)?.uri?.toString(),
        })),
      })),
      entries: [...this.review.entries.keys()],
      useInsets: this.useInsets(),
      useToolbars: this.useToolbars(),
      insetsLive: this.insets.count(),
      insetsFailed: this.insets.failed,
      lastDiag: Object.fromEntries(this.lastDiag),
    };
  }

  /** Logs one line per editor whenever what we decide for it changes (helps diagnose "nothing is drawn"). */
  private diag(editor: vscode.TextEditor, msg: string): void {
    const k = editor.document.uri.toString() + '#' + String(editor.viewColumn);
    if (this.lastDiag.get(k) === msg) return;
    this.lastDiag.set(k, msg);
    this.log?.info(`render ${editor.document.uri.fsPath} [col ${editor.viewColumn}]: ${msg}`);
  }

  render(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== 'file') {
      this.diag(editor, `not a file (scheme ${editor.document.uri.scheme})`);
      return;
    }
    if (!isPlainTextEditor(editor)) {
      this.diag(editor, 'skipped (shown inside a diff editor)');
      this.clear(editor); // inside a (multi-)diff editor the diff is already shown natively
      return;
    }
    const key = S.keyOf(editor.document.uri.fsPath);
    const hunks = this.review.entries.has(key) ? this.review.hunks(key) : [];
    if (!hunks.length) {
      this.diag(editor, this.review.entries.has(key) ? 'no changes' : 'not under review');
      this.clear(editor);
      return;
    }
    const doc = editor.document;
    const last = doc.lineCount - 1;
    const words = cfg('highlightWords', true);
    const insets = this.useInsets();
    const maxLines = cfg('deletedLines.maxLines', 30);
    const added: vscode.Range[] = [];
    const addedWords: vscode.Range[] = [];
    const above: vscode.DecorationOptions[] = [];
    const below: vscode.DecorationOptions[] = [];
    const hints: vscode.DecorationOptions[] = [];
    const ruler: vscode.Range[] = [];
    const blocks: InsetBlock[] = [];
    const isMac = process.platform === 'darwin';
    const tbMode = insets ? cfg<string>('hunkToolbar', 'all') : 'off';
    const cursorLine = editor.selection.active.line;
    const activeHunk = tbMode === 'active' ? hunkAtLine(hunks, cursorLine) : undefined;
    const maxCols = tbMode !== 'off' ? maxColumns(doc, editor.options.tabSize as number) : 0;
    const tabSize = (editor.options.tabSize as number) || 4;

    hunks.forEach((h, index) => {
      const ref = { key, aStart: h.aStart, bStart: h.bStart };
      const wantToolbar = tbMode === 'all' || (tbMode === 'active' && activeHunk === h);
      const lastText = h.bLines.length ? h.bLines[h.bLines.length - 1] : h.aLines[h.aLines.length - 1] || '';
      const toolbar = wantToolbar
        ? {
            index: index + 1,
            total: hunks.length,
            anchorCols: columns(lastText.slice(0, lastText.length - lastText.trimStart().length), tabSize),
            maxCols,
          }
        : undefined;
      const wd = words && h.aLines.length && h.bLines.length ? wordDiff(h.aLines, h.bLines) : null;
      // Mostly rewritten lines: word highlights would just be noise.
      const showWords = wd && wd.addedRatio < 0.7;
      for (let i = 0; i < h.bLines.length; i++) {
        const line = h.bStart + i;
        if (line <= last) added.push(new vscode.Range(line, 0, line, 0));
      }
      if (showWords) {
        for (const r of wd!.added) {
          const line = h.bStart + r.line;
          if (line <= last) addedWords.push(new vscode.Range(line, r.start, line, r.end));
        }
      }
      if (insets) {
        // Red block above the change; the pill goes under the change (inside the red block for a pure deletion).
        if (h.aLines.length) {
          blocks.push({
            afterLine: h.bStart - 1,
            lines: h.aLines,
            removed: showWords ? wd!.removed : [],
            languageId: doc.languageId,
            ref,
            toolbar: h.bLines.length ? undefined : toolbar,
          });
          const at = Math.min(Math.max(h.bStart, 0), last);
          ruler.push(new vscode.Range(at, 0, at, 0));
        }
        if (h.bLines.length && toolbar) {
          blocks.push({
            afterLine: Math.min(h.bStart + h.bLines.length - 1, last),
            lines: [],
            removed: [],
            languageId: doc.languageId,
            ref,
            toolbar,
          });
        }
        return;
      }
      if (!h.aLines.length) return;
      {
        const hover = this.hoverFor(h, doc.languageId, ref, isMac);
        const n = h.aLines.length;
        const hintText = `−${n} line${n === 1 ? '' : 's'} removed (hover to see)`;
        if (h.bStart <= last) {
          above.push({ range: new vscode.Range(h.bStart, 0, h.bStart, 0), hoverMessage: hover });
          hints.push({ range: lineEnd(doc, h.bStart), hoverMessage: hover, renderOptions: { after: { contentText: hintText } } });
        } else {
          below.push({ range: new vscode.Range(last, 0, last, 0), hoverMessage: hover });
          hints.push({ range: lineEnd(doc, last), hoverMessage: hover, renderOptions: { after: { contentText: hintText } } });
        }
      }
    });
    editor.setDecorations(this.addedLine, added);
    editor.setDecorations(this.addedWord, addedWords);
    editor.setDecorations(this.removedAbove, above);
    editor.setDecorations(this.removedBelow, below);
    editor.setDecorations(this.removedHint, hints);
    editor.setDecorations(this.removedRuler, ruler);
    if (insets) this.insets.render(editor, blocks, maxLines);
    else this.insets.clear(editor);
    this.diag(
      editor,
      `${hunks.length} changes, ${added.length} added lines, ${insets ? `${blocks.length} inset blocks (${this.insets.count()} live${this.insets.failed ? ', FAILED' : ''})` : `fallback (${hints.length} removed hints)`}`
    );
  }

  private hoverFor(
    h: Hunk,
    languageId: string,
    ref: { key: string; aStart: number; bStart: number },
    isMac: boolean
  ): vscode.MarkdownString {
    const max = cfg('deletedLines.maxLines', 30) * 3;
    const lines = h.aLines.length > max ? [...h.aLines.slice(0, max), `… ${h.aLines.length - max} more`] : h.aLines;
    const fence = '````';
    const arg = encodeURIComponent(JSON.stringify([ref]));
    const md = new vscode.MarkdownString(
      `**Removed by Claude** (${hunkStat(h)})\n\n${fence}${languageId}\n${lines.join('\n')}\n${fence}\n\n` +
        `[$(check) Keep](command:claudeInlineDiff.acceptHunk?${arg}) ${isMac ? '⌘Y' : 'Ctrl+Y'} · ` +
        `[$(discard) Undo](command:claudeInlineDiff.rejectHunk?${arg}) ${isMac ? '⌘N' : 'Ctrl+N'} · ` +
        `[$(diff) Side-by-side](command:claudeInlineDiff.showDiff)`,
      true
    );
    md.isTrusted = { enabledCommands: ['claudeInlineDiff.acceptHunk', 'claudeInlineDiff.rejectHunk', 'claudeInlineDiff.showDiff'] };
    return md;
  }

  flash(editor: vscode.TextEditor, ranges: vscode.Range[], ms = 1400): void {
    editor.setDecorations(this.flashDeco, ranges);
    const old = this.flashTimers.get(editor);
    if (old) clearTimeout(old);
    this.flashTimers.set(
      editor,
      setTimeout(() => {
        editor.setDecorations(this.flashDeco, []);
        this.flashTimers.delete(editor);
      }, ms)
    );
  }

  clear(editor: vscode.TextEditor): void {
    for (const d of [this.addedLine, this.addedWord, this.removedAbove, this.removedBelow, this.removedHint, this.removedRuler])
      editor.setDecorations(d, []);
    this.insets.clear(editor);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }
}

/**
 * True for an editor shown in a normal text tab. Editors embedded in a diff or
 * multi-diff editor also appear in visibleTextEditors; drawing there would
 * duplicate the diff.
 */
export function isPlainTextEditor(editor: vscode.TextEditor): boolean {
  // Only skip when there is positive evidence of a diff showing this file and no plain tab
  // for it is active. editor.viewColumn can be undefined in some Cursor layouts, so it is not
  // used as evidence on its own.
  const uri = editor.document.uri.toString();
  const active = vscode.window.tabGroups.all.map((g) => g.activeTab?.input).filter((i) => i !== undefined);
  if (active.some((i) => i instanceof vscode.TabInputText && i.uri.toString() === uri)) return true;
  const inDiff = active.some(
    (i) =>
      (i instanceof vscode.TabInputTextDiff && (i.modified.toString() === uri || i.original.toString() === uri)) ||
      (typeof (vscode as any).TabInputTextMultiDiff === 'function' &&
        i instanceof (vscode as any).TabInputTextMultiDiff &&
        ((i as any).textDiffs || []).some((d: any) => d.modified?.toString() === uri || d.original?.toString() === uri))
  );
  return !inDiff;
}

/** Display columns of a line (tabs expanded). */
export function columns(line: string, tabSize: number): number {
  let col = 0;
  for (const ch of line) col = ch === '\t' ? col + tabSize - (col % tabSize) : col + 1;
  return col;
}

const maxColsCache = new WeakMap<vscode.TextDocument, { version: number; cols: number }>();
function maxColumns(doc: vscode.TextDocument, tabSize: number): number {
  const hit = maxColsCache.get(doc);
  if (hit && hit.version === doc.version) return hit.cols;
  let cols = 0;
  for (let i = 0; i < doc.lineCount; i++) cols = Math.max(cols, columns(doc.lineAt(i).text, tabSize || 4));
  maxColsCache.set(doc, { version: doc.version, cols });
  return cols;
}

function lineEnd(doc: vscode.TextDocument, line: number): vscode.Range {
  const l = doc.lineAt(Math.min(line, doc.lineCount - 1));
  return new vscode.Range(l.range.end, l.range.end);
}
