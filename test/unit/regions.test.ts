import { describe, it, expect } from 'vitest';
import { diffLines } from '../../src/core/diff';
import { applyEdit, hunksFromRegions, recordClaudeEdit, acceptInRegions, Region } from '../../src/core/regions';

const BASE = `export interface Order {
  id: string;
  total: number;
}

export function isPaid(order: Order): boolean {
  return order.status === 'paid';
}

export function describe(order: Order): string {
  return 'Order ' + order.id + ' is ' + order.status;
}

export function legacyTotal(orders: Order[]): number {
  let sum = 0;
  for (const o of orders) sum += o.total;
  return sum;
}

export function sortByTotal(orders: Order[]): Order[] {
  return [...orders].sort((a, b) => a.total - b.total);
}

export const CURRENCY = 'USD';`.split('\n');

/** Claude's five edits of the live comparison with Cursor, one tool call each. */
function claudeEdits(): { text: string[]; regions: Region[] } {
  let text = [...BASE];
  let regions: Region[] = [];
  const edit = (from: string, to: string) => {
    const before = text;
    const s = before.join('\n');
    if (!s.includes(from)) throw new Error('missing ' + from);
    text = s.replace(from, to).split('\n');
    regions = recordClaudeEdit(regions, before, text);
  };
  edit("=== 'paid';", "=== 'paid' || order.status === 'shipped';");
  edit("'Order ' + order.id + ' is ' + order.status;", '`Order ${order.id} is ${order.status}`;');
  edit(
    'export function legacyTotal(orders: Order[]): number {\n  let sum = 0;\n  for (const o of orders) sum += o.total;\n  return sum;\n}\n\n',
    ''
  );
  edit(
    'a.total - b.total);\n}\n',
    'a.total - b.total);\n}\n\nexport function totalOf(orders: Order[]): number {\n  return orders.reduce((s, o) => s + o.total, 0);\n}\n'
  );
  edit("CURRENCY = 'USD'", "CURRENCY = 'EUR'");
  return { text, regions };
}

describe('edit regions (changes grouped like Cursor)', () => {
  it('a whole-file diff glues describe() to the deleted function; regions keep them apart', () => {
    const { text, regions } = claudeEdits();
    const whole = diffLines(BASE, text);
    expect(whole.some((h) => h.aLines.some((l) => l.includes("'Order '")) && h.aLines.some((l) => l.includes('legacyTotal')))).toBe(true);

    const hunks = hunksFromRegions(BASE, text, regions)!;
    expect(hunks).not.toBeNull();
    const describeHunk = hunks.find((h) => h.aLines.some((l) => l.includes("'Order '")))!;
    expect(describeHunk.aLines).toEqual(["  return 'Order ' + order.id + ' is ' + order.status;"]);
    expect(describeHunk.bLines).toEqual(['  return `Order ${order.id} is ${order.status}`;']);
    const deleted = hunks.find((h) => h.aLines.some((l) => l.includes('legacyTotal')))!;
    expect(deleted.bLines).toEqual([]);
    expect(deleted.aLines[0]).toBe('export function legacyTotal(orders: Order[]): number {');
    expect(hunks).toHaveLength(4); // isPaid, describe, legacyTotal, totalOf + CURRENCY (touching edits join)
  });

  it('Keep and Undo keep regions consistent with the texts', () => {
    const { text, regions } = claudeEdits();
    const hunks = hunksFromRegions(BASE, text, regions)!;
    // Keep the describe change: the baseline takes Claude's line.
    const h = hunks[1];
    const base2 = [...BASE.slice(0, h.aStart), ...h.bLines, ...BASE.slice(h.aStart + h.aLines.length)];
    const after = hunksFromRegions(base2, text, acceptInRegions(regions, h))!;
    expect(after).toHaveLength(3);
    // Undo the legacyTotal deletion: the file takes the old lines back.
    const d = after.find((x) => x.bLines.length === 0)!;
    const text2 = [...text.slice(0, d.bStart), ...d.aLines, ...text.slice(d.bStart)];
    const r2 = applyEdit(acceptInRegions(regions, h), d.bStart, 0, d.aLines.length, true);
    const after2 = hunksFromRegions(base2, text2, r2)!;
    expect(after2.map((x) => x.aLines.join('|'))).toEqual(after.filter((x) => x !== d).map((x) => x.aLines.join('|')));
  });

  it('a user edit outside regions moves them; stale regions give null (whole-file diff instead)', () => {
    const { text, regions } = claudeEdits();
    const userText = ['// header', ...text];
    const userBase = ['// header', ...BASE];
    expect(hunksFromRegions(userBase, userText, applyEdit(regions, 0, 0, 1, false))).toHaveLength(4);
    expect(hunksFromRegions(userBase, userText, regions)).toBeNull();
  });

  it('a new file written by Claude is one region', () => {
    const regions = recordClaudeEdit([], [], ['a', 'b']);
    expect(hunksFromRegions([], ['a', 'b'], regions)).toEqual([{ aStart: 0, aLines: [], bStart: 0, bLines: ['a', 'b'] }]);
  });
});
