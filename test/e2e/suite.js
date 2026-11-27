// E2E suite executed inside VS Code. Simulates Claude Code by running the real
// bundled hook (dist/hook.js) with Claude-shaped payloads, then writing files
// to disk the way Claude's Edit/Write tools do.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync, execFileSync } = require('child_process');

const WS = process.env.CID_WORKSPACE;
const HOOK = process.env.CID_HOOK;
const SHOTS = process.env.CID_SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(50);
  }
  throw new Error('timeout: ' + what);
}

function hook(event, tool, input, extra = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: 'e2e-session', transcript_path: '/x', cwd: WS, hook_event_name: event, tool_name: tool, tool_input: input, tool_use_id: 'toolu_' + Math.random(), permission_mode: 'acceptEdits', ...extra }),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, 'hook exit code: ' + r.stderr);
  return r.stdout;
}
/** Claude edits a file: Pre hook → disk write → Post hook. */
function claudeWrite(rel, text, tool = 'Edit') {
  const abs = path.join(WS, rel);
  hook('PreToolUse', tool, { file_path: abs });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  hook('PostToolUse', tool, { file_path: abs });
  return abs;
}
function diag(obj) {
  console.log('    diag: ' + JSON.stringify(obj));
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.appendFileSync(path.join(SHOTS, 'diag.jsonl'), JSON.stringify(obj) + '\n');
  }
}
function shot(name) {
  if (!SHOTS) return;
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.appendFileSync(path.join(SHOTS, 'windows.txt'), name + '\n' + execFileSync('xwininfo', ['-root', '-tree'], { encoding: 'utf8', timeout: 5000 }).split('\n').filter((l) => /"/.test(l) && !/has no name/.test(l)).join('\n') + '\n');
  } catch {}
  fs.mkdirSync(SHOTS, { recursive: true });
  try {
    // Capture the workbench window itself (Cursor opens a separate login window that can cover it).
    let win = 'root';
    try {
      const ids = execFileSync('xdotool', ['search', '--name', 'workspace'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').filter(Boolean);
      if (ids.length) {
        win = ids[ids.length - 1];
        execFileSync('xdotool', ['windowraise', win], { timeout: 5000 });
      }
    } catch {}
    execFileSync('import', ['-window', win, path.join(SHOTS, name + '.png')], { timeout: 10000 });
  } catch (e) {
    console.log('screenshot failed: ' + e.message);
  }
}

const BEFORE = `import { readFile } from 'fs/promises';

export async function loadConfig(path: string) {
  const raw = await readFile(path, 'utf8');
  const config = JSON.parse(raw);
  if (!config.name) {
    throw new Error('missing name');
  }
  return config;
}

export function greet(name: string) {
  console.log('Hello ' + name);
}
`;
const AFTER = `import { readFile } from 'fs/promises';
import { z } from 'zod';

const Config = z.object({ name: z.string(), port: z.number().default(8080) });

export async function loadConfig(path: string) {
  const raw = await readFile(path, 'utf8');
  return Config.parse(JSON.parse(raw));
}

export function greet(name: string) {
  console.log(\`Hello, \${name}!\`);
}
`;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let api;

test('activates and exposes the API', async () => {
  const ext = vscode.extensions.getExtension('inlinediff.claude-inline-diff');
  assert.ok(ext, 'extension present');
  api = await ext.activate();
  assert.ok(api.review);
  console.log('    editorInsets available: ' + api.insetsAvailable());
});

test('editors already open at activation are rendered (startup restore)', async () => {
  // Cursor/VS Code restore editors before an onStartupFinished extension activates; no visible-editors event follows.
  const d = api.renderer.debugState();
  assert.ok(Array.isArray(d.visibleTextEditors));
});

test('install hook command writes settings.json in the temp CLAUDE_CONFIG_DIR', async () => {
  await vscode.commands.executeCommand('claudeInlineDiff.installHooks');
  const s = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  assert.ok(JSON.stringify(s.hooks.PreToolUse).includes('claude-inline-diff-hook.js'));
  assert.ok(s.hooks.UserPromptSubmit);
});

test('a Claude edit shows up inline (hunks, insets, reveal on edit)', async () => {
  const abs = path.join(WS, 'src', 'config.ts');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, BEFORE);
  hook('UserPromptSubmit', undefined, undefined, { prompt: 'Use zod to validate the config' });
  claudeWrite('src/config.ts', AFTER);
  await until(() => api.review.pendingKeys().length === 1, 'review entry');
  const key = api.review.pendingKeys()[0];
  await until(() => vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.fsPath === abs, 'revealOnEdit opened the file');
  await until(() => vscode.window.activeTextEditor.document.getText() === AFTER, 'editor shows Claude text');
  const hunks = api.review.hunks(key);
  assert.strictEqual(hunks.length, 4, 'four hunks, got ' + JSON.stringify(hunks));
  if (api.insetsAvailable()) await until(() => api.renderer.insets.count() >= 2, 'inset blocks drawn');
  diag({ editor: vscode.env.appName, version: vscode.version, insetsAvailable: api.insetsAvailable(), insetCount: api.renderer.insets.count(), insetFailed: api.renderer.insets.failed });
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => {});
  await sleep(1500);
  shot('01-inline-diff');
});

test('Accept (cursor in hunk) updates baseline only, auto-advances', async () => {
  const ed = vscode.window.activeTextEditor;
  const key = api.review.pendingKeys()[0];
  const first = api.review.hunks(key)[0];
  ed.selection = new vscode.Selection(first.bStart, 0, first.bStart, 0);
  await vscode.commands.executeCommand('claudeInlineDiff.acceptHunk');
  assert.strictEqual(api.review.hunks(key).length, 3);
  assert.strictEqual(ed.document.getText(), AFTER, 'file untouched by accept');
  const next = api.review.hunks(key)[0];
  assert.strictEqual(vscode.window.activeTextEditor.selection.active.line, next.bStart, 'cursor moved to next change');
  await sleep(800);
  shot('04-after-accept');
});

test('Undo restores the accepted change', async () => {
  const key = api.review.pendingKeys()[0];
  await vscode.commands.executeCommand('claudeInlineDiff.undo');
  assert.strictEqual(api.review.hunks(key).length, 4);
});

test('Reject restores old lines in the file and saves it', async () => {
  const ed = vscode.window.activeTextEditor;
  const key = api.review.pendingKeys()[0];
  const last = api.review.hunks(key)[3]; // the greet() change
  ed.selection = new vscode.Selection(last.bStart, 0, last.bStart, 0);
  await vscode.commands.executeCommand('claudeInlineDiff.rejectHunk');
  assert.ok(ed.document.getText().includes("console.log('Hello ' + name);"));
  assert.ok(!ed.document.isDirty, 'saved after reject');
  assert.ok(fs.readFileSync(ed.document.uri.fsPath, 'utf8').includes("'Hello ' + name"));
  assert.ok(api.review.hunks(key).every((h) => !h.bLines.join('\n').includes('Hello, ')), 'greet change gone');
  await sleep(800);
  shot('05-after-reject');
  await vscode.commands.executeCommand('claudeInlineDiff.undo');
  assert.ok(api.review.hunks(key).some((h) => h.bLines.join('\n').includes('Hello, ')), 'greet change back');
  assert.ok(ed.document.getText().includes('Hello, ${name}!'));
});

test('user edits outside Claude hunks are absorbed, not shown as Claude changes', async () => {
  const ed = vscode.window.activeTextEditor;
  const key = api.review.pendingKeys()[0];
  const n0 = api.review.hunks(key).length;
  const lineOfGreet = ed.document.getText().split('\n').findIndex((l) => l.startsWith('export function greet'));
  const we = new vscode.WorkspaceEdit();
  we.insert(ed.document.uri, new vscode.Position(lineOfGreet, 0), '// my own comment\n');
  assert.ok(await vscode.workspace.applyEdit(we), 'edit applied');
  assert.ok(ed.document.getText().includes('// my own comment'));
  await sleep(300);
  assert.strictEqual(api.review.hunks(key).length, n0, 'hunk count unchanged: ' + JSON.stringify(api.review.hunks(key)));
  assert.ok(!api.review.hunks(key).some((h) => h.bLines.includes('// my own comment')), 'own edit not shown as Claude change');
  assert.ok(api.review.entries.get(key).content.includes('// my own comment'), 'absorbed into baseline');
  await ed.document.save();
});

test('a new file created by Claude: Reject file moves it away', async () => {
  const abs = claudeWrite('src/new-util.ts', 'export const answer = 42;\n', 'Write');
  await until(() => api.review.pendingKeys().length === 2, 'second file pending');
  const key = api.review.pendingKeys().find((k) => k.endsWith('new-util.ts'));
  await vscode.commands.executeCommand('claudeInlineDiff.rejectFile', vscode.Uri.file(abs));
  await until(() => !fs.existsSync(abs), 'file removed');
  assert.ok(!api.review.entries.has(key));
  await vscode.commands.executeCommand('claudeInlineDiff.undo');
  assert.ok(fs.existsSync(abs), 'undo brings it back');
  await vscode.commands.executeCommand('claudeInlineDiff.acceptFile', vscode.Uri.file(abs));
});

test('a Bash edit (sed) is detected via git', async () => {
  const git = (...a) => execFileSync('git', a, { cwd: WS, stdio: 'pipe' });
  fs.rmSync(path.join(WS, '.git'), { recursive: true, force: true });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
  fs.writeFileSync(path.join(WS, 'notes.md'), '# Notes\nold line\n');
  git('add', 'notes.md');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'notes');
  const id = { tool_use_id: 'toolu_bash_1' };
  hook('PreToolUse', 'Bash', { command: "sed -i 's/old/new/' notes.md" }, id);
  fs.writeFileSync(path.join(WS, 'notes.md'), '# Notes\nnew line\n');
  hook('PostToolUse', 'Bash', { command: "sed -i 's/old/new/' notes.md" }, id);
  await until(() => api.review.pendingKeys().some((k) => k.endsWith('notes.md')), 'bash edit detected');
  await vscode.commands.executeCommand('claudeInlineDiff.acceptFile', vscode.Uri.file(path.join(WS, 'notes.md')));
});

test('reject with feedback is delivered to Claude on the next prompt', async () => {
  const key = api.review.pendingKeys().find((k) => k.endsWith('config.ts'));
  api.review.queueFeedback(key, 'keep the default port configurable via env', '- a\n+ b');
  const out = hook('UserPromptSubmit', undefined, undefined, { prompt: 'continue' });
  const j = JSON.parse(out);
  assert.ok(j.hookSpecificOutput.additionalContext.includes('default port'));
});

test('Review All opens a multi-file diff', async () => {
  await sleep(1000); // let earlier reveal-on-edit tabs settle
  await vscode.commands.executeCommand('claudeInlineDiff.reviewAll');
  await until(() => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => /Claude changes/.test(t.label))), 'multi-diff tab opened');
  await sleep(600);
  shot('06-review-all');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
});

test('a second Claude edit to an open file shows up as a new change (baseline kept)', async () => {
  const key = api.review.pendingKeys().find((k) => k.endsWith('config.ts'));
  const abs = api.review.entries.get(key).path;
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(abs));
  ed.selection = new vscode.Selection(0, 0, 0, 0);
  const before = api.review.hunks(key).length;
  const text = fs.readFileSync(abs, 'utf8') + '\nexport const VERSION = 2;\n';
  claudeWrite('src/config.ts', text);
  try {
    await until(() => api.review.hunks(key).some((h) => h.bLines.join('\n').includes('VERSION')), 'new hunk');
  } catch (e) {
    const d = vscode.workspace.textDocuments.find((x) => x.uri.fsPath === abs);
    throw new Error('new hunk missing: ' + JSON.stringify({ before, now: api.review.hunks(key).length, dirty: d && d.isDirty, docHasVersion: d && d.getText().includes('VERSION'), diskHasVersion: fs.readFileSync(abs, 'utf8').includes('VERSION') }));
  }
  assert.strictEqual(api.review.entries.get(key).content.includes('VERSION'), false, 'baseline unchanged by a later Claude edit');
});

test('Cursor agent payloads are ignored', async () => {
  const before = api.review.entries.size;
  const abs = path.join(WS, 'cursor-agent.ts');
  fs.writeFileSync(abs, 'a');
  hook('PreToolUse', 'Edit', { file_path: abs }, { cursor_version: '2.0.0' });
  fs.writeFileSync(abs, 'b');
  await sleep(1200);
  assert.strictEqual(api.review.entries.size, before);
});

test('decoration fallback renders without insets', async () => {
  await vscode.workspace.getConfiguration('claudeInlineDiff').update('deletedLines.renderer', 'decoration', vscode.ConfigurationTarget.Global);
  await sleep(500);
  assert.strictEqual(api.insetsAvailable(), false);
  assert.strictEqual(api.renderer.insets.count(), 0);
  const key = api.review.pendingKeys().find((k) => k.endsWith('config.ts'));
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(api.review.entries.get(key).path));
  await vscode.commands.executeCommand('workbench.action.closeOtherEditors');
  await vscode.commands.executeCommand('notifications.clearAll');
  const h = api.review.hunks(key).find((x) => x.aLines.length);
  ed.selection = new vscode.Selection(h.bStart, 0, h.bStart, 0);
  await sleep(500);
  shot('02-decoration-fallback');
  await vscode.commands.executeCommand('editor.action.showHover');
  await sleep(1200);
  shot('03-fallback-hover');
  await vscode.workspace.getConfiguration('claudeInlineDiff').update('deletedLines.renderer', undefined, vscode.ConfigurationTarget.Global);
});

test('Accept all / step revert / steps view data', async () => {
  assert.ok(api.review.steps.length >= 1, 'steps recorded');
  await vscode.commands.executeCommand('claudeInlineDiff.acceptAll');
  assert.strictEqual(api.review.pendingKeys().length, 0);
  const step = api.review.steps.find((s) => s.prompt.includes('zod'));
  assert.ok(step, 'zod step present');
  const n = await api.review.revertStep(step);
  assert.ok(n >= 1);
  const text = fs.readFileSync(path.join(WS, 'src', 'config.ts'), 'utf8');
  assert.ok(text.includes("throw new Error('missing name')"), 'file back to before the step');
  await api.review.undo();
  assert.ok(fs.readFileSync(path.join(WS, 'src', 'config.ts'), 'utf8').includes('zod'));
});

test('uninstall hook command removes our entries', async () => {
  // modal confirmation cannot be clicked in tests: use the core function the command calls
  const setupPath = path.join(__dirname, '..', '..', 'dist', 'uninstall.js');
  const r = spawnSync(process.execPath, [setupPath], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  const s = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  assert.ok(!s.hooks, 'hooks removed');
  assert.ok(!fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'hooks', 'claude-inline-diff-hook.js')));
});

exports.run = async function () {
  let failed = 0;
  for (const t of tests) {
    try {
      console.log('  … ' + t.name);
      await Promise.race([t.fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('test timed out (30s)')), 30000))]);
      console.log('  ✓ ' + t.name);
    } catch (e) {
      failed++;
      console.log('  ✗ ' + t.name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e));
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} e2e tests passed`);
  if (failed) throw new Error(failed + ' e2e test(s) failed');
};
