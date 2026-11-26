import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { handle, HookInput, dirtyFiles } from '../../src/hook/hook';
import * as S from '../../src/core/store';
import { sandbox } from './helpers';

let sb: ReturnType<typeof sandbox>;
let clock = 1_700_000_000_000;
const ctx = () => ({ env: sb.env, now: () => clock++ });

/** Payload shaped like Claude Code's (CLI and the official VS Code extension send the same fields). */
function payload(event: string, tool: string, input: any, extra: Partial<HookInput> = {}): HookInput {
  return {
    session_id: 'sess-1',
    transcript_path: '/tmp/t.jsonl',
    cwd: sb.project,
    permission_mode: 'acceptEdits',
    hook_event_name: event,
    tool_name: tool,
    tool_input: input,
    tool_use_id: 'toolu_' + Math.random().toString(36).slice(2),
    ...extra,
  };
}

/** Simulates Claude: Pre hook → write → Post hook. */
function claudeEdit(rel: string, newText: string, tool = 'Edit', extra: Partial<HookInput> = {}) {
  const abs = path.join(sb.project, rel);
  const p = payload('PreToolUse', tool, { file_path: abs, old_string: 'x', new_string: 'y' }, extra);
  expect(handle(p, ctx())).toBe('');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, newText);
  return handle({ ...p, hook_event_name: 'PostToolUse', tool_response: { success: true } }, ctx());
}

beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe('hook: Edit / MultiEdit / Write', () => {
  it('snapshots the file before the first edit only', () => {
    const f = sb.write('a.ts', 'v1');
    claudeEdit('a.ts', 'v2');
    claudeEdit('a.ts', 'v3', 'MultiEdit');
    const entries = S.loadEntries(sb.store);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('v1');
    expect(entries[0].existed).toBe(true);
    expect(entries[0].path).toBe(f);
    expect(entries[0].sessionId).toBe('sess-1');
    expect(entries[0].landedAt).toBeGreaterThan(0);
  });

  it('records a new file created by Write as not existed', () => {
    claudeEdit('src/new.ts', 'hello', 'Write');
    const [e] = S.loadEntries(sb.store);
    expect(e.existed).toBe(false);
    expect(e.content).toBe('');
  });

  it('creates a self-ignoring store (.gitignore "*") and never touches the project .gitignore', () => {
    sb.write('.gitignore', 'node_modules\n');
    sb.write('a.ts', 'v1');
    claudeEdit('a.ts', 'v2');
    expect(fs.readFileSync(path.join(sb.store, '.gitignore'), 'utf8')).toContain('*');
    expect(sb.read('.gitignore')).toBe('node_modules\n');
  });

  it('honours storage=home', () => {
    S.writeConfig({ storage: 'home', dirName: '.claude-review', trackBash: true }, sb.env);
    sb.write('a.ts', 'v1');
    claudeEdit('a.ts', 'v2');
    expect(fs.existsSync(sb.store)).toBe(false);
    expect(S.loadEntries(S.globalStoreDir(sb.env))).toHaveLength(1);
  });

  it('puts files outside the project in the home store', () => {
    const outside = path.join(sb.root, 'elsewhere.txt');
    fs.writeFileSync(outside, 'o1');
    const p = payload('PreToolUse', 'Edit', { file_path: outside });
    handle(p, ctx());
    expect(S.loadEntries(S.globalStoreDir(sb.env))).toHaveLength(1);
  });

  it('resolves relative paths against cwd and finds the git root from a subdirectory', () => {
    sb.write('pkg/a.ts', 'v1');
    handle(payload('PreToolUse', 'Edit', { file_path: 'a.ts' }, { cwd: path.join(sb.project, 'pkg') }), ctx());
    expect(S.loadEntries(sb.store)).toHaveLength(1);
  });

  it('skips binary and oversized files', () => {
    fs.writeFileSync(path.join(sb.project, 'bin.dat'), Buffer.from([1, 0, 2]));
    handle(payload('PreToolUse', 'Write', { file_path: path.join(sb.project, 'bin.dat') }), ctx());
    expect(S.loadEntries(sb.store)).toHaveLength(0);
  });

  it('ignores Cursor agent payloads (cursor_version) and unrelated tools', () => {
    sb.write('a.ts', 'v1');
    handle(payload('PreToolUse', 'Edit', { file_path: path.join(sb.project, 'a.ts') }, { cursor_version: '1.7.0' }), ctx());
    handle(payload('PreToolUse', 'Read', { file_path: path.join(sb.project, 'a.ts') }), ctx());
    expect(S.loadEntries(sb.store)).toHaveLength(0);
  });

  it('tolerates garbage input', () => {
    expect(handle(null as any, ctx())).toBe('');
    expect(handle({} as any, ctx())).toBe('');
    expect(handle(payload('PreToolUse', 'Edit', {}), ctx())).toBe('');
  });

  it('tracks activity between Pre and Post', () => {
    const f = sb.write('a.ts', 'v1');
    const p = payload('PreToolUse', 'Edit', { file_path: f });
    handle(p, ctx());
    expect(S.loadActivity(sb.store, 1e15, clock)).toHaveLength(1);
    handle({ ...p, hook_event_name: 'PostToolUse' }, ctx());
    expect(S.loadActivity(sb.store, 1e15, clock)).toHaveLength(0);
  });

  it('first writer wins under parallel Pre hooks', () => {
    const f = sb.write('a.ts', 'orig');
    handle(payload('PreToolUse', 'Edit', { file_path: f }), ctx());
    fs.writeFileSync(f, 'changed-by-first');
    handle(payload('PreToolUse', 'Edit', { file_path: f }), ctx());
    expect(S.loadEntries(sb.store)[0].content).toBe('orig');
  });

  it('works for NotebookEdit (notebook_path)', () => {
    const f = sb.write('n.ipynb', '{"cells":[]}');
    handle(payload('PreToolUse', 'NotebookEdit', { notebook_path: f }), ctx());
    expect(S.loadEntries(sb.store)).toHaveLength(1);
  });
});

describe('hook: steps (UserPromptSubmit)', () => {
  it('groups edits by prompt and keeps the before-state per step', () => {
    sb.write('a.ts', 'v1');
    handle({ session_id: 'sess-1', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'first' }, ctx());
    claudeEdit('a.ts', 'v2');
    handle({ session_id: 'sess-1', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'second' }, ctx());
    claudeEdit('a.ts', 'v3');
    const steps = S.loadSteps(sb.store);
    expect(steps.map((s) => s.prompt)).toEqual(['second', 'first']);
    expect(steps[0].files[0].content).toBe('v2');
    expect(steps[1].files[0].content).toBe('v1');
  });

  it('creates an implicit step when no prompt was recorded', () => {
    sb.write('a.ts', 'v1');
    claudeEdit('a.ts', 'v2');
    expect(S.loadSteps(sb.store)).toHaveLength(1);
  });
});

describe('hook: feedback delivery', () => {
  it('returns rejection feedback as additionalContext on the next prompt, once', () => {
    S.queueFeedback(sb.store, { sessionId: 'sess-1', path: '/x/a.ts', text: 'keep the old API', excerpt: '- old\n+ new', ts: 1 });
    const out = handle({ session_id: 'sess-1', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'go on' }, ctx());
    const j = JSON.parse(out);
    expect(j.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(j.hookSpecificOutput.additionalContext).toContain('keep the old API');
    expect(handle({ session_id: 'sess-1', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'x' }, ctx())).toBe('');
  });

  it('delivers on PostToolUse while Claude is still working', () => {
    S.queueFeedback(sb.store, { path: '/x/a.ts', text: 'no', ts: 1 });
    sb.write('a.ts', 'v1');
    const out = claudeEdit('a.ts', 'v2');
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe('PostToolUse');
  });

  it("does not deliver another session's feedback", () => {
    S.queueFeedback(sb.store, { sessionId: 'other', path: '/x/a.ts', text: 'no', ts: 1 });
    expect(handle({ session_id: 'sess-1', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'x' }, ctx())).toBe('');
    expect(S.pendingFeedback(sb.store)).toHaveLength(1);
  });
});

const hasGit = spawnSync('git', ['--version']).status === 0;
describe.skipIf(!hasGit)('hook: Bash edits via git', () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: sb.project, stdio: 'pipe' });
  beforeEach(() => {
    fs.rmSync(path.join(sb.project, '.git'), { recursive: true });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('config', 'core.autocrlf', 'false');
    sb.write('tracked.txt', 'clean\n');
    sb.write('dirty.txt', 'committed\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    sb.write('dirty.txt', 'user edit\n');
  });

  function bash(run: () => void) {
    const p = payload('PreToolUse', 'Bash', { command: 'sed -i ...' });
    handle(p, ctx());
    run();
    handle({ ...p, hook_event_name: 'PostToolUse' }, ctx());
  }

  it('detects tracked, dirty, new and deleted files changed by a command', () => {
    expect(dirtyFiles(sb.project)).toEqual(['dirty.txt']);
    bash(() => {
      sb.write('tracked.txt', 'by bash\n');
      sb.write('dirty.txt', 'user edit\nbash too\n');
      sb.write('new.txt', 'fresh\n');
    });
    const byName = Object.fromEntries(S.loadEntries(sb.store).map((e) => [path.basename(e.path), e]));
    expect(Object.keys(byName).sort()).toEqual(['dirty.txt', 'new.txt', 'tracked.txt']);
    expect(byName['tracked.txt'].content).toBe('clean\n');
    expect(byName['dirty.txt'].content).toBe('user edit\n'); // the user's uncommitted edit is the baseline, not HEAD
    expect(byName['new.txt'].existed).toBe(false);
    expect(byName['tracked.txt'].source).toBe('bash');
  });

  it('ignores files the command did not change', () => {
    bash(() => {});
    expect(S.loadEntries(sb.store)).toHaveLength(0);
  });

  it('can be switched off', () => {
    S.writeConfig({ storage: 'project', dirName: '.claude-review', trackBash: false }, sb.env);
    bash(() => sb.write('tracked.txt', 'x\n'));
    expect(S.loadEntries(sb.store)).toHaveLength(0);
  });
});

describe('bundled dist/hook.js over stdin', () => {
  const bundle = path.resolve(__dirname, '../../dist/hook.js');
  it.skipIf(!fs.existsSync(bundle))('snapshots, prints nothing and exits 0', () => {
    const f = sb.write('a.ts', 'v1');
    const run = (data: string) => spawnSync(process.execPath, [bundle], { input: data, env: sb.env, encoding: 'utf8' });
    const r = run(JSON.stringify(payload('PreToolUse', 'Edit', { file_path: f })));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(S.loadEntries(sb.store)).toHaveLength(1);
    const bad = run('{not json');
    expect(bad.status).toBe(0);
    expect(bad.stdout).toBe('');
  });
});
