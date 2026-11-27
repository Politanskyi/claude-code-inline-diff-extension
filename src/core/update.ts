// Update check: which GitHub release is newer than the running extension, and which file to download.
// Pure (no network here); the request itself is made in src/update.ts.

export const REPO = 'Politanskyi/claude-code-inline-diff-extension';
export const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
export const ASSET_NAME = 'claude-inline-diff.vsix';
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
export const MAX_VSIX_BYTES = 20 * 1024 * 1024;
export const CHECK_INTERVAL_MS = 6 * 3600_000;

export type UpdateMode = 'install' | 'notify' | 'off';

export interface Release {
  version: string;
  /** Where the .vsix is (always under this repository's release downloads). */
  url: string;
  /** Hex sha256 of the .vsix when GitHub reports it. */
  sha256?: string;
  /** The release page, for "Release Notes". */
  page: string;
}

/** [major, minor, patch] of `1.2.3` / `v1.2.3`, or null for anything else (pre-releases are not offered). */
export function parseVersion(v: unknown): [number, number, number] | null {
  const m = typeof v === 'string' ? /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `a` is a later version than `b`; false when either is not a plain x.y.z. */
export function isNewer(a: unknown, b: unknown): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * The release described by GitHub's "latest release" answer, or null when it is a draft / pre-release, has no
 * .vsix of ours, or the file is not served from this repository's releases.
 */
export function releaseFrom(json: any): Release | null {
  if (!json || typeof json !== 'object' || json.draft || json.prerelease) return null;
  const v = parseVersion(json.tag_name);
  if (!v) return null;
  const asset = (Array.isArray(json.assets) ? json.assets : []).find((a: any) => a && a.name === ASSET_NAME);
  const url = asset?.browser_download_url;
  if (typeof url !== 'string' || !url.startsWith(DOWNLOAD_PREFIX)) return null;
  if (typeof asset.size === 'number' && asset.size > MAX_VSIX_BYTES) return null;
  const digest = typeof asset.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest) : null;
  const version = v.join('.');
  return {
    version,
    url,
    sha256: digest ? digest[1].toLowerCase() : undefined,
    page: `https://github.com/${REPO}/releases/tag/v${version}`,
  };
}

/** Hosts a download may be redirected to (GitHub serves release files from its own storage hosts). */
export function allowedDownloadHost(host: string): boolean {
  return host === 'github.com' || host.endsWith('.githubusercontent.com');
}

/** Whether an automatic check is due: none in the last CHECK_INTERVAL_MS (by any window; the stamp is shared). */
export function checkDue(lastCheck: number | undefined, now: number): boolean {
  return !lastCheck || now - lastCheck >= CHECK_INTERVAL_MS || lastCheck > now;
}
