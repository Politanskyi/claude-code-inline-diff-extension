import { describe, it, expect } from 'vitest';
import { normalizeKey, findConflicts, addUserKeybindings, keyFor, removeUserKeybindings } from '../../src/core/keybindings';

const parse = (t: string) => JSON.parse(t.replace(/\/\/[^"\n]*$/gm, ''));

describe('keybinding conflicts', () => {
  it('normalizes modifier order and aliases', () => {
    expect(normalizeKey('Shift+Cmd+Backspace')).toBe('shift+cmd+backspace');
    expect(normalizeKey('cmd+shift+backspace')).toBe('shift+cmd+backspace');
    expect(normalizeKey('alt+cmd+enter')).toBe(normalizeKey('cmd+alt+enter'));
    expect(normalizeKey('ctrl+k ctrl+s')).toBe('ctrl+k ctrl+s');
  });

  it('finds IntelliJ-style conflicts per platform', () => {
    const ours = [
      { command: 'claudeInlineDiff.acceptHunk', key: 'ctrl+y', mac: 'cmd+y', when: 'x' },
      { command: 'claudeInlineDiff.nextHunk', key: 'alt+f5', mac: 'alt+f5' },
    ];
    const others = [
      {
        extension: 'k--kato.intellij-idea-keybindings',
        keybindings: [
          { mac: 'cmd+y', command: 'editor.action.previewDeclaration' },
          { key: 'ctrl+y', command: 'editor.action.deleteLines' },
          { mac: 'cmd+y', command: '-foo' },
        ],
      },
    ];
    const mac = findConflicts(ours, others, 'darwin');
    expect(mac).toHaveLength(1);
    expect(mac[0].theirs).toEqual([
      { extension: 'k--kato.intellij-idea-keybindings', command: 'editor.action.previewDeclaration', when: undefined },
    ]);
    expect(findConflicts(ours, others, 'linux')[0].theirs[0].command).toBe('editor.action.deleteLines');
    expect(keyFor({ command: 'c', key: 'ctrl+y', mac: 'cmd+y' }, 'darwin')).toBe('cmd+y');
  });
});

describe('addUserKeybindings', () => {
  const e = [{ key: 'cmd+y', command: 'claudeInlineDiff.acceptHunk', when: 'editorTextFocus && claudeInlineDiff.cursorInHunk' }];

  it('appends to a commented user file and keeps comments', () => {
    const src = '// Place your key bindings in this file to override the defaults\n[\n\t{ "key": "cmd+k", "command": "foo" } // mine\n]\n';
    const out = addUserKeybindings(src, e)!;
    expect(out).toContain('// mine');
    expect(parse(out)).toHaveLength(2);
    expect(parse(out)[1].command).toBe('claudeInlineDiff.acceptHunk');
  });

  it('handles empty file, empty array and trailing comma', () => {
    expect(parse(addUserKeybindings('', e)!)).toHaveLength(1);
    expect(parse(addUserKeybindings('[]', e)!)).toHaveLength(1);
    expect(parse(addUserKeybindings('[{"key":"a","command":"b"},]', e)!.replace(/,(\s*[}\]])/g, '$1'))).toHaveLength(2);
  });

  it('is idempotent', () => {
    const once = addUserKeybindings('[]', e)!;
    expect(addUserKeybindings(once, e)).toBeNull();
  });

  it('refuses non-arrays', () => {
    expect(() => addUserKeybindings('{}', e)).toThrow();
  });
});

describe('removeUserKeybindings', () => {
  const e = [
    { key: 'cmd+y', command: 'claudeInlineDiff.acceptHunk', when: 'editorTextFocus && claudeInlineDiff.cursorInHunk' },
    { key: 'cmd+n', command: 'claudeInlineDiff.rejectHunk' },
  ];

  it('gives back the original file after add + remove', () => {
    const src = '// Place your key bindings in this file to override the defaults\n[\n\t{ "key": "cmd+k", "command": "foo" } // mine\n]\n';
    expect(removeUserKeybindings(addUserKeybindings(src, e)!)).toBe(src);
  });

  it('leaves an empty array when only ours were there, and other files alone', () => {
    expect(parse(removeUserKeybindings(addUserKeybindings('', e)!)!)).toEqual([]);
    expect(removeUserKeybindings('[\n\t{ "key": "cmd+k", "command": "foo" }\n]\n')).toBeNull();
  });
});
