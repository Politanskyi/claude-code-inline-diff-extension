import { describe, it, expect } from 'vitest';
import * as U from '../../src/core/update';

const asset = (over: object = {}) => ({
  name: U.ASSET_NAME,
  size: 74000,
  digest: 'sha256:' + 'ab'.repeat(32),
  browser_download_url: `https://github.com/${U.REPO}/releases/download/v0.3.1/claude-inline-diff.vsix`,
  ...over,
});
const latest = (over: object = {}) => ({ tag_name: 'v0.3.1', draft: false, prerelease: false, assets: [asset()], ...over });

describe('update: versions', () => {
  it('compares plain x.y.z versions', () => {
    expect(U.isNewer('0.3.1', '0.3.0')).toBe(true);
    expect(U.isNewer('v0.10.0', '0.9.9')).toBe(true);
    expect(U.isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(U.isNewer('0.3.0', '0.3.0')).toBe(false);
    expect(U.isNewer('0.2.9', '0.3.0')).toBe(false);
  });

  it('never offers what it cannot read', () => {
    expect(U.isNewer('0.4.0-beta.1', '0.3.0')).toBe(false);
    expect(U.isNewer('latest', '0.3.0')).toBe(false);
    expect(U.isNewer(undefined, '0.3.0')).toBe(false);
    expect(U.isNewer('0.4.0', '')).toBe(false);
  });
});

describe('update: the release to install', () => {
  it("reads version, file, checksum and page from GitHub's answer", () => {
    expect(U.releaseFrom(latest())).toEqual({
      version: '0.3.1',
      url: `https://github.com/${U.REPO}/releases/download/v0.3.1/claude-inline-diff.vsix`,
      sha256: 'ab'.repeat(32),
      page: `https://github.com/${U.REPO}/releases/tag/v0.3.1`,
    });
    expect(U.releaseFrom(latest({ assets: [asset({ digest: undefined })] }))?.sha256).toBeUndefined();
  });

  it('skips drafts, pre-releases, odd tags and releases without our .vsix', () => {
    expect(U.releaseFrom(latest({ draft: true }))).toBeNull();
    expect(U.releaseFrom(latest({ prerelease: true }))).toBeNull();
    expect(U.releaseFrom(latest({ tag_name: 'nightly' }))).toBeNull();
    expect(U.releaseFrom(latest({ assets: [] }))).toBeNull();
    expect(U.releaseFrom(latest({ assets: [asset({ name: 'other.vsix' })] }))).toBeNull();
    expect(U.releaseFrom(null)).toBeNull();
    expect(U.releaseFrom({ message: 'API rate limit exceeded' })).toBeNull();
  });

  it("takes the file only from this repository's releases, and not a huge one", () => {
    expect(U.releaseFrom(latest({ assets: [asset({ browser_download_url: 'https://example.com/claude-inline-diff.vsix' })] }))).toBeNull();
    expect(
      U.releaseFrom(
        latest({
          assets: [asset({ browser_download_url: 'https://github.com/someone/else/releases/download/v9/claude-inline-diff.vsix' })],
        })
      )
    ).toBeNull();
    expect(U.releaseFrom(latest({ assets: [asset({ size: U.MAX_VSIX_BYTES + 1 })] }))).toBeNull();
  });

  it('follows redirects only to GitHub hosts', () => {
    expect(U.allowedDownloadHost('github.com')).toBe(true);
    expect(U.allowedDownloadHost('release-assets.githubusercontent.com')).toBe(true);
    expect(U.allowedDownloadHost('objects.githubusercontent.com')).toBe(true);
    expect(U.allowedDownloadHost('githubusercontent.com.evil.example')).toBe(false);
    expect(U.allowedDownloadHost('example.com')).toBe(false);
  });
});

describe('update: how often', () => {
  it('checks when never checked, after the interval, or when the clock went back', () => {
    const now = 1_800_000_000_000;
    expect(U.checkDue(undefined, now)).toBe(true);
    expect(U.checkDue(now - U.CHECK_INTERVAL_MS, now)).toBe(true);
    expect(U.checkDue(now - 60_000, now)).toBe(false);
    expect(U.checkDue(now + 60_000, now)).toBe(true);
  });
});
