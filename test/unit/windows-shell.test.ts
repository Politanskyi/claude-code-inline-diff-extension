// Windows only: the hook command exactly as Set Up writes it to settings.json must run in the
// shells Claude Code may use there (Git Bash by default, PowerShell, cmd), with the payload on stdin.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as setup from '../../src/core/setup';
import { sandbox } from './helpers';

const isWin = process.platform === 'win32';
const dist = path.resolve(__dirname, '../../dist/hook.js');

function gitBash(): string | undefined {
  const c = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ].filter((x): x is string => !!x);
  return c.find((p) => fs.existsSync(p));
}

type Shell = 'bash' | 'powershell' | 'cmd';
function runIn(shell: Shell, command: string, input: string, env: NodeJS.ProcessEnv) {
  const opts = { input, env, encoding: 'utf8' as const, timeout: 30000 };
  if (shell === 'bash') return spawnSync(gitBash()!, ['-c', command], opts);
  if (shell === 'powershell') return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], opts);
  return spawnSync(command, { ...opts, shell: true }); // cmd /d /s /c "<command>"
}

describe.skipIf(!isWin || !fs.existsSync(dist))('Windows: the installed hook command runs', () => {
  let sb: ReturnType<typeof sandbox>;
  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => sb.cleanup());

  const payload = (f: string, event: string) =>
    JSON.stringify({ session_id: 's', cwd: sb.project, hook_event_name: event, tool_name: 'Edit', tool_input: { file_path: f } });
  const baselines = () => {
    try {
      return fs.readdirSync(path.join(sb.store, 'baselines')).filter((x) => x.endsWith('.json'));
    } catch {
      return [];
    }
  };

  for (const shell of ['bash', 'powershell', 'cmd'] as Shell[]) {
    it(`node variant in ${shell}: snapshots, prints nothing, exits 0`, () => {
      if (shell === 'bash' && !gitBash()) throw new Error('Git Bash not found on this runner');
      setup.install({ bundled: dist, dir: sb.claude, nodeOnPath: true });
      const cmd = JSON.parse(fs.readFileSync(path.join(sb.claude, 'settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command;
      const f = sb.write('a.ts', 'v1');
      const pre = runIn(shell, cmd, payload(f, 'PreToolUse'), sb.env);
      expect({ status: pre.status, stdout: pre.stdout, stderr: pre.stderr, cmd }).toMatchObject({ status: 0, stdout: '' });
      expect(baselines()).toHaveLength(1);
      fs.writeFileSync(f, 'v2');
      const post = runIn(shell, cmd, payload(f, 'PostToolUse'), sb.env);
      expect(post.status).toBe(0);
      expect(fs.readdirSync(path.join(sb.store, 'baselines')).some((x) => x.endsWith('.landed'))).toBe(true);
    });
  }

  it('a path with spaces works in every shell', () => {
    const spaced = path.join(sb.root, 'My Claude Dir');
    setup.install({ bundled: dist, dir: spaced, nodeOnPath: true });
    const cmd = JSON.parse(fs.readFileSync(path.join(spaced, 'settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command;
    const out: Record<string, unknown> = {};
    for (const shell of ['bash', 'powershell', 'cmd'] as Shell[]) {
      const f = sb.write(`s-${shell}.ts`, 'v1');
      const r = runIn(shell, cmd, payload(f, 'PreToolUse'), sb.env);
      out[shell] = { status: r.status, stderr: (r.stderr || '').slice(0, 200) };
    }
    expect({ out, n: baselines().length, cmd }).toMatchObject({ n: 3 });
  });

  // Diagnostic: which form of "run the editor's binary as Node" works where (node stands in for the editor binary).
  it('diagnostic: no-node fallback forms per shell', () => {
    const probe = path.join(sb.root, 'probe dir', 'probe.js');
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(
      probe,
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({env:process.env.ELECTRON_RUN_AS_NODE||null,stdin:s.length})));"
    );
    const exe = process.execPath;
    const forms: Record<string, string> = {
      current: setup.hookCommand(probe, { nodeOnPath: false, execPath: exe, platform: 'win32' }),
      posix: `ELECTRON_RUN_AS_NODE=1 "${exe}" "${probe}"`,
      ps: `$env:ELECTRON_RUN_AS_NODE='1'; & "${exe}" "${probe}"`,
    };
    const matrix: Record<string, unknown> = {};
    for (const [name, cmd] of Object.entries(forms))
      for (const shell of ['bash', 'powershell', 'cmd'] as Shell[]) {
        const r = runIn(shell, cmd, 'x'.repeat(10), { ...sb.env, ELECTRON_RUN_AS_NODE: undefined });
        matrix[`${name}/${shell}`] = {
          status: r.status,
          stdout: (r.stdout || '').slice(0, 80),
          stderr: (r.stderr || '').replace(/\s+/g, ' ').slice(0, 120),
        };
      }
    console.log('FALLBACK-MATRIX ' + JSON.stringify(matrix));
    console.log('FALLBACK-FORMS ' + JSON.stringify(forms));
  });
});
