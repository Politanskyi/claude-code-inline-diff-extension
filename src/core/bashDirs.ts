// Which folders a shell command says it works in: `cd <dir> && …`, `pushd <dir>`, `git -C <dir> …`.
// Used by the hook to look for Bash edits in a repository other than the chat's project. A heuristic:
// a command that changes files somewhere else without naming the folder this way is not seen.
import * as path from 'path';

const MAX_DIRS = 3;

/** One shell word at the start of `s`: quoted or bare; null when it needs the shell to work out ($VAR, `cmd`, globs). */
function firstWord(s: string, home: string): string | null {
  let out = '';
  let i = 0;
  let any = false;
  while (i < s.length && !/\s/.test(s[i])) {
    const c = s[i];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      out += s.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      const end = s.indexOf('"', i + 1);
      if (end < 0) return null;
      const inner = s.slice(i + 1, end);
      if (/[`\\]/.test(inner)) return null;
      out += inner;
      i = end + 1;
    } else if (c === '\\' && i + 1 < s.length) {
      out += s[i + 1];
      i += 2;
    } else if (/[`*?()<>]/.test(c)) return null;
    else {
      out += c;
      i++;
    }
    any = true;
  }
  if (!any || !out) return null;
  out = out.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home);
  if (out === '~' || out.startsWith('~/')) out = home + out.slice(1);
  if (out.includes('$') || out.startsWith('~') || out === '-') return null;
  return out;
}

/**
 * Absolute folders named by `cd` / `pushd` at the start of a command part and by `git -C`, in order.
 * A relative `cd` continues from the previous one, as in the shell.
 */
export function commandDirs(command: string, cwd: string, home: string): string[] {
  const dirs: string[] = [];
  const add = (d: string) => {
    if (!dirs.includes(d) && dirs.length < MAX_DIRS) dirs.push(d);
  };
  let here = cwd;
  for (const part of command.split(/&&|\|\||[;|\n(){}]/)) {
    const seg = part.trim();
    let m = /^(?:cd|pushd)\s+(?:--\s+)?/.exec(seg);
    if (m) {
      const w = firstWord(seg.slice(m[0].length), home);
      if (w) {
        here = path.resolve(here, w);
        add(here);
      }
      continue;
    }
    m = /^git\s+-C\s+/.exec(seg);
    if (m) {
      const w = firstWord(seg.slice(m[0].length), home);
      if (w) add(path.resolve(here, w));
    }
  }
  return dirs;
}
