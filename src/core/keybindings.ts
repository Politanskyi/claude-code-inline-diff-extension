// Keyboard-shortcut conflicts with other extensions (e.g. IntelliJ IDEA Keybindings binds Cmd+Y / Cmd+N).
// Extension keybindings all share one priority, so another extension can silently win. User
// keybindings.json entries always win, so the fix is to copy ours there, with our `when` clauses
// (active only inside a Claude change) so the other extension keeps the keys everywhere else.

export interface KeybindingContribution {
  command: string;
  key?: string;
  mac?: string;
  linux?: string;
  win?: string;
  when?: string;
}

const MOD_ORDER = ['ctrl', 'shift', 'alt', 'cmd'];

/** "Shift+Cmd+Backspace" → "shift+cmd+backspace" with a stable modifier order; chords are kept as-is. */
export function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .split(' ')
    .map((part) => {
      const bits = part.split('+').map((b) => (b === 'meta' || b === 'win' ? 'cmd' : b === 'option' ? 'alt' : b));
      const mods = bits.slice(0, -1).sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
      return [...mods, bits[bits.length - 1]].join('+');
    })
    .join(' ');
}

export function keyFor(k: KeybindingContribution, platform: NodeJS.Platform): string | undefined {
  const raw = platform === 'darwin' ? (k.mac ?? k.key) : platform === 'win32' ? (k.win ?? k.key) : (k.linux ?? k.key);
  return raw ? normalizeKey(raw) : undefined;
}

export interface Conflict {
  key: string;
  ours: KeybindingContribution;
  theirs: { extension: string; command: string; when?: string }[];
}

/** Our keybindings whose key another extension also binds (for the current platform). */
export function findConflicts(
  ours: KeybindingContribution[],
  others: { extension: string; keybindings: KeybindingContribution[] }[],
  platform: NodeJS.Platform
): Conflict[] {
  const out: Conflict[] = [];
  for (const o of ours) {
    const key = keyFor(o, platform);
    if (!key) continue;
    const theirs: Conflict['theirs'] = [];
    for (const ext of others) {
      for (const k of ext.keybindings) {
        if (!k || typeof k.command !== 'string' || k.command.startsWith('-')) continue;
        if (keyFor(k, platform) === key) theirs.push({ extension: ext.extension, command: k.command, when: k.when });
      }
    }
    if (theirs.length) out.push({ key, ours: o, theirs });
  }
  return out;
}

/** Removes comments (keeping strings) with blanks so offsets stay aligned. */
function blankComments(text: string): string {
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
    } else if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e < 0 ? text.length : e + 2;
      out += text.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export const MARKER = '// Claude Inline Diff: active only inside a Claude change; elsewhere your other shortcuts apply.';

/**
 * Appends user keybindings (JSONC array text). Entries already present (same key + command) are skipped.
 * Returns the new text, or null when nothing had to be added. Throws if the text is not an array.
 */
export function addUserKeybindings(text: string, entries: { key: string; command: string; when?: string }[]): string | null {
  const clean = blankComments(text);
  if (!clean.trim()) text = '[]';
  const c2 = clean.trim() ? clean : '[]';
  const open = c2.indexOf('[');
  const close = c2.lastIndexOf(']');
  if (open < 0 || close < open || c2.slice(0, open).trim() || c2.slice(close + 1).trim())
    throw new Error('keybindings.json is not a JSON array');
  let existing: any[] = [];
  try {
    existing = JSON.parse(c2.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    throw new Error('keybindings.json could not be parsed');
  }
  const has = (e: { key: string; command: string }) =>
    existing.some((x) => x && x.command === e.command && typeof x.key === 'string' && normalizeKey(x.key) === normalizeKey(e.key));
  const todo = entries.filter((e) => !has(e));
  if (!todo.length) return null;
  let p = close - 1;
  while (p > open && /\s/.test(c2[p])) p--;
  const needsComma = c2[p] !== '[' && c2[p] !== ',';
  const body = todo.map((e) => '\t' + JSON.stringify({ key: e.key, command: e.command, ...(e.when ? { when: e.when } : {}) })).join(',\n');
  // Comma right after the last entry; whatever followed it (e.g. a trailing comment) stays in place.
  const between = text.slice(p + 1, close).replace(/\s+$/, '');
  return text.slice(0, p + 1) + (needsComma ? ',' : '') + between + `\n\t${MARKER}\n${body}\n` + text.slice(close);
}

/**
 * Removes what addUserKeybindings wrote: our marker lines and the one-line entries of our commands (and the
 * comma it put after the entry before them). Returns the new text, or null when nothing of ours is there.
 * Throws if the result would not parse, so a hand-edited file is never damaged.
 */
export function removeUserKeybindings(text: string, commandPrefix = 'claudeInlineDiff.'): string | null {
  const ours = new RegExp(`^\\s*\\{[^\\n]*"command"\\s*:\\s*"${commandPrefix.replace(/\./g, '\\.')}[^\\n]*\\}\\s*,?\\s*$`);
  const lines = text.split('\n');
  const kept = lines.filter((l) => l.trim() !== MARKER && !ours.test(l));
  if (kept.length === lines.length) return null;
  let out = kept.join('\n');
  // The entry before ours got a comma from us; with nothing after it, take the comma back.
  const clean = blankComments(out);
  const close = clean.lastIndexOf(']');
  let p = close - 1;
  while (p >= 0 && /\s/.test(clean[p])) p--;
  if (close > 0 && clean[p] === ',') out = out.slice(0, p) + out.slice(p + 1);
  JSON.parse(blankComments(out).replace(/,(\s*[}\]])/g, '$1') || '[]');
  return out;
}
