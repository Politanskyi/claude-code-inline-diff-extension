import { describe, it, expect } from 'vitest';
import { addProposedApi, hasProposedApi, argvPathFor, removeProposedApi } from '../../src/core/argv';

const ID = 'inlinediff.claude-inline-diff';
const parse = (t: string) => JSON.parse(t.replace(/\/\/.*$/gm, ''));

describe('argv.json editing', () => {
  it('adds the key to a typical commented argv.json', () => {
    const src =
      '// This configuration file allows you to pass permanent command line arguments\n{\n\t// "disable-hardware-acceleration": true,\n\t"enable-crash-reporter": false,\n\t"crash-reporter-id": "abc"\n}\n';
    const out = addProposedApi(src, ID);
    expect(parse(out)['enable-proposed-api']).toEqual([ID]);
    expect(parse(out)['crash-reporter-id']).toBe('abc');
    expect(out).toContain('// "disable-hardware-acceleration": true,');
    expect(hasProposedApi(out, ID)).toBe(true);
  });

  it('appends to an existing array and is idempotent', () => {
    const src = '{ "enable-proposed-api": ["other.ext"] }';
    const out = addProposedApi(src, ID);
    expect(parse(out)['enable-proposed-api']).toEqual(['other.ext', ID]);
    expect(addProposedApi(out, ID)).toBe(out);
  });

  it('handles empty array, empty object, trailing comma, empty file', () => {
    expect(parse(addProposedApi('{"enable-proposed-api": []}', ID))['enable-proposed-api']).toEqual([ID]);
    expect(parse(addProposedApi('{}', ID))['enable-proposed-api']).toEqual([ID]);
    expect(addProposedApi('{ "a": 1, }', ID)).toContain('"a": 1,\n\t"enable-proposed-api"');
    expect(parse(addProposedApi('', ID))['enable-proposed-api']).toEqual([ID]);
  });

  it('ignores a commented-out key', () => {
    const src = '{\n // "enable-proposed-api": ["' + ID + '"]\n "x": 1\n}';
    expect(hasProposedApi(src, ID)).toBe(false);
    expect(parse(addProposedApi(src, ID))['enable-proposed-api']).toEqual([ID]);
  });

  it('throws on non-object content', () => {
    expect(() => addProposedApi('[1]', ID)).toThrow();
  });

  it('maps products to argv locations', () => {
    expect(argvPathFor('Cursor', '/h')).toMatch(/[\\/]\.cursor[\\/]argv\.json$/);
    expect(argvPathFor('Visual Studio Code', '/h')).toMatch(/[\\/]\.vscode[\\/]argv\.json$/);
    expect(argvPathFor('Visual Studio Code - Insiders', '/h')).toMatch(/\.vscode-insiders/);
  });
});

describe('argv.json: removing our id', () => {
  const commented =
    '// This configuration file allows you to pass permanent command line arguments\n{\n\t// "disable-hardware-acceleration": true,\n\t"enable-crash-reporter": false,\n\t"crash-reporter-id": "abc"\n}\n';

  it('gives back the original file after add + remove', () => {
    expect(removeProposedApi(addProposedApi(commented, ID), ID)).toBe(commented);
  });

  it('keeps other ids in the array', () => {
    const src = '{\n\t"enable-proposed-api": ["other.ext", "inlinediff.claude-inline-diff"]\n}\n';
    const out = removeProposedApi(src, ID);
    expect(parse(out)['enable-proposed-api']).toEqual(['other.ext']);
    expect(hasProposedApi(out, ID)).toBe(false);
  });

  it('removes the property when it comes first, keeping what follows', () => {
    const out = removeProposedApi('{\n\t"enable-proposed-api": ["inlinediff.claude-inline-diff"],\n\t"x": 1\n}\n', ID);
    expect(parse(out)).toEqual({ x: 1 });
  });

  it('leaves an empty object when ours was the only key, and a file without our id alone', () => {
    expect(parse(removeProposedApi(addProposedApi('', ID), ID))).toEqual({});
    expect(removeProposedApi(commented, ID)).toBe(commented);
  });
});
