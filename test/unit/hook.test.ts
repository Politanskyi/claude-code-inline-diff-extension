import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { handle, HookInput, dirtyFiles, housekeeping } from '../../src/hook/hook';
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

  it('keeps the project clean by default: one store per project under the home folder', () => {
    sb.write('a.ts', 'v1');
    claudeEdit('a.ts', 'v2');
    expect(fs.existsSync(sb.projectStore)).toBe(false);
    expect(S.loadEntries(sb.store)).toHaveLength(1);
    expect(sb.store.startsWith(path.join(S.globalDir(sb.env), 'projects') + path.sep)).toBe(true);
    expect(S.loadEntries(S.globalStoreDir(sb.env))).toHaveLength(0); // never mixed with other projects
  });

  it('honours storage=project', () => {
    S.writeConfig({ ...S.DEFAULT_CONFIG, storage: 'project' }, sb.env);
    sb.write('a.ts', 'v1');
    claudeEdit('a.ts', 'v2');
    expect(S.loadEntries(sb.projectStore)).toHaveLength(1);
    expect(fs.existsSync(sb.store)).toBe(false);
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

  it('keeps project files in the project store when cwd is a symlink to the project', () => {
    if (process.platform === 'win32') return; // symlinks need admin rights on Windows; 8.3 names cover it there
    const link = path.join(sb.root, 'link-to-project');
    fs.symlinkSync(sb.project, link);
    const f = sb.write('a.ts', 'v1');
    handle(payload('PreToolUse', 'Edit', { file_path: path.join(link, 'a.ts') }, { cwd: link }), ctx());
    expect(S.loadEntries(sb.store).map((e) => e.path)).toEqual([f]);
    expect(S.loadEntries(S.globalStoreDir(sb.env))).toHaveLength(0);
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

  it('keeps steps for stepRetentionDays from the shared config', () => {
    const day = 24 * 3600_000;
    S.beginStep(sb.store, 's', 'p', 0);
    S.recordStepFile(sb.store, 's', path.join(sb.project, 'a.ts'), { existed: true, content: 'c' }, 0);
    housekeeping(sb.store, 10 * day, { ...S.DEFAULT_CONFIG, stepRetentionDays: 30 }, sb.env);
    expect(S.loadSteps(sb.store)).toHaveLength(1); // 10 days old, kept for 30
    housekeeping(sb.store, 10 * day, S.DEFAULT_CONFIG, sb.env);
    expect(S.loadSteps(sb.store)).toHaveLength(0); // default 7 days
  });

  it('reviews what the user keeps under ~/.claude (settings, CLAUDE.md, skills)', () => {
    for (const rel of ['settings.json', 'CLAUDE.md', 'skills/x/SKILL.md', 'projects.md']) {
      expect(S.isClaudeInternal(path.join(sb.claude, rel), sb.project, sb.env)).toBe(false);
    }
    for (const rel of ['projects/p/memory/n.md', 'plans/a.md', 'todos/t.json']) {
      expect(S.isClaudeInternal(path.join(sb.claude, rel), sb.project, sb.env)).toBe(true);
    }
    const file = path.join(sb.claude, 'CLAUDE.md');
    fs.writeFileSync(file, 'old');
    handle(payload('PreToolUse', 'Write', { file_path: file, content: 'new' }), ctx());
    expect(S.loadEntries(S.globalStoreDir(sb.env)).map((e) => e.content)).toEqual(['old']);
  });

  it('skips Claude Code working files outside the project (memory, plans, todos)', () => {
    const mem = path.join(sb.claude, 'projects', 'p', 'memory', 'note.md');
    fs.mkdirSync(path.dirname(mem), { recursive: true });
    fs.writeFileSync(mem, 'old');
    const p = payload('PreToolUse', 'Write', { file_path: mem, content: 'new' });
    expect(handle(p, ctx())).toBe('');
    fs.writeFileSync(mem, 'new');
    handle({ ...p, hook_event_name: 'PostToolUse' }, ctx());
    expect(S.loadEntries(S.globalStoreDir(sb.env))).toHaveLength(0);
    expect(S.isClaudeInternal(mem, sb.project, sb.env)).toBe(true);
    expect(S.isClaudeInternal(path.join(sb.project, 'a.ts'), sb.project, sb.env)).toBe(false);
  });

  it('expires unreviewed changes outside any project, never the project ones', () => {
    const day = 24 * 3600_000;
    const now = Date.now();
    const outside = path.join(sb.root, 'elsewhere.txt');
    const base = { version: 3 as const, existed: true, content: 'c', createdAt: now - 10 * day };
    S.createBaseline(S.globalStoreDir(sb.env), { ...base, path: outside });
    S.createBaseline(S.globalStoreDir(sb.env), { ...base, path: path.join(sb.root, 'fresh.txt'), createdAt: now });
    S.createBaseline(S.globalStoreDir(sb.env), {
      ...base,
      path: path.join(sb.claude, 'projects', 'p', 'memory', 'old.md'),
      createdAt: now,
    });
    S.createBaseline(sb.store, { ...base, path: path.join(sb.project, 'a.ts') });
    housekeeping(sb.store, now, S.DEFAULT_CONFIG, sb.env);
    expect(S.loadEntries(S.globalStoreDir(sb.env)).map((e) => path.basename(e.path))).toEqual(['fresh.txt']);
    expect(S.loadEntries(sb.store)).toHaveLength(1);
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

  it("keeps it for the main agent when a subagent's tool call comes first", () => {
    S.queueFeedback(sb.store, { sessionId: 'sess-1', path: '/x/a.ts', text: 'no', ts: 1 });
    sb.write('a.ts', 'v1');
    expect(claudeEdit('a.ts', 'v2', 'Edit', { agent_id: 'sub-1', agent_type: 'general-purpose' })).toBe('');
    expect(S.pendingFeedback(sb.store)).toHaveLength(1);
    expect(claudeEdit('a.ts', 'v3')).toContain('PostToolUse');
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

  it('skips files saved in the editor while the command ran (user edits, Undo/Keep)', () => {
    const abs = (rel: string) => S.realPath(path.join(sb.project, rel));
    bash(() => {
      sb.write('tracked.txt', 'undone in the editor\n');
      S.recordEditorWrite(abs('tracked.txt'), clock++, sb.env);
      sb.write('dirty.txt', 'saved by user\n');
      S.recordEditorWrite(abs('dirty.txt'), clock++, sb.env);
      sb.write('dirty.txt', 'saved by user\nthen changed by bash\n'); // content moved on: Claude's change again
      sb.write('new.txt', 'fresh\n');
    });
    const names = S.loadEntries(sb.store)
      .map((e) => path.basename(e.path))
      .sort();
    expect(names).toEqual(['dirty.txt', 'new.txt']);
  });

  it('ignores editor saves made before the command started', () => {
    S.recordEditorWrite(S.realPath(path.join(sb.project, 'tracked.txt')), 0, sb.env);
    bash(() => sb.write('tracked.txt', 'by bash\n'));
    expect(S.loadEntries(sb.store).map((e) => path.basename(e.path))).toEqual(['tracked.txt']);
  });

  it('can be switched off', () => {
    S.writeConfig({ ...S.DEFAULT_CONFIG, trackBash: false }, sb.env);
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

describe('hook: edit regions', () => {
  it('records where each Edit landed, so changes group per edit (like Cursor)', async () => {
    const { hunksFromRegions } = await import('../../src/core/regions');
    const rel = 'regions.ts';
    const base = ['function a() {', '  return 1;', '}', '', 'function old() {', '  return 0;', '}', '', 'const X = 1;'].join('\n');
    sb.write(rel, base);
    const abs = path.join(sb.project, rel);
    let cur = base;
    const step = (from: string, to: string) => {
      cur = cur.replace(from, to);
      claudeEdit(rel, cur);
    };
    step('  return 1;', '  return 2;');
    step('function old() {\n  return 0;\n}\n\n', '');
    step('const X = 1;', 'const X = 2;');
    const [e] = S.loadEntries(sb.store).filter((x) => x.path === S.realPath(abs));
    expect(e.regions).toBeDefined();
    const hunks = hunksFromRegions(e.content.split('\n'), cur.split('\n'), e.regions!)!;
    expect(hunks.map((h) => [h.aLines, h.bLines])).toEqual([
      [['  return 1;'], ['  return 2;']],
      // Edits that touch join one change, as in Cursor's view.
      [['function old() {', '  return 0;', '}', '', 'const X = 1;'], ['const X = 2;']],
    ]);
    expect(fs.existsSync(path.join(sb.store, 'before'))).toBe(true);
    expect(fs.readdirSync(path.join(sb.store, 'before'))).toEqual([]); // taken at PostToolUse
  });
});

describe('hook: Claude turn (UserPromptSubmit … Stop)', () => {
  it('marks the turn on the prompt and on tool calls, clears it on Stop', () => {
    const store = sb.store;
    handle({ session_id: 'sess-1', cwd: sb.project, hook_event_name: 'UserPromptSubmit', prompt: 'go' }, ctx());
    const t1 = S.lastTurnActivity(store);
    expect(t1).toBeGreaterThan(0);
    sb.write('a.ts', 'v1');
    claudeEdit('a.ts', 'v2');
    expect(S.lastTurnActivity(store)).toBeGreaterThan(t1);
    handle({ session_id: 'sess-1', cwd: sb.project, hook_event_name: 'Stop' }, ctx());
    expect(S.lastTurnActivity(store)).toBe(0);
  });
});
