// A small, dependency-free syntax highlighter for the removed-code blocks.
// It is not a TextMate engine: it recognises comments, strings, numbers,
// keywords, types, functions and operators for common language families,
// and the colours come from the active VS Code/Cursor theme (see theme.ts),
// so removed code looks like the code around it.

export type TokenKind =
  'comment' | 'string' | 'number' | 'keyword' | 'type' | 'function' | 'constant' | 'operator' | 'tag' | 'attr' | 'text';
export interface Token {
  kind: TokenKind;
  text: string;
}
export interface HlState {
  block?: string; // terminator of an open block comment / multi-line string
  blockKind?: TokenKind;
}

interface Family {
  line?: string[];
  block?: [string, string][];
  strings: string[];
  tripleStrings?: string[];
  keywords: Set<string>;
  constants: Set<string>;
  types?: Set<string>;
  markup?: boolean;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_KEYWORDS = words(`abstract as async await break case catch class const continue debugger default delete do else enum export extends
 final finally for from func function go goto if implements import in instanceof interface is let match mod module mut namespace new
 of override package private protected pub public readonly return sealed select static struct super switch this throw throws trait try
 type typeof union unsafe use using var virtual void volatile where while with yield def defer fn impl loop crate self Self dyn ref move
 lambda when object val fun companion suspend inline extern sizeof typedef register signed unsigned auto goto chan map range fallthrough`);
const C_CONST = words('true false null undefined nil None True False NaN Infinity nullptr this super iota');
const C_TYPES = words(
  'int long short char float double bool boolean byte string String number any unknown never void object symbol bigint u8 u16 u32 u64 i8 i16 i32 i64 f32 f64 usize isize str Vec Option Result Promise Array Map Set Record'
);
const PY_KEYWORDS = words(
  'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case print self cls'
);
const SH_KEYWORDS = words(
  'if then else elif fi for while until do done case esac in function return local export source alias unset set echo exit readonly declare shift trap'
);
const RB_KEYWORDS = words(
  'alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require attr_accessor'
);
const SQL_KEYWORDS = words(
  'select from where insert into values update set delete create table alter drop index join left right inner outer on group by order having limit offset as and or not null is in like between union all distinct primary key foreign references default exists case when then else end view returning with'
);
const LUA_KEYWORDS = words('and break do else elseif end for function goto if in local not or repeat return then until while');
const YAML_CONST = words('true false null yes no on off ~');

const FAMILIES: Record<string, Family> = {
  c: { line: ['//'], block: [['/*', '*/']], strings: ['"', "'", '`'], keywords: C_KEYWORDS, constants: C_CONST, types: C_TYPES },
  python: {
    line: ['#'],
    strings: ['"', "'"],
    tripleStrings: ['"""', "'''"],
    keywords: PY_KEYWORDS,
    constants: C_CONST,
    types: words('int str float bool list dict set tuple bytes object type Exception'),
  },
  shell: { line: ['#'], strings: ['"', "'"], keywords: SH_KEYWORDS, constants: words('true false') },
  ruby: { line: ['#'], strings: ['"', "'"], keywords: RB_KEYWORDS, constants: words('true false nil') },
  sql: { line: ['--'], block: [['/*', '*/']], strings: ["'", '"'], keywords: SQL_KEYWORDS, constants: words('true false null') },
  lua: { line: ['--'], block: [['--[[', ']]']], strings: ['"', "'"], keywords: LUA_KEYWORDS, constants: words('true false nil') },
  yaml: { line: ['#'], strings: ['"', "'"], keywords: new Set(), constants: YAML_CONST },
  json: { strings: ['"'], keywords: new Set(), constants: words('true false null') },
  css: {
    block: [['/*', '*/']],
    line: [],
    strings: ['"', "'"],
    keywords: words('important media import supports keyframes font-face'),
    constants: new Set(),
  },
  markup: { block: [['<!--', '-->']], strings: ['"', "'"], keywords: new Set(), constants: new Set(), markup: true },
  plain: { strings: [], keywords: new Set(), constants: new Set() },
};

const LANG_FAMILY: Record<string, string> = {
  javascript: 'c',
  typescript: 'c',
  javascriptreact: 'c',
  typescriptreact: 'c',
  java: 'c',
  c: 'c',
  cpp: 'c',
  csharp: 'c',
  go: 'c',
  rust: 'c',
  swift: 'c',
  kotlin: 'c',
  php: 'c',
  dart: 'c',
  scala: 'c',
  groovy: 'c',
  'objective-c': 'c',
  jsonc: 'c',
  vue: 'c',
  svelte: 'c',
  python: 'python',
  shellscript: 'shell',
  bash: 'shell',
  zsh: 'shell',
  dockerfile: 'shell',
  makefile: 'shell',
  powershell: 'shell',
  perl: 'shell',
  r: 'shell',
  toml: 'yaml',
  ini: 'yaml',
  properties: 'yaml',
  ruby: 'ruby',
  sql: 'sql',
  lua: 'lua',
  yaml: 'yaml',
  json: 'json',
  css: 'css',
  scss: 'c',
  less: 'c',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  markdown: 'plain',
  plaintext: 'plain',
};

export function familyOf(languageId: string): Family {
  return FAMILIES[LANG_FAMILY[languageId] || 'c'];
}

const NUM = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[a-zA-Z]*)/;
const IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*/u;
const OPS = /^[+\-*/%=<>!&|^~?:]+/;

function push(out: Token[], kind: TokenKind, text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ kind, text });
}

/** Tokenises one line; `state` carries open block comments/strings to the next line. */
export function tokenizeLine(line: string, languageId: string, state: HlState = {}): { tokens: Token[]; state: HlState } {
  const f = familyOf(languageId);
  const out: Token[] = [];
  let i = 0;
  let st: HlState = { ...state };
  if (f.markup) return tokenizeMarkup(line, st);
  while (i < line.length) {
    if (st.block) {
      const end = line.indexOf(st.block, i);
      if (end < 0) {
        push(out, st.blockKind || 'comment', line.slice(i));
        return { tokens: out, state: st };
      }
      push(out, st.blockKind || 'comment', line.slice(i, end + st.block.length));
      i = end + st.block.length;
      st = {};
      continue;
    }
    const rest = line.slice(i);
    const lc = f.line?.find((p) => rest.startsWith(p));
    const bc = f.block?.find(([a]) => rest.startsWith(a));
    if (bc) {
      st = { block: bc[1], blockKind: 'comment' };
      push(out, 'comment', bc[0]);
      i += bc[0].length;
      continue;
    }
    if (lc) {
      push(out, 'comment', rest);
      break;
    }
    const tq = f.tripleStrings?.find((q) => rest.startsWith(q));
    if (tq) {
      st = { block: tq, blockKind: 'string' };
      push(out, 'string', tq);
      i += tq.length;
      continue;
    }
    const ch = line[i];
    if (f.strings.includes(ch)) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
      push(out, 'string', line.slice(i, Math.min(j + 1, line.length)));
      if (j >= line.length && ch === '`') st = { block: '`', blockKind: 'string' };
      i = Math.min(j + 1, line.length);
      continue;
    }
    let m = NUM.exec(rest);
    if (m && (i === 0 || !/[\p{L}\p{N}_$]/u.test(line[i - 1]))) {
      push(out, 'number', m[0]);
      i += m[0].length;
      continue;
    }
    m = IDENT.exec(rest);
    if (m) {
      const w = m[0];
      const after = line.slice(i + w.length).trimStart();
      let kind: TokenKind = 'text';
      if (f.keywords.has(w) || (languageId === 'sql' && f.keywords.has(w.toLowerCase()))) kind = 'keyword';
      else if (f.constants.has(w)) kind = 'constant';
      else if (f.types?.has(w) || (/^[A-Z][a-z]/.test(w) && f !== FAMILIES.yaml && f !== FAMILIES.plain)) kind = 'type';
      else if (after.startsWith('(')) kind = 'function';
      else if (f === FAMILIES.yaml && after.startsWith(':')) kind = 'attr';
      else if (f === FAMILIES.css && after.startsWith(':')) kind = 'attr';
      push(out, kind, w);
      i += w.length;
      continue;
    }
    m = OPS.exec(rest);
    if (m) {
      push(out, 'operator', m[0]);
      i += m[0].length;
      continue;
    }
    push(out, 'text', ch);
    i++;
  }
  return { tokens: out, state: st };
}

function tokenizeMarkup(line: string, st: HlState): { tokens: Token[]; state: HlState } {
  const out: Token[] = [];
  let i = 0;
  while (i < line.length) {
    if (st.block) {
      const end = line.indexOf(st.block, i);
      if (end < 0) {
        push(out, 'comment', line.slice(i));
        return { tokens: out, state: st };
      }
      push(out, 'comment', line.slice(i, end + st.block.length));
      i = end + st.block.length;
      st = {};
      continue;
    }
    if (line.startsWith('<!--', i)) {
      st = { block: '-->', blockKind: 'comment' };
      push(out, 'comment', '<!--');
      i += 4;
      continue;
    }
    const tag = /^<\/?[\w:.-]+/.exec(line.slice(i));
    if (tag) {
      push(out, 'tag', tag[0]);
      i += tag[0].length;
      // attributes until '>'
      while (i < line.length && line[i] !== '>') {
        const a = /^\s+|^[\w:.\-@]+|^"[^"]*"?|^'[^']*'?|^=|^\/./.exec(line.slice(i));
        const t = a ? a[0] : line[i];
        push(out, t.startsWith('"') || t.startsWith("'") ? 'string' : /^[\w@]/.test(t) ? 'attr' : 'text', t);
        i += t.length;
      }
      if (line[i] === '>') {
        push(out, 'tag', '>');
        i++;
      }
      continue;
    }
    push(out, 'text', line[i]);
    i++;
  }
  return { tokens: out, state: st };
}

export function tokenizeLines(lines: string[], languageId: string): Token[][] {
  let st: HlState = {};
  return lines.map((l) => {
    const r = tokenizeLine(l, languageId, st);
    st = r.state;
    return r.tokens;
  });
}
