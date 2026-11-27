# Changelog

## 0.1.9
- Changes group per Claude edit (edit regions recorded by the hook), like Cursor's agent diff.
- Cursor-measured look: removed text in one colour, word marks off by default, pill colours/sizes, Keep without shortcut.
- Pill stays inside the visible editor width; Keep all changes registered; floating bar hidden over Cursor's own diffs; singular Undo/Keep header for one file.

## 0.1.0
- First release: inline review of Claude Code edits (editorInsets red blocks + decoration fallback), word-level
  highlights, Accept/Reject per change/file/all, Cmd/Ctrl+Y / N, auto-advance, status bar, badges, undo,
  absorbing user edits, Claude Changes / Claude Steps panels, Bash edit detection (git), step revert,
  reject with feedback (UserPromptSubmit additionalContext), safe hook install/uninstall.
