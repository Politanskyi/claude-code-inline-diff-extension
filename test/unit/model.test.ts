import { describe, it, expect } from 'vitest';
import { diffTexts } from '../../src/core/diff';
import * as M from '../../src/core/model';

const change = (l1: number, c1: number, l2: number, c2: number, text: string): M.TextChange => ({
  range: { start: { line: l1, character: c1 }, end: { line: l2, character: c2 } },
  text,
});

describe('accept / reject', () => {
  const base = 'a\nb\nc\nd';
  const cur = 'a\nB\nc\nd\ne';
  const hunks = diffTexts(base, cur);

  it('accepting a hunk updates only the baseline', () => {
    const nb = M.acceptHunkInBaseline(base, hunks[0], '\n');
    expect(nb).toBe('a\nB\nc\nd');
    expect(diffTexts(nb, cur)).toHaveLength(1); // the other hunk is still pending
  });

  it('rejecting a hunk restores old lines in the file', () => {
    const nt = M.rejectHunkInText(cur, hunks[0], '\n');
    expect(nt).toBe('a\nb\nc\nd\ne');
    const nt2 = M.rejectHunkInText(cur, hunks[1], '\n');
    expect(nt2).toBe('a\nB\nc\nd');
  });

  it('accepting / rejecting every hunk converges', () => {
    let b = base;
    for (const h of [...diffTexts(b, cur)].reverse()) b = M.acceptHunkInBaseline(b, h, '\n');
    expect(b).toBe(cur);
    let t = cur;
    for (const h of [...diffTexts(base, t)].reverse()) t = M.rejectHunkInText(t, h, '\n');
    expect(t).toBe(base);
  });

  it('keeps CRLF line endings of untouched lines', () => {
    const b = 'a\r\nb\r\nc';
    const c = 'a\r\nX\r\nc';
    const h = diffTexts(b, c)[0];
    expect(M.rejectHunkInText(c, h, '\r\n')).toBe(b);
    expect(M.acceptHunkInBaseline(b, h, '\r\n')).toBe(c);
  });

  it('keeps mixed line endings intact', () => {
    const b = 'a\r\nb\nc';
    const c = 'a\r\nB\nc';
    expect(M.rejectHunkInText(c, diffTexts(b, c)[0], '\n')).toBe(b);
  });

  it('handles deletion at end of file', () => {
    const b = 'a\nb\nc';
    const c = 'a';
    const h = diffTexts(b, c);
    expect(M.rejectHunkInText(c, h[0], '\n')).toBe(b);
  });
});

describe('absorbUserEdits', () => {
  const base = 'one\ntwo\nthree\nfour\nfive';
  const cur = 'one\nTWO\nthree\nfour\nfive';
  const hunks = diffTexts(base, cur);

  it('copies an edit outside Claude hunks into the baseline', () => {
    const nb = M.absorbUserEdits(base, hunks, [change(3, 0, 3, 4, 'FOUR')], '\n');
    expect(nb).toBe('one\ntwo\nthree\nFOUR\nfive');
  });

  it('leaves edits inside a Claude hunk alone', () => {
    expect(M.absorbUserEdits(base, hunks, [change(1, 0, 1, 3, 'Two')], '\n')).toBeNull();
  });

  it('maps lines below hunks that changed the line count', () => {
    const c2 = 'one\nnew1\nnew2\ntwo\nthree';
    const b2 = 'one\ntwo\nthree';
    const h2 = diffTexts(b2, c2);
    const nb = M.absorbUserEdits(b2, h2, [change(4, 0, 4, 5, 'THREE')], '\n');
    expect(nb).toBe('one\ntwo\nTHREE');
  });

  it('absorbs multi-line insertions', () => {
    const nb = M.absorbUserEdits(base, hunks, [change(4, 4, 4, 4, '\nsix')], '\n');
    expect(nb).toBe('one\ntwo\nthree\nfour\nfive\nsix');
  });
});

describe('navigation helpers', () => {
  const hunks = diffTexts('a\nb\nc\nd\ne\nf', 'a\nB\nc\nd\nf');
  it('finds the hunk at a line and the deletion point', () => {
    expect(M.hunkAtLine(hunks, 1)).toBe(hunks[0]);
    expect(M.hunkAtLine(hunks, 0)).toBeUndefined();
    expect(M.hunkAtLine(hunks, 4)).toBe(hunks[1]); // deletion of "e" sits before line 4
    expect(M.hunkAtLine(hunks, 3)).toBe(hunks[1]);
  });
  it('next / prev wrap around', () => {
    expect(M.nextHunk(hunks, 1)).toBe(hunks[1]);
    expect(M.nextHunk(hunks, 10)).toBe(hunks[0]);
    expect(M.nextHunk(hunks, 10, false)).toBeUndefined();
    expect(M.prevHunk(hunks, 0)).toBe(hunks[1]);
  });
  it('summary and stats', () => {
    expect(M.summaryText(1, 2)).toBe('1 file · 2 changes');
    expect(M.hunkStat(hunks[0])).toBe('−1 +1');
    expect(M.totals(hunks)).toEqual({ removed: 2, added: 1 });
  });
  it('minimalEdit keeps CRLF pairs whole', () => {
    expect(M.minimalEdit('a\r\nb', 'a\r\nc')).toEqual({ start: 3, end: 4, text: 'c' });
    expect(M.minimalEdit('same', 'same')).toBeNull();
    const e = M.minimalEdit('x\r\n', 'x\n')!;
    expect('x\r\n'.slice(0, e.start) + e.text + 'x\r\n'.slice(e.end)).toBe('x\n');
  });
});

describe('nearestHunk (where Cursor puts its one pill)', () => {
  // Lines 0-9; changes at line 1 (modified), lines 5-6 (added), and a deletion before line 9.
  const base = ['0', '1', '2', '3', '4', '7', '8', 'x', '9'].join('\n');
  const cur = ['0', 'one', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n');
  const hunks = diffTexts(base, cur);

  it('picks the change containing the line, else the closest by first/last line', () => {
    expect(hunks.map((h) => h.bStart)).toEqual([1, 5, 9]);
    expect(M.nearestHunk(hunks, 1)).toBe(hunks[0]);
    expect(M.nearestHunk(hunks, 6)).toBe(hunks[1]);
    expect(M.nearestHunk(hunks, 3)).toBe(hunks[0]); // 2 from line 1, 2 from line 5: the first wins
    expect(M.nearestHunk(hunks, 8)).toBe(hunks[2]);
    expect(M.nearestHunk([], 3)).toBeUndefined();
  });
});

describe('keyLabels', () => {
  it('follows the key scheme and the platform', () => {
    expect(M.keyLabels(true, 'both')).toMatchObject({ keep: '⌘Y', undo: '⌘N', fileKeep: '⌘↵' });
    expect(M.keyLabels(true, 'alt')).toMatchObject({ keep: '⌥⌘↵', undo: '⌥⌘⌫' });
    expect(M.keyLabels(false, 'cursor')).toMatchObject({ keep: 'Ctrl+Y', fileUndo: 'Ctrl+Shift+Backspace' });
  });
});

describe('chats of this window', () => {
  const G = '/home/store';
  const step = (sessionId: string, storeDir: string) => ({ sessionId, storeDir });

  it('takes the newest chat that has a step in a project store', () => {
    const steps = [step('other', G), step('mine', '/p/store'), step('older', '/p/store')];
    expect(M.currentSession(steps, G)).toBe('mine');
  });

  it('has no current chat when only chats of other projects edited files here', () => {
    expect(M.currentSession([step('other', G)], G)).toBeUndefined();
    expect(M.currentSession([], G)).toBeUndefined();
  });

  it('counts a chat as own even for its steps in the global store', () => {
    const own = M.ownSessions([step('mine', G), step('mine', '/p/store'), step('other', G)], G);
    expect([...own]).toEqual(['mine']);
  });
});

describe('first-run setup', () => {
  const base = { hookConfigured: false, version: '0.2.1' };

  it('opens on a fresh install and again after an update or reinstall of another version', () => {
    expect(M.shouldAutoSetUp(base)).toBe(true);
    expect(M.shouldAutoSetUp({ ...base, shownForVersion: '0.2.0' })).toBe(true);
  });

  it('stays quiet once shown for this version, with the hook in place, or after a deliberate removal', () => {
    expect(M.shouldAutoSetUp({ ...base, shownForVersion: '0.2.1' })).toBe(false);
    expect(M.shouldAutoSetUp({ ...base, hookConfigured: true })).toBe(false);
    expect(M.shouldAutoSetUp({ ...base, removedByUser: true })).toBe(false);
  });
});
