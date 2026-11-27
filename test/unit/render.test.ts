import { describe, it, expect } from 'vitest';
import { tokenizeLine, tokenizeLines } from '../../src/core/highlight';
import { parseJsonc, paletteFromRules, matchScope } from '../../src/theme';
import { renderLine, insetHtml } from '../../src/insets';

const kinds = (line: string, lang: string) => tokenizeLine(line, lang).tokens.map((t) => [t.kind, t.text]);

describe('highlight', () => {
  it('tokenizes a TS line', () => {
    const k = kinds('const x = foo("a", 42); // hi', 'typescript');
    expect(k).toContainEqual(['keyword', 'const']);
    expect(k).toContainEqual(['function', 'foo']);
    expect(k).toContainEqual(['string', '"a"']);
    expect(k).toContainEqual(['number', '42']);
    expect(k).toContainEqual(['comment', '// hi']);
  });
  it('carries block comments and python triple strings across lines', () => {
    const t = tokenizeLines(['a /* start', 'middle', 'end */ b'], 'javascript');
    expect(t[1]).toEqual([{ kind: 'comment', text: 'middle' }]);
    expect(t[2][0]).toEqual({ kind: 'comment', text: 'end */' });
    const p = tokenizeLines(['x = """doc', 'more', '"""'], 'python');
    expect(p[1][0].kind).toBe('string');
  });
  it('handles python, shell, sql, html', () => {
    expect(kinds('def f(): # c', 'python')).toContainEqual(['keyword', 'def']);
    expect(kinds('echo $HOME # c', 'shellscript')).toContainEqual(['comment', '# c']);
    expect(kinds('SELECT * FROM t', 'sql')).toContainEqual(['keyword', 'SELECT']);
    expect(kinds('<div class="a">x</div>', 'html')).toContainEqual(['attr', 'class']);
  });
  it('round-trips text exactly', () => {
    const line = '\tif (a<b && c) { return `x${y}`; }';
    expect(
      tokenizeLine(line, 'typescript')
        .tokens.map((t) => t.text)
        .join('')
    ).toBe(line);
  });
});

describe('theme', () => {
  it('parses JSONC themes and maps scopes', () => {
    const theme = parseJsonc(`{
      // comment
      "tokenColors": [
        { "scope": "comment", "settings": { "foreground": "#111", "fontStyle": "italic" } },
        { "scope": ["keyword", "storage.type"], "settings": { "foreground": "#222" } },
        { "scope": "keyword.control", "settings": { "foreground": "#333" } },
        { "scope": "string, string.quoted", "settings": { "foreground": "#444" } },
      ],
    }`);
    const rules = theme.tokenColors.map((t: any) => ({
      scopes: Array.isArray(t.scope) ? t.scope : t.scope.split(',').map((s: string) => s.trim()),
      settings: t.settings,
    }));
    expect(matchScope(rules, 'keyword.control.flow')?.foreground).toBe('#333');
    const p = paletteFromRules(rules);
    expect(p.comment).toEqual({ color: '#111', fontStyle: 'italic' });
    expect(p.keyword?.color).toBe('#333');
    expect(p.string?.color).toBe('#444');
  });
});

describe('inset html', () => {
  it('escapes code and marks removed words', () => {
    const html = renderLine([{ kind: 'text', text: 'a<b>c' }], [{ line: 0, start: 1, end: 4 }], {});
    expect(html).toBe('a<span class="w">&lt;b&gt;</span>c');
  });
  it('builds a CSP-locked document with buttons and a collapsed tail', () => {
    const m = { fontSize: 14, lineHeight: 20, fontFamily: 'Menlo', fontWeight: 'normal', tabSize: 4, ligatures: false };
    const html = insetHtml(
      {
        afterLine: 3,
        lines: ['x', 'y', 'z'],
        removed: [],
        languageId: 'typescript',
        ref: { key: 'k', aStart: 0, bStart: 0 },
        buttons: true,
        stat: '−3',
      },
      ['x', 'y'],
      1,
      'NONCE',
      {},
      m
    );
    expect(html).toContain("script-src 'nonce-NONCE'");
    expect(html).toContain('height:20px');
    expect(html).toContain('1 more removed line');
    expect(html).toContain('data-a="accept"');
    expect((html.match(/class="l"/g) || []).length).toBe(2);
  });
});
