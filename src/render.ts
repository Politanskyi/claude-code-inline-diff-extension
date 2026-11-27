// Draws a file's review in its editors: green added lines (removed words marked only with highlightWords),
// removed code as inset blocks (or a decoration fallback with hover), and
// overview-ruler (scrollbar) markers. Updates are debounced.
import * as vscode from 'vscode';
import * as S from './core/store';
import { Hunk, wordDiff } from './core/diff';
import { hunkStat, hunkAtLine, nearestHunk, keyLabels } from './core/model';
import { ReviewManager, cfg } from './review';
import { InsetManager, InsetBlock } from './insets';

const color = (id: string) => new vscode.ThemeColor('claudeInlineDiff.' + id);

export class Renderer implements vscode.Disposable {
  private addedLine = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: color('addedLineBackground'),
    overviewRulerColor: color('addedGutter'),
    overviewRulerLane: vscode.OverviewRulerLane.Right, // Cursor: added on the right, pure deletions on the left
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
  /** Last place the user touched per document (cursor or mouse hover): Cursor's pill follows it. */
  private interaction = new Map<string, number>();

  constructor(
    private readonly review: ReviewManager,
    insets: InsetManager,
    private readonly log?: vscode.LogOutputChannel
  ) {
    this.insets = insets;
    this.disposables.push(
      this.addedLine,
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
        this.interaction.set(e.textEditor.document.uri.toString(), e.selections[0].active.line);
        if (cfg<string>('hunkToolbar', 'cursor') !== 'all' && this.useInsets()) this.schedule(30);
      }),
      // No mouse-move API for extensions: a hover provider is told where the mouse rests over text.
      vscode.languages.registerHoverProvider(
        { scheme: 'file' },
        {
          provideHover: (doc, pos) => {
            if (cfg<string>('hunkToolbar', 'cursor') !== 'cursor' || !this.review.entries.has(S.keyOf(doc.uri.fsPath))) return undefined;
            const k = doc.uri.toString();
            if (this.interaction.get(k) !== pos.line) {
              this.interaction.set(k, pos.line);
              this.schedule(0);
            }
            return undefined;
          },
        }
      ),
      vscode.window.onDidChangeActiveColorTheme(() => this.schedule(0)),
      vscode.workspace.onDidChangeConfiguration(
        (e) => (e.affectsConfiguration('claudeInlineDiff') || e.affectsConfiguration('editor')) && this.schedule(0)
      )
    );
  }

  /** Whether Keep/Undo pills are drawn under changes (so CodeLens is not needed). */
  useToolbars(): boolean {
    return this.useInsets() && cfg<string>('hunkToolbar', 'cursor') !== 'off';
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
    const words = cfg('highlightWords', false);
    // Like Cursor's performance protection: past 100 changes, no removed blocks and no pills.
    const heavy = hunks.length > 100;
    const insets = this.useInsets() && !heavy;
    const maxLines = cfg('deletedLines.maxLines', 30);
    const added: vscode.Range[] = [];
    const above: vscode.DecorationOptions[] = [];
    const below: vscode.DecorationOptions[] = [];
    const hints: vscode.DecorationOptions[] = [];
    const ruler: vscode.Range[] = [];
    const blocks: InsetBlock[] = [];
    const tbMode = insets ? cfg<string>('hunkToolbar', 'cursor') : 'off';
    const cursorLine = editor.selection.active.line;
    const activeHunk = tbMode === 'active' ? hunkAtLine(hunks, cursorLine) : tbMode === 'cursor' ? this.pillHunk(editor, hunks) : undefined;

    hunks.forEach((h, index) => {
      const ref = { key, aStart: h.aStart, bStart: h.bStart };
      const wantToolbar = tbMode === 'all' || activeHunk === h;
      const toolbar = wantToolbar ? { index: index + 1, total: hunks.length } : undefined;
      const wd = words && h.aLines.length && h.bLines.length ? wordDiff(h.aLines, h.bLines) : null;
      // Mostly rewritten lines: word highlights would just be noise.
      const showWords = wd && wd.addedRatio < 0.7;
      for (let i = 0; i < h.bLines.length; i++) {
        const line = h.bStart + i;
        if (line <= last) added.push(new vscode.Range(line, 0, line, 0));
      }
      // Like Cursor: added lines are one colour; changed words are marked only inside removed lines.
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
      if (!h.aLines.length || heavy) return;
      // The hover sits on the whole-line rule only: it covers the hint too, and a second copy showed it twice.
      {
        const hover = this.hoverFor(h, doc.languageId, ref);
        const n = h.aLines.length;
        const hintText = `−${n} line${n === 1 ? '' : 's'} removed (hover to see)`;
        if (h.bStart <= last) {
          above.push({ range: new vscode.Range(h.bStart, 0, h.bStart, 0), hoverMessage: hover });
          hints.push({ range: lineEnd(doc, h.bStart), renderOptions: { after: { contentText: hintText } } });
        } else {
          below.push({ range: new vscode.Range(last, 0, last, 0), hoverMessage: hover });
          hints.push({ range: lineEnd(doc, last), renderOptions: { after: { contentText: hintText } } });
        }
      }
    });
    editor.setDecorations(this.addedLine, added);
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

  /**
   * The one change that shows the pill, like Cursor: nearest to where the user last was (cursor or
   * mouse); if that change is scrolled out of view, the first change whose pill line is visible.
   */
  private pillHunk(editor: vscode.TextEditor, hunks: Hunk[]): Hunk | undefined {
    const line = this.interaction.get(editor.document.uri.toString()) ?? editor.selection.active.line;
    const h = nearestHunk(hunks, line);
    const pillLine = (x: Hunk) => (x.bLines.length ? x.bStart + x.bLines.length - 1 : Math.max(0, x.bStart - 1));
    const visible = (l: number) => editor.visibleRanges.some((r) => l >= r.start.line && l <= r.end.line);
    if (!h || !editor.visibleRanges.length || visible(pillLine(h))) return h;
    return hunks.find((x) => visible(pillLine(x))) || h;
  }

  private hoverFor(h: Hunk, languageId: string, ref: { key: string; aStart: number; bStart: number }): vscode.MarkdownString {
    const k = keyLabels(process.platform === 'darwin', cfg<string>('keybindingScheme', 'both'));
    const max = cfg('deletedLines.maxLines', 30) * 3;
    const lines = h.aLines.length > max ? [...h.aLines.slice(0, max), `… ${h.aLines.length - max} more`] : h.aLines;
    const fence = '````';
    const arg = encodeURIComponent(JSON.stringify([ref]));
    const md = new vscode.MarkdownString(
      `**Removed by Claude** (${hunkStat(h)})\n\n${fence}${languageId}\n${lines.join('\n')}\n${fence}\n\n` +
        `[$(check) Keep](command:claudeInlineDiff.acceptHunk?${arg}) ${k.keep} · ` +
        `[$(discard) Undo](command:claudeInlineDiff.rejectHunk?${arg}) ${k.undo} · ` +
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
    for (const d of [this.addedLine, this.removedAbove, this.removedBelow, this.removedHint, this.removedRuler])
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

function lineEnd(doc: vscode.TextDocument, line: number): vscode.Range {
  const l = doc.lineAt(Math.min(line, doc.lineCount - 1));
  return new vscode.Range(l.range.end, l.range.end);
}
