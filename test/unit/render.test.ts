import { describe, it, expect } from 'vitest';
import { renderLine, insetHtml } from '../../src/insets';

describe('inset html', () => {
  it('escapes code and marks removed words', () => {
    const html = renderLine('a<b>c', [{ line: 0, start: 1, end: 4 }]);
    expect(html).toBe('a<span class="w">&lt;b&gt;</span>c');
  });
  it('builds a CSP-locked document with buttons and a collapsed tail', () => {
    const m = {
      fontSize: 14,
      lineHeight: 20,
      fontFamily: 'Menlo',
      fontWeight: 'normal',
      tabSize: 4,
      ligatures: false,
      keep: '⌘Y',
      undo: '⌘N',
    };
    const html = insetHtml(
      {
        afterLine: 3,
        lines: ['x', 'y', 'z'],
        removed: [],
        languageId: 'typescript',
        ref: { key: 'k', aStart: 0, bStart: 0 },
        toolbar: { index: 2, total: 5 },
      },
      ['x', 'y'],
      1,
      'NONCE',
      m
    );
    expect(html).toContain("script-src 'nonce-NONCE'");
    expect(html).toContain('height:20px');
    expect(html).toContain('1 more removed line');
    expect(html).toContain('data-a="accept"');
    expect((html.match(/class="l"/g) || []).length).toBe(2);
    expect(html).toContain('2 of 5');
    expect(html).toContain('>Keep<');
    expect(html).toContain('>Undo<');
  });
});
