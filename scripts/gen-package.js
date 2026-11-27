// One-off generator for package.json contributions (kept for maintainability: edit and re-run).
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const C = (command, title, icon, extra = {}) => ({ command: 'claudeInlineDiff.' + command, title, category: 'Claude Inline Diff', ...(icon ? { icon: '$(' + icon + ')' } : {}), ...extra });
const commands = [
  C('acceptHunk', 'Keep Change', 'check'),
  C('rejectHunk', 'Undo Change', 'discard'),
  C('rejectHunkWithFeedback', 'Undo Change with Feedback for Claude…', 'comment-discussion'),
  C('acceptFile', 'Keep File (all changes in this file)', 'check-all'),
  C('rejectFile', 'Undo File (all changes in this file)', 'close-all'),
  C('acceptAll', 'Keep All (all files)', 'check-all'),
  C('rejectAll', 'Undo All (all files)', 'close-all'),
  C('undo', 'Revert Last Keep/Undo', 'reply'),
  // Text-only twins (no icon) so the editor title bar / floating bar show words like Cursor's buttons.
  { command: 'claudeInlineDiff.keepFileText', title: 'Keep File', category: 'Claude Inline Diff' },
  { command: 'claudeInlineDiff.undoFileText', title: 'Undo File', category: 'Claude Inline Diff' },
  { command: 'claudeInlineDiff.keepAllText', title: 'Keep All', category: 'Claude Inline Diff' },
  { command: 'claudeInlineDiff.undoAllText', title: 'Undo All', category: 'Claude Inline Diff' },
  { command: 'claudeInlineDiff.nextFileText', title: 'Next File ›', category: 'Claude Inline Diff' },
  C('reviewAll', 'Review All Changes (multi-file diff)', 'diff-multiple'),
  C('nextHunk', 'Next Change', 'arrow-down'),
  C('prevHunk', 'Previous Change', 'arrow-up'),
  C('nextFile', 'Next File with Changes', 'arrow-right'),
  C('prevFile', 'Previous File with Changes', 'arrow-left'),
  C('showDiff', 'Open Side-by-Side Diff', 'diff'),
  C('listFiles', 'List Files to Review', 'list-flat'),
  C('installHooks', 'Install Claude Code Hook'),
  C('uninstallHooks', 'Uninstall Claude Code Hook'),
  C('hookStatus', 'Show Hook Status'),
  C('enableInsets', 'Enable Inline Removed-Code Blocks (argv.json)…'),
  C('revertStep', 'Revert to Before This Step', 'history'),
  C('clearSnapshots', 'Delete Review Snapshots (.claude-review)…'),
  C('refresh', 'Refresh', 'refresh'),
  C('openFile', 'Open File at First Change'),
  C('revealHunk', 'Show Change'),
];
const when = {
  hunk: 'editorTextFocus && claudeInlineDiff.cursorInHunk',
  file: 'editorTextFocus && claudeInlineDiff.activeFileHasChanges',
  cursor: "config.claudeInlineDiff.keybindingScheme != 'alt'",
  alt: "config.claudeInlineDiff.keybindingScheme != 'cursor'",
};
const K = (command, key, mac, w) => ({ command: 'claudeInlineDiff.' + command, key, mac, when: w });
const keybindings = [
  K('acceptHunk', 'ctrl+y', 'cmd+y', `${when.hunk} && ${when.cursor}`),
  K('rejectHunk', 'ctrl+n', 'cmd+n', `${when.hunk} && ${when.cursor}`),
  K('acceptFile', 'ctrl+shift+y', 'cmd+shift+y', `${when.file} && ${when.cursor}`),
  K('rejectFile', 'ctrl+shift+n', 'cmd+shift+n', `${when.file} && ${when.cursor}`),
  // Cursor's own bulk keys (from Cursor 3.32 source: "Accept Edits" Cmd+Enter, "Reject All Edits" Cmd+Shift+Backspace).
  K('acceptFile', 'ctrl+enter', 'cmd+enter', `${when.file} && ${when.cursor}`),
  K('rejectFile', 'ctrl+shift+backspace', 'cmd+shift+backspace', `${when.file} && ${when.cursor}`),
  K('acceptHunk', 'ctrl+alt+enter', 'cmd+alt+enter', `${when.hunk} && ${when.alt}`),
  K('rejectHunk', 'ctrl+alt+backspace', 'cmd+alt+backspace', `${when.hunk} && ${when.alt}`),
  K('acceptFile', 'ctrl+shift+alt+enter', 'cmd+shift+alt+enter', `${when.file} && ${when.alt}`),
  K('rejectFile', 'ctrl+shift+alt+backspace', 'cmd+shift+alt+backspace', `${when.file} && ${when.alt}`),
  K('nextHunk', 'alt+f5', 'alt+f5', 'editorTextFocus && claudeInlineDiff.hasChanges'),
  K('prevHunk', 'shift+alt+f5', 'shift+alt+f5', 'editorTextFocus && claudeInlineDiff.hasChanges'),
  K('nextFile', 'ctrl+alt+pagedown', 'cmd+alt+pagedown', 'claudeInlineDiff.hasChanges'),
  K('prevFile', 'ctrl+alt+pageup', 'cmd+alt+pageup', 'claudeInlineDiff.hasChanges'),
  K('undo', 'ctrl+z', 'cmd+z', 'editorTextFocus && claudeInlineDiff.canUndoAccept'),
];
const P = (type, def, description, extra = {}) => ({ type, default: def, markdownDescription: description, ...extra });
const configuration = {
  title: 'Claude Inline Diff',
  properties: {
    'claudeInlineDiff.storage.location': P('string', 'project', 'Where review snapshots live. `project`: `<git root>/.claude-review/` (ignores itself via its own `.gitignore`). `home`: `~/.claude/inline-diff/store/`. Files outside the project always use `home`.', { enum: ['project', 'home'] }),
    'claudeInlineDiff.storage.projectDirName': P('string', '.claude-review', 'Folder name of the project-local store.'),
    'claudeInlineDiff.trackBashEdits': P('boolean', true, 'Detect files changed by Claude\'s **Bash** tool (git repositories only: compares `git status` before/after each command).'),
    'claudeInlineDiff.keybindingScheme': P('string', 'both', '`cursor`: Cmd/Ctrl+Y / N per change, Cmd/Ctrl+Shift+Y / N per file. `alt`: Cmd/Ctrl+Alt+Enter / Backspace (+Shift for file). `both`: all of them. Keys are only active while the cursor is inside a Claude change (file keys: while the file has changes).', { enum: ['cursor', 'alt', 'both'] }),
    'claudeInlineDiff.autoAdvance': P('string', 'hunkThenFile', 'After Accept/Reject jump to the next change, then the next file.', { enum: ['hunkThenFile', 'hunk', 'off'] }),
    'claudeInlineDiff.followClaude': P('boolean', true, 'When Claude lands a new change in a visible file, scroll to it and briefly highlight it (like Cursor\'s agent). Never moves the view while your cursor is inside a change.'),
    'claudeInlineDiff.revealOnEdit': P('boolean', true, 'Open a file (preview tab, focus stays where it is) when Claude starts changing it, scrolled to the change.'),
    'claudeInlineDiff.deletedLines.renderer': P('string', 'auto', '`auto`: red inline blocks via the `editorInsets` proposed API when enabled, otherwise decorations. `inset` / `decoration` force one.', { enum: ['auto', 'inset', 'decoration'] }),
    'claudeInlineDiff.deletedLines.maxLines': P('number', 30, 'Removed lines drawn per block before collapsing the rest.', { minimum: 3, maximum: 500 }),
    'claudeInlineDiff.hunkToolbar': P('string', 'all', 'Cursor-style pill under each change: `⌃ 1 of 3 ⌄ | Undo | Keep` (needs the editorInsets API). `all`: under every change. `active`: only under the change at the cursor (like Cursor; lines below shift when it moves). `off`: use CodeLens instead.', { enum: ['all', 'active', 'off'] }),
    'claudeInlineDiff.showCodeLens': P('boolean', false, 'Also show Keep / Undo CodeLens above changes and at the top of the file (always used when the editorInsets API is unavailable or `hunkToolbar` is `off`).'),
    'claudeInlineDiff.floatingBar': P('boolean', true, 'Floating **Undo All / Keep All** buttons at the bottom-right of the editor (needs the `contribEditorContentMenu` proposed API, enabled by the same argv.json line).'),
    'claudeInlineDiff.highlightWords': P('boolean', true, 'Highlight changed words inside modified lines.'),
    'claudeInlineDiff.saveAfterReject': P('boolean', true, 'Save the file after Reject so Claude reads what you see.'),
    'claudeInlineDiff.absorbUserEdits': P('boolean', true, 'Your own edits outside Claude\'s changes are folded into the baseline (never shown as Claude\'s). Edits inside a change become part of it.'),
    'claudeInlineDiff.confirmRejectAll': P('boolean', true, 'Ask before rejecting all changes in all files.'),
    'claudeInlineDiff.confirmDeleteCreatedFile': P('boolean', true, 'Ask before moving a file Claude created to the trash on Reject.'),
    'claudeInlineDiff.stepRetentionDays': P('number', 7, 'Keep per-step snapshots (for step revert) this many days.', { minimum: 1 }),
    'claudeInlineDiff.pollIntervalMs': P('number', 700, 'How often to look for new snapshots (ms). File watchers are used too.', { minimum: 200 }),
  },
};
const fileWhen = 'resourceScheme == file && claudeInlineDiff.activeFileHasChanges';
const menus = {
  'editor/title': [
    { command: 'claudeInlineDiff.undoFileText', group: 'navigation@1', when: fileWhen },
    { command: 'claudeInlineDiff.keepFileText', group: 'navigation@2', when: fileWhen },
    { command: 'claudeInlineDiff.prevHunk', group: '1_claudeInlineDiff@1', when: fileWhen },
    { command: 'claudeInlineDiff.nextHunk', group: '1_claudeInlineDiff@2', when: fileWhen },
    { command: 'claudeInlineDiff.showDiff', group: '1_claudeInlineDiff@3', when: fileWhen },
    { command: 'claudeInlineDiff.reviewAll', group: '1_claudeInlineDiff@4', when: fileWhen },
  ],
  'editor/content': [
    { command: 'claudeInlineDiff.undoAllText', group: 'claudeInlineDiff@1', when: 'claudeInlineDiff.hasChanges && config.claudeInlineDiff.floatingBar' },
    { command: 'claudeInlineDiff.keepAllText', group: 'claudeInlineDiff@2', when: 'claudeInlineDiff.hasChanges && config.claudeInlineDiff.floatingBar' },
    { command: 'claudeInlineDiff.nextFileText', group: 'claudeInlineDiff@3', when: 'claudeInlineDiff.multipleFiles && config.claudeInlineDiff.floatingBar' },
  ],
  'editor/context': [
    { command: 'claudeInlineDiff.acceptHunk', group: '0_claudeInlineDiff@1', when: 'claudeInlineDiff.cursorInHunk' },
    { command: 'claudeInlineDiff.rejectHunk', group: '0_claudeInlineDiff@2', when: 'claudeInlineDiff.cursorInHunk' },
    { command: 'claudeInlineDiff.rejectHunkWithFeedback', group: '0_claudeInlineDiff@3', when: 'claudeInlineDiff.cursorInHunk' },
  ],
  'explorer/context': [
    { command: 'claudeInlineDiff.acceptFile', group: '7_claudeInlineDiff@1', when: 'resourcePath in claudeInlineDiff.files' },
    { command: 'claudeInlineDiff.rejectFile', group: '7_claudeInlineDiff@2', when: 'resourcePath in claudeInlineDiff.files' },
    { command: 'claudeInlineDiff.showDiff', group: '7_claudeInlineDiff@3', when: 'resourcePath in claudeInlineDiff.files' },
  ],
  'view/title': [
    { command: 'claudeInlineDiff.reviewAll', group: 'navigation@0', when: 'view == claudeInlineDiff.changes && claudeInlineDiff.hasChanges' },
    { command: 'claudeInlineDiff.acceptAll', group: 'navigation@1', when: 'view == claudeInlineDiff.changes && claudeInlineDiff.hasChanges' },
    { command: 'claudeInlineDiff.rejectAll', group: 'navigation@2', when: 'view == claudeInlineDiff.changes && claudeInlineDiff.hasChanges' },
    { command: 'claudeInlineDiff.undo', group: 'navigation@3', when: 'view == claudeInlineDiff.changes' },
    { command: 'claudeInlineDiff.refresh', group: '1_more@1', when: 'view == claudeInlineDiff.changes || view == claudeInlineDiff.steps' },
    { command: 'claudeInlineDiff.installHooks', group: '1_more@2', when: 'view == claudeInlineDiff.changes' },
  ],
  'view/item/context': [
    { command: 'claudeInlineDiff.showDiff', group: 'inline@1', when: 'view == claudeInlineDiff.changes && viewItem == file' },
    { command: 'claudeInlineDiff.acceptFile', group: 'inline@2', when: 'view == claudeInlineDiff.changes && viewItem == file' },
    { command: 'claudeInlineDiff.rejectFile', group: 'inline@3', when: 'view == claudeInlineDiff.changes && viewItem == file' },
    { command: 'claudeInlineDiff.acceptHunk', group: 'inline@1', when: 'view == claudeInlineDiff.changes && viewItem == hunk' },
    { command: 'claudeInlineDiff.rejectHunk', group: 'inline@2', when: 'view == claudeInlineDiff.changes && viewItem == hunk' },
    { command: 'claudeInlineDiff.acceptFile', group: 'inline@1', when: 'view == claudeInlineDiff.changes && viewItem == session' },
    { command: 'claudeInlineDiff.revertStep', group: 'inline@1', when: 'view == claudeInlineDiff.steps && viewItem == step' },
  ],
  commandPalette: ['openFile', 'revealHunk', 'revertStep', 'refresh', 'keepFileText', 'undoFileText', 'keepAllText', 'undoAllText', 'nextFileText'].map((c) => ({ command: 'claudeInlineDiff.' + c, when: 'false' })),
};
const color = (id, description, d) => ({ id: 'claudeInlineDiff.' + id, description, defaults: { dark: d.dark, light: d.light, highContrast: d.hc || d.dark, highContrastLight: d.hcl || d.light } });
const colors = [
  // Same sources as Cursor's native inline diff: the theme's diffEditor colours for lines,
  // rgba(12,233,27,.15) / rgba(242,13,59,.25) for changed words (Cursor 3.32 CSS).
  color('addedLineBackground', 'Background of lines Claude added or changed.', { dark: 'diffEditor.insertedLineBackground', light: 'diffEditor.insertedLineBackground' }),
  color('addedWordBackground', 'Background of words Claude changed.', { dark: '#0ce91b26', light: '#0ce91b26' }),
  color('addedGutter', 'Overview ruler (scrollbar) marker for added lines; also the Keep button.', { dark: 'charts.green', light: 'charts.green' }),
  color('removedLineBackground', 'Background of removed code blocks.', { dark: 'diffEditor.removedLineBackground', light: 'diffEditor.removedLineBackground' }),
  color('removedWordBackground', 'Background of removed words.', { dark: '#f20d3b40', light: '#f20d3b40' }),
  color('removedGutter', 'Overview ruler (scrollbar) marker for removed lines.', { dark: 'charts.red', light: 'charts.red' }),
  color('badgeForeground', 'Explorer / tab badge for files with Claude changes.', { dark: '#d29922', light: '#9a6700' }),
];
Object.assign(pkg, {
  name: 'claude-inline-diff',
  displayName: 'Claude Inline Diff',
  description: "Review Claude Code's edits inline, like Cursor's agent diff: red removed lines between your code, green added lines, word highlights, Accept/Reject per change, file or all (Cmd+Y / Cmd+N), auto-advance, undo.",
  version: '0.1.0',
  publisher: 'inlinediff',
  license: 'MIT',
  private: true,
  engines: { vscode: '^1.90.0' },
  categories: ['Other', 'SCM Providers', 'AI'],
  keywords: ['claude', 'claude code', 'inline diff', 'cursor', 'accept reject', 'code review'],
  activationEvents: ['onStartupFinished'],
  main: './dist/extension.js',
  enabledApiProposals: ['editorInsets', 'contribEditorContentMenu'],
  capabilities: { untrustedWorkspaces: { supported: true }, virtualWorkspaces: false },
  icon: 'media/icon.png',
  contributes: {
    commands,
    keybindings,
    configuration,
    menus,
    colors,
    views: {
      scm: [
        { id: 'claudeInlineDiff.changes', name: 'Claude Changes', icon: '$(sparkle)', contextualTitle: 'Claude Changes' },
        { id: 'claudeInlineDiff.steps', name: 'Claude Steps', icon: '$(history)', contextualTitle: 'Claude Steps', visibility: 'collapsed' },
      ],
    },
    viewsWelcome: [
      { view: 'claudeInlineDiff.changes', contents: 'No Claude changes waiting for review.\nWhen Claude Code edits a file, the change appears inline in the editor and here.\n[Install Claude Code Hook](command:claudeInlineDiff.installHooks)' },
      { view: 'claudeInlineDiff.steps', contents: 'Claude steps (one per prompt) appear here; revert any step and everything after it.' },
    ],
  },
  scripts: {
    build: 'node scripts/build.js',
    watch: 'node scripts/build.js --watch',
    typecheck: 'tsc --noEmit -p .',
    lint: 'eslint src test',
    format: 'prettier --write "src/**/*.ts" "test/**/*.ts"',
    'format:check': 'prettier --check "src/**/*.ts" "test/**/*.ts"',
    test: 'vitest run',
    'test:e2e': 'node scripts/build.js && node test/e2e/run.js',
    package: 'node scripts/build.js --production && vsce package --no-dependencies --allow-missing-repository --no-rewrite-relative-links -o claude-inline-diff.vsix',
    'vscode:uninstall': 'node ./dist/uninstall.js',
  },
});
delete pkg.main_; delete pkg.author; delete pkg.directories;
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
