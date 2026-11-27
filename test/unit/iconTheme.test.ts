import { describe, it, expect } from 'vitest';
import { iconIdFor, parseJsonc } from '../../src/core/iconTheme';

const theme = {
  file: '_file',
  fileNames: { 'package.json': '_npm' },
  fileExtensions: { 'd.ts': '_dts', ts: '_ts' },
  languageIds: { typescript: '_tslang', python: '_py' },
};

describe('iconIdFor (VS Code lookup order)', () => {
  it('file name first, then the longest extension, then the language, then the default', () => {
    expect(iconIdFor(theme, 'Package.json', 'json')).toBe('_npm');
    expect(iconIdFor(theme, 'x.d.ts', 'typescript')).toBe('_dts');
    expect(iconIdFor(theme, 'x.ts', 'typescript')).toBe('_ts');
    expect(iconIdFor(theme, 'x.py', 'python')).toBe('_py');
    expect(iconIdFor(theme, 'x.unknown', undefined)).toBe('_file');
  });
});

describe('parseJsonc', () => {
  it('reads comments and trailing commas, keeps // inside strings', () => {
    expect(parseJsonc('{\n // c\n "a": "http://x", /* b */ "c": [1,2,],\n}')).toEqual({ a: 'http://x', c: [1, 2] });
  });
});
