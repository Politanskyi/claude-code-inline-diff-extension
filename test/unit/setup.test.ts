import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as setup from '../../src/core/setup';
import { sandbox } from './helpers';

let sb: ReturnType<typeof sandbox>;
let bundled: string;
let settingsFile: string;
const readS = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const install = () => setup.install({ bundled, dir: sb.claude, nodeOnPath: true });

beforeEach(() => {
  sb = sandbox();
  bundled = path.join(sb.root, 'hook.js');
  fs.writeFileSync(bundled, '#!/usr/bin/env node\n// claude-inline-diff hook v1.0.0\n');
  settingsFile = path.join(sb.claude, 'settings.json');
});
afterEach(() => sb.cleanup());

const FOREIGN = {
  model: 'opus',
  env: { SECRET: 'x' },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }],
  },
};

describe('install', () => {
  it('creates settings.json and the script when nothing exists', () => {
    const done = install();
    expect(fs.existsSync(path.join(sb.claude, 'hooks', 'claude-inline-diff-hook.js'))).toBe(true);
    const s = readS();
    for (const ev of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit']) expect(setup.hasOurHook(s, ev)).toBe(true);
    expect(s.hooks.PreToolUse[0].matcher).toBe(setup.TOOL_MATCHER);
    expect(s.hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(done.some((d) => d.includes('backup'))).toBe(false); // nothing to back up
    if (process.platform !== 'win32') expect(fs.statSync(settingsFile).mode & 0o777).toBe(0o600);
  });

  it('keeps foreign settings and hooks, backs up, preserves permissions', () => {
    fs.writeFileSync(settingsFile, JSON.stringify(FOREIGN), { mode: 0o640 });
    if (process.platform !== 'win32') fs.chmodSync(settingsFile, 0o640);
    const done = install();
    const s = readS();
    expect(s.model).toBe('opus');
    expect(s.env).toEqual({ SECRET: 'x' });
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('my-linter.sh');
    expect(s.hooks.Stop).toEqual(FOREIGN.hooks.Stop);
    expect(s.hooks.PreToolUse).toHaveLength(2);
    const backup = done.find((d) => d.startsWith('backup'))!.split('→ ')[1];
    expect(JSON.parse(fs.readFileSync(backup, 'utf8'))).toEqual(FOREIGN);
    if (process.platform !== 'win32') expect(fs.statSync(settingsFile).mode & 0o777).toBe(0o640);
  });

  it('is idempotent (no duplicates, no extra backups)', () => {
    install();
    const before = fs.readFileSync(settingsFile, 'utf8');
    const done = install();
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(before);
    expect(done).toContain('settings.json already up to date');
    expect(readS().hooks.PreToolUse).toHaveLength(1);
  });

  it('never overwrites invalid JSON', () => {
    fs.writeFileSync(settingsFile, '{ "model": "opus", }  // broken');
    expect(() => install()).toThrow(/not valid JSON/);
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe('{ "model": "opus", }  // broken');
    expect(fs.existsSync(path.join(sb.claude, 'hooks', 'claude-inline-diff-hook.js'))).toBe(false);
  });

  it('refuses a non-object settings file', () => {
    fs.writeFileSync(settingsFile, '[1,2]');
    expect(() => install()).toThrow(/not a JSON object/);
  });

  it('writes through a symlinked settings.json', () => {
    if (process.platform === 'win32') return;
    const real = path.join(sb.root, 'dotfiles-settings.json');
    fs.writeFileSync(real, '{}');
    fs.symlinkSync(real, settingsFile);
    install();
    expect(fs.lstatSync(settingsFile).isSymbolicLink()).toBe(true);
    expect(setup.hasOurHook(JSON.parse(fs.readFileSync(real, 'utf8')), 'PreToolUse')).toBe(true);
  });

  it('repairs an outdated command/matcher in place', () => {
    install();
    const s = readS();
    s.hooks.PreToolUse[0].matcher = 'Edit';
    s.hooks.PreToolUse[0].hooks[0].command = 'node "/old/claude-inline-diff-hook.js"';
    fs.writeFileSync(settingsFile, JSON.stringify(s));
    const done = install();
    expect(done.join()).toMatch(/matcher/);
    expect(done.join()).toMatch(/command/);
    expect(readS().hooks.PreToolUse[0].matcher).toBe(setup.TOOL_MATCHER);
  });

  it('status reflects the state', () => {
    expect(setup.status(bundled, sb.claude).configured).toBe(false);
    install();
    const st = setup.status(bundled, sb.claude);
    expect(st).toMatchObject({ configured: true, scriptInstalled: true, installedVersion: '1.0.0', bundledVersion: '1.0.0' });
  });
});

describe('hook command', () => {
  it('uses node when available, else the editor binary in node mode', () => {
    expect(setup.hookCommand('/h/x.js', { nodeOnPath: true })).toBe('node "/h/x.js"');
    expect(setup.hookCommand('/h/x.js', { nodeOnPath: false, execPath: '/A/Cursor Helper', platform: 'darwin' })).toBe(
      'ELECTRON_RUN_AS_NODE=1 "/A/Cursor Helper" "/h/x.js"'
    );
  });
});

describe('uninstall', () => {
  it('removes only our entries and the script, keeps foreign hooks', () => {
    fs.writeFileSync(settingsFile, JSON.stringify(FOREIGN));
    install();
    const done = setup.uninstall({ dir: sb.claude, env: sb.env });
    expect(readS()).toEqual(FOREIGN);
    expect(fs.existsSync(path.join(sb.claude, 'hooks', 'claude-inline-diff-hook.js'))).toBe(false);
    expect(done.some((d) => d.includes('deleted'))).toBe(true);
  });

  it('drops the hooks key when it becomes empty', () => {
    install();
    setup.uninstall({ dir: sb.claude, env: sb.env });
    expect(readS()).toEqual({});
  });

  it('does not delete a foreign file with our name', () => {
    fs.mkdirSync(path.join(sb.claude, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(sb.claude, 'hooks', 'claude-inline-diff-hook.js'), '// someone else');
    setup.uninstall({ dir: sb.claude, env: sb.env });
    expect(fs.existsSync(path.join(sb.claude, 'hooks', 'claude-inline-diff-hook.js'))).toBe(true);
  });

  it('is a no-op when nothing is installed, and refuses broken JSON', () => {
    expect(setup.uninstall({ dir: sb.claude, env: sb.env })).toEqual([]);
    fs.writeFileSync(settingsFile, '{bad');
    expect(() => setup.uninstall({ dir: sb.claude, env: sb.env })).toThrow();
  });
});

describe('acceptEdits offer', () => {
  it('enables and rolls back to the previous mode', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { defaultMode: 'plan', allow: ['Bash(ls)'] } }));
    setup.enableAcceptEdits(sb.claude, sb.env);
    expect(readS().permissions.defaultMode).toBe('acceptEdits');
    setup.uninstall({ dir: sb.claude, env: sb.env });
    expect(readS().permissions).toEqual({ defaultMode: 'plan', allow: ['Bash(ls)'] });
  });

  it('removes the key when it was unset before', () => {
    setup.enableAcceptEdits(sb.claude, sb.env);
    expect(setup.rollbackAcceptEdits(sb.claude, sb.env)).toHaveLength(1);
    expect(readS()).toEqual({});
  });

  it('leaves the mode alone if the user changed it since, or if we never set it', () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }));
    setup.enableAcceptEdits(sb.claude, sb.env); // already set by the user → not recorded
    expect(setup.rollbackAcceptEdits(sb.claude, sb.env)).toEqual([]);
    expect(readS().permissions.defaultMode).toBe('acceptEdits');
    fs.writeFileSync(settingsFile, '{}');
    setup.enableAcceptEdits(sb.claude, sb.env);
    const s = readS();
    s.permissions.defaultMode = 'default';
    fs.writeFileSync(settingsFile, JSON.stringify(s));
    expect(setup.rollbackAcceptEdits(sb.claude, sb.env)).toEqual([]);
    expect(readS().permissions.defaultMode).toBe('default');
  });
});

describe('installed command really runs (posix shell, as Claude Code does)', () => {
  const dist = path.resolve(__dirname, '../../dist/hook.js');
  it.skipIf(process.platform === 'win32' || !fs.existsSync(dist))('snapshots through the command written to settings.json', async () => {
    const { spawnSync } = await import('child_process');
    setup.install({ bundled: dist, dir: sb.claude, nodeOnPath: true });
    const cmd = readS().hooks.PreToolUse[0].hooks[0].command;
    const f = sb.write('a.ts', 'v1');
    const r = spawnSync('sh', ['-c', cmd], {
      input: JSON.stringify({
        session_id: 's',
        cwd: sb.project,
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: f },
      }),
      env: sb.env,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(fs.readdirSync(path.join(sb.store, 'baselines')).filter((x) => x.endsWith('.json'))).toHaveLength(1);
    // Electron-as-node variant with the current node binary standing in for the editor executable.
    const cmd2 = setup.hookCommand(setup.hookPath(sb.claude), { nodeOnPath: false, execPath: process.execPath });
    const r2 = spawnSync('sh', ['-c', cmd2], { input: '{}', env: sb.env, encoding: 'utf8' });
    expect(r2.status).toBe(0);
  });
});
