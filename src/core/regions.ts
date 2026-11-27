// Edit regions: where Claude's edits landed, so changes group the way Cursor's agent diff does.
//
// A whole-file diff of "before Claude" vs "now" can align equal lines ambiguously (a `}` or a blank
// line can match in several places), which glues unrelated edits into one change. Cursor builds its
// review from the agent's edits instead. We do the same: the hook records, for each Claude edit, which
// lines it replaced, and the review shows the changes inside those regions only.
//
// A region is a run of lines of the current text (`bStart`, `bLen`) that replaced `aLen` lines of the
// baseline. Regions are sorted, never overlap and never touch; outside them both texts are the same.

import { Hunk, diffLines } from './diff';

export interface Region {
  bStart: number;
  bLen: number;
  aLen: number;
}

/**
 * Updates regions for a change of the current text: lines [start, start+oldLen) became newLen lines.
 * `claude`: the change belongs to the review: Claude's edit, or Undo of a change (which puts the
 * baseline's lines back inside its region). It joins every region it overlaps or touches, or starts
 * a new one. Otherwise (the user's typing): regions it overlaps grow or shrink with it, the ones
 * after it move; a change outside every region adds none (the baseline absorbs it).
 */
export function applyEdit(regions: readonly Region[], start: number, oldLen: number, newLen: number, claude: boolean): Region[] {
  const end = start + oldLen;
  const delta = newLen - oldLen;
  const keep: Region[] = [];
  const hit: Region[] = [];
  for (const r of [...regions].sort((x, y) => x.bStart - y.bStart)) {
    const rEnd = r.bStart + r.bLen;
    const overlaps = r.bStart < end && rEnd > start;
    const inside = oldLen === 0 && r.bStart < start && rEnd > start; // insertion strictly inside the region
    const touches = rEnd >= start && r.bStart <= end;
    if (overlaps || inside || (claude && touches)) hit.push(r);
    else if (r.bStart >= end) keep.push({ ...r, bStart: r.bStart + delta });
    else keep.push({ ...r });
  }
  if (hit.length) {
    const s = Math.min(start, ...hit.map((r) => r.bStart));
    const e = Math.max(end, ...hit.map((r) => r.bStart + r.bLen));
    const covered = hit.reduce((n, r) => n + r.bLen, 0);
    const aLen = e - s - covered + hit.reduce((n, r) => n + r.aLen, 0);
    keep.push({ bStart: s, bLen: e - s + delta, aLen });
  } else if (claude) keep.push({ bStart: start, bLen: newLen, aLen: oldLen });
  return keep.filter((r) => r.bLen > 0 || r.aLen > 0).sort((x, y) => x.bStart - y.bStart);
}

/** After Keep of `h`: the baseline takes Claude's lines, so the region covering it replaced that many lines. */
export function acceptInRegions(regions: readonly Region[], h: Hunk): Region[] {
  return regions.map((r) =>
    h.bStart >= r.bStart && h.bStart + h.bLines.length <= r.bStart + r.bLen
      ? { ...r, aLen: r.aLen - h.aLines.length + h.bLines.length }
      : { ...r }
  );
}

/**
 * Hunks from regions, or null when the regions do not explain the two texts (then the caller
 * diffs the whole file). Inside a region, unchanged lines split it into several hunks.
 */
export function hunksFromRegions(a: readonly string[], b: readonly string[], regions: readonly Region[]): Hunk[] | null {
  let ai = 0;
  let bi = 0;
  const out: Hunk[] = [];
  for (const r of [...regions].sort((x, y) => x.bStart - y.bStart)) {
    const same = r.bStart - bi;
    if (same < 0 || r.bLen < 0 || r.aLen < 0 || ai + same > a.length) return null;
    for (let k = 0; k < same; k++) if (a[ai + k] !== b[bi + k]) return null;
    ai += same;
    bi += same;
    if (ai + r.aLen > a.length || bi + r.bLen > b.length) return null;
    for (const h of diffLines(a.slice(ai, ai + r.aLen), b.slice(bi, bi + r.bLen)))
      out.push({ ...h, aStart: h.aStart + ai, bStart: h.bStart + bi });
    ai += r.aLen;
    bi += r.bLen;
  }
  if (a.length - ai !== b.length - bi) return null;
  for (let k = 0; ai + k < a.length; k++) if (a[ai + k] !== b[bi + k]) return null;
  return out;
}

/** Applies one Claude tool call (file `before` → `after`) to the regions. */
export function recordClaudeEdit(regions: readonly Region[], before: readonly string[], after: readonly string[]): Region[] {
  // Last change first, in `before` coordinates, so earlier positions stay valid.
  let rs = [...regions];
  for (const h of diffLines([...before], [...after]).reverse()) rs = applyEdit(rs, h.aStart, h.aLines.length, h.bLines.length, true);
  return rs;
}
