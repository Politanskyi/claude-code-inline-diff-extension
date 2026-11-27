// Self-update from this project's GitHub releases. The extension is installed from a .vsix (it uses proposed
// APIs, so it cannot be published to a marketplace), which the editor never updates on its own.
// This is the extension's only network use: one request to GitHub's releases API every few hours and, when a
// newer release exists, the download of its .vsix. Nothing about you or your code is sent. `update: off` stops it.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as crypto from 'crypto';
import * as U from './core/update';

const STAMP = 'updateCheckedAt';
const INSTALLED = 'updateInstalled';
const NOTIFIED = 'updateNotified';

function get(url: string, accept: string, redirects = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !(u.host === 'api.github.com' || U.allowedDownloadHost(u.host)))
      return reject(new Error('unexpected address ' + u.host));
    const req = https.get(u, { headers: { 'User-Agent': 'claude-inline-diff', Accept: accept }, timeout: 20000 }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        return get(new URL(res.headers.location, u).toString(), accept, redirects - 1).then(resolve, reject);
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + code));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > U.MAX_VSIX_BYTES) req.destroy(new Error('file too large'));
        else chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

export class Updater implements vscode.Disposable {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel
  ) {}

  private mode(): U.UpdateMode {
    const m = vscode.workspace.getConfiguration('claudeInlineDiff').get<string>('update', 'install');
    return m === 'notify' || m === 'off' ? m : 'install';
  }

  private current(): string {
    return String(this.ctx.extension.packageJSON?.version ?? '');
  }

  /** Checks a little after startup and then every hour whether a check is due (the stamp is shared by all windows). */
  start(): void {
    const tick = () => void this.check(false);
    const first = setTimeout(tick, 20_000);
    this.timer = setInterval(tick, 3600_000);
    this.ctx.subscriptions.push({ dispose: () => clearTimeout(first) });
  }

  async check(manual: boolean): Promise<void> {
    if (this.busy) return;
    if (!manual) {
      if (this.mode() === 'off' || !U.checkDue(this.ctx.globalState.get<number>(STAMP), Date.now())) return;
    }
    this.busy = true;
    try {
      // Stamped before the request: other windows see it and do not ask too.
      await this.ctx.globalState.update(STAMP, Date.now());
      const rel = U.releaseFrom(JSON.parse((await get(U.LATEST_URL, 'application/vnd.github+json')).toString('utf8')));
      const installed = this.ctx.globalState.get<string>(INSTALLED);
      const have = U.isNewer(installed, this.current()) ? installed! : this.current();
      if (!rel || !U.isNewer(rel.version, have)) {
        this.log.info(`update check: ${rel ? 'latest release is ' + rel.version : 'no usable release'}, have ${have}`);
        if (manual) {
          if (have !== this.current()) void this.offerReload(have);
          else void vscode.window.showInformationMessage(`Claude Inline Diff ${have} is the latest version.`);
        }
        return;
      }
      this.log.info(`update check: ${rel.version} is available, have ${have}`);
      if (manual || this.mode() === 'install') await this.install(rel);
      else if (this.ctx.globalState.get<string>(NOTIFIED) !== rel.version) {
        await this.ctx.globalState.update(NOTIFIED, rel.version);
        void vscode.window
          .showInformationMessage(`Claude Inline Diff ${rel.version} is available (you have ${have}).`, 'Update', 'Release Notes')
          .then((pick) => {
            if (pick === 'Update') void this.install(rel).catch((e) => this.failed(e, true));
            else if (pick === 'Release Notes') void vscode.env.openExternal(vscode.Uri.parse(rel.page));
          });
      }
    } catch (e) {
      this.failed(e, manual);
    } finally {
      this.busy = false;
    }
  }

  private failed(e: unknown, tell: boolean): void {
    const msg = e instanceof Error ? e.message : String(e);
    this.log.warn('update: ' + msg);
    if (tell) void vscode.window.showWarningMessage('Claude Inline Diff: update failed: ' + msg);
  }

  private async install(rel: U.Release): Promise<void> {
    const data = await get(rel.url, 'application/octet-stream');
    if (rel.sha256) {
      const got = crypto.createHash('sha256').update(data).digest('hex');
      if (got !== rel.sha256) throw new Error('downloaded file does not match the release (sha256)');
    }
    if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) throw new Error('downloaded file is not a .vsix');
    const dir = path.join(this.ctx.globalStorageUri.fsPath, 'update');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `claude-inline-diff-${rel.version}.vsix`);
    fs.writeFileSync(file, data);
    try {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    await this.ctx.globalState.update(INSTALLED, rel.version);
    this.log.info(`update: installed ${rel.version} (${data.length} bytes${rel.sha256 ? ', sha256 checked' : ''})`);
    void this.offerReload(rel.version, rel.page);
  }

  private async offerReload(version: string, page?: string): Promise<void> {
    const pick = await vscode.window.showInformationMessage(
      `Claude Inline Diff ${version} is installed. Reload the window to start using it.`,
      'Reload Window',
      ...(page ? ['Release Notes'] : [])
    );
    if (pick === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
    else if (pick === 'Release Notes' && page) void vscode.env.openExternal(vscode.Uri.parse(page));
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
