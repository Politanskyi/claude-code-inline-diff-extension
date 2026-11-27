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

  it('every command hidden from the palette is reachable from a menu, keybinding or the code', () => {
    const code = ['extension', 'views', 'insets', 'render', 'review']
      .map((f) => fs.readFileSync(path.join(root, `src/${f}.ts`), 'utf8'))
      .join('\n')
      .replace(/reg\('[\w]+'/g, '');
    const hidden = pkg.contributes.menus.commandPalette.filter((i: any) => i.when === 'false').map((i: any) => i.command);
    const reachable = new Set([
      ...Object.values(pkg.contributes.menus)
        .flat()
        .filter((i: any) => i.when !== 'false')
        .map((i: any) => i.command),
      ...pkg.contributes.keybindings.map((k: { command: string }) => k.command),
    ]);
    const orphans = hidden.filter(
      (c: string) => !reachable.has(c) && !code.includes(c) && !code.includes(`'${c.replace('claudeInlineDiff.', '')}'`)
    );
    expect(orphans).toEqual([]);
  });
});
