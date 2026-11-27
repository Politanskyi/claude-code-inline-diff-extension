// Adds our extension id to argv.json's "enable-proposed-api" without breaking
// the file. argv.json is JSONC (comments allowed), so we edit text, not JSON.
import * as os from 'os';
import * as path from 'path';

/** Removes comments (keeping strings intact) so we can inspect the structure. */
function stripComments(text: string): string {
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

export function hasProposedApi(text: string, id: string): boolean {
  const clean = stripComments(text);
  const m = /"enable-proposed-api"\s*:\s*\[([^\]]*)\]/.exec(clean);
  return !!m && m[1].split(',').some((s) => s.trim().replace(/^"|"$/g, '').toLowerCase() === id.toLowerCase());
}

/**
 * Returns argv.json text with `id` in "enable-proposed-api" (unchanged if already there).
 * Throws if the file's structure is not recognisable (caller then shows manual steps).
 */
export function addProposedApi(text: string, id: string): string {
  if (hasProposedApi(text, id)) return text;
  const clean = stripComments(text);
  if (!clean.trim()) return `{\n\t"enable-proposed-api": ["${id}"]\n}\n`;
  const arr = /"enable-proposed-api"\s*:\s*\[([^\]]*)\]/.exec(clean);
  if (arr) {
    const closeIdx = arr.index + arr[0].length - 1; // the ']'
    const inner = arr[1];
    const sep = inner.trim() ? ', ' : '';
    // Insert after the last non-space char inside the array (positions match: comments were blanked, not removed).
    let insertAt = closeIdx;
    while (insertAt > 0 && /\s/.test(clean[insertAt - 1])) insertAt--;
    return text.slice(0, insertAt) + `${sep}"${id}"` + text.slice(insertAt);
  }
  const last = clean.lastIndexOf('}');
  const first = clean.indexOf('{');
  if (first < 0 || last < first) throw new Error('argv.json is not a JSON object');
  let p = last - 1;
  while (p > first && /\s/.test(clean[p])) p--;
  const needsComma = clean[p] !== '{' && clean[p] !== ',';
  const insert = `${needsComma ? ',' : ''}\n\t"enable-proposed-api": ["${id}"]\n`;
  return text.slice(0, p + 1) + insert + text.slice(last);
}

/** ~/.cursor/argv.json, ~/.vscode/argv.json, … by product. */
export function argvPathFor(appName: string, home = os.homedir()): string {
  const n = appName.toLowerCase();
  const folder = n.includes('cursor')
    ? '.cursor'
    : n.includes('insiders')
      ? '.vscode-insiders'
      : n.includes('vscodium') || n.includes('oss')
        ? '.vscode-oss'
        : n.includes('windsurf')
          ? '.windsurf'
          : '.vscode';
  return path.join(home, folder, 'argv.json');
}
