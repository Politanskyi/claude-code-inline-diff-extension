// Removed code drawn as real red blocks between editor lines, using the
// proposed `editorInsets` API (vscode.window.createWebviewTextEditorInset).
// Written from scratch against the API's public shape; feature-detected at
// runtime, so the extension works (with decorations) when the API is absent.
//
// Enable: package.json has "enabledApiProposals": ["editorInsets"]; the user
// adds "enable-proposed-api": ["inlinediff.claude-inline-diff"] to argv.json.
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { CharRange } from './core/diff';
import { tokenizeLines, TokenKind } from './core/highlight';
import { currentPalette, Palette } from './theme';
import { HunkRef } from './review';

/** Our own declaration of the proposed API surface we use. */
interface WebviewEditorInset {
  readonly webview: vscode.Webview;
  readonly onDidDispose: vscode.Event<void>;
  dispose(): void;
}
type CreateInset = (editor: vscode.TextEditor, line: number, height: number, options?: vscode.WebviewOptions) => WebviewEditorInset;

let probed: CreateInset | null | undefined;

/** The inset factory, or undefined when the proposed API is not enabled for us. */
export function insetApi(): CreateInset | undefined {
  if (probed !== undefined) return probed || undefined;
  try {
    // Accessing a proposed API that is not enabled throws; a missing one is undefined.
    const f = (vscode.window as any).createWebviewTextEditorInset;
    probed = typeof f === 'function' ? (f.bind(vscode.window) as CreateInset) : null;
  } catch {
    probed = null;
  }
  return probed || undefined;
}

export interface InsetBlock {
  /** 0-based line the block is drawn after; -1 = above the first line. */
  afterLine: number;
  lines: string[];
  removed: CharRange[]; // word-level removed ranges, relative to `lines`
  languageId: string;
  ref: HunkRef;
  buttons: boolean;
  stat: string;
}

export interface InsetActions {
  accept(ref: HunkRef): void;
  reject(ref: HunkRef): void;
  feedback(ref: HunkRef): void;
}

interface Live {
  inset: WebviewEditorInset;
  sig: string;
  disposed: boolean;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Editor metrics, so blocks line up with real lines. */
export function editorMetrics(doc?: vscode.TextDocument) {
  const c = vscode.workspace.getConfiguration('editor', doc);
  const fontSize = c.get<number>('fontSize', 14) || 14;
  let lh = c.get<number>('lineHeight', 0) || 0;
  if (lh > 0 && lh < 8) lh = Math.round(lh * fontSize); // multiplier form
  if (lh === 0) lh = Math.round(fontSize * (process.platform === 'darwin' ? 1.5 : 1.35));
  return {
    fontSize,
    lineHeight: lh,
    fontFamily: c.get<string>('fontFamily', 'monospace'),
    fontWeight: c.get<string>('fontWeight', 'normal'),
    tabSize: c.get<number>('tabSize', 4) || 4,
    ligatures: c.get<unknown>('fontLigatures', false),
  };
}

const KIND_STYLE = (p: Palette, k: TokenKind) => {
  const s = p[k];
  if (!s || !s.color) return '';
  const fs = s.fontStyle || '';
  return `color:${s.color};${fs.includes('italic') ? 'font-style:italic;' : ''}${fs.includes('bold') ? 'font-weight:bold;' : ''}`;
};

/** Renders one line's tokens with removed-word highlights layered on top. */
export function renderLine(tokens: { kind: TokenKind; text: string }[], removed: CharRange[], palette: Palette): string {
  // Split tokens at removed-range boundaries.
  const cuts = new Set<number>();
  for (const r of removed) {
    cuts.add(r.start);
    cuts.add(r.end);
  }
  let col = 0;
  let html = '';
  for (const t of tokens) {
    let i = 0;
    while (i < t.text.length) {
      let j = i + 1;
      while (j < t.text.length && !cuts.has(col + j)) j++;
      const piece = t.text.slice(i, j);
      const start = col + i;
      const inRemoved = removed.some((r) => start >= r.start && start < r.end);
      const style = KIND_STYLE(palette, t.kind);
      const cls = inRemoved ? ' class="w"' : '';
      html += style || cls ? `<span${cls}${style ? ` style="${style}"` : ''}>${esc(piece)}</span>` : esc(piece);
      i = j;
    }
    col += t.text.length;
  }
  return html || '&#8203;';
}

/** Column just past the first removed line's text (tabs expanded), where the buttons float. */
export function btnLeftCh(line: string, tabSize: number): number {
  let col = 0;
  for (const ch of line.replace(/\s+$/, '')) col = ch === '\t' ? col + tabSize - (col % tabSize) : col + 1;
  return Math.max(col, 20);
}

export function insetHtml(
  block: InsetBlock,
  shownLines: string[],
  hidden: number,
  nonce: string,
  palette: Palette,
  m: ReturnType<typeof editorMetrics>
): string {
  const tokens = tokenizeLines(shownLines, block.languageId);
  const body = shownLines
    .map((_, i) =>
      renderLine(
        tokens[i],
        block.removed.filter((r) => r.line === i),
        palette
      )
    )
    .map((h) => `<div class="l">${h}</div>`)
    .join('');
  const more = hidden
    ? `<div class="l more">⋯ ${hidden} more removed line${hidden === 1 ? '' : 's'} — hover the change or open the side-by-side diff</div>`
    : '';
  const isMac = process.platform === 'darwin';
  const buttons = block.buttons
    ? `<div class="btns"><span class="stat">${esc(block.stat)}</span>` +
      `<button class="rej" data-a="reject" title="Reject change (${isMac ? '⌘N' : 'Ctrl+N'})">Reject <kbd>${isMac ? '⌘N' : 'Ctrl+N'}</kbd></button>` +
      `<button class="acc" data-a="accept" title="Accept change (${isMac ? '⌘Y' : 'Ctrl+Y'})">Accept <kbd>${isMac ? '⌘Y' : 'Ctrl+Y'}</kbd></button>` +
      `<button class="fb" data-a="feedback" title="Reject and tell Claude why">…</button></div>`
    : '';
  const ff = m.fontFamily.replace(/</g, '');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
html,body{margin:0;padding:0;overflow:hidden;background:transparent}
body{font-family:${ff};font-size:${m.fontSize}px;font-weight:${m.fontWeight};tab-size:${m.tabSize};-moz-tab-size:${m.tabSize};
 font-feature-settings:${m.ligatures ? '"liga" 1, "calt" 1' : '"liga" 0, "calt" 0'};color:var(--vscode-editor-foreground)}
.l{height:${m.lineHeight}px;line-height:${m.lineHeight}px;white-space:pre;overflow:hidden;
 background:var(--vscode-claudeInlineDiff-removedLineBackground,rgba(248,81,73,.15));
 box-shadow:inset 3px 0 0 var(--vscode-claudeInlineDiff-removedGutter,#f85149)}
.w{background:var(--vscode-claudeInlineDiff-removedWordBackground,rgba(248,81,73,.4));border-radius:2px}
.more{font-style:italic;opacity:.75;font-family:var(--vscode-font-family);font-size:12px;padding-left:8px}
.btns{position:absolute;top:0;left:calc(${btnLeftCh(shownLines[0] || '', m.tabSize)}ch + 24px);height:${m.lineHeight}px;display:flex;align-items:center;gap:4px;opacity:.92}
.btns:hover{opacity:1}
.stat{font:11px var(--vscode-font-family);opacity:.7;margin-right:4px}
button{font:11px var(--vscode-font-family);height:${Math.max(16, m.lineHeight - 4)}px;padding:0 7px;border:0;border-radius:4px;cursor:pointer}
kbd{font:10px var(--vscode-font-family);opacity:.75;margin-left:4px}
.acc{background:var(--vscode-claudeInlineDiff-addedGutter,#2ea043);color:#fff}
.rej{background:var(--vscode-claudeInlineDiff-removedGutter,#f85149);color:#fff}
.fb{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
</style></head><body>${body}${more}${buttons}
<script nonce="${nonce}">const vs=acquireVsCodeApi();document.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>vs.postMessage({a:b.dataset.a})));</script>
</body></html>`;
}

export class InsetManager implements vscode.Disposable {
  private live = new Map<vscode.TextEditor, Map<string, Live>>();
  failed = false;

  constructor(
    private readonly actions: InsetActions,
    private readonly log: vscode.LogOutputChannel
  ) {}

  available(): boolean {
    return !this.failed && !!insetApi();
  }

  /** Shows exactly `blocks` in `editor` (reusing unchanged insets); only blocks near the visible range are drawn. */
  render(editor: vscode.TextEditor, blocks: InsetBlock[], maxLines: number): void {
    const create = insetApi();
    if (!create || this.failed) return;
    const m = editorMetrics(editor.document);
    const palette = currentPalette();
    const margin = 60;
    const vis = editor.visibleRanges;
    const near = (line: number) => !vis.length || vis.some((r) => line >= r.start.line - margin && line <= r.end.line + margin);
    const current = this.live.get(editor) || new Map<string, Live>();
    const next = new Map<string, Live>();
    for (const b of blocks) {
      if (!near(b.afterLine)) continue;
      const shown = b.lines.length > maxLines ? b.lines.slice(0, maxLines - 1) : b.lines;
      const hidden = b.lines.length - shown.length;
      const height = shown.length + (hidden ? 1 : 0);
      const sig = crypto
        .createHash('sha1')
        .update(JSON.stringify([b.afterLine, height, b.lines, b.removed, b.buttons, b.stat, b.languageId, m, palette]))
        .digest('hex');
      const reuse = current.get(sig);
      if (reuse && !reuse.disposed) {
        next.set(sig, reuse);
        current.delete(sig);
        continue;
      }
      try {
        const inset = create(editor, b.afterLine, height, { enableScripts: true, localResourceRoots: [] });
        const live: Live = { inset, sig, disposed: false };
        inset.onDidDispose(() => (live.disposed = true));
        inset.webview.onDidReceiveMessage((msg: { a?: string }) => {
          if (msg?.a === 'accept') this.actions.accept(b.ref);
          else if (msg?.a === 'reject') this.actions.reject(b.ref);
          else if (msg?.a === 'feedback') this.actions.feedback(b.ref);
        });
        inset.webview.html = insetHtml(b, shown, hidden, crypto.randomBytes(12).toString('base64'), palette, m);
        next.set(sig, live);
      } catch (e: any) {
        this.log.warn('editor inset failed, falling back to decorations: ' + (e?.message || e));
        this.failed = true;
        break;
      }
    }
    for (const old of current.values()) if (!old.disposed) old.inset.dispose();
    if (next.size) this.live.set(editor, next);
    else this.live.delete(editor);
  }

  clear(editor: vscode.TextEditor): void {
    for (const l of this.live.get(editor)?.values() || []) if (!l.disposed) l.inset.dispose();
    this.live.delete(editor);
  }

  /** Drops insets of editors that are no longer visible. */
  prune(visible: readonly vscode.TextEditor[]): void {
    for (const ed of [...this.live.keys()]) if (!visible.includes(ed)) this.clear(ed);
  }

  count(): number {
    let n = 0;
    for (const m of this.live.values()) n += m.size;
    return n;
  }

  dispose(): void {
    for (const ed of [...this.live.keys()]) this.clear(ed);
  }
}
