// esbuild: three bundles. dist/extension.js (the extension), dist/hook.js (standalone
// Claude Code hook, copied into ~/.claude/hooks by the install command) and
// dist/uninstall.js (vscode:uninstall cleanup). No runtime dependencies.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const root = path.resolve(__dirname, '..');
const hookVersion = /HOOK_VERSION = '([\d.]+)'/.exec(fs.readFileSync(path.join(root, 'src/hook/hook.ts'), 'utf8'))[1];

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: !production,
  minify: false,
  logLevel: 'info',
  absWorkingDir: root,
};
const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  {
    ...common,
    sourcemap: false,
    entryPoints: ['src/hook/hook.ts'],
    outfile: 'dist/hook.js',
    banner: {
      js: `#!/usr/bin/env node\n// claude-inline-diff hook v${hookVersion} — https://github.com/Politanskyi/claude-code-inline-diff-extension (MIT).\n// Safe to delete: run "Claude Inline Diff: Uninstall Claude Code Hook" to remove it cleanly.`,
    },
  },
  { ...common, sourcemap: false, entryPoints: ['src/uninstall.ts'], outfile: 'dist/uninstall.js' },
].filter((b) => fs.existsSync(path.join(root, b.entryPoints[0])));

(async () => {
  if (watch) {
    for (const b of builds) await (await esbuild.context(b)).watch();
  } else {
    await Promise.all(builds.map((b) => esbuild.build(b)));
  }
})().catch(() => process.exit(1));
