// Runs via package.json "vscode:uninstall" when the extension is fully
// uninstalled (VS Code/Cursor run it on the next start after removal).
// Removes our Claude Code hook entries and script. Review snapshots
// (~/.claude/inline-diff/, or .claude-review/ in projects) are left in place.
import { uninstall } from './core/setup';
try {
  for (const line of uninstall()) console.log('[claude-inline-diff] ' + line);
} catch (e: any) {
  console.error('[claude-inline-diff] uninstall cleanup failed: ' + (e && e.message));
}
