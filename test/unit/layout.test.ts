import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chatContainer, chatContainerFromState, CLAUDE_CHAT_CONTAINER } from '../../src/core/layout';

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
