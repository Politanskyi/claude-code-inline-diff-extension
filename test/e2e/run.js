// Runs test/e2e/suite.js inside a real VS Code with this extension loaded
// (extension development mode, which also allows the editorInsets proposed API).
// Everything lives in a temp dir: the real ~/.claude is never touched.
// Linux: xvfb-run -a -s "-screen 0 1600x1000x24" node test/e2e/run.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cid-e2e-')));
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  const userData = path.join(tmp, 'user-data');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({
      'workbench.startupEditor': 'none',
      'workbench.colorTheme': process.env.CID_THEME || 'Default Dark Modern',
      'editor.fontSize': 15,
      'window.zoomLevel': 0,
      'security.workspace.trust.enabled': false,
      'git.enabled': false,
      'editor.minimap.enabled': true,
      'claudeInlineDiff.confirmDeleteCreatedFile': false,
      'claudeInlineDiff.confirmRejectAll': false,
      'claudeInlineDiff.revealOnEdit': true,
    })
  );
  for (const name of Object.keys(process.env)) if (name.startsWith('ELECTRON_') || name.startsWith('VSCODE_')) delete process.env[name];
  const shots = process.env.CID_SHOTS || '';
  try {
    await runTests({
      // CID_EDITOR=/path/to/cursor runs the suite in Cursor instead of a downloaded VS Code.
      ...(process.env.CID_EDITOR ? { vscodeExecutablePath: process.env.CID_EDITOR } : { version: process.env.CID_VSCODE_VERSION || 'stable' }),
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [workspace, '--disable-extensions', '--user-data-dir', userData, '--extensions-dir', path.join(tmp, 'ext'), '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--disable-workspace-trust', ...(process.env.CID_EDITOR ? ['--skip-onboarding'] : []), ...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []), ...(process.env.CID_NO_PROPOSED ? [] : ['--enable-proposed-api', 'inlinediff.claude-inline-diff'])],
      extensionTestsEnv: {
        CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
        CLAUDE_INLINE_DIFF_HOME: path.join(tmp, 'claude', 'inline-diff'),
        CLAUDE_INLINE_DIFF_TEST: '1',
        CLAUDE_INLINE_DIFF_TRACE: '1',
        CID_WORKSPACE: workspace,
        CID_HOOK: path.join(root, 'dist', 'hook.js'),
        CID_SHOTS: shots,
      },
    });
  } catch (e) {
    console.error('E2E failed:', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    if (!process.exitCode) fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main();
