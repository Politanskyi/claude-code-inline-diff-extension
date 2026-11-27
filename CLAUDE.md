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

## Layout
- `src/core/` — no `vscode` import, unit-tested: `diff.ts` (Myers + word diff, ported MIT), `model.ts`
  (accept/reject/absorb math, key labels), `regions.ts` (per-edit grouping), `store.ts` (on-disk format
  shared by hook and extension), `setup.ts` (settings.json install/uninstall), `iconTheme.ts` (file icons
  for the Changes list), `keybindings.ts` (conflicts with other extensions), `layout.ts` (where the Claude
  chat lives), `argv.ts` (argv.json `enable-proposed-api`)
- `src/hook/hook.ts` — Claude Code hook (PreToolUse/PostToolUse/UserPromptSubmit/Stop), bundled standalone; `turns/` markers = Claude is working (Stop does not fire on user interrupt, so a quiet turn expires after 3 min)
- `src/review.ts` — ReviewManager (state, actions, undo, absorbing user edits)
- `src/render.ts`, `src/insets.ts` — decorations (+ hover fallback), editorInsets webviews (removed blocks, pill)
- `src/views.ts` — status bar, file badges, Claude Changes list (webview, Cursor-style; icons via `src/core/iconTheme.ts`), Claude Steps tree, CodeLens
- `src/extension.ts` — activation and commands
- `docs/` — RESEARCH.md, INSTALL.uk.md, MANUAL_TESTING.uk.md

## Conventions
- Never write to the real `~/.claude` in tests: set `CLAUDE_CONFIG_DIR` / `CLAUDE_INLINE_DIFF_HOME` to temp dirs.
- Hook must never block Claude: swallow errors, exit 0, print only JSON additionalContext for feedback.
- Any change under `src/hook/` (or `src/core/store.ts` it bundles) needs a `HOOK_VERSION` bump, or installed hooks are never updated.
- No network, no telemetry, no runtime deps. Keep `src/core` free of `vscode`.
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
- Cursor 3.32.4 (VS Code 1.147 base), Linux .deb unpacked: `CID_EDITOR=<cursor binary> xvfb-run -a npm run test:e2e` → 17/17.
  Insets work via `~/.cursor/argv.json` (tested with a temp HOME) and via `--enable-proposed-api`; without either → decoration fallback, all tests pass.
- Cursor 3 shows a login overlay inside the workbench window; e2e passes `--skip-onboarding` (Cursor-only CLI flag) for screenshots.
- `contribEditorContentMenu` / `editor/content` work in Cursor (used for the floating per-file Undo File / Keep File bar).
- Cursor keeps the Claude Code chat in a generated auxiliary-bar container; `src/core/layout.ts` finds it in `state.vscdb` and `vscode.moveViews` puts Claude Changes under it once.
- Bash tracking skips files the editor saved during the command (`editor-writes/` in the global store).
- Stores: default `storage: home` = `~/.claude/inline-diff/projects/<name>-<sha256(path)[:12]>/` per project (`homeProjectStoreDir`, derived from the real project root by both hook and extension); `project` = `<root>/.claude-review/`; files outside a project → `~/.claude/inline-diff/store/`, where unreviewed baselines expire after `stepRetentionDays`; Claude Code's working folders outside the project (`projects/`, `plans/`, `todos/` under `claudeDir`) are never snapshotted (`isClaudeInternal`); the rest of `~/.claude` is reviewed. Chat history and Claude Steps use only this window's own chats (`M.ownSessions`: a step outside the global store); `storage.location` counts only when set explicitly (`explicitStorage`). The extension reads both project locations and `moveStore`s to the configured one (only folders with our .gitignore marker).

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
- Claude Changes (Cursor's composer file list, from its source): pending files only while any are pending; afterwards every file the current chat touched (steps of the newest own session, `M.currentSession`), undone ones too; collapsed by default and never auto-expanded (Cursor's `isFileListExpanded` changes only on user click); the status bar opens it via `<view>.focus` (checked live) and hands focus back to the editor.
- Floating Undo File / Keep File ⌘⏎ via `editor/content` (Cursor renders only its first two items) (proposed contribEditorContentMenu), only in the active editor (`claudeInlineDiff.activeFiles`); Cursor's own file bar sits in the breadcrumb row, which extensions cannot use; Undo All / Keep All / Review in the Claude Changes list.
- Follow Claude (reveal + flash new hunks), Review All (vscode.changes multi-diff), no inline drawing inside diff editors.
- e2e: 17 tests, pass in Cursor 3.32.4 (dark + light) and VS Code 1.148.

## Next ideas (not started)
- Whether Cursor runs `vscode:uninstall`; the rest of docs/MANUAL_TESTING.uk.md not yet ticked.
- Optional Stop-hook delivery of feedback.
