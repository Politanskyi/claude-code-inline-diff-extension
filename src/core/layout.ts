// Where the Claude Code chat lives in the window, so the Claude Changes list can sit right under it
// (like the file list under Cursor's agent chat).
//
// The chat is the view `claudeVSCodeSidebarSecondary` of the official extension. By default it is in
// the container `claude-sidebar-secondary`, but editors move it: Cursor, for one, puts it in a
// generated auxiliary-bar container. The editor keeps that in its global state (`views.customizations`
// → `viewLocations`), a SQLite file with no API. The JSON is stored as plain text, so a scan of the
// file (and its write-ahead log, which holds the newest pages) finds it without an SQLite library.

import * as fs from 'fs';

export const CLAUDE_CHAT_VIEW = 'claudeVSCodeSidebarSecondary';
export const CLAUDE_CHAT_CONTAINER = 'workbench.view.extension.claude-sidebar-secondary';

/** The container id the chat view was moved to, from raw state text; the last match is the newest. */
export function chatContainerFromState(text: string): string | null {
  const re = new RegExp(`"${CLAUDE_CHAT_VIEW}"\\s*:\\s*"(workbench\\.[\\w.\\-]+)"`, 'g');
  let found: string | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) found = m[1];
  return found;
}

/** Reads `state.vscdb` (+ `-wal`) and returns the chat's container, or the default one. */
export function chatContainer(stateDb: string): string {
  let text = '';
  for (const f of [stateDb, stateDb + '-wal']) {
    try {
      text += fs.readFileSync(f).toString('latin1');
    } catch {
      /* missing */
    }
  }
  return chatContainerFromState(text) || CLAUDE_CHAT_CONTAINER;
}
