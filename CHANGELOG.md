# Changelog

## 0.1.26
- Fix: a file Claude created without a trailing newline showed a phantom "-1" and an empty removed block; created files now count as one added change, and Keep makes the whole text the baseline.
- Fix: `stepRetentionDays` above 7 was ignored (the hook pruned steps after a week); the hook now reads it from the shared config (hook v1.0.5).
- Removed the *List Files to Review* quick pick (use *Show Claude Changes*), a dead `HOOK_BANNER` export, the unused `hookReady` context key and an always-true `runHunk` argument.
- Consistency: one `ACTIVITY_STALE_MS` for "Claude editing" (was 60 s in one place, 120 s in another); list labels built in one place; both Review modes share one multi-diff opener; the hook honours `storage.projectDirName` when filtering `git status`; stale comments removed.
- Docs: README key table lists Alt+J/K/L/H; INSTALL notes what `vscode:uninstall` cannot restore; the `pollIntervalMs` description no longer claims file watchers.

## 0.1.25
- Status bar: no ▲ ▼ arrows (the pill arrows and Alt+J / Alt+K do the same).

## 0.1.24
- The status bar summary shows the Claude Changes list through the view's focus command, then gives focus back to the editor (checked live). New command *Show Claude Changes*.

## 0.1.23
- Clicking the status bar summary opens the Claude Changes list (it used to open a plain quick pick).

## 0.1.22
- Claude Changes no longer expands itself on new changes: like Cursor, only you expand or collapse it.

## 0.1.21
- Claude Changes: "N Files" is a real heading (larger, semibold) and the file rows are indented under it.

## 0.1.20
- Claude Changes: no separate collapse arrow on "N Files" (the view section collapses); +/- without zero parts, like Cursor ("+41", "+7 -1"); Review tab title without a doubled "(N files)".

## 0.1.19
- Claude Changes keeps the current chat's history like Cursor: once everything is reviewed it lists every file the chat changed (+/- since before the chat, Review shows the whole chat's diff); a new chat starts empty.
- Claude Changes is collapsed by default and expands itself when new changes arrive.

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
