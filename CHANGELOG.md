# Changelog

## 0.3.4
- Claude Changes: the section title shows how many files wait for Keep / Undo (`CLAUDE CHANGES (3 FILES TO REVIEW)`), also while the list is collapsed. Nothing is added when all is decided. The editor only lets a section change its title once it has been opened in the window, so a list that was never expanded since the window loaded has no count yet (the status bar shows it then).
- Claude Changes: the list shows the files of the chat on screen also while changes wait for Keep / Undo: what another chat left for review is listed in that chat. Undo All / Keep All and the count in the section title are of the files listed (the editor and the status bar still show every waiting change).
- Claude Changes: every chat has its own history, like the file list under each Cursor chat. A new chat shows an empty list a few seconds after it is opened (before, the previous chat's files stayed until the new chat changed a file); closing it unused brings the previous chat's files back; an earlier chat opened from the history shows its own files again. Going back to a chat that is still loaded gives the hook no sign, so the window also follows the Claude Code extension's own log, which names the chat the panel switches to at once (and, as a slower fallback, the editor's saved workspace state). The hook learns which chat is open from a new `SessionStart` entry in `~/.claude/settings.json` (added by itself on update). Hook 1.0.16.

## 0.3.3
Found while going through the manual checklist live in Cursor 3.32.4:
- Fix: after a click on the floating **Undo File / Keep File** (or Keep all changes), Cmd/Ctrl+Z was the editor's own undo — Claude's text came back unsaved and no longer under review — because the click had taken the focus out of the text. The focus now goes back to the editor, so Cmd/Ctrl+Z takes the action back as after the keys.
- Fix: with red blocks off (`deletedLines.renderer: decoration`), hovering a change showed the removed code twice.
- Fix: `followClaude` did nothing for Claude's first edit to a file that was not under review yet.
- Claude Steps: a step is named by what you typed, without the IDE context Claude Code adds in front of it (`<ide_opened_file>…`). Files outside the project join the step of their prompt (same name, reverted with it) instead of one "(prompt not recorded)" step — one row in the list for both — and so do edits Claude makes after you reverted the step.
- Fix: when Bash tracking was switched on while a command ran (or the hook before a command failed), the command was compared with an older command's snapshot, so anything changed in between (for example by Cursor's agent) was shown as Claude's. Hook 1.0.12.

## 0.3.2
- Wording: the last places that still said Accept / Reject now say Keep / Undo, like the rest of the interface (the "Undid: …" status message after *Revert Last Keep/Undo*, setting descriptions).
- The description of `confirmRejectAll` says what it does: it covers the Undo All command and shortcut; the list's Undo All always asks with its own Confirm click.
- Documentation brought in line with 0.3.x (settings table, update and network notes).

## 0.3.1
- The **Claude Changes** header (N Files, Undo All / Keep All / Review) stays on top while a long list scrolls.
- Self-update with several windows open: one window downloads and installs a release (they used to race and each do it), and every window offers **Reload Window**.
- Windows: Bash edits in another repository were not seen when the command named it in double quotes with backslashes (`cd "C:\Users\me\repo" && …`) or as a Git Bash drive path (`cd /c/Users/me/repo`). Both are read now. Hook 1.0.10.

## 0.3.0
- **Updates itself.** The extension is installed from a .vsix, which the editor never updates (*Auto Update* on its page does nothing for such extensions). It now looks at this project's GitHub releases a little after startup and every few hours, downloads a newer `.vsix`, checks it against the release's SHA-256, installs it and offers **Reload Window**. Setting `claudeInlineDiff.update`: `install` (default), `notify` (only tell me) or `off` (no network requests at all). New command **Check for Updates**. This is the extension's only network use; nothing about you or your code is sent.
- Bash edits in **another repository** are now seen. Until now a command was compared with `git status` only in the chat's own project, so `cd ../other-repo && sed -i …` (or a script run there) changed files that showed up nowhere. The hook now also looks at the repository the command names (`cd <dir>`, `pushd <dir>`, `git -C <dir>`), at the shell's current folder, and at repositories where this chat already changed a file. Such files appear in the chat's window with the Bash tag, like other changes outside the project. A command that edits some other place without naming it is still not seen. Hook 1.0.9.
- After installing, the **Set Up** list opens only in the focused window (it used to open in every open window at once).
- The extension's page in the editor shows the README screenshots (their links now point to the repository; they used to be broken).
- Fix: after **Undo** in the pill on a file Claude created (the file goes to the trash), its row stayed in Claude Changes for a while. It now goes at once.
- The chat's file history no longer lists Claude Code's own working files (memory, plans) recorded by old hook versions.

## 0.2.4
- New command **Remove Completely (hook, settings, snapshots, backups)…**: one confirmation removes everything the extension ever wrote — the hook and "Edit automatically", our `argv.json` line, the shortcuts added by *Fix Shortcuts*, all snapshots and history, the stored state and the backup files — then offers *Uninstall Extension*. One backup of `settings.json` from before the removal is kept.
- Only the last backup of `settings.json` is kept (`settings.json.bak-claude-inline-diff-<time>`); every change used to leave another one behind for good. Older ones are removed on the next write.

## 0.2.3
- Fully like Cursor: a file changed by a chat of another project is not highlighted here either (0.2.2 still drew the change when you opened the file). The change is reviewed only in the window of the chat that made it; this window shows no list row, no inline diff, no badge and no "Claude editing" for it.

## 0.2.2
- Like Cursor, a change belongs to the chat that made it. A file outside the chat's project now shows in **that** window's Claude Changes (Undo / Keep, then the chat's history) and status bar; the window of the project the file lives in no longer lists it, but still highlights the change inline (with Undo / Keep) when you open the file there.
- Fix: such a file used to appear in the chat's window only by accident (while Claude Code kept the document loaded in the background) and vanish a few minutes later.

## 0.2.1
- A missing Claude Code hook is always visible now: a "Hook not installed … Set Up" row above the Claude Changes list even when it still lists files (chat history), and a **Claude Inline Diff: Set Up** item in the status bar (the list is collapsed by default). Before, only an empty list said so, so after a reinstall the extension looked broken.
- The Set Up list opens by itself once per extension version while the hook is missing (the editor keeps the old "already shown" flag across a reinstall), and never after *Uninstall Claude Code Hook*.
- Other windows notice Set Up / Uninstall when they get focus.
- Releases need no tag: a push to master with a version that has no GitHub release yet builds, tests and publishes it (tag `v<version>` is created by CI).

## 0.2.0 — first release
Claude Code's edits reviewed inline in Cursor / VS Code, like Cursor's own agent diff:
- red removed blocks between the lines (proposed `editorInsets`, with a stable fallback), green added lines, one Cursor-style `Undo / Keep` pill;
- Keep / Undo per change, per file and for everything, with Cursor's keys (Cmd/Ctrl+Y / N, Cmd/Ctrl+Enter, Cmd/Ctrl+Shift+Backspace) and Alt+J/K/L/H navigation; Cmd/Ctrl+Z reverts a Keep or an Undo;
- **Claude Changes** list under the Claude Code chat (Undo All / Keep All / Review, the chat's history once reviewed) and **Claude Steps** (revert to before a prompt);
- edits from Edit/Write/MultiEdit/NotebookEdit and from Bash (git repos), "Undo with feedback" that reaches Claude;
- snapshots outside the project (`~/.claude/inline-diff/projects/`), no network, no telemetry.

Since 0.1.31:
- One-step setup: on the first run the **Set Up** list opens by itself with everything ticked and explained — the Claude Code hook, *Edit automatically*, red removed-code blocks (argv.json) — and Enter applies it all. The hook and *Edit automatically* work in the next Claude chat; the red blocks after a full restart (*Quit Cursor* button). Also in the Claude Changes empty state, its `…` menu and the command palette (*Set Up…*); unticked red blocks are offered again after the first change.
- Releases: pushing a `v*` tag builds, tests and attaches `claude-inline-diff.vsix` to a GitHub release (`.github/workflows/release.yml`), so installing needs no build.
- Fix: the check for red removed-code blocks always said "enabled" (the proposed function exists even when it may not be called), so they were never offered and *Show Hook Status* was wrong. It now asks the host.
- README and INSTALL start with a short quick start.

## 0.1.31
- Only Claude Code's working folders under `~/.claude` are skipped now: `projects/` (memory, transcripts), `plans/`, `todos/`. What you keep there yourself (`settings.json`, `CLAUDE.md`, skills, agents, hooks, commands) is reviewed again like any other file (hook v1.0.8).
- Claude Steps no longer lists steps of another project's chat that edited files here (the same rule Claude Changes got in 0.1.29).
- Unit tests for choosing the window's chat; README, INSTALL and the manual checklist describe files outside the project.

## 0.1.30
- Fix: a window that started while Cursor still held an older manifest read `storage.location` as `project` (the old default) and rewrote the shared config, so snapshots went back into `.claude-review/`. Only a value you set yourself counts now; otherwise snapshots stay outside the project.

## 0.1.29
- Fix: a window without its own Claude chat showed another project's chat history in Claude Changes (files that chat edited here, already reviewed). History now comes only from chats of this window's project; another chat's changes still show while they wait for review.

## 0.1.28
- Claude Code's own files outside the project (memory, plans, settings under `~/.claude`) are no longer snapshotted: they are not changes to review (hook v1.0.7).
- Changes outside any project that nobody reviewed expire after `stepRetentionDays` (default 7): the file stays as it is and the snapshot in `~/.claude/inline-diff/store/` is dropped. Project changes still wait for Keep or Undo.

## 0.1.27
- Snapshots no longer live in the project by default: each project gets its own folder under `~/.claude/inline-diff/projects/` (hook v1.0.6). An existing `.claude-review/` is moved there automatically; `storage.location: project` keeps the old behaviour, and switching moves the snapshots either way.
- Fix: `storage.location: home` used one store for every project, so another project's running Claude could hide Undo/Keep here and the chat history could pick the wrong chat.

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
