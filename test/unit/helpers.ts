import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { homeProjectStoreDir } from '../../src/core/store';

/** A throwaway project + Claude config dir; never touches the real ~/.claude. */
export function sandbox() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cid-'))); // .native expands Windows 8.3 names
  const project = path.join(root, 'project');
  const claude = path.join(root, 'claude');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(claude, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: claude, CLAUDE_INLINE_DIFF_HOME: path.join(claude, 'inline-diff') };
  delete env.CLAUDE_PROJECT_DIR;
  return {
    root,
    project,
    claude,
    env,
    /** The project's store (default `storage: home`: outside the project). */
    store: homeProjectStoreDir(project, env),
    /** The in-project store (`storage: project`). */
    projectStore: path.join(project, '.claude-review'),
    write(rel: string, text: string) {
      const p = path.join(project, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
      return p;
    },
    read(rel: string) {
      return fs.readFileSync(path.join(project, rel), 'utf8');
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
