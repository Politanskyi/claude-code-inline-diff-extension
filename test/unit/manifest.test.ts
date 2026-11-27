import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const src = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');

describe('package.json ↔ extension.ts', () => {
  it('every contributed command has a handler', () => {
    const registered = new Set([...src.matchAll(/reg\('([\w]+)'/g)].map((m) => 'claudeInlineDiff.' + m[1]));
    const missing = pkg.contributes.commands.map((c: { command: string }) => c.command).filter((c: string) => !registered.has(c));
    expect(missing).toEqual([]);
  });

  it('every menu item and keybinding points at a contributed command', () => {
    const known = new Set(pkg.contributes.commands.map((c: { command: string }) => c.command));
    const used = [
      ...Object.values(pkg.contributes.menus).flatMap((items: any) => items.map((i: { command: string }) => i.command)),
      ...pkg.contributes.keybindings.map((k: { command: string }) => k.command),
    ];
    expect(used.filter((c) => !known.has(c))).toEqual([]);
  });
});
