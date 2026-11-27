# Claude Inline Diff

VS Code / Cursor extension (TypeScript) that shows Claude Code's edits (made through the official
Claude Code extension panel or the CLI) inline in the working file, Cursor-agent style: red removed
blocks between lines, green added lines, word highlights, Accept/Reject per change/file/all,
Cmd+Y / Cmd+N, auto-advance, status bar, badges, undo.

Extension id: **`inlinediff.claude-inline-diff`** (needed in `~/.cursor/argv.json` → `enable-proposed-api`).

## Commands
- `npm run build` — esbuild → `dist/extension.js`, `dist/hook.js`, `dist/uninstall.js`
- `npm test` — vitest unit tests (`test/unit`)
- `npm run lint` / `npm run format` / `npm run typecheck`
- `npm run test:e2e` — VS Code via @vscode/test-electron (Linux: `xvfb-run -a npm run test:e2e`)
- `npm run package` — production build + `claude-inline-diff.vsix`

## Layout
- `src/core/` — no `vscode` import, unit-tested: `diff.ts` (Myers + word diff, ported MIT), `model.ts`
  (accept/reject/absorb math), `store.ts` (on-disk format shared by hook and extension), `setup.ts`
  (settings.json install/uninstall), `highlight.ts` (tiny tokenizer for removed code)
- `src/hook/hook.ts` — Claude Code hook (PreToolUse/PostToolUse/UserPromptSubmit), bundled standalone
- `src/review.ts` — ReviewManager (state, actions, undo, absorbing user edits)
- `src/render.ts`, `src/insets.ts`, `src/theme.ts` — decorations, editorInsets webviews, theme colours
- `src/views.ts` — status bar, file badges, Claude Changes / Claude Steps trees, CodeLens
- `src/extension.ts` — activation and commands
- `docs/` — RESEARCH.md, INSTALL.uk.md, MANUAL_TESTING.uk.md

## Conventions
- Never write to the real `~/.claude` in tests: set `CLAUDE_CONFIG_DIR` / `CLAUDE_INLINE_DIFF_HOME` to temp dirs.
- Hook must never block Claude: swallow errors, exit 0, print only JSON additionalContext for feedback.
- No network, no telemetry, no runtime deps. Keep `src/core` free of `vscode`.
- Code derived from claude-code-inline-review keeps its MIT header. Do NOT copy code from ahmerds/hunker (UNLICENSED).
- One commit per stage; update the progress table below.

## Git
- Repository: https://github.com/Politanskyi/claude-code-inline-diff-extension, branch `master`.

## Progress
| Stage | Status |
|---|---|
| 0 Research (docs/RESEARCH.md) | done |
| 1 Scaffold (esbuild, lint, prettier, vitest, CI) | done |
| 2 Diff core + model | done (29 tests) |
| 3 Hook + store | done (simulated CLI/extension payloads, bundled script over stdin, Bash via git) |
| 4 Hook install/uninstall | done (temp CLAUDE_CONFIG_DIR tests; acceptEdits offer + rollback; vscode:uninstall cleanup) |
| 5 Rendering (insets + fallback) | done — verified in real VS Code 1.148 via e2e (insets drawn, decoration fallback, screenshots in docs/media) |
| 6 Controls, navigation, status bar, undo | done — e2e: accept/reject/undo/auto-advance/absorb/new-file trash/Bash/feedback/steps |
| 7 vsix + docs | done — `npm run package` → claude-inline-diff.vsix (11 files, ~50 KB; installs via code CLI); README, docs/INSTALL.uk.md, docs/MANUAL_TESTING.uk.md |
| 8 Panel, Bash, steps, feedback | done — Claude Changes (sessions→files→hunks) + Claude Steps views, Bash via git, step revert, `Claude editing <file>`, reveal-on-edit, reject with feedback (UserPromptSubmit/PostToolUse additionalContext) |

## Known issues / lessons
- VS Code 1.148 refuses `editorInsets` even in dev mode unless `--enable-proposed-api <id>` is passed (e2e passes it).
  The probe can see the function while creation fails → InsetManager sets `failed` and falls back to decorations.
- `TextDocument.isDirty` is not reliable inside onDidChangeTextDocument; Claude's disk write is detected by
  "document text == file on disk" instead (review.ts `matchesDisk`).
- Never `await` a non-modal notification inside a command (it blocks until dismissed; hung the e2e).
- Insets do not scroll horizontally with the editor; buttons are anchored right after the first removed line.
- Minimap: stable decoration API has no minimap colour; only the overview ruler (scrollbar) is marked.

## Verified in Cursor
- Cursor 3.32.4 (VS Code 1.147 base), Linux .deb unpacked: `CID_EDITOR=<cursor binary> xvfb-run -a npm run test:e2e` → 16/16.
  Insets work via `~/.cursor/argv.json` (tested with a temp HOME) and via `--enable-proposed-api`; without either → decoration fallback, all tests pass.
- Cursor 3 shows a login overlay inside the workbench window; e2e passes `--skip-onboarding` (Cursor-only CLI flag) for screenshots.
- `contribEditorContentMenu` / `editor/content` exist in Cursor's build (candidate for a floating review bar).

## Cursor parity (taken from Cursor 3.32 source/CSS, checked with screenshots in Cursor 3.32.4)
- Labels Keep / Undo; keys Cmd/Ctrl+Y / N, Cmd/Ctrl+Enter (keep file), Cmd/Ctrl+Shift+Backspace (undo file) — from Cursor's
  `editor.action.inlineDiffs.*` registrations.
- Colours: theme diffEditor.inserted/removedLineBackground; words rgba(12,233,27,.15) / rgba(242,13,59,.25); no gutter bar.
- Pill under each change (inset row): `⌃ i of n ⌄ | Undo | Keep | …`, right-aligned unless the editor overflows horizontally.
- Floating Undo All / Keep All / Next File via `editor/content` (proposed contribEditorContentMenu).
- Follow Claude (reveal + flash new hunks), Review All (vscode.changes multi-diff), no inline drawing inside diff editors.
- e2e: 16 tests, pass in Cursor 3.32.4 (dark + light) and VS Code 1.148.

## Next ideas (not started)
- Live check with a logged-in Cursor + official Claude Code extension (docs/MANUAL_TESTING.uk.md); whether Cursor runs `vscode:uninstall`.
- Optional Stop-hook delivery of feedback; per-session filter in the Changes view; light-theme screenshot.
