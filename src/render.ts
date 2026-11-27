// Draws a file's review in its editors: green added lines + word highlights,
// removed code as inset blocks (or a decoration fallback with hover), and
// overview-ruler (scrollbar) markers. Updates are debounced.
import * as vscode from 'vscode';
import * as S from './core/store';
import { Hunk, wordDiff } from './core/diff';
import { hunkStat } from './core/model';
import { ReviewManager, cfg } from './review';
import { InsetManager, InsetBlock } from './insets';

const color = (id: string) => new vscode.ThemeColor('claudeInlineDiff.' + id);

export class Renderer implements vscode.Disposable {
  private addedLine = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: color('addedLineBackground'),
    overviewRulerColor: color('addedGutter'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    borderColor: color('addedGutter'),
    borderStyle: 'solid',
    borderWidth: '0 0 0 3px',
  });
  private addedWord = vscode.window.createTextEditorDecorationType({ backgroundColor: color('addedWordBackground'), borderRadius: '2px' });
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
  private timer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];
  readonly insets: InsetManager;

  constructor(
    private readonly review: ReviewManager,
    insets: InsetManager
  ) {
    this.insets = insets;
    this.disposables.push(
      this.addedLine,
      this.addedWord,
      this.removedAbove,
      this.removedBelow,
      this.removedHint,
      this.removedRuler,
      review.onDidChange(() => this.schedule()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule(0)),
      vscode.window.onDidChangeTextEditorVisibleRanges(() => this.schedule(120)),
      vscode.window.onDidChangeActiveColorTheme(() => this.schedule(0)),
      vscode.workspace.onDidChangeConfiguration(
        (e) => (e.affectsConfiguration('claudeInlineDiff') || e.affectsConfiguration('editor')) && this.schedule(0)
      )
    );
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
    this.insets.prune(vscode.window.visibleTextEditors);
    for (const ed of vscode.window.visibleTextEditors) this.render(ed);
  }

  render(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== 'file') return;
    const key = S.keyOf(editor.document.uri.fsPath);
    const hunks = this.review.entries.has(key) ? this.review.hunks(key) : [];
    if (!hunks.length) {
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

    for (const h of hunks) {
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
      if (!h.aLines.length) continue;
      const ref = { key, aStart: h.aStart, bStart: h.bStart };
      if (insets) {
        blocks.push({
          afterLine: h.bStart - 1,
          lines: h.aLines,
          removed: showWords ? wd!.removed : [],
          languageId: doc.languageId,
          ref,
          buttons: true,
          stat: hunkStat(h),
        });
        const at = Math.min(Math.max(h.bStart, 0), last);
        ruler.push(new vscode.Range(at, 0, at, 0));
      } else {
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
    }
    editor.setDecorations(this.addedLine, added);
    editor.setDecorations(this.addedWord, addedWords);
    editor.setDecorations(this.removedAbove, above);
    editor.setDecorations(this.removedBelow, below);
    editor.setDecorations(this.removedHint, hints);
    editor.setDecorations(this.removedRuler, ruler);
    if (insets) this.insets.render(editor, blocks, maxLines);
    else this.insets.clear(editor);
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
        `[$(check) Accept](command:claudeInlineDiff.acceptHunk?${arg}) ${isMac ? '⌘Y' : 'Ctrl+Y'} · ` +
        `[$(discard) Reject](command:claudeInlineDiff.rejectHunk?${arg}) ${isMac ? '⌘N' : 'Ctrl+N'} · ` +
        `[$(diff) Side-by-side](command:claudeInlineDiff.showDiff)`,
      true
    );
    md.isTrusted = { enabledCommands: ['claudeInlineDiff.acceptHunk', 'claudeInlineDiff.rejectHunk', 'claudeInlineDiff.showDiff'] };
    return md;
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

function lineEnd(doc: vscode.TextDocument, line: number): vscode.Range {
  const l = doc.lineAt(Math.min(line, doc.lineCount - 1));
  return new vscode.Range(l.range.end, l.range.end);
}
