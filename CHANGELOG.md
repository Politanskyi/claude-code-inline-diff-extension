# Changelog

## 0.1.18
- Views no longer titled "Claude Changes: Claude Changes" after moving under the chat (no `contextualTitle`).
- Cleaner empty state: centred icon and "No changes to review", or an Install Hook button.

## 0.1.17
- Claude Changes is always shown: an empty state when there is nothing to review, the hook install button when the hook is missing.

## 0.1.16
- Claude Steps: *Revert to Before This Step* is also in the right-click menu of a step.

## 0.1.15
- Undo with feedback goes to the main Claude agent, not to a subagent that happens to call a tool first. (hook v1.0.4, updated automatically).
- Undo All warns before moving files Claude created to the trash.
- Shortcut labels (pill, hover, CodeLens, status bar) follow `keybindingScheme`.
- Cleanup: dead commands, the old tree view code, the unused syntax colouring (`theme.ts`, `highlight.ts`) removed; a manifest test catches commands nothing can reach; docs match the current behaviour.

## 0.1.14
- Claude Changes list: "Undo / Keep" for one file, "Undo All / Keep All" for several, like Cursor.

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
- Pill exactly Cursor's size (24px, 2px below the change, fractional inset height); the "…" button moved off the pill (Undo with feedback stays in the editor context menu).

## 0.1.9
- Changes group per Claude edit (edit regions recorded by the hook), like Cursor's agent diff.
- Cursor-measured look: removed text in one colour, word marks off by default, pill colours/sizes, Keep without shortcut.
- Pill stays inside the visible editor width; Keep all changes registered; floating bar hidden over Cursor's own diffs.

## 0.1.0
- First release: inline review of Claude Code edits (editorInsets red blocks + decoration fallback), word-level
  highlights, Accept/Reject per change/file/all, Cmd/Ctrl+Y / N, auto-advance, status bar, badges, undo,
  absorbing user edits, Claude Changes / Claude Steps panels, Bash edit detection (git), step revert,
  reject with feedback (UserPromptSubmit additionalContext), safe hook install/uninstall.
