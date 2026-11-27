// Finds the active colour theme's JSON (from the extension that contributes
// it), follows "include", and maps our token kinds to its tokenColors.
// Extensions cannot query theme token colours directly, so this is the
// closest we can get without bundling a TextMate engine.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TokenKind } from './core/highlight';

export type Palette = Partial<Record<TokenKind, { color?: string; fontStyle?: string }>>;

const SCOPES: Record<Exclude<TokenKind, 'text'>, string[]> = {
  comment: ['comment', 'comment.line', 'comment.block'],
  string: ['string', 'string.quoted', 'string.quoted.double'],
  number: ['constant.numeric'],
  keyword: ['keyword.control', 'keyword', 'storage.type', 'storage'],
  type: ['entity.name.type', 'support.type', 'entity.name.class', 'support.class'],
  function: ['entity.name.function', 'support.function'],
  constant: ['constant.language', 'constant'],
  operator: ['keyword.operator'],
  tag: ['entity.name.tag'],
  attr: ['entity.other.attribute-name', 'support.type.property-name', 'variable.other.property'],
};

/** Strips // and /* *\/ comments and trailing commas (theme files are JSONC). */
export function parseJsonc(text: string): any {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? text.length : e + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

interface Rule {
  scopes: string[];
  settings: { foreground?: string; fontStyle?: string };
}

function loadThemeRules(file: string, depth = 0): Rule[] {
  if (depth > 5 || !/\.json$/i.test(file)) return [];
  let json: any;
  try {
    json = parseJsonc(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const rules: Rule[] = json.include ? loadThemeRules(path.join(path.dirname(file), json.include), depth + 1) : [];
  for (const tc of Array.isArray(json.tokenColors) ? json.tokenColors : []) {
    if (!tc || !tc.settings) continue;
    const scopes = Array.isArray(tc.scope) ? tc.scope : typeof tc.scope === 'string' ? tc.scope.split(',') : [];
    rules.push({ scopes: scopes.map((s: string) => s.trim()).filter(Boolean), settings: tc.settings });
  }
  return rules;
}

/** Most specific rule whose selector is a prefix of `scope` (ignores descendant selectors). */
export function matchScope(rules: Rule[], scope: string): Rule['settings'] | undefined {
  let best: Rule['settings'] | undefined;
  let bestLen = -1;
  for (const r of rules) {
    for (const sel of r.scopes) {
      if (sel.includes(' ')) continue;
      if ((scope === sel || scope.startsWith(sel + '.')) && sel.length >= bestLen && r.settings.foreground) {
        best = r.settings;
        bestLen = sel.length;
      }
    }
  }
  return best;
}

export function paletteFromRules(rules: Rule[]): Palette {
  const p: Palette = {};
  for (const [kind, scopes] of Object.entries(SCOPES) as [TokenKind, string[]][]) {
    for (const s of scopes) {
      const m = matchScope(rules, s);
      if (m) {
        p[kind] = { color: m.foreground, fontStyle: m.fontStyle };
        break;
      }
    }
  }
  return p;
}

function findThemeFile(): string | undefined {
  const name = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
  if (!name) return undefined;
  for (const ext of vscode.extensions.all) {
    const themes = ext.packageJSON?.contributes?.themes;
    if (!Array.isArray(themes)) continue;
    const t = themes.find((x: any) => x.id === name || x.label === name);
    if (t && typeof t.path === 'string') return path.join(ext.extensionPath, t.path);
  }
  return undefined;
}

/** Fallback colours by theme kind (Dark+ / Light+ like). */
function fallback(kind: vscode.ColorThemeKind): Palette {
  const dark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
  return dark
    ? {
        comment: { color: '#6A9955' },
        string: { color: '#CE9178' },
        number: { color: '#B5CEA8' },
        keyword: { color: '#C586C0' },
        type: { color: '#4EC9B0' },
        function: { color: '#DCDCAA' },
        constant: { color: '#569CD6' },
        tag: { color: '#569CD6' },
        attr: { color: '#9CDCFE' },
      }
    : {
        comment: { color: '#008000' },
        string: { color: '#A31515' },
        number: { color: '#098658' },
        keyword: { color: '#AF00DB' },
        type: { color: '#267F99' },
        function: { color: '#795E26' },
        constant: { color: '#0000FF' },
        tag: { color: '#800000' },
        attr: { color: '#E50000' },
      };
}

let cached: { theme: string; palette: Palette } | undefined;

export function currentPalette(): Palette {
  const theme = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme') || '';
  if (cached && cached.theme === theme) return cached.palette;
  const file = findThemeFile();
  const fromTheme = file ? paletteFromRules(loadThemeRules(file)) : {};
  const palette = { ...fallback(vscode.window.activeColorTheme.kind), ...fromTheme };
  cached = { theme, palette };
  return palette;
}

export function resetPalette(): void {
  cached = undefined;
}
