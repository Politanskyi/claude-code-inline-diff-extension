# Research: Cursor-style inline diffs for Claude Code edits

Research date: 2026-11-26. Sources are public web pages fetched on that date. Claims carry the URL they come from. Anything not confirmed by a source is marked **(inferred)**. Cursor's review UI has changed many times and much of what is known comes from forum threads, not official docs, so treat Section 1 as describing behaviour that may differ between versions.

---

## 1. Cursor's native agent diff UX

### 1.1 Inline diff rendering

- Agent edits show as red/green inline diffs inside the normal editor. Users describe the older flow as "a clear before/after comparison" with "a simple Apply (or Accept) control for each change / each location", reviewable "file by file, chunk by chunk".
  https://forum.cursor.com/t/bring-back-per-change-apply-inline-diff-review-you-re-throwing-away-your-best-ux-advantage/160856
- Deleted lines appear as red lines above or in place of the green added lines, with no editable buffer content behind them. This matches what VS Code itself does for Copilot inline diffs using view zones (see 3.1). No Cursor source describes the DOM. **(inferred)**
- Word/character-level highlights: no official Cursor page found that describes intra-line (word-level) highlighting for agent diffs. It is commonly seen in screenshots, but **unconfirmed (inferred)**.
- There is a setting to turn inline diffs on and off: *Cursor Settings > Agents > Applying Changes > Inline Diffs*. Staff suggest toggling it when diffs disappear.
  https://forum.cursor.com/t/bring-back-the-review-tool-from-earlier-cursor-ide-versions/174469 ,
  https://forum.cursor.com/t/per-change-keep-undo-buttons-missing-after-agent-edits-only-undo-all-available/158983
- Edits are written to disk before the user accepts them. The diff is a review layer over a file that has already changed, and there are several complaints about this ("Why does Cursor apply diffs immediately before the user accepts them?").
  https://forum.cursor.com/t/why-does-cursor-apply-diffs-immediately-before-the-user-accepts-them/145070 ,
  https://forum.cursor.com/t/bring-back-per-change-apply-inline-diff-review-you-re-throwing-away-your-best-ux-advantage/160856

### 1.2 Per-hunk widgets

- Current labels are **Keep / Undo** per change, and **Keep File / Undo File** per file (staff reply, Oct 12, 2026). Older builds and most users say "Accept / Reject".
  https://forum.cursor.com/t/bring-back-the-review-tool-from-earlier-cursor-ide-versions/174469
- Placement: a small floating button pair attached to each hunk, at its top-right edge in the editor. No official doc describes the exact position. **(inferred, from common screenshots)**
- Pending changes stay in review across follow-up agent turns, so a new turn does not clear unreviewed hunks (same staff reply).
  https://forum.cursor.com/t/bring-back-the-review-tool-from-earlier-cursor-ide-versions/174469
- Per-file accept/reject icons can appear only when hovering a file row in the pending-changes list. With inline diffs off, per-file Accept is hidden (forum reports, summarized via search).
  https://forum.cursor.com/t/unable-to-find-or-change-agent-review-settings-in-cursor/137778

### 1.3 Keybindings (what is verified)

| Action | Binding | Status / source |
|---|---|---|
| Accept all changes | Cmd+Enter (Ctrl+Enter) "with suggested changes" | Official: https://cursor.com/docs/reference/keyboard-shortcuts |
| Reject all changes | **Cmd+Shift+Backspace** in the current docs | Official: https://cursor.com/docs/reference/keyboard-shortcuts |
| Reject all (old) | Cmd/Ctrl+Backspace until v0.48; changed because it collided with deleting chat text | https://forum.cursor.com/t/shift-backspace-for-rejecting-changes-is-a-bad-idea/74243 (staff, Apr 2 2025: "changed the shortcut for 'Reject all' in version 0.48") |
| Accept hunk ("Keep") | Cmd+Y | Community only: https://forum.cursor.com/t/efficient-agent-review-using-keyboard-shortcuts/153713 , https://forum.cursor.com/t/accepting-diff-regression-jumping-again/136523 . Not in the official table |
| Reject hunk ("Undo") | Cmd+N | Only seen in a related-topic title ("command-N / command-Y buttons"). **Unconfirmed (inferred)** |
| Accept/reject file | Cmd+Shift+Y / Cmd+Shift+N | **No source found.** Do not rely on these |
| Jump to first/next change | Alt/Option+J | Community: feature request "Auto Jump to Next Change (Option+J) after Keep (Cmd+Y)", linked from https://forum.cursor.com/t/efficient-agent-review-using-keyboard-shortcuts/153713 |
| Stop agent | Cmd+Shift+Backspace | https://cursor.com/docs/agent/review |

Notes:
- In 2024 users said Cursor showed no shortcuts in the UI. Staff answered that "The Accept/Reject keyboard shortcuts exist" without naming them.
  https://forum.cursor.com/t/what-is-the-keyboard-shortcut-for-navigating-the-changes-applied/14641
- Users report that Accept/Reject shortcuts act on hunks top-to-bottom, regardless of the cursor, and that the viewport does not follow.
  https://forum.cursor.com/t/what-is-the-keyboard-shortcut-for-navigating-the-changes-applied/14641 (via search summary)
- In 1.7.38, pressing Cmd+Y inside a diff block showed "No definition found", which suggests the binding is context-dependent. https://forum.cursor.com/t/accepting-diff-regression-jumping-again/136523

### 1.4 Auto-advance

- After "Keep" on a hunk, Cursor scrolls to the next diff. Users on 1.7.x called this "extremely disruptive, and sometimes dangerous". Staff disabled it once in 1.7, then said "There is a setting for this one as well!" without naming it.
  https://forum.cursor.com/t/accepting-diff-regression-jumping-again/136523
- When review moves to the next file, focus can leave the editor after Cmd+Y, which breaks keyboard-only review. Staff (Mar 10, 2026): "The team is actively improving review keyboard navigation."
  https://forum.cursor.com/t/efficient-agent-review-using-keyboard-shortcuts/153713

### 1.5 Review bar and Review panel

- Bottom review bar (as described for 2.6.20, Mar 2026): "Keep All" / "Reject All", "Next File" / "Previous File", per-file "Keep" / "Reject", and diff highlights in each changed file. It "showed up automatically after every agent run".
  https://forum.cursor.com/t/review-diff-navigation-bar-missing-after-agent-changes-v2-6-20/155587
- Older builds had up/down/left/right arrow buttons for moving between edits. Staff (Dec 9, 2025): "The arrow navigation buttons were replaced with a new floating Review panel". You open it by clicking **Review** after the agent replies, and "A bottom panel will appear where you can accept or reject changes for the current file and move to the next file."
  https://forum.cursor.com/t/how-to-navigate-to-the-changes-made-in-chat-to-accept-or-reject-them/145639
- 2.0 changelog: agent edits across several files can be reviewed in one combined view instead of opening each file.
  https://cursor.com/changelog/2-0
- Chat shows a session-level "Review +1181 -413" button (added/removed line counts) in the new Agent Window.
  https://forum.cursor.com/t/bring-back-per-change-apply-inline-diff-review-you-re-throwing-away-your-best-ux-advantage/160856
- Global Keep All / Undo All were reportedly removed when auto-approve was added, while per-file Keep/Undo stayed (forum, via search summary).
  https://forum.cursor.com/t/undo-all-and-keep-all-buttons-disappeared/152674
- "Review" → "Find Issues" runs an AI review of the proposed edits. https://cursor.com/docs/agent/review

### 1.6 Undo, checkpoints, restore

- Checkpoints are automatic local snapshots of the agent's changes, stored separately from Git. They track only agent edits, not manual ones. You restore with the "Restore Checkpoint" button on an earlier request, or with "+" when hovering a message. They are not version control. (Official docs page, via search summary. docs.cursor.com now redirects to cursor.com/docs.)
  https://docs.cursor.com/agent/chat/checkpoints
- Restore reverts only files the agent edited with its file tools. Terminal-command changes, subagent changes and manual edits stay. It reverts files, not chat history. Cloud and background agents have no restore button. Staff recommend committing before an agent session.
  https://forum.cursor.com/t/the-changes-are-not-rolled-back-after-clicking-the-restore-checkpoint-button/176899/5 ,
  https://forum.cursor.com/t/restore-checkpoint-permanently-destroys-change-history/129652
- Cmd+Z after Keep/Undo: no official statement found. Undo on inline edits has been reported broken at times ("Undo & Reject on Inline-Edits are broken").
  https://forum.cursor.com/t/undo-reject-on-inline-edits-are-broken/134860 . Whether Reject is itself an undoable edit is **unconfirmed (inferred: Reject is applied as a normal buffer edit, so Cmd+Z restores it)**.

### 1.7 User edits during review

- No official description found. Forum reports describe being asked to accept diffs "on every line that I type", which suggests user edits inside pending regions get folded into the diff state.
  https://forum.cursor.com/t/have-to-accept-diff-on-every-line-that-i-type/22788
- A request to "Re-sync Keep/Undo review UI after branch switch" shows that the review state is tracked separately from file content and can go stale when the file changes externally.
  https://forum.cursor.com/t/re-sync-keep-undo-review-ui-after-branch-switch-without-re-applying-agent-edits/164125
- **(inferred)** Recommended behaviour for us: treat a user edit that overlaps a pending hunk as an implicit accept of that hunk, and shift non-overlapping hunks by the line delta.

### 1.8 Version history (best effort)

| Version | Change | Source |
|---|---|---|
| 0.4x (2024–early 2025) | Per-block Accept/Reject in Composer/Cmd+K. Cmd+Backspace = reject all | https://forum.cursor.com/t/shift-backspace-for-rejecting-changes-is-a-bad-idea/74243 |
| 0.48 | "Reject all" shortcut changed | same |
| 1.3 | A forum thread titled "Cursor 1.3 removed an important feature" (details not retrieved) | https://forum.cursor.com/t/bring-back-per-change-apply-inline-diff-review-you-re-throwing-away-your-best-ux-advantage/160856 |
| 1.7 | Auto-scroll to next diff after Keep, reverted, then re-appeared behind a setting | https://forum.cursor.com/t/accepting-diff-regression-jumping-again/136523 |
| 2.0 | Multi-file combined review view | https://cursor.com/changelog/2-0 |
| ~Dec 2025 (2.x) | Arrow nav replaced by floating Review panel and bottom bar | https://forum.cursor.com/t/how-to-navigate-to-the-changes-made-in-chat-to-accept-or-reject-them/145639 |
| 2.5–2.6 | Bugs: only the first file's diff shows, review bar missing, silent auto-apply | https://forum.cursor.com/t/review-diff-navigation-bar-missing-after-agent-changes-v2-6-20/155587 |
| 3.x (2026) | New "Agents Window" defaults to session-level Review with a git-style diff and file-level discard. Per-change Keep/Undo stays only in the Editor window | https://forum.cursor.com/t/bring-back-the-review-tool-from-earlier-cursor-ide-versions/174469 , https://forum.cursor.com/t/cursor-3-1-ai-applies-changes-directly-no-keepfile-undofile-buttons-how-to-enable-them/158699/5 |

There is clear demand for per-hunk inline review, which Cursor 3.x moved away from in its default flow. https://forum.cursor.com/t/bring-back-per-change-apply-inline-diff-review-you-re-throwing-away-your-best-ux-advantage/160856

---

## 2. Claude Code hooks

Primary source: https://code.claude.com/docs/en/hooks (also served as `hooks.md`). All facts below come from that page unless another URL is given.

### 2.1 Events

`SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreSkillShellCommand`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`, `SessionEnd`.

The relevant ones for us:
- `PreToolUse` runs before the tool. Use it to snapshot the original file content.
- `PostToolUse` runs after a successful tool call. Use it to compute and show the diff.
- `PostToolBatch` fires once after all parallel tool calls resolve, with a `tool_calls` array.
- `UserPromptSubmit` and `Stop` can inject feedback.
- `FileChanged` fires on filesystem changes, whatever caused them, including Bash and external processes.

Doc note: a `PostToolUse` hook matching `Edit|Write` does **not** fire when Bash rewrites the file. Use `FileChanged` or `git status` for those cases.

### 2.2 Common stdin fields (all events)

| Field | Notes |
|---|---|
| `session_id` | |
| `prompt_id` | UUID of the current user prompt. Absent before the first input |
| `transcript_path` | JSONL, written asynchronously and may lag |
| `cwd` | |
| `scratchpad_dir` | v2.1.257+, may be absent |
| `permission_mode` | `"default"` (labelled Manual), `"plan"`, `"acceptEdits"`, `"auto"`, `"dontAsk"`, `"bypassPermissions"`. Not on every event |
| `effort` | `{ "level": "low".."max" }` on tool-context events |
| `hook_event_name` | |
| `agent_id`, `agent_type` | Only inside subagents/teammates or with `--agent` |

Event-specific fields:
- **PreToolUse**: `tool_name`, `tool_input`, `tool_use_id` (MCP tools also get `mcp_server`).
- **PostToolUse**: `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, optional `duration_ms`. On failure, `tool_response` is the error string.
- **UserPromptSubmit**: `prompt`, plus `session_title` if set.
- **Stop**: `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`.
- **SessionStart**: `source` (`startup|resume|clear|compact|fork`), optional `model`, `agent_type`, `session_title`.
- **FileChanged**: `file_path`, `event` (`change|add|unlink`).

`tool_input` for file tools: Edit = `file_path`, `old_string`, `new_string`, `replace_all`. Write = `file_path`, `content`. Paths are always absolute, with backslashes on Windows. `NotebookEdit` also exists (`Edit.*` matches it).

`tool_response` documented example for Write: `{ "filePath": "...", "type": "create" }`. The Edit response shape is not documented. In practice it carries `filePath`, `oldString`, `newString`, `originalFile`, `structuredPatch`, `userModified`, `replaceAll`. **(inferred, undocumented, so don't depend on it.)** A safer approach: snapshot the file in PreToolUse, or read the original from our own document cache, then diff against the disk after PostToolUse.

### 2.3 Configuration

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write|NotebookEdit",
        "hooks": [ { "type": "command", "command": "node", "args": ["/abs/path/hook.js"], "timeout": 30 } ] }
    ]
  }
}
```

- Three levels: event → matcher group → handlers. Handler `type`: `command`, `http`, `mcp_tool`, `prompt`, `agent`.
- Locations: `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json` (personal, gitignored), managed policy, plugin `hooks/hooks.json`, and skill/agent frontmatter. The VS Code extension shares `~/.claude/settings.json` with the CLI (https://code.claude.com/docs/en/vs-code).
- Placeholders: `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`.
- Matcher: `"*"`, `""` or omitted matches all. A value made only of `[A-Za-z0-9_\- ,|]` is an exact name or a `|`/`,` list. Anything else is an unanchored JS regex (`Edit.*` also matches `NotebookEdit`, so use `^Edit$`).
- Handler fields: `if` (permission-rule syntax such as `"Edit(*.ts)"`, tool events only), `timeout` (seconds), `statusMessage`, `once` (skills only). Command hooks also take `args` (exec form, no shell), `async`, `asyncRewake`, `shell` (`bash|powershell`), and `onFailure` (`continue|block`, v2.1.295+).
- `"disableAllHooks": true` turns all hooks off. "Direct edits to hooks in settings files are normally picked up automatically by the file watcher." `ConfigChange` fires when settings change.
- HTTP hooks receive the same JSON as a POST body. That is an alternative to spawning a process: the extension could run a localhost server. **(inferred viability: the docs say the body matches, but we have not checked localhost or auth constraints)**

### 2.4 Exit codes

- **0**: success. If stdout is a single JSON object, its fields apply. Plain-text stdout becomes context on UserPromptSubmit and SessionStart.
- **2**: blocking error. stderr is the reason. On PostToolUse it can't block (the tool already ran), so stderr is shown to Claude instead.
- **Other**: non-blocking error. The user sees a "hook error" notice and the action proceeds, unless `onFailure: "block"` is set.

### 2.5 JSON output

- Universal: `continue` (false stops Claude), `stopReason`, `suppressOutput` (no effect), `systemMessage` (shown to the user), `terminalSequence`.
- Decision patterns: top-level `decision: "block"` + `reason` for UserPromptSubmit, PostToolUse, PostToolBatch, Stop, SubagentStop, ConfigChange, PreCompact. PreToolUse uses `hookSpecificOutput.permissionDecision` (`allow|deny|ask|defer`), `permissionDecisionReason`, `updatedInput` (replaces the whole input) and `additionalContext`. Top-level `decision` is deprecated for PreToolUse.
- `hookSpecificOutput` must include `hookEventName`.
- **PostToolUse**: `decision:"block"` puts `reason` next to the tool result, and Claude still sees the original output. Other fields: `additionalContext`, `updatedToolOutput` (must match the tool's output schema or it is ignored), `classifierContext`, `updatedMCPToolOutput`.
- **UserPromptSubmit**: `decision:"block"` + `reason` (shown to the user, not added to context), and `hookSpecificOutput.additionalContext`, `sessionTitle`, `suppressOriginalPrompt`. The prompt can't be rewritten.
- **Stop**: `decision:"block"` + `reason` keeps Claude going with `reason` as its instruction. `additionalContext` also continues, shown as "Stop hook feedback". Consecutive continuations are capped at 8 (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).
- **SessionStart**: `additionalContext`, `initialUserMessage`, `sessionTitle`, `watchPaths`, `reloadSkills`.
- `additionalContext` is injected as a system reminder. If it exceeds 10,000 characters, it is written to a file and Claude gets the path plus a 2,000-character preview. Placement: next to the tool result (Pre/PostToolUse, PostToolBatch), alongside the prompt (UserPromptSubmit), or at turn end (Stop). The docs advise writing it as factual statements, because imperative "system command" phrasing can trigger prompt-injection defenses.
- On `--resume`, saved PostToolUse/UserPromptSubmit context is replayed, not recomputed.

### 2.6 Timeouts and async

- Defaults: 600 s for command/http/mcp_tool, 30 s for prompt, 60 s for agent. 30 s for command hooks on UserPromptSubmit. SessionEnd has a 1.5 s budget.
- `async: true` runs the hook in the background with no timeout enforced. Its `additionalContext`/`systemMessage` are delivered on the **next turn**. If the session is idle, the output waits for the next user interaction.
- `asyncRewake: true` runs in the background and **wakes Claude immediately on exit 2**, even when idle. stderr (or stdout) is shown to Claude as a system reminder. `timeout` still applies.
- When the user interrupts with Ctrl+Enter, PostToolUse hooks get 10 s to finish. Esc cancels them.

### 2.7 Windows

- `shell: "powershell"` uses `pwsh.exe`, falling back to `powershell.exe`. The default is bash (Git Bash) when it is installed. Set the path with `CLAUDE_CODE_GIT_BASH_PATH`.
- Exec form (`args`) needs a real executable. npm `.cmd`/`.bat` shims won't spawn, so use `node <script>`.
- In PowerShell, use `${CLAUDE_PROJECT_DIR}` or `$env:CLAUDE_PROJECT_DIR`, not bare `$CLAUDE_PROJECT_DIR`.
- Without Git Bash, only exit codes 0 and 2 count as a verdict for PreToolUse, PermissionRequest and PreSkillShellCommand.
- There is no `/dev/tty`. Hooks can't talk to the terminal directly.

### 2.8 IDE extension parity

- "Claude Code fires the same hook events wherever it runs: sessions in the terminal, IDE extensions, the Desktop app, and cloud sessions." https://code.claude.com/docs/en/hooks
- The VS Code extension installs in Cursor (`cursor:extension/anthropic.claude-code`). Settings, including hooks, are shared with the CLI. The extension has its own diff review: a side-by-side diff in Manual mode, plus **Accept this change / Reject this change** buttons per change (v2.1.275+, not for diffs with more than 100 changes), and the commands *Claude Code: Accept/Reject Change at Cursor*. It also supports checkpoints and rewind.
  https://code.claude.com/docs/en/vs-code
- The CLI, when connected to the IDE, "Opens diffs in VS Code's native diff viewer". Our extension may need to coexist with that or ask users to disable it. https://code.claude.com/docs/en/vs-code

### 2.9 Feeding "rejection feedback" back to Claude

Documented options, from best to worst fit:

1. **`UserPromptSubmit` → `hookSpecificOutput.additionalContext`**. This is the most robust. Queue rejections (file, hunk text, optional user note) in a state file. On the user's next prompt, the hook prints them as context alongside the prompt and clears the queue. Plain stdout works too. The default timeout is 30 s, so the hook has to be fast. Its limit is that Claude only learns about rejections when the user next types.
2. **`PostToolUse` → `additionalContext` or `decision:"block"` + `reason`**. Context lands next to the tool result, so Claude sees it immediately. That only works if the verdict is known while the hook runs, which means a synchronous hook that waits for the user's review: up to 600 s by default, and it blocks the agent. That is acceptable in a "review each edit" mode and too heavy for Cursor-style async review. **(inferred design trade-off)**
3. **`Stop` → `decision:"block"` + `reason`**. When Claude tries to finish while rejections are pending, the hook makes it continue with the rejection summary as its instruction. The cap is 8 consecutive continuations. Check `stop_hook_active` to avoid loops.
4. **`asyncRewake` command hook (exit 2)**. A background hook that waits for review and, on rejection, exits 2 with feedback on stderr. That wakes Claude even when idle. It is the only documented way to push feedback without user input. Undocumented details remain, such as how it interacts with an in-progress turn. **(inferred)**
5. **`PreToolUse` `permissionDecision:"deny"` + reason**. This blocks edits *before* they apply (Claude Code's own approval flow). It doesn't fit an already-applied-then-review model.

Recommendation: combine (1) with (3). Optionally add (4) as an opt-in "notify Claude immediately" mode.

### 2.10 Cursor's agent and Claude-format hooks

- Cursor hooks live in `.cursor/hooks.json` / `~/.cursor/hooks.json` as `{"version":1,"hooks":{...}}` with camelCase events (`preToolUse`, `postToolUse`, `afterFileEdit`, `beforeSubmitPrompt`, `stop`, `sessionStart`, ...). https://cursor.com/docs/agent/hooks
- Cursor common stdin fields: `conversation_id`, `generation_id`, `model`, `model_id`, `model_params`, `hook_event_name`, **`cursor_version`**, `workspace_roots`, `user_email`, `transcript_path`. `afterFileEdit` adds `file_path` and `edits: [{old_string,new_string}]`. Outputs include `permission`, `user_message`, `agent_message`, `updated_input`, `additional_context` (postToolUse, sessionStart), and `followup_message` (stop). Exit 2 blocks. https://cursor.com/docs/agent/hooks
- Cursor **does load Claude Code hooks** from `.claude/settings.local.json`, `.claude/settings.json` and `~/.claude/settings.json` when *Settings → Agents → Third-Party Imports → "Include Third-Party Plugins, Skills, and Other Configs"* is on (the default). Event map: PreToolUse→preToolUse, PostToolUse→postToolUse, UserPromptSubmit→beforeSubmitPrompt, Stop→stop, SubagentStop→subagentStop, SessionStart→sessionStart, SessionEnd→sessionEnd, PreCompact→preCompact. Notification and PermissionRequest are not supported. Tool names map `Bash`→`Shell` and `Edit`→`Write`, and `Glob` is unsupported. Cursor accepts both nested `hookSpecificOutput` and flat output.
  https://cursor.com/docs/reference/third-party-hooks
- Consequence: **our Claude-format hooks may also fire for Cursor's own agent.** The payload then follows Cursor's schema, with `cursor_version` and `conversation_id` and no `session_id` **(inferred: the mapping page doesn't describe input payloads)**. The hook script should detect `cursor_version` (or a missing `session_id`) and no-op, so Cursor's native diff UI doesn't get duplicated.
- A forum report on 2.6.11 says `.claude/settings.json` hooks never fired even with the setting on. https://forum.cursor.com/t/claude-hooks-dont-work/153614

---

## 3. VS Code editor insets and alternatives

### 3.1 `editorInsets` proposed API

Source: https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.editorInsets.d.ts

```ts
export interface WebviewEditorInset {
  readonly editor: TextEditor; readonly line: number; readonly height: number;
  readonly webview: Webview; readonly onDidDispose: Event<void>; dispose(): void;
}
export namespace window {
  export function createWebviewTextEditorInset(editor: TextEditor, line: number, height: number, options?: WebviewOptions): WebviewEditorInset;
}
```

- Implementation: `EditorWebviewZone` is a view zone with `afterLineNumber = line` and **`heightInLines = height`**, so the height is measured in lines, not pixels. A full webview element is mounted into it (z-index 10 "without this, the webview is not interactive"). The API has no update/resize method, so changing position or height means dispose and recreate.
  https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/browser/mainThreadCodeInsets.ts
- Gated by `checkProposedApiEnabled(extension, 'editorInsets')`. https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/common/extHost.api.impl.ts
- Enabling it: add `"enabledApiProposals": ["editorInsets"]` in package.json, add the d.ts (`npx @vscode/dts dev`), and launch with `--enable-proposed-api=<publisher.name>`, or persist it via "Preferences: Configure Runtime Arguments" by adding the ID to `"enable-proposed-api"` in `argv.json`. Proposed APIs work only in Insiders upstream and **can't be published to the Marketplace**. Distribute as a VSIX instead.
  https://code.visualstudio.com/api/advanced-topics/using-proposed-api
- Status: tracking issue #85682 is open/backlog. Maintainer (Sep 21, 2023): "currently not planned to be finalized". Copilot's inline diff uses internal view zones, not insets ("As of today we have no feature that builds on inset webviews"). Users have long asked for dynamic height. https://github.com/microsoft/vscode/issues/85682
- Cursor: a third-party README documents `~/.cursor/argv.json` with `enable-proposed-api` (https://marketplace.visualstudio.com/items?itemName=ali50m.xnes), which suggests Cursor honours the flag in stable builds. Whether `editorInsets` specifically works in Cursor is **unconfirmed. Test it.**
- Costs **(inferred)**: each inset is a separate webview (iframe/process-backed), so dozens of hunks means dozens of webviews. Theme matching and font metrics must be replicated by hand. Fixed line height breaks with wrapped lines and zoom. And it requires users to edit argv.json.

### 3.2 Stable-API alternatives

- **Decorations** (`window.createTextEditorDecorationType`): `backgroundColor`/`isWholeLine` give green added lines, and `before`/`after` `contentText` gives virtual text. `contentText` goes into CSS `content`, so whitespace collapses and newlines don't render, meaning one decoration per line is required.
  https://code.visualstudio.com/api/references/vscode-api#DecorationRenderOptions ,
  https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/75707565/vscode-texteditordecoration-api-not-rendering-white-spaces .
  Inline decorations are CSS `::before`/`::after` (https://github.com/Microsoft/vscode/issues/34441). A known hack injects CSS through the `textDecoration` string (e.g. `"none; display:block; white-space:pre"`) to make a `before` pseudo-element render as a block above the line, which can show deleted lines as red phantom rows. This depends on internal CSS and may break. **(inferred, community technique)** Virtual text can't be selected or copied and doesn't push following lines down reliably. **(inferred)**
- **CodeLens** (`languages.registerCodeLensProvider`): stable, clickable "Accept | Reject" above a line, and it does reserve vertical space. Users can turn it off globally (`editor.codeLens`). The best stable fit for per-hunk buttons **(inferred)**.
- **Comments API** (`comments.createCommentController`): stable multi-line widget with rich text and actions. It is heavy, styled as review comments, and shows up in the Comments panel **(inferred)**.
- **Inline `after` text / inlay hints**: good for small labels like "⌘Y keep · ⌘N undo" at end of line.
- **Read-only virtual doc + `vscode.diff`**: the native diff editor. It is reliable, but not inline.
- **Keybinding context**: set a `setContext('claudeInlineDiff.hasHunkAtCursor', ...)` key and bind Cmd+Y/Cmd+N with a `when` clause. Cmd+Y is redo on Windows/Linux, so it needs care.

---

## 4. Design implications for our extension

- **Edits are already on disk** (Claude Code applied them). As Cursor does, model the review as overlay state keyed by file, with hunks of {originalLines, newRange}. Accept drops the overlay. Reject writes the original text back with a `WorkspaceEdit`, so Cmd+Z can undo the rejection.
- **Source of the original text**: snapshot it in a `PreToolUse` hook (matcher `^(Edit|Write|NotebookEdit)$`) or from the extension's open-document cache. Don't rely on the undocumented `tool_response.originalFile`/`structuredPatch`.
- **Hook transport**: a tiny `node` script (exec form, `args`, so it works on Windows) that forwards stdin JSON to the extension over a local socket or file drop. It must exit 0 quickly. Consider `type: "http"` to a localhost server.
- **Install hooks into `.claude/settings.local.json`** (personal, gitignored) or `~/.claude/settings.json`. The file watcher picks them up live. Merge with existing hooks and never overwrite.
- **Detect Cursor's own agent**: if the payload has `cursor_version`/`conversation_id` and no `session_id`, no-op, because Cursor imports `.claude/settings*.json` hooks by default.
- **Rejection feedback**: queue rejections and inject them through `UserPromptSubmit` `additionalContext` (fast, 30 s timeout). Also use a `Stop` hook with `decision:"block"` + `reason` when rejections are pending at turn end, guarding with `stop_hook_active`. Optionally offer `asyncRewake` for immediate wake-up. Write the feedback as facts ("User rejected hunk in src/a.ts lines 10-14; original kept"), not as commands.
- **Rendering, in order of preference**: (1) stable decorations: green whole-line background on added lines, red phantom deleted lines via the `before` block hack, and per-line `before` decorations as a fallback. (2) CodeLens "Keep ⌘Y | Undo ⌘N" per hunk. (3) Optional `editorInsets` path behind a setting, for users who enable proposed API. It can't go on the Marketplace, so keep it out of the default build.
- **Keybindings**: mirror community Cursor habits (Cmd+Y keep hunk, Cmd+N undo hunk) plus the official "all" bindings (Cmd+Enter accept all, Cmd+Shift+Backspace reject all), all scoped with `when` contexts. Make them configurable, because Cursor's own bindings will conflict inside Cursor.
- **Auto-advance**: after keep/undo, move to the next hunk, then the next file, but make it a setting (default on, with no viewport jump if the next hunk is visible). Cursor users complained about forced scrolling.
- **Review bar**: a status-bar item or editor-title actions showing "N files · M hunks", prev/next file, Keep All, Undo All. Cursor's bottom bar is the reference.
- **User edits**: an edit overlapping a hunk counts as accepting that hunk. Shift other hunks by the line delta. On external or disk changes that break hunk anchors, drop the overlay rather than show stale diffs.
- **Coexistence**: Claude Code's VS Code extension has its own per-change Accept/Reject diff view (v2.1.275+), and the CLI can open native diffs. Document how to avoid double review (e.g. use `acceptEdits` mode in Claude Code and let our overlay handle review).
- **Persistence**: keep pending hunks in `workspaceState` so review survives reloads. Cursor users report review state lost on restart. https://forum.cursor.com/t/review-of-changes-done-in-agent-chat-window-disappears-after-cursor-restart/163021

## 5. Reference projects: what we take, rewrite, avoid

### 5.1 broosk1993/claude-code-inline-review (MIT, v0.4.2): studied and partly ported
Source: https://github.com/broosk1993/claude-code-inline-review (cloned and read in full).

| Area | Reference | This extension |
|---|---|---|
| Line diff | Myers O(ND), linear space, step budget, hunk sliding for readable placement (`src/diff.js`) | **Ported** to TypeScript (`src/core/diff.ts`), with the MIT notice kept in the file header and `THIRD_PARTY_LICENSE_claude-code-inline-review.txt` |
| Word diff | Token-level Myers within a hunk, ranges on both sides | **Ported** (same file) |
| Review model | `absorbUserEdits`, `replaceLines` (keeps mixed EOLs), `minimalEdit`, `hunkAtLine` | **Ported** to `src/core/model.ts`, extended with navigation helpers and a summary |
| Hook | PreToolUse makes a baseline on the first edit; PostToolUse touches a `.landed` marker | **Rewritten** (`src/hook/hook.ts`). We keep the idea of the first-writer-wins baseline and the landed marker, and add: project-local store, Bash tracking via git, step journal, activity markers, feedback delivery, and skipping Cursor's own agent |
| Storage | `~/.claude/review/baselines`, one global folder | **Changed** (since 0.1.27: one folder per project under `~/.claude/inline-diff/projects/` by default; the original plan below is kept for history): project-local `.claude-review/` by default (it ignores itself through its own `.gitignore: *`, so your `.gitignore` is never edited). Home folder is optional and also used for files outside the project |
| Setup | Merge into settings.json with backup and permissions preserved, no clobbering of invalid JSON | **Rewritten** on the same safety rules. Adds UserPromptSubmit, updates the command in place, has a full uninstall, and runs `vscode:uninstall` cleanup |
| Deleted lines UI | Comment-thread widgets | **Replaced** with editorInsets (webview blocks with theme-coloured syntax). Fallback is decorations plus hover |
| Weaknesses | Hooks left behind on uninstall; baselines in home; no sessions; Bash invisible | All addressed (see the README feature table) |

### 5.2 ahmerds/hunker (UNLICENSED): idea only, no code
License is UNLICENSED/private, so **no code was read for reuse or copied**. We take only the publicly described idea: render deleted lines with the proposed `editorInsets` API (`vscode.window.createWebviewTextEditorInset`), enabled with `enabledApiProposals: ["editorInsets"]` plus `argv.json` `"enable-proposed-api"`, and fall back to decorations. Our implementation (`src/insets.ts`) is written from scratch against the VS Code API typings and the behaviour described in §3.1.

### 5.3 Decisions (summary)
- Keybindings match Cursor's own (from Cursor 3.32 source): Cmd/Ctrl+Y / N per change, Cmd/Ctrl+Enter / Cmd/Ctrl+Shift+Backspace per file; Cmd/Ctrl+Shift+Y / N also work. All of them are active only while the cursor is in a Claude change (file keys: while the file has Claude changes), so Cursor's agent and normal editing keep their bindings elsewhere. An alternative scheme (Ctrl+Alt+Enter / Backspace) is available.
- Feedback is delivered on UserPromptSubmit (`additionalContext`), or on Claude's next PostToolUse if it is still working (§2.9). A blocking Stop hook was rejected: it would keep Claude running when the user didn't ask.
- The hook prints nothing except a JSON `additionalContext` object, and only when feedback is queued.

## 6. The official Claude Code extension for VS Code / Cursor (`anthropic.claude-code`)
Source: https://code.claude.com/docs/en/vs-code (fetched 2026-11-26), https://code.claude.com/docs/en/hooks

**Hooks.** The extension and the CLI share `~/.claude/settings.json`, including hooks (confirmed: "allowed commands, environment variables, hooks, and MCP servers"). The panel's *Customize → Hooks* lists the hooks a session loaded. The hook stdin payload is the same Claude Code payload, because the panel runs the same agent (confirmed for the shared settings; field-by-field parity is **inferred**, since the docs list no IDE-specific fields). Documented differences that could matter to hooks:
- The diagnostics MCP tool is `mcp__claude-vscode__getDiagnostics` in the panel and `mcp__ide__getDiagnostics` in the CLI. That's irrelevant to us: we match only Edit|MultiEdit|Write|NotebookEdit|Bash.
- `CLAUDE_CONFIG_DIR` set through the extension's `environmentVariables` setting must be absolute. Our installer writes absolute script paths and honours `CLAUDE_CONFIG_DIR` when the editor process has it.

**Diff review in the official extension.** In *Manual* mode, Claude shows a side-by-side diff **before** an edit and asks permission. Since v2.1.275 it has per-change *Accept this change* / *Reject this change* buttons. In **Edit automatically** (`acceptEdits`) mode, edits apply without that prompt. To have a single review, our extension targets `acceptEdits`:
- VS Code/Cursor user setting `claudeCode.initialPermissionMode: "acceptEdits"` (read only from *user* settings since v2.1.225), or
- `permissions.defaultMode: "acceptEdits"` in `~/.claude/settings.json`, or
- the mode selector in the prompt box ("Edit automatically").

Our installer only **offers** to set these, and records what it changed so uninstall can roll it back.

If the official diff tab does open (Manual mode), we don't interfere. PreToolUse creates the baseline, but nothing shows inline until the edit lands in the file (empty diff = hidden; PostToolUse marks it landed). If the edit is rejected in the official UI, the empty baseline is cleaned up after the grace period.

**`autosave` (default true)** saves files before Read/Edit/Write run, so Claude writes to disk and the open editor reloads clean. We use "reload leaves the document clean" to tell Claude's write apart from user typing. As a second guard, absorption of user edits is paused while a tool call on that file is in flight (activity marker between Pre and PostToolUse), in case the extension ever applies edits through the editor (**inferred** safeguard).

**Keybindings of the official extension** (docs): Cmd/Ctrl+Esc, Cmd/Ctrl+Shift+Esc, Cmd/Ctrl+N (*new conversation*, only when the Claude panel has focus **and** `enableNewConversationShortcut` is on, default off), Cmd/Ctrl+Shift+T, Alt/Option+K (editor focus), Ctrl+Alt/Option+F, Cmd/Ctrl+D (dictation, Claude focus). "Accept/Reject Change at Cursor" have no default binding. Our Cmd/Ctrl+Y / N / Shift+Y / Shift+N bindings require `editorTextFocus && claudeInlineDiff.cursorInHunk`, which is false while the Claude webview has focus, so **no conflict** (verified by reading the `when` clauses; not tested in a live editor). We register no commands under `claude-vscode.*` / `claudeCode.*`.

**Cursor's own agent.** Cursor runs Claude-format hooks for its agent too (§2.10). Its payloads carry `cursor_version` (and `conversation_id`), and our hook exits silently on them.
