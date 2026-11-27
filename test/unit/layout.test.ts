import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chatContainer, chatContainerFromState, CLAUDE_CHAT_CONTAINER } from '../../src/core/layout';
import { chatSectionState } from '../../src/core/layout';
import { visibleChatFromText, liveWalText, ChatLogReader, NEW_CHAT } from '../../src/core/layout';

const custom = (id: string) =>
  `views.customizations{"viewContainerLocations":{"${id}":2},"viewLocations":{"claudeVSCodeSidebarSecondary":"${id}"}}`;

describe('Claude Code chat location', () => {
  it('finds the container the chat was moved to; the newest entry wins', () => {
    const a = 'workbench.views.service.auxiliarybar.ad5a8d1c-375c-47ab-a7f9-dd95822de9b4';
    const b = 'workbench.views.service.auxiliarybar.0000aaaa-1111-2222-3333-444455556666';
    expect(chatContainerFromState('\0junk' + custom(a) + '\0')).toBe(a);
    expect(chatContainerFromState(custom(a) + custom(b))).toBe(b);
    expect(chatContainerFromState('{"viewLocations":{"other":"workbench.x"}}')).toBeNull();
  });

  it('reads the state file and its write-ahead log, defaulting to the extension container', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cid-layout-'));
    const db = path.join(dir, 'state.vscdb');
    expect(chatContainer(db)).toBe(CLAUDE_CHAT_CONTAINER);
    fs.writeFileSync(db, custom('workbench.views.service.auxiliarybar.old'));
    fs.writeFileSync(db + '-wal', custom('workbench.views.service.auxiliarybar.new'));
    expect(chatContainer(db)).toBe('workbench.views.service.auxiliarybar.new');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('chat shown in the Claude Code panel', () => {
  const rec = (id?: string) =>
    'memento/webviewView.claudeVSCodeSidebarSecondary{"webviewState":"{\\"isFullEditor\\":false' +
    (id ? `,\\"sessionID\\":\\"${id}\\",\\"sessionUpdatedAt\\":17958` : '') +
    '}"}';
  const A = '04e02a8b-2927-45ea-bb46-9d7be0e6645e';
  const B = '9c90cdda-4cb7-47e1-9309-c2b7b564b47d';

  it('reads the session of the last state record', () => {
    expect(visibleChatFromText('xx' + rec(A) + 'yy' + rec(B) + 'zz')).toBe(B);
    expect(visibleChatFromText(rec(A) + rec())).toBeNull(); // a new chat without a session yet
    expect(visibleChatFromText('nothing here')).toBeUndefined();
  });

  it('takes only the current frames of the write-ahead log', () => {
    const page = 512;
    const frame = (salt: number, text: string) => {
      const b = Buffer.alloc(24 + page);
      b.writeUInt32BE(salt, 8);
      b.writeUInt32BE(7, 12);
      b.write(text, 24, 'latin1');
      return b;
    };
    const header = Buffer.alloc(32);
    header.writeUInt32BE(page, 8);
    header.writeUInt32BE(2, 16);
    header.writeUInt32BE(7, 20);
    // After a checkpoint the log restarts: the frame with the old salt behind the new ones is stale.
    const wal = Buffer.concat([header, frame(2, rec(A)), frame(1, rec(B))]);
    expect(visibleChatFromText(liveWalText(wal))).toBe(A);
    expect(liveWalText(Buffer.alloc(10))).toBe('');
  });
});

describe("official extension's log", () => {
  const A = '04e02a8b-2927-45ea-bb46-9d7be0e6645e';
  const B = '9c90cdda-4cb7-47e1-9309-c2b7b564b47d';
  const launch = (ch: string, resume = true) =>
    `x [info] Received message from webview: {"type":"launch_claude","channelId":"${ch}","cwd":"<string>"${resume ? ',"resume":"<string>"' : ''}}\n`;
  const resumed = (id: string) =>
    `x [info] From claude: [DEBUG] FileHistory: No need to copy file history for resuming with same session id: ${id}\n`;
  const attach = (ch: string) => `x [info] From claude: [DEBUG] session.attach: vscode-${ch} on vscode\n`;

  it('tells which chat the panel was attached to', () => {
    const r = new ChatLogReader();
    expect(r.feed(launch('a1') + resumed(A) + attach('a1') + launch('b2') + resumed(B) + attach('b2'))).toBe(B);
    expect(r.feed(attach('a1'))).toBe(A); // back to a chat that is still loaded: no launch, no hook
    expect(r.feed('unrelated line\n')).toBeUndefined();
  });

  it('ties a chat to its channel when the launch line was left in the previous log file', () => {
    const r = new ChatLogReader();
    expect(r.feed(resumed(A) + attach('a1'))).toBe(A);
    expect(r.feed(launch('b2') + resumed(B) + attach('b2') + attach('a1'))).toBe(A);
  });

  it('does not take a new chat for the next resumed one, and waits for whole lines', () => {
    const r = new ChatLogReader();
    expect(r.feed(launch('n1', false) + attach('n1'))).toBe(NEW_CHAT);
    r.feed(launch('a1') + resumed(A));
    expect(r.feed(attach('n1'))).toBeUndefined();
    const line = attach('a1');
    expect(r.feed(line.slice(0, 20))).toBeUndefined();
    expect(r.feed(line.slice(20))).toBe(A);
  });
});

describe('chat section left collapsed in a new workspace', () => {
  const c = 'workbench.views.service.auxiliarybar.ad5a8d1c-375c-47ab-a7f9-dd95822de9b4';
  const state = (chat: object) => ({
    [c + '.state']: JSON.stringify({ claudeVSCodeSidebarSecondary: chat, 'claudeInlineDiff.changes': { collapsed: true } }),
  });
  const fresh = state({ collapsed: true, isHidden: true });
  const active = { 'workbench.auxiliarybar.activepanelid': c };

  it('expands when the chat tab is on screen and the section was never opened', () => {
    expect(chatSectionState({ ...fresh, ...active }, c)).toBe('expand');
    expect(chatSectionState(active, c)).toBe('expand'); // nothing saved yet: the default is collapsed
  });
  it('waits while another tab is on screen or the side bar is hidden', () => {
    expect(chatSectionState({ ...fresh, 'workbench.auxiliarybar.activepanelid': 'workbench.panel.aichat.f704' }, c)).toBe('wait');
    expect(chatSectionState({ ...fresh, ...active, 'workbench.auxiliaryBar.hidden': 'true' }, c)).toBe('wait');
    expect(chatSectionState(fresh, c)).toBe('wait');
  });
  it('leaves an open section alone; a never-opened one is saved with the height of its title', () => {
    expect(chatSectionState({ ...state({ collapsed: false, isHidden: true, size: 1001 }), ...active }, c)).toBe('done');
    expect(chatSectionState({ ...state({ collapsed: true, isHidden: true, size: 22 }), ...active }, c)).toBe('expand');
  });
});
