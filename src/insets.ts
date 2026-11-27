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

/** Cursor-style pill under a change: `⌃ 2 of 5 ⌄ | Undo ⌘N | Keep ⌘Y`. */
export interface Toolbar {
  index: number; // 1-based position of this change in the file
  total: number;
  /** Indentation (columns) of the change's last line: anchor used when the editor scrolls horizontally and the right edge is unknown. */
  anchorCols: number;
  /** Longest line in the document, in columns: tells the webview whether the editor overflows horizontally. */
  maxCols: number;
}

export interface InsetBlock {
  /** 0-based line the block is drawn after; -1 = above the first line. */
  afterLine: number;
  /** Removed lines to draw (may be empty for a toolbar-only block). */
  lines: string[];
  removed: CharRange[]; // word-level removed ranges, relative to `lines`
  languageId: string;
  ref: HunkRef;
  toolbar?: Toolbar;
}

export interface InsetActions {
  accept(ref: HunkRef): void;
  reject(ref: HunkRef): void;
  feedback(ref: HunkRef): void;
  navigate(ref: HunkRef, dir: 1 | -1): void;
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
    // An editor that scrolls sideways is this many columns (plus the scrollbar) wider than its longest line.
    scrollBeyond: c.get<number>('scrollBeyondLastColumn', 4) ?? 4,
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
        {} as Palette // one colour, like Cursor's removed lines
      )
    )
    .map((h) => `<div class="l">${h}</div>`)
    .join('');
  const more = hidden
    ? `<div class="l more">⋯ ${hidden} more removed line${hidden === 1 ? '' : 's'} — hover the change or open the side-by-side diff</div>`
    : '';
  const isMac = process.platform === 'darwin';
  const kY = isMac ? '⌘Y' : 'Ctrl+Y';
  const kN = isMac ? '⌘N' : 'Ctrl+N';
  const t = block.toolbar;
  const toolbar = t
    ? `<div class="tbrow"><div class="tb" id="tb" role="toolbar" aria-label="Change ${t.index} of ${t.total}">` +
      (t.total > 1
        ? `<div class="nav"><button class="ic" data-a="prev" title="Previous change" aria-label="Previous change">${CHEVRON_UP}</button>` +
          `<span class="ctr">${t.index} of ${t.total}</span>` +
          `<button class="ic" data-a="next" title="Next change" aria-label="Next change">${CHEVRON_DOWN}</button></div>`
        : '') +
      `<button class="b sec" data-a="reject" title="Undo this change (${kN})">Undo<span class="k">${kN}</span></button>` +
      `<button class="b pri" data-a="accept" title="Keep this change (${kY})">Keep</button>` +
      `<button class="b sec more-b" data-a="feedback" title="Undo and tell Claude why…">…</button>` +
      `</div></div>`
    : '';
  const ff = m.fontFamily.replace(/</g, '');
  const pillH = Math.min(22, m.lineHeight);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
html,body{margin:0;padding:0;overflow:hidden;background:transparent}
body{font-family:${ff};font-size:${m.fontSize}px;font-weight:${m.fontWeight};tab-size:${m.tabSize};-moz-tab-size:${m.tabSize};
 font-feature-settings:${m.ligatures ? '"liga" 1, "calt" 1' : '"liga" 0, "calt" 0'};color:var(--vscode-editor-foreground)}
/* Removed code, as Cursor draws it: theme removed-line background, the text in one colour (the editor's at 75%, no syntax colours), no gutter bar. */
.l{height:${m.lineHeight}px;line-height:${m.lineHeight}px;white-space:pre;overflow:hidden;
 color:color-mix(in srgb,var(--vscode-editor-foreground) 75%,transparent);
 background:var(--vscode-claudeInlineDiff-removedLineBackground,var(--vscode-diffEditor-removedLineBackground,rgba(242,13,59,.15)))}
.w{background:var(--vscode-claudeInlineDiff-removedWordBackground,rgba(242,13,59,.25));box-shadow:inset 1px 0 rgba(242,13,59,.25),inset -1px 0 rgba(242,13,59,.25)}
.more{font-style:italic;opacity:.75;font-family:var(--vscode-font-family);font-size:12px;padding-left:8px}
/* Toolbar row: Cursor's acceptRejectPartialEditWidget — pill attached under the change, right edge next to the scrollbar. */
.tbrow{position:relative;height:${m.lineHeight}px}
.tb{position:absolute;top:0;right:18px;border-top-left-radius:0;display:flex;flex-direction:row;gap:2px;height:${pillH}px;align-items:stretch;
 font-family:var(--vscode-font-family);font-size:12px;border-bottom-left-radius:4px;border-bottom-right-radius:4px}
.nav{display:flex;align-items:center;gap:3px;padding:0 7px;border-radius:4px;color:var(--vscode-editor-foreground);
 background:color-mix(in srgb,var(--vscode-editor-foreground) 5.5%,var(--vscode-editor-background))}
.ctr{min-width:36px;text-align:center;font-variant-numeric:tabular-nums;white-space:nowrap}
.ic{background:none;border:0;padding:0 2px;margin:0;cursor:pointer;color:inherit;display:flex;align-items:center;opacity:.8}
.ic:hover{opacity:1}
.ic svg{width:14px;height:14px;fill:currentColor}
.b{display:flex;align-items:center;gap:5px;border:0;border-radius:4px;padding:0 7px;cursor:pointer;font:inherit;white-space:nowrap}
.pri{padding:0 6px;background:color-mix(in srgb,var(--vscode-charts-green,#2ea043) 85%,transparent);color:var(--vscode-button-foreground,#fff)}
.pri:hover{background:var(--vscode-charts-green,#2ea043)}
/* Measured on Cursor's pill: editor background, a faint border (the text colour at 11%). */
.sec{background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);
 box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--vscode-editor-foreground) 11%,var(--vscode-editor-background))}
.sec:hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2))}
.k{opacity:.7;font-size:12px}
.more-b{padding:0 5px}
</style></head><body>${body}${more}${toolbar}
<script nonce="${nonce}">
const vs=acquireVsCodeApi();
document.querySelectorAll('button').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();vs.postMessage({a:b.dataset.a})}));
${
  t
    ? `// Right-aligned like Cursor's pill, at the right edge of what is visible. The inset is as wide as the
// editor's scroll width, which can be wider than the editor, so the pill watches how much of it the
// editor clips (IntersectionObserver sees clipping by the parent frames) and moves left by that much.
(()=>{const tb=document.getElementById('tb');
// A 1px probe as wide as the inset: the part of it the editor shows is the visible span, even when the pill is hidden.
const probe=document.createElement('div');probe.style.cssText='position:absolute;left:0;top:0;width:100%;height:1px;pointer-events:none';
document.querySelector('.tbrow').appendChild(probe);
const th=[];for(let i=0;i<=20;i++)th.push(i/20);
new IntersectionObserver((es)=>{const e=es[es.length-1];const r=e.intersectionRect,b=e.boundingClientRect;
if(r.width<=0)return; // scrolled out of view
tb.style.left='auto';tb.style.right=Math.max(0,b.right-r.right)+18+'px';},{threshold:th}).observe(probe);})();`
    : ''
}
</script>
</body></html>`;
}

const CHEVRON_UP = '<svg viewBox="0 0 16 16"><path d="M8 5.3 3.6 9.7l.7.7L8 6.7l3.7 3.7.7-.7z"/></svg>';
const CHEVRON_DOWN = '<svg viewBox="0 0 16 16"><path d="M8 10.7 3.6 6.3l.7-.7L8 9.3l3.7-3.7.7.7z"/></svg>';

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
      const height = shown.length + (hidden ? 1 : 0) + (b.toolbar ? 1 : 0);
      const sig = crypto
        .createHash('sha1')
        .update(JSON.stringify([b.afterLine, height, b.lines, b.removed, b.toolbar, b.ref, b.languageId, m, palette]))
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
          else if (msg?.a === 'next') this.actions.navigate(b.ref, 1);
          else if (msg?.a === 'prev') this.actions.navigate(b.ref, -1);
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
