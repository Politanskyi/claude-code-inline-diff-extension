import { describe, it, expect } from 'vitest';
import { diffLines, diffTexts, splitLines, wordDiff, eolOf, Hunk } from '../../src/core/diff';

/** Applies hunks to `a` and checks we get `b` (every diff must be exact). */
function apply(a: string[], hunks: Hunk[]): string[] {
  const out: string[] = [];
  let i = 0;
  for (const h of hunks) {
    while (i < h.aStart) out.push(a[i++]);
    out.push(...h.bLines);
    i += h.aLines.length;
  }
  while (i < a.length) out.push(a[i++]);
  return out;
}

describe('diffLines', () => {
  it('returns no hunks for equal texts', () => {
    expect(diffTexts('a\nb\nc', 'a\nb\nc')).toEqual([]);
  });

  it('finds a modification', () => {
    expect(diffTexts('a\nb\nc', 'a\nB\nc')).toEqual([{ aStart: 1, aLines: ['b'], bStart: 1, bLines: ['B'] }]);
  });

  it('finds pure insertion and deletion', () => {
    expect(diffTexts('a\nc', 'a\nb\nc')).toEqual([{ aStart: 1, aLines: [], bStart: 1, bLines: ['b'] }]);
    expect(diffTexts('a\nb\nc', 'a\nc')).toEqual([{ aStart: 1, aLines: ['b'], bStart: 1, bLines: [] }]);
  });

  it('handles new file (empty baseline) and emptied file', () => {
    expect(diffTexts('', 'x\ny')).toEqual([{ aStart: 0, aLines: [''], bStart: 0, bLines: ['x', 'y'] }]);
    expect(diffTexts('x\ny', '')).toEqual([{ aStart: 0, aLines: ['x', 'y'], bStart: 0, bLines: [''] }]);
  });

  it('separates hunks by unchanged lines', () => {
    const h = diffTexts('1\n2\n3\n4\n5', 'one\n2\n3\n4\nfive');
    expect(h.map((x) => [x.aStart, x.bStart])).toEqual([
      [0, 0],
      [4, 4],
    ]);
  });

  it('slides an inserted function to a readable position', () => {
    const a = ['function a() {', '}', '', 'function c() {', '}'];
    const b = ['function a() {', '}', '', 'function b() {', '}', '', 'function c() {', '}'];
    const h = diffLines(a, b);
    expect(h).toHaveLength(1);
    expect(h[0].bLines).toEqual(['function b() {', '}', '']);
  });

  it('treats CRLF and LF lines alike', () => {
    expect(diffTexts('a\r\nb\r\n', 'a\nb\n')).toEqual([]);
    expect(eolOf('a\r\nb')).toBe('\r\n');
    expect(eolOf('a\nb')).toBe('\n');
  });

  it('is exact on random edits (property test)', () => {
    let seed = 42;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    for (let t = 0; t < 300; t++) {
      const a = Array.from({ length: rnd(30) }, () => 'l' + rnd(8));
      const b = a.slice();
      for (let k = rnd(6); k > 0; k--) {
        const op = rnd(3);
        const at = rnd(b.length + 1);
        if (op === 0) b.splice(at, 0, 'n' + rnd(5));
        else if (op === 1 && b.length) b.splice(Math.min(at, b.length - 1), 1);
        else if (b.length) b[Math.min(at, b.length - 1)] = 'm' + rnd(5);
      }
      expect(apply(a, diffLines(a, b))).toEqual(b);
    }
  });

  it('degrades gracefully when the budget runs out', () => {
    const a = Array.from({ length: 3000 }, (_, i) => 'a' + i);
    const b = Array.from({ length: 3000 }, (_, i) => (i % 2 ? 'a' + i : 'b' + i));
    const h = diffLines(a, b, 1000);
    expect(apply(a, h)).toEqual(b);
  });

  it('is fast on a large file with a few edits', () => {
    const a = Array.from({ length: 50000 }, (_, i) => 'line ' + i);
    const b = a.slice();
    b[100] = 'changed';
    b.splice(30000, 0, 'inserted');
    const t = Date.now();
    const h = diffLines(a, b);
    expect(Date.now() - t).toBeLessThan(1500);
    expect(h).toHaveLength(2);
  });
});

describe('wordDiff', () => {
  it('marks changed words on both sides', () => {
    const w = wordDiff(['const x = foo(1);'], ['const x = bar(1);'])!;
    expect(w.removed).toEqual([{ line: 0, start: 10, end: 13 }]);
    expect(w.added).toEqual([{ line: 0, start: 10, end: 13 }]);
    expect(w.addedRatio).toBeGreaterThan(0);
  });

  it('joins ranges separated by whitespace only', () => {
    const w = wordDiff(['a foo bar b'], ['a baz qux b'])!;
    expect(w.added).toEqual([{ line: 0, start: 2, end: 9 }]);
  });

  it('handles multi-line hunks', () => {
    const w = wordDiff(['x', 'y'], ['x', 'z'])!;
    expect(w.added).toEqual([{ line: 1, start: 0, end: 1 }]);
  });

  it('gives up on huge hunks', () => {
    const big = [Array.from({ length: 7000 }, (_, i) => 'w' + i).join(' ')];
    expect(wordDiff(big, ['x'])).toBeNull();
  });

  it('splitLines keeps a trailing empty line', () => {
    expect(splitLines('a\n')).toEqual(['a', '']);
    expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
  });
});
