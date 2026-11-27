# Changelog

## 0.1.13
- No change count on the Claude Code tab, like Cursor's chat tab.

## 0.1.12
- Claude Changes list redrawn like Cursor's (webview): "N Files", always-visible Undo All / Keep All / Review, Undo All confirmed by a second click, file icons from the icon theme, +N -M after the name.
- Undo All / Keep All hidden while Claude works (new `Stop` hook; existing installs get it on update).
- Status bar summary hidden while the list is visible.
- Cmd/Ctrl+Z right after Undo brings the change back for review (it used to become your own edit).

## 0.1.11
- File bar: "Keep File ⌘⏎" (Ctrl+Enter off macOS) like Cursor's, and only in the active editor.

## 0.1.10
- Fix: a Claude edit right after Undo/Keep could vanish from review (the editor had not reloaded the write yet, so the fresh baseline looked resolved and was dropped).
- Pill exactly Cursor's size (24px, 2px below the change, fractional inset height); the "…" button moved off the pill (Undo with feedback stays in the context menu and the Claude Changes list).

## 0.1.9
- Changes group per Claude edit (edit regions recorded by the hook), like Cursor's agent diff.
- Cursor-measured look: removed text in one colour, word marks off by default, pill colours/sizes, Keep without shortcut.
- Pill stays inside the visible editor width; Keep all changes registered; floating bar hidden over Cursor's own diffs; singular Undo/Keep header for one file.

## 0.1.0
- First release: inline review of Claude Code edits (editorInsets red blocks + decoration fallback), word-level
  highlights, Accept/Reject per change/file/all, Cmd/Ctrl+Y / N, auto-advance, status bar, badges, undo,
  absorbing user edits, Claude Changes / Claude Steps panels, Bash edit detection (git), step revert,
  reject with feedback (UserPromptSubmit additionalContext), safe hook install/uninstall.
