// Review logic with no editor dependency (unit-testable in plain Node).
//
// absorbUserEdits / replaceLines / minimalEdit / hunkAtLine are ported from
// claude-code-inline-review v0.4.2 (src/model.js) by Brusk Awat, MIT License —
// see THIRD_PARTY_LICENSE_claude-code-inline-review.txt.

import { Hunk, splitLines } from './diff';

export interface Pos {
  line: number;
  character: number;
}
export interface TextChange {
  range: { start: Pos; end: Pos };
  text: string;
}

export const hunkEnd = (h: Hunk) => h.bStart + h.bLines.length;

/** True when an edit spanning current lines [l1, l2] touches the hunk. */
export function touches(h: Hunk, l1: number, l2: number): boolean {
  if (h.bLines.length === 0) return l1 < h.bStart && l2 >= h.bStart;
  return l1 <= hunkEnd(h) - 1 && l2 >= h.bStart;
}

/**
 * Copies the user's own edits into the baseline so they never show up as
 * Claude's changes. Edits inside a Claude hunk are left alone (they become
 * part of that change). `hunks` must describe the text *before* the edits.
 * Returns the new baseline, or null when nothing was absorbed.
 */
export function absorbUserEdits(baseline: string, hunks: Hunk[], changes: readonly TextChange[], eol: string): string | null {
  const lines = splitLines(baseline);
  const sorted = [...changes].sort((x, y) => y.range.start.line - x.range.start.line || y.range.start.character - x.range.start.character);
  let changed = false;
  for (const c of sorted) {
    const l1 = c.range.start.line;
    const l2 = c.range.end.line;
    if (hunks.some((h) => touches(h, l1, l2))) continue;
    let offset = 0;
    for (const h of hunks) if (hunkEnd(h) <= l1) offset += h.aLines.length - h.bLines.length;
    const a1 = l1 + offset;
    const a2 = l2 + offset;
    if (a1 < 0 || a2 >= lines.length) continue;
    const prefix = lines[a1].slice(0, c.range.start.character);
    const suffix = lines[a2].slice(c.range.end.character);
    lines.splice(a1, a2 - a1 + 1, ...splitLines(prefix + c.text + suffix));
    changed = true;
  }
  return changed ? lines.join(eol) : null;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  const re = /\r\n|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) starts.push(m.index + m[0].length);
  return starts;
}

/** Replaces lines [start, start+count) of `text` with `lines`, keeping all other bytes (incl. line endings). */
export function replaceLines(text: string, start: number, count: number, lines: string[], eol: string): string {
  const starts = lineStarts(text);
  const n = starts.length;
  const end = start + count;
  if (start >= n) return text + lines.map((l) => eol + l).join('');
  if (end < n) return text.slice(0, starts[start]) + lines.map((l) => l + eol).join('') + text.slice(starts[end]);
  if (lines.length) return text.slice(0, starts[start]) + lines.join(eol);
  if (start === 0) return '';
  const cut = text.slice(starts[start] - 2, starts[start]) === '\r\n' ? 2 : 1;
  return text.slice(0, starts[start] - cut);
}

/** Accepting a hunk: the baseline takes Claude's lines. */
export function acceptHunkInBaseline(baseline: string, hunk: Hunk, eol: string): string {
  return replaceLines(baseline, hunk.aStart, hunk.aLines.length, hunk.bLines, eol);
}

/** Rejecting a hunk: the file takes the baseline's lines back. */
export function rejectHunkInText(text: string, hunk: Hunk, eol: string): string {
  return replaceLines(text, hunk.bStart, hunk.bLines.length, hunk.aLines, eol);
}

/** Smallest single replacement turning `before` into `after` (offsets into `before`). */
export function minimalEdit(before: string, after: string): { start: number; end: number; text: string } | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  const splits = (str: string, i: number) =>
    i > 0 &&
    i < str.length &&
    ((str[i - 1] === '\r' && str[i] === '\n') || (/[\uD800-\uDBFF]/.test(str[i - 1]) && /[\uDC00-\uDFFF]/.test(str[i])));
  while (p > 0 && (splits(before, p) || splits(after, p))) p--;
  while (s > 0 && (splits(before, before.length - s) || splits(after, after.length - s))) s--;
  return { start: p, end: before.length - s, text: after.slice(p, after.length - s) };
}

/**
 * The hunk nearest to `line` (0-based): Cursor shows its one Keep/Undo pill there, measuring the
 * distance to the first and the last line of each change (a pure deletion sits at one line).
 */
export function nearestHunk(hunks: Hunk[], line: number): Hunk | undefined {
  let best: Hunk | undefined;
  let bestDist = Infinity;
  for (const h of hunks) {
    const start = h.bStart;
    const end = h.bLines.length ? h.bStart + h.bLines.length - 1 : h.bStart;
    const d = line >= start && line <= end ? 0 : Math.min(Math.abs(line - start), Math.abs(line - end));
    if (d < bestDist) {
      best = h;
      bestDist = d;
    }
  }
  return best;
}

/** The hunk under a cursor line: containing it, or a pure deletion right at/above it. */
export function hunkAtLine(hunks: Hunk[], line: number): Hunk | undefined {
  return (
    hunks.find((h) => h.bLines.length > 0 && line >= h.bStart && line < hunkEnd(h)) ||
    hunks.find((h) => h.bLines.length === 0 && (line === h.bStart || line === h.bStart - 1))
  );
}

export function hunkIndexAtLine(hunks: Hunk[], line: number): number {
  const h = hunkAtLine(hunks, line);
  return h ? hunks.indexOf(h) : -1;
}

/** The line a hunk is "at" for navigation. */
export function hunkAnchorLine(h: Hunk): number {
  return h.bLines.length ? h.bStart : Math.max(0, h.bStart - 1);
}

/** Next hunk strictly after `line` (wraps when `wrap`). */
export function nextHunk(hunks: Hunk[], line: number, wrap = true): Hunk | undefined {
  const after = hunks.find((h) => hunkAnchorLine(h) > line);
  return after || (wrap ? hunks[0] : undefined);
}

export function prevHunk(hunks: Hunk[], line: number, wrap = true): Hunk | undefined {
  const before = [...hunks].reverse().find((h) => hunkAnchorLine(h) < line);
  return before || (wrap ? hunks[hunks.length - 1] : undefined);
}

/** Hunk to land on after resolving one at `line` in the new hunk list. */
export function hunkAfterResolve(hunks: Hunk[], line: number): Hunk | undefined {
  return hunks.find((h) => hunkAnchorLine(h) >= line) || undefined;
}

export function hunkStat(h: Hunk): string {
  const parts: string[] = [];
  if (h.aLines.length) parts.push('−' + h.aLines.length);
  if (h.bLines.length) parts.push('+' + h.bLines.length);
  return parts.join(' ');
}

export function totals(hunks: Hunk[]) {
  let removed = 0;
  let added = 0;
  for (const h of hunks) {
    removed += h.aLines.length;
    added += h.bLines.length;
  }
  return { removed, added };
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "3 files · 7 changes" */
export function summaryText(files: number, changes: number): string {
  return `${plural(files, 'file')} · ${plural(changes, 'change')}`;
}
