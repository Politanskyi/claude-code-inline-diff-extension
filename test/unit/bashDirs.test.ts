import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { commandDirs } from '../../src/core/bashDirs';

const cwd = path.resolve('/work/app');
const home = path.resolve('/home/me');
const dirs = (c: string) => commandDirs(c, cwd, home);
const r = (...p: string[]) => path.resolve(...p);

describe('folders a shell command names', () => {
  it('reads cd at the start, absolute and relative', () => {
    expect(dirs('cd /srv/lib && npm test')).toEqual([r('/srv/lib')]);
    expect(dirs('cd ../lib; make')).toEqual([r('/work/lib')]);
    expect(dirs('npm test')).toEqual([]);
  });

  it('expands ~ and $HOME, and understands quotes and escapes', () => {
    expect(dirs('cd ~/Desktop/x && ls')).toEqual([r(home, 'Desktop/x')]);
    expect(dirs('cd "$HOME/my repo" && ls')).toEqual([r(home, 'my repo')]);
    expect(dirs("cd '/srv/my repo' && ls")).toEqual([r('/srv/my repo')]);
    expect(dirs('cd /srv/my\\ repo && ls')).toEqual([r('/srv/my repo')]);
  });

  it('follows a chain of cd like the shell and finds cd after other commands', () => {
    expect(dirs('cd /srv && cd lib && make')).toEqual([r('/srv'), r('/srv/lib')]);
    expect(dirs('echo hi && cd /srv/lib && make')).toEqual([r('/srv/lib')]);
    expect(dirs('(cd /srv/lib && make)')).toEqual([r('/srv/lib')]);
    expect(dirs('pushd /srv/lib\nmake')).toEqual([r('/srv/lib')]);
  });

  it('reads git -C, relative to the last cd', () => {
    expect(dirs('git -C /srv/lib status')).toEqual([r('/srv/lib')]);
    expect(dirs('cd /srv && git -C lib apply p.patch')).toEqual([r('/srv'), r('/srv/lib')]);
  });

  it('keeps backslashes of Windows paths inside double quotes, like bash', () => {
    expect(commandDirs('cd "C:\\Users\\me\\other repo" && fmt', 'C:\\work\\app', 'C:\\Users\\me', true)).toEqual([
      'C:\\Users\\me\\other repo',
    ]);
    expect(dirs('cd "/srv/a\\"b" && ls')).toEqual([r('/srv/a"b')]);
  });

  it('reads Git Bash drive paths on Windows', () => {
    const win = (c: string) => commandDirs(c, 'C:\\work\\app', 'C:\\Users\\me', true);
    expect(win('cd /c/Users/me/x && ls')).toEqual(['C:\\Users\\me\\x']);
    expect(win('cd /d && ls')).toEqual(['D:\\']);
    expect(win('cd ~/x && ls')).toEqual(['C:\\Users\\me\\x']);
    expect(dirs('cd /c/Users/me/x && ls')).toEqual([r('/c/Users/me/x')]); // elsewhere it is a plain folder
  });

  it('gives up on what only the shell can work out', () => {
    expect(dirs('cd "$TARGET" && make')).toEqual([]);
    expect(dirs('cd $(mktemp -d) && make')).toEqual([]);
    expect(dirs('cd - && make')).toEqual([]);
    expect(dirs('cd ~other/x && make')).toEqual([]);
    expect(dirs('cd')).toEqual([]);
    expect(dirs('echo "cd is a word"')).toEqual([]);
  });

  it('returns each folder once and at most three', () => {
    expect(dirs('cd /a && cd /a && cd /b && cd /c && cd /d')).toEqual([r('/a'), r('/b'), r('/c')]);
  });
});
