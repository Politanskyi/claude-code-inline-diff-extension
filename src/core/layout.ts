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

// ---------- the chat shown in the Claude Code panel ----------
//
// The official extension keeps the session its sidebar shows only in the webview's own state, which the editor
// writes to the workspace's `state.vscdb` (key `memento/webviewView.<view id>`) when it flushes its state: up to
// a minute after a switch. Switching back to a chat that is still loaded fires no hook, so this is the only sign.

const CHAT_STATE_RE = /memento\/webviewView\.claudeVSCodeSidebar(?:Secondary)?\{"webviewState":"\{((?:[^"\\]|\\.)*)\}"/g;

/** The session id in the last state record of `text`: a string, null (a record without a session), undefined (no record). */
export function visibleChatFromText(text: string): string | null | undefined {
  let found: string | null | undefined;
  CHAT_STATE_RE.lastIndex = 0;
  for (let m = CHAT_STATE_RE.exec(text); m; m = CHAT_STATE_RE.exec(text)) {
    const id = /\\"sessionID\\":\\"([0-9a-fA-F-]{8,64})\\"/.exec(m[1]);
    found = id ? id[1] : null;
  }
  return found;
}

/**
 * The frames of a write-ahead log that are current: after a checkpoint the log is rewritten from its start and
 * older frames stay behind them in the file, told apart by the salt in the header.
 */
export function liveWalText(wal: Buffer): string {
  if (wal.length < 32) return '';
  const pageSize = wal.readUInt32BE(8) || 65536;
  const salt = wal.subarray(16, 24);
  let end = 32;
  while (end + 24 + pageSize <= wal.length && wal.subarray(end + 8, end + 16).equals(salt)) end += 24 + pageSize;
  return wal.subarray(32, end).toString('latin1');
}

/** The chat the Claude Code sidebar shows, as last written to this workspace's state; undefined when unknown. */
export function visibleChat(stateDb: string): string | null | undefined {
  try {
    const fromWal = visibleChatFromText(liveWalText(fs.readFileSync(stateDb + '-wal')));
    if (fromWal !== undefined) return fromWal;
  } catch {
    /* no log */
  }
  try {
    return visibleChatFromText(fs.readFileSync(stateDb).toString('latin1'));
  } catch {
    return undefined;
  }
}

// ---------- the official extension's log ----------
//
// Switching the panel to a chat whose process is still loaded is only an "attach" inside the official extension:
// no hook fires. Its log says so at once (`session.attach: vscode-<channel>`), and which session a channel runs
// follows from the lines of its launch. Best effort: the log's wording is not an interface.

/** What `ChatLogReader.feed` returns for a chat that was just started (it has no session id in the log). */
export const NEW_CHAT = '(new chat)';

export class ChatLogReader {
  private readonly channels = new Map<string, string>();
  private lastLaunch: string | null = null;
  private lastResume: string | null = null;
  private resumed = false;
  private rest = '';

  /** Feeds new log text; returns the session the panel was attached to last in it (if that is known). */
  feed(text: string): string | undefined {
    const lines = (this.rest + text).split('\n');
    this.rest = lines.pop() || '';
    let shown: string | undefined;
    for (const line of lines) {
      let m = /"type":"launch_claude","channelId":"([\w-]+)"/.exec(line);
      if (m) {
        this.lastLaunch = m[1];
        this.lastResume = null;
        this.resumed = line.includes('"resume":');
        continue;
      }
      // A resumed chat names its session, and the panel attaches to its channel right after.
      m = /resuming with same session id: ([0-9a-fA-F-]{8,64})/.exec(line);
      if (m) {
        this.lastResume = m[1];
        continue;
      }
      m = /session\.attach: vscode-([\w-]+) on/.exec(line);
      if (!m) continue;
      // The launch line may be missing (the log rolls over to a new file): then the attach alone ties them.
      if (!this.channels.has(m[1]) && this.lastResume && (this.lastLaunch === null || this.lastLaunch === m[1])) {
        this.channels.set(m[1], this.lastResume);
        this.lastResume = null;
      }
      // A launch without a resume, then the attach to its channel: a new chat is on screen.
      shown = this.channels.get(m[1]) ?? (this.lastLaunch === m[1] && !this.resumed ? NEW_CHAT : undefined);
    }
    return shown;
  }
}
