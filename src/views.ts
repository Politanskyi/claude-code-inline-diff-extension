// Status bar ("N files · M changes" + prev/next, "Claude editing <file>"), Explorer/tab badges,
// CodeLens (fallback when pills are off), the Claude Changes list (a webview under the Claude Code chat)
// and the Claude Steps tree (Source Control).
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as S from './core/store';
import { IconThemeDoc, iconIdFor, parseJsonc } from './core/iconTheme';
import { hunkStat, summaryText, hunkAnchorLine, plural, keyLabels, totals } from './core/model';
import { ReviewManager, cfg } from './review';
import { diffTexts } from './core/diff';

/** Shortcut labels under the current key scheme (read on use, so a settings change applies at once). */
const keys = () => keyLabels(process.platform === 'darwin', cfg<string>('keybindingScheme', 'both'));

// ---------- status bar ----------

export class StatusBar implements vscode.Disposable {
  private main = vscode.window.createStatusBarItem('claudeInlineDiff.summary', vscode.StatusBarAlignment.Left, 1000);
  private prev = vscode.window.createStatusBarItem('claudeInlineDiff.prev', vscode.StatusBarAlignment.Left, 999);
  private next = vscode.window.createStatusBarItem('claudeInlineDiff.next', vscode.StatusBarAlignment.Left, 998);
  private editing = vscode.window.createStatusBarItem('claudeInlineDiff.editing', vscode.StatusBarAlignment.Left, 1001);
  private disposables: vscode.Disposable[];

  constructor(
    private readonly review: ReviewManager,
    private readonly list?: ChangesPanel
  ) {
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
    // Opens the Claude Changes list (nicer than a quick pick); the editor keeps focus for Cmd+Y / Cmd+N.
    this.main.command = 'claudeInlineDiff.showChangesList';
    this.disposables = [
      this.main,
      this.prev,
      this.next,
      this.editing,
      review.onDidChange(() => this.update()),
      review.onActivity(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      ...(list ? [list.onDidChangeVisibility(() => this.update())] : []),
    ];
    this.update();
  }

  update(): void {
    const { files, changes } = this.review.totals();
    // The Claude Changes list already shows this; the summary is for when the list is closed.
    if (files && !this.list?.visible) {
      this.main.text = `$(sparkle) ${summaryText(files, changes)}`;
      const fb = this.review.pendingFeedbackCount();
      const md = new vscode.MarkdownString(
        `**Claude changes to review**\n\n${keys().keep} keep · ${keys().undo} undo (cursor in a change)\n\n${keys().fileKeep} keep file · ${keys().fileUndo} undo file` +
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
    private readonly toolbarsActive: () => boolean
  ) {
    this.disposables = [
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
      review.onDidChange(() => this._onDidChange.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('claudeInlineDiff') && this._onDidChange.fire()),
      this._onDidChange,
    ];
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const always = cfg('showCodeLens', false);
    const toolbars = this.toolbarsActive();
    // Cursor-style pills under each change (plus Undo File / Keep File in the title bar) replace CodeLens.
    if (!always && toolbars) return [];
    const key = S.keyOf(doc.uri.fsPath);
    const hunks = this.review.entries.has(key) ? this.review.hunks(key) : [];
    if (!hunks.length) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    const out: vscode.CodeLens[] = [
      new vscode.CodeLens(top, { title: `$(sparkle) Claude: ${plural(hunks.length, 'change')}`, command: 'claudeInlineDiff.nextHunk' }),
      new vscode.CodeLens(top, { title: `Undo File ${keys().fileUndo}`, command: 'claudeInlineDiff.rejectFile', arguments: [doc.uri] }),
      new vscode.CodeLens(top, { title: `Keep File ${keys().fileKeep}`, command: 'claudeInlineDiff.acceptFile', arguments: [doc.uri] }),
    ];
    if (this.review.pendingKeys().length > 1)
      out.push(new vscode.CodeLens(top, { title: 'Next file →', command: 'claudeInlineDiff.nextFile' }));
    if (toolbars) return out;
    hunks.forEach((h, i) => {
      const line = Math.min(hunkAnchorLine(h), doc.lineCount - 1);
      const r = new vscode.Range(line, 0, line, 0);
      const ref = { key, aStart: h.aStart, bStart: h.bStart };
      out.push(
        new vscode.CodeLens(r, { title: `${i + 1} of ${hunks.length}`, command: 'claudeInlineDiff.nextHunk' }),
        new vscode.CodeLens(r, { title: `$(discard) Undo ${keys().undo}`, command: 'claudeInlineDiff.rejectHunk', arguments: [ref] }),
        new vscode.CodeLens(r, { title: `$(check) Keep ${keys().keep}`, command: 'claudeInlineDiff.acceptHunk', arguments: [ref] }),
        new vscode.CodeLens(r, {
          title: '$(comment) Undo with feedback',
          command: 'claudeInlineDiff.rejectHunkWithFeedback',
          arguments: [ref],
        }),
        new vscode.CodeLens(r, { title: hunkStat(h), command: '' })
      );
    });
    return out;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

// ---------- Claude Changes list ----------

/**
 * The file list under the Claude Code chat, drawn like Cursor's list under its agent chat: a header
 * "N Files" with Undo All / Keep All / Review always visible (Undo All asks for a second click, like
 * Cursor), and one row per file with +added −removed and ✕ / ✓ on hover. A webview, because a tree
 * view can only put actions in its title bar, small and visible on hover.
 *
 * Like Cursor: while there are changes to review it lists only those; once everything is reviewed it
 * keeps listing every file the current Claude chat changed (its history; no Undo/Keep then), and a new
 * chat starts empty. Collapsed by default and only the user expands or collapses it, like Cursor's file
 * list, which it never opens by itself.
 * With nothing at all it shows an empty state, or the hook install button when the hook is missing.
 */
export class ChangesPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = 'claudeInlineDiff.changes';
  private view?: vscode.WebviewView;
  private hookReady = true;
  private readonly _onVisibility = new vscode.EventEmitter<void>();
  readonly onDidChangeVisibility = this._onVisibility.event;
  private disposables: vscode.Disposable[];
  private theme: { doc: IconThemeDoc; dir: vscode.Uri; root: vscode.Uri } | null | undefined;
  private langs: Map<string, string> | undefined;
  private historyStats = new Map<string, { before: string | null; now: string | null; added: number; removed: number }>();

  constructor(private readonly review: ReviewManager) {
    this.disposables = [
      vscode.window.registerWebviewViewProvider(ChangesPanel.id, this, { webviewOptions: { retainContextWhenHidden: false } }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('workbench.iconTheme') || !this.view) return;
        this.theme = undefined;
        this.setHtml(this.view);
      }),
      review.onDidChange(() => this.update()),
      this._onVisibility,
    ];
  }

  /** The list is on screen (so the status bar summary would only repeat it). */
  get visible(): boolean {
    return !!this.view?.visible;
  }

  setHookReady(ready: boolean): void {
    if (this.hookReady === ready) return;
    this.hookReady = ready;
    this.update();
  }

  /**
   * Shows (and expands) the list: `<id>.focus` (a command every view has), then focus goes back to
   * the editor so Cmd+Y / Cmd+N keep working.
   */
  async show(): Promise<void> {
    const hadEditor = !!vscode.window.activeTextEditor;
    await vscode.commands.executeCommand(ChangesPanel.id + '.focus');
    if (hadEditor) await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.setHtml(view);
    view.webview.onDidReceiveMessage((m: { a?: string; key?: string }) => this.onMessage(m));
    view.onDidChangeVisibility(() => {
      this._onVisibility.fire();
      if (view.visible) this.update();
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this._onVisibility.fire();
    });
    this._onVisibility.fire();
    this.update();
  }

  private onMessage(m: { a?: string; key?: string }): void {
    const e = m.key ? this.review.entries.get(m.key) : undefined;
    const uri = e ? vscode.Uri.file(e.path) : undefined;
    const run = (cmd: string, ...args: unknown[]) => void vscode.commands.executeCommand('claudeInlineDiff.' + cmd, ...args);
    if (m.a === 'open' && m.key) {
      if (e) run('openFile', m.key);
      else {
        const f = this.review.sessionFiles().find((x) => x.key === m.key);
        if (f && fs.existsSync(f.path)) void vscode.window.showTextDocument(vscode.Uri.file(f.path), { preview: true });
      }
    } else if (m.a === 'keep' && uri) run('acceptFile', uri);
    else if (m.a === 'undo' && uri) run('rejectFile', uri);
    else if (m.a === 'keepAll') run('acceptAll');
    else if (m.a === 'undoAll') run('rejectAll', 'confirmed');
    else if (m.a === 'review') run('reviewAll');
    else if (m.a === 'install') run('installHooks');
  }

  private state() {
    const pending = this.review.pendingKeys();
    if (!pending.length) return { files: this.historyRows(), history: true, hookReady: this.hookReady, working: this.review.working };
    const files = pending.map((key) => {
      const e = this.review.entries.get(key)!;
      const hunks = this.review.hunks(key);
      const rel = vscode.workspace.asRelativePath(e.path);
      return {
        key,
        name: path.basename(e.path),
        dir: path.dirname(rel) === '.' ? '' : path.dirname(rel),
        ...totals(hunks),
        changes: hunks.length,
        isNew: !e.existed,
        bash: e.source === 'bash',
        icon: this.iconFor(path.basename(e.path)),
      };
    });
    return { files, history: false, hookReady: this.hookReady, working: this.review.working };
  }

  /** The current chat's files with +/- against the text from before the chat (cached per text). */
  private historyRows() {
    const seen = new Set<string>();
    const rows = this.review.sessionFiles().map((f) => {
      seen.add(f.key);
      const now = this.review.textNow(f.key, f.path);
      let st = this.historyStats.get(f.key);
      if (!st || st.before !== f.before || st.now !== now) {
        st = { before: f.before, now, ...totals(diffTexts(f.before ?? '', now ?? '')) };
        this.historyStats.set(f.key, st);
      }
      const rel = vscode.workspace.asRelativePath(f.path);
      return {
        key: f.key,
        name: path.basename(f.path),
        dir: path.dirname(rel) === '.' ? '' : path.dirname(rel),
        added: st.added,
        removed: st.removed,
        icon: this.iconFor(path.basename(f.path)),
      };
    });
    for (const k of this.historyStats.keys()) if (!seen.has(k)) this.historyStats.delete(k);
    return rows;
  }

  private setHtml(view: vscode.WebviewView): void {
    const th = this.loadTheme();
    view.webview.options = { enableScripts: true, localResourceRoots: th ? [th.root] : [] };
    view.webview.html = this.html(view.webview, th);
  }

  /** The active file icon theme (its JSON and folder), or null when there is none we can read. */
  private loadTheme(): { doc: IconThemeDoc; dir: vscode.Uri; root: vscode.Uri } | null {
    if (this.theme !== undefined) return this.theme;
    this.theme = null;
    const id = vscode.workspace.getConfiguration('workbench').get<string>('iconTheme');
    if (!id) return null;
    for (const ext of vscode.extensions.all) {
      const t = (ext.packageJSON?.contributes?.iconThemes || []).find((x: any) => x?.id === id);
      if (!t?.path) continue;
      try {
        const file = vscode.Uri.joinPath(ext.extensionUri, t.path);
        const doc = parseJsonc(fs.readFileSync(file.fsPath, 'utf8')) as IconThemeDoc;
        this.theme = { doc, dir: vscode.Uri.joinPath(file, '..'), root: ext.extensionUri };
      } catch {
        /* unreadable theme: rows show no icon */
      }
      break;
    }
    return this.theme;
  }

  /** Language id by file name / extension, from every extension's language contributions. */
  private languageOf(fileName: string): string | undefined {
    if (!this.langs) {
      this.langs = new Map();
      for (const ext of vscode.extensions.all)
        for (const l of ext.packageJSON?.contributes?.languages || []) {
          if (typeof l?.id !== 'string') continue;
          for (const x of l.extensions || [])
            if (typeof x === 'string' && !this.langs.has(x.toLowerCase())) this.langs.set(x.toLowerCase(), l.id);
          for (const n of l.filenames || [])
            if (typeof n === 'string' && !this.langs.has('/' + n.toLowerCase())) this.langs.set('/' + n.toLowerCase(), l.id);
        }
    }
    const name = fileName.toLowerCase();
    if (this.langs.has('/' + name)) return this.langs.get('/' + name);
    const parts = name.split('.');
    for (let i = 1; i < parts.length; i++) {
      const id = this.langs.get('.' + parts.slice(i).join('.'));
      if (id) return id;
    }
    return undefined;
  }

  /** `{img}` (SVG/PNG icon), `{ch, font, color}` (icon font glyph) or undefined. */
  private iconFor(fileName: string): { img?: string; ch?: string; font?: string; color?: string } | undefined {
    const th = this.loadTheme();
    if (!th || !this.view) return undefined;
    const id = iconIdFor(th.doc, fileName, this.languageOf(fileName));
    const def = id ? th.doc.iconDefinitions?.[id] : undefined;
    if (!def) return undefined;
    if (def.iconPath) return { img: this.view.webview.asWebviewUri(vscode.Uri.joinPath(th.dir, def.iconPath)).toString() };
    if (def.fontCharacter) {
      const hex = def.fontCharacter.replace(/^\\/, '');
      const ch = /^[0-9a-f]+$/i.test(hex) ? String.fromCodePoint(parseInt(hex, 16)) : def.fontCharacter;
      return { ch, font: def.fontId || th.doc.fonts?.[0]?.id, color: def.fontColor };
    }
    return undefined;
  }

  private update(): void {
    if (!this.view) return;
    // No count on the chat tab: Cursor's file list under its chat has none either (the header says "N Files").
    void this.view.webview.postMessage({ a: 'state', ...this.state() });
  }

  private html(webview: vscode.Webview, th: { doc: IconThemeDoc; dir: vscode.Uri } | null): string {
    const fonts = (th?.doc.fonts || [])
      .map((f) => {
        const src = f.src
          .map((s) => `url("${webview.asWebviewUri(vscode.Uri.joinPath(th!.dir, s.path))}") format("${s.format || 'woff'}")`)
          .join(',');
        return `@font-face{font-family:"cid-${f.id}";src:${src};font-weight:${f.weight || 'normal'};font-style:${f.style || 'normal'}}.f-${f.id}{font-family:"cid-${f.id}";font-size:${f.size || '100%'}}`;
      })
      .join('\n');
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<style>
html,body{margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:transparent;user-select:none}
.hd{display:flex;align-items:center;gap:4px;height:30px;padding:0 8px 0 12px}
.tw{color:var(--vscode-foreground);font-size:13px;font-weight:600;flex:1;min-width:0;white-space:nowrap}
.btn{font:inherit;font-size:12px;border:0;border-radius:4px;height:22px;padding:0 7px;cursor:pointer;white-space:nowrap;background:transparent;color:var(--vscode-foreground)}
.btn:hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2))}
.btn.text{color:var(--vscode-descriptionForeground)}
.btn.text:hover{color:var(--vscode-foreground)}
.btn.sec{background:color-mix(in srgb,var(--vscode-foreground) 10%,transparent)}
.btn.sec:hover{background:color-mix(in srgb,var(--vscode-foreground) 16%,transparent)}
.btn.warn{color:var(--vscode-errorForeground)}
.rows{padding:0 0 4px}
.row{display:flex;align-items:center;gap:6px;height:23px;padding:0 8px 0 24px;cursor:pointer;font-size:12px}
.row:hover{background:var(--vscode-list-hoverBackground)}
.nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dir{color:var(--vscode-descriptionForeground);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.st{font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}
.ad{color:var(--vscode-gitDecoration-addedResourceForeground,#73c991)}
.rm{color:var(--vscode-gitDecoration-deletedResourceForeground,#c74e39)}
.tag{font-size:11px;color:var(--vscode-descriptionForeground)}
.acts{display:none;gap:2px}
.row:hover .acts{display:flex}
.sp{flex:1}
.fi{width:16px;height:16px;flex:none;display:flex;align-items:center;justify-content:center;overflow:hidden;font-size:14px;line-height:1}
.fi img{width:16px;height:16px}
${fonts}
.ic{border:0;background:transparent;color:var(--vscode-foreground);width:22px;height:20px;border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
.ic:hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2))}
.ic svg{width:14px;height:14px;fill:currentColor}
html,body,#root{height:100%}
.empty{height:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:12px 16px;text-align:center;color:var(--vscode-descriptionForeground);font-size:12px;line-height:1.4}
.empty svg{width:20px;height:20px;fill:currentColor;opacity:.7}
.empty .t{color:var(--vscode-foreground);opacity:.75}
.empty button{margin-top:4px;font:inherit;font-size:12px;height:24px;padding:0 10px;border:0;border-radius:4px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.empty button:hover{background:var(--vscode-button-hoverBackground)}
</style></head><body><div id="root"></div>
<script nonce="${nonce}">
const vs=acquireVsCodeApi();
let confirmUndo=false;let confirmTimer=0;let data={files:[],hookReady:true};
const X='<svg viewBox="0 0 16 16"><path d="M8 8.7l3.6 3.6.7-.7L8.7 8l3.6-3.6-.7-.7L8 7.3 4.4 3.7l-.7.7L7.3 8l-3.6 3.6.7.7z"/></svg>';
const V='<svg viewBox="0 0 16 16"><path d="M6.3 11.3 2.7 7.7l-.7.7 4.3 4.3 7.7-7.7-.7-.7z"/></svg>';
const OK='<svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1a6 6 0 1 1 0 12A6 6 0 0 1 8 2zm2.9 3.6L7 9.5 5.1 7.6l-.7.7L7 10.9l4.6-4.6z"/></svg>';
const PLUG='<svg viewBox="0 0 16 16"><path d="M6 1v3h4V1h1v3h1.5v3A4.5 4.5 0 0 1 8.5 11.5V15h-1v-3.5A4.5 4.5 0 0 1 3.5 7V4H5V1zm-1.5 4v2a3.5 3.5 0 0 0 7 0V5z"/></svg>';
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function send(a,key){vs.postMessage({a,key})}
function icon(i){if(!i)return '';if(i.img)return '<span class="fi"><img src="'+esc(i.img)+'" alt=""></span>';if(i.ch)return '<span class="fi'+(i.font?' f-'+esc(i.font):'')+'" style="color:'+esc(i.color||'inherit')+'">'+esc(i.ch)+'</span>';return ''}
function render(){
  const r=document.getElementById('root');const f=data.files;
  // Empty state: the hook install when it is missing, otherwise a quiet "nothing to review".
  if(!f.length){r.innerHTML=data.hookReady?'<div class="empty">'+OK+'<div class="t">No changes to review</div></div>':'<div class="empty">'+PLUG+'<div class="t">Install the Claude Code hook to review Claude&#39;s edits here</div><button data-a="install">Install Hook</button></div>';return}
  // Cursor: "Undo All / Keep All" for several files, "Undo / Keep" for one;
  // hidden while the agent works (the changes are still coming).
  const many=f.length>1;
  if(data.working)confirmUndo=false;
  // No collapse toggle of its own: the view section above already collapses.
  r.innerHTML='<div class="hd"><div class="tw">'+f.length+' '+(f.length===1?'File':'Files')+'</div>'+
    (data.working||data.history?'':'<button class="btn text'+(confirmUndo?' warn':'')+'" data-a="undoAll" title="'+(confirmUndo?'Click again to confirm undo':'Undo all Claude changes')+'">'+(confirmUndo?'Confirm':(many?'Undo All':'Undo'))+'</button>'+
    '<button class="btn text" data-a="keepAll" title="Keep all Claude changes">'+(many?'Keep All':'Keep')+'</button>')+
    '<button class="btn sec" data-a="review" title="Review all changes in a diff">Review</button></div>'+
    '<div class="rows">'+f.map(x=>'<div class="row" data-a="open" data-key="'+esc(x.key)+'" title="'+esc((x.dir?x.dir+'/':'')+x.name)+(data.history?'':' · '+x.changes+' change'+(x.changes===1?'':'s'))+'">'+
      icon(x.icon)+'<span class="nm">'+esc(x.name)+'</span>'+
      // Like Cursor: "+41", "+7 -1", "-3" (no zero parts).
      '<span class="st">'+(x.added?'<span class="ad">+'+x.added+'</span>':'')+(x.added&&x.removed?' ':'')+(x.removed?'<span class="rm">-'+x.removed+'</span>':'')+'</span>'+
      (x.isNew?'<span class="tag">new</span>':'')+(x.bash?'<span class="tag">Bash</span>':'')+'<span class="sp"></span>'+
      // History rows (already reviewed) have nothing to keep or undo.
      (data.history?'':'<span class="acts"><button class="ic" data-a="undo" data-key="'+esc(x.key)+'" title="Undo File">'+X+'</button><button class="ic" data-a="keep" data-key="'+esc(x.key)+'" title="Keep File">'+V+'</button></span>')+'</div>').join('')+'</div>';
}
document.addEventListener('click',e=>{
  const t=e.target.closest('[data-a]');if(!t)return;e.stopPropagation();const a=t.dataset.a;
  if(a==='undoAll'){
    if(!confirmUndo){confirmUndo=true;clearTimeout(confirmTimer);confirmTimer=setTimeout(()=>{confirmUndo=false;render()},4000);render();return}
    confirmUndo=false;clearTimeout(confirmTimer);render();
  }
  send(a,t.dataset.key);
});
window.addEventListener('message',e=>{if(e.data&&e.data.a==='state'){data=e.data;if(!data.files.length)confirmUndo=false;render()}});
render();
</script></body></html>`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
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
