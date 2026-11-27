# Claude Inline Diff

VS Code / Cursor extension (TypeScript) that shows Claude Code's edits (made through the official
Claude Code extension panel or the CLI) inline in the working file, Cursor-agent style: red removed
blocks between lines, green added lines, optional word marks, Keep/Undo per change/file/all,
Cursor's keys, auto-advance, status bar, badges, undo.

Extension id: **`inlinediff.claude-inline-diff`** (needed in `~/.cursor/argv.json` → `enable-proposed-api`).

## Commands
- `npm run build` — esbuild → `dist/extension.js`, `dist/hook.js`, `dist/uninstall.js`
- `npm test` — vitest unit tests (`test/unit`)
- `npm run lint` / `npm run format` / `npm run typecheck`
- `npm run test:e2e` — VS Code via @vscode/test-electron (Linux: `xvfb-run -a npm run test:e2e`)
- `npm run package` — production build + `claude-inline-diff.vsix`
- Release: bump the version in `scripts/gen-package.js` (and CHANGELOG) and push to master; `.github/workflows/release.yml` runs after CI passes on all three OSes for that master commit, sees a version with no GitHub release yet, builds and publishes it with tag `v<version>` (installed copies then update themselves). Commits that keep the version release nothing. A hand-pushed tag must match package.json

## Layout
- `src/core/` — no `vscode` import, unit-tested: `diff.ts` (Myers + word diff, ported MIT), `model.ts`
  (accept/reject/absorb math, key labels), `regions.ts` (per-edit grouping), `store.ts` (on-disk format
  shared by hook and extension), `setup.ts` (settings.json install/uninstall), `iconTheme.ts` (file icons
  for the Changes list), `keybindings.ts` (conflicts with other extensions), `layout.ts` (where the Claude
  chat lives), `argv.ts` (argv.json `enable-proposed-api`), `bashDirs.ts` (folders a shell command names), `update.ts` (which GitHub release is newer, which file to take)
- `src/hook/hook.ts` — Claude Code hook (PreToolUse/PostToolUse/UserPromptSubmit/Stop/SessionStart), bundled standalone; `turns/` markers = Claude is working (Stop does not fire on user interrupt, so a quiet turn expires after 3 min)
- `src/review.ts` — ReviewManager (state, actions, undo, absorbing user edits)
- `src/render.ts`, `src/insets.ts` — decorations (+ hover fallback), editorInsets webviews (removed blocks, pill)
- `src/views.ts` — status bar, file badges, Claude Changes list (webview, Cursor-style; icons via `src/core/iconTheme.ts`), Claude Steps tree, CodeLens
- `src/update.ts` — self-update from GitHub releases (the extension cannot be on a marketplace: proposed APIs)
- `src/extension.ts` — activation and commands
- `docs/` — RESEARCH.md, INSTALL.uk.md, MANUAL_TESTING.uk.md

## Conventions
- Never write to the real `~/.claude` in tests: set `CLAUDE_CONFIG_DIR` / `CLAUDE_INLINE_DIFF_HOME` to temp dirs.
- Backups: `writeSettings` keeps one `settings.json.bak-claude-inline-diff-<time>` (`pruneBackups`); `argv.json` / `keybindings.json` have one `.bak-claude-inline-diff` each. *Remove Completely* (`removeCompletely` in extension.ts) undoes everything we wrote and must be extended whenever the extension starts writing somewhere new.
- Hook must never block Claude: swallow errors, exit 0, print only JSON additionalContext for feedback.
- Any change under `src/hook/` (or `src/core/store.ts` it bundles) needs a `HOOK_VERSION` bump, or installed hooks are never updated.
- No telemetry, no runtime deps. The only network use is the self-update (`src/update.ts`: GitHub's latest-release API and the release's .vsix, only from this repository, SHA-256 checked; setting `update` = `off` stops it). Nothing else may open a connection. Keep `src/core` free of `vscode`.
- Code derived from claude-code-inline-review keeps its MIT header. Do NOT copy code from ahmerds/hunker (UNLICENSED).
- One commit per stage; update the progress table below.

## Progress
| Stage | Status |
|---|---|
| 0 Research (docs/RESEARCH.md) | done |
| 1 Scaffold (esbuild, lint, prettier, vitest, CI) | done |
| 2 Diff core + model | done (29 tests) |
| 3 Hook + store | done (simulated CLI/extension payloads, bundled script over stdin, Bash via git) |
| 4 Hook install/uninstall | done (temp CLAUDE_CONFIG_DIR tests; acceptEdits offer + rollback; vscode:uninstall cleanup) |
| 5 Rendering (insets + fallback) | done — verified in real VS Code 1.148 via e2e (insets drawn, decoration fallback); docs/media screenshots retaken live in Cursor 3.32.4 (0.1.31) |
| 6 Controls, navigation, status bar, undo | done — e2e: accept/reject/undo/auto-advance/absorb/new-file trash/Bash/feedback/steps |
| 7 vsix + docs | done — `npm run package` → claude-inline-diff.vsix (11 files, ~67 KB; installs via code CLI); README, docs/INSTALL.uk.md, docs/MANUAL_TESTING.uk.md |
| 8 Panel, Bash, steps, feedback | done — Claude Changes (files, under the Claude Code chat) + Claude Steps views, Bash via git, step revert, `Claude editing <file>`, reveal-on-edit, reject with feedback (UserPromptSubmit/PostToolUse additionalContext) |

## Known issues / lessons
- VS Code 1.148 refuses `editorInsets` even in dev mode unless `--enable-proposed-api <id>` is passed (e2e passes it).
  The probe can see the function while creation fails → InsetManager sets `failed` and falls back to decorations.
- `TextDocument.isDirty` is not reliable inside onDidChangeTextDocument; Claude's disk write is detected by
  "document text == file on disk" instead (review.ts `matchesDisk`).
- Never `await` a non-modal notification inside a command (it blocks until dismissed; hung the e2e).
- Insets do not scroll horizontally with the editor; the pill stays right-aligned in the visible part.
- Minimap: stable decoration API has no minimap colour; only the overview ruler (scrollbar) is marked.

## Verified in Cursor
- Cursor 3.32.4 (VS Code 1.147 base), Linux .deb unpacked: `CID_EDITOR=<cursor binary> xvfb-run -a npm run test:e2e` → 17/17 (now 18 tests; macOS Cursor 3.32.4: 18/18).
  Insets work via `~/.cursor/argv.json` (tested with a temp HOME) and via `--enable-proposed-api`; without either → decoration fallback, all tests pass.
- Cursor 3 shows a login overlay inside the workbench window; e2e passes `--skip-onboarding` (Cursor-only CLI flag) for screenshots.
- `contribEditorContentMenu` / `editor/content` work in Cursor (used for the floating per-file Undo File / Keep File bar).
- Cursor keeps the Claude Code chat in a generated auxiliary-bar container; `src/core/layout.ts` finds it in `state.vscdb` and `vscode.moveViews` puts Claude Changes under it once.
- The Bash snapshot also notes, for every file waiting for review, what it was before Claude (`base`): a command that puts such a file back (rm of a created file, restore of a deleted one, revert) leaves nothing to review even though the window drops the entry mid-command, and a Keep during the command is not re-created. A file changed and committed by the same command is invisible to `git status` (known limit).
- `expandChatOnce` (extension.ts): a new workspace starts with the chat section collapsed; it is opened once per workspace (`chatOpenedOnce` in workspaceState) when the workspace's `state.vscdb`, read with `node:sqlite` (`layout.storedValues`; no-op where the runtime lacks it), says the chat's container is the active secondary-side-bar tab and the section is collapsed (a never-opened section is saved collapsed with size 22, so the size tells nothing).
- `review.currentText` reads the disk unless the open document is dirty: the editor keeps stale copies of files not shown in a tab (Claude Code loads the file it edits; outside the workspace nothing reloads it).
- Bash tracking skips files the editor saved during the command (`editor-writes/` in the global store). It compares `git status` before/after in the project and in up to three other repositories (`otherRepos` in hook.ts: named by `cd` / `pushd` / `git -C` in the command, the payload's cwd, repositories of files the session already changed outside the project); their files go to the global store with the chat's session id, except files the other project's own store already has under review.
- Stores: default `storage: home` = `~/.claude/inline-diff/projects/<name>-<sha256(path)[:12]>/` per project (`homeProjectStoreDir`, derived from the real project root by both hook and extension); `project` = `<root>/.claude-review/`; files outside a project → `~/.claude/inline-diff/store/`, where unreviewed baselines expire after `stepRetentionDays`; Claude Code's working folders outside the project (`projects/`, `plans/`, `todos/` under `claudeDir`) are never snapshotted (`isClaudeInternal`); the rest of `~/.claude` is reviewed. Chat history and Claude Steps use only this window's own chats (`M.ownSessions`: a step outside the global store); a window loads only the changes it owns (`M.ownsEntry` in `refresh`: project-store entries, plus global-store entries made by its own chats — Cursor's model, where its agent asks “This edits a file outside your workspace” in its own chat), so another project's chat shows nothing here: no list row, inline diff, badge or activity; `storage.location` counts only when set explicitly (`explicitStorage`). The extension reads both project locations and `moveStore`s to the configured one (only folders with our .gitignore marker).

## Cursor parity (taken from Cursor 3.32 source/CSS, checked with screenshots in Cursor 3.32.4)
- Labels Keep / Undo; keys Cmd/Ctrl+Y / N, Cmd/Ctrl+Enter (keep file), Cmd/Ctrl+Shift+Backspace (undo file) — from Cursor's
  `editor.action.inlineDiffs.*` registrations.
- Colours: theme diffEditor.inserted/removedLineBackground; removed text in one colour (editor fg 75%, no syntax colours); word marks off by default (`highlightWords`); no gutter bar.
- Pill colours measured in Cursor (One Dark Pro): nav = fg 5.5% over editor bg, Undo = editor bg + 1px border fg 11%, Keep = charts.green; Keep shows no shortcut, Undo shows ⌘N. Same 24px pill as Cursor, but in its own row instead of an overlay.
- Grouping: the hook records edit regions (`src/core/regions.ts`, `BaselineFile.regions`) per Claude tool call; hunks are diffed inside regions (Cursor diffs per agent edit), whole-file diff when regions do not fit.
- Pill placement: a 1px full-width probe + IntersectionObserver finds the visible right edge of the inset (inset is as wide as the scroll width).
- The floating Keep all changes / Review Next File bar hides when the file has Cursor's own diffs (`inlineDiffs.activeEditorWithDiffs`).
- Pill (inset row, 26px = Cursor's 24px pill + 2px gap, fractional heightInLines): `⌃ i of n ⌄ | Undo | Keep` (feedback only via the editor context menu), one per file under the change nearest the last cursor/mouse position (mouse via a no-op HoverProvider), right-aligned.
- Cursor parity (from its source): Keep → next change in the same file only; Undo / file actions do not move; Alt+J/K/L/H; word marks only in removed lines; no auto-open/scroll; >100 changes → no removed blocks or pills.
- Claude Changes (Cursor's composer file list, from its source): pending files only while any are pending; afterwards every file the chat on screen touched (`review.currentSession`, see below), undone ones too; collapsed by default and never auto-expanded (Cursor's `isFileListExpanded` changes only on user click); the status bar opens it via `<view>.focus` (checked live) and hands focus back to the editor. The count in the section title (of the listed files) is `WebviewView.title` (a `description` is hidden while the section is collapsed, checked live); it can be set only after the view was resolved (first expanded) in the window.
- The list shows pending entries of the chat on screen only (`entry.sessionId`; entries without one always), no note about the rest (the user found it noise); Undo All / Keep All from the list and the section-title count are of the listed keys; the status bar counts all pending.
- The list's chat (`review.currentSession`) is the one in `<project store>/chat.json`, written by the hook on SessionStart with source resume/clear/compact (the official extension launches Claude with `resume` when an earlier chat is opened and on reload; `startup` goes to `chat-new.json` with Claude's pid (`CLAUDE_PID`): a new chat keeps its process while it is open, while the extension's "Loading config cache" launches fire SessionStart:startup with a throwaway session id and exit within a second or two — so `S.newChat` counts it only after 3 s and while the pid lives; all checked in its log) and on UserPromptSubmit; fallback for older hooks: the chat that changed a file last. Switching back to a chat whose process is still loaded (the official extension only detaches/attaches) fires no hook: `watchVisibleChat` reads the sidebar webview's saved state (`memento/webviewView.claudeVSCodeSidebarSecondary` → `sessionID`) from the workspace `state.vscdb` + live WAL frames (`layout.visibleChat`) and notes a change like the hook does; the editor flushes that state late (up to about a minute, unreliable for the user). The fast path is `watchClaudeLog`: the official extension's log (`<logs>/window N/exthost/Anthropic.claude-code/*.log`, next to ours) has `session.attach: vscode-<channel>` at once, and `launch_claude` + `resuming with same session id` map a channel to its session (`layout.ChatLogReader`); best effort, the wording is not an interface. A `launch_claude` without `resume` followed by the attach to its channel is a new chat on screen: `review.confirmNewChat` then skips the 3 s grace for the session the hook noted last (`chat-new.json` keeps the last 6 startup notes, so a later config-cache launch does not push the open new chat out).
- Floating Undo File / Keep File ⌘⏎ via `editor/content` (Cursor renders only its first two items) (proposed contribEditorContentMenu), only in the active editor (`claudeInlineDiff.activeFiles`); Cursor's own file bar sits in the breadcrumb row, which extensions cannot use; Undo All / Keep All / Review in the Claude Changes list.
- While the agent works (checked live with Cursor's agent): the list header hides Undo All / Keep All (Cursor shows Stop), per-file ✕ / ✓ stay usable; the header is sticky in long lists.
- Follow Claude (reveal + flash new hunks), Review All (vscode.changes multi-diff), no inline drawing inside diff editors.
- e2e: 18 tests, pass in Cursor 3.32.4 (dark + light) and VS Code 1.148.

## Next ideas (not started)
- Whether Cursor runs `vscode:uninstall`; the rest of docs/MANUAL_TESTING.uk.md not yet ticked.
- Optional Stop-hook delivery of feedback.
