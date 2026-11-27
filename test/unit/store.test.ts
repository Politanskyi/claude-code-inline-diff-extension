import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as S from '../../src/core/store';
import { sandbox } from './helpers';

let sb = sandbox();
afterEach(() => {
  sb.cleanup();
  sb = sandbox();
});

describe('store', () => {
  it('gives each project its own home store, stable and readable', () => {
    const a = S.homeProjectStoreDir('/work/shop app', sb.env);
    expect(a).toBe(S.homeProjectStoreDir('/work/shop app', sb.env));
    expect(path.basename(a)).toMatch(/^shop_app-[0-9a-f]{12}$/);
    expect(S.homeProjectStoreDir('/other/shop app', sb.env)).not.toBe(a); // same name, different project
  });

  it('moves a store between project and home, merging, and only if it is ours', () => {
    const f = sb.write('a.ts', 'x');
    S.createBaseline(sb.projectStore, { version: 3, path: f, existed: true, content: 'old', createdAt: 1 });
    expect(S.moveStore(sb.projectStore, sb.store)).toBe(true);
    expect(fs.existsSync(sb.projectStore)).toBe(false);
    expect(S.loadEntries(sb.store)).toHaveLength(1);
    // Merge into an existing target keeps what is there.
    const g = sb.write('b.ts', 'y');
    S.createBaseline(sb.projectStore, { version: 3, path: g, existed: true, content: 'old', createdAt: 1 });
    expect(S.moveStore(sb.projectStore, sb.store)).toBe(true);
    expect(S.loadEntries(sb.store)).toHaveLength(2);
    // A folder of the same name that is not ours is never touched.
    sb.write('.claude-review/notes.txt', 'mine');
    expect(S.moveStore(sb.projectStore, sb.store)).toBe(false);
    expect(sb.read('.claude-review/notes.txt')).toBe('mine');
  });

  it('round-trips entries and removes them', () => {
    const f = sb.write('a.ts', 'x');
    S.createBaseline(sb.store, { version: 3, path: f, existed: true, content: '\uFEFFold', createdAt: 5 });
    const [e] = S.loadEntries(sb.store);
    expect(e.content).toBe('old'); // BOM stripped
    e.content = 'newer';
    S.writeEntry(e);
    expect(S.loadEntries(sb.store)[0].content).toBe('newer');
    S.removeEntry(e);
    expect(S.loadEntries(sb.store)).toHaveLength(0);
  });

  it('skips half-written / foreign json', () => {
    fs.mkdirSync(path.join(sb.store, 'baselines'), { recursive: true });
    fs.writeFileSync(path.join(sb.store, 'baselines', 'x.json'), '{"pa');
    fs.writeFileSync(path.join(sb.store, 'baselines', 'y.json'), '{"foo":1}');
    expect(S.loadEntries(sb.store)).toEqual([]);
  });

  it('expires stale activity', () => {
    S.startActivity(sb.store, { path: '/a', tool: 'Edit', ts: 0 });
    expect(S.loadActivity(sb.store, 1000, 5000)).toEqual([]);
    expect(fs.readdirSync(path.join(sb.store, 'activity'))).toEqual([]);
  });

  it('prunes old steps', () => {
    S.beginStep(sb.store, 's', 'p', 1000);
    S.recordStepFile(sb.store, 's', '/a', { existed: true, content: 'c' }, 1000);
    expect(S.loadSteps(sb.store)).toHaveLength(1);
    S.pruneSteps(sb.store, 10, 100000);
    expect(S.loadSteps(sb.store)).toHaveLength(0);
  });

  it('drops a chat folder that only has its state file left, once it is old', () => {
    S.shareStep(sb.store, 'idle', 't00000000001000', 'p');
    S.beginStep(sb.store, 'busy', 'p', Date.now());
    S.recordStepFile(sb.store, 'busy', '/a', { existed: true, content: 'c' });
    const dirs = () => fs.readdirSync(path.join(sb.store, 'steps')).sort();
    S.pruneSteps(sb.store, 3600_000);
    expect(dirs()).toEqual(['busy', 'idle']); // fresh: the prompt may still be running
    S.pruneSteps(sb.store, 3600_000, Date.now() + 2 * 3600_000);
    expect(dirs()).toEqual([]);
  });

  it('config defaults and validation', () => {
    expect(S.readConfig(sb.env)).toEqual(S.DEFAULT_CONFIG);
    fs.mkdirSync(S.globalDir(sb.env), { recursive: true });
    fs.writeFileSync(S.configPath(sb.env), JSON.stringify({ storage: 'home', dirName: '../evil', trackBash: false, stepRetentionDays: 0 }));
    expect(S.readConfig(sb.env)).toEqual({ storage: 'home', dirName: '.claude-review', trackBash: false, stepRetentionDays: 7 });
    fs.writeFileSync(S.configPath(sb.env), JSON.stringify({ stepRetentionDays: 30 }));
    expect(S.readConfig(sb.env).stepRetentionDays).toBe(30);
  });

  it('realPath resolves the existing part of a not-yet-created path', () => {
    if (process.platform === 'win32') return;
    const link = path.join(sb.root, 'lnk');
    fs.symlinkSync(sb.project, link);
    expect(S.realPath(path.join(link, 'new', 'deep', 'f.ts'))).toBe(path.join(sb.project, 'new', 'deep', 'f.ts'));
  });

  it('long paths get hashed file names', () => {
    expect(S.fileNameFor('/' + 'x'.repeat(400))).toMatch(/^h-[0-9a-f]{64}$/);
  });

  it('isInside', () => {
    expect(S.isInside('/a/b/c', '/a/b')).toBe(true);
    expect(S.isInside('/a/bc', '/a/b')).toBe(false);
    expect(S.isInside('/a/b', '/a/b')).toBe(false);
    if (S.CASE_INSENSITIVE) expect(S.isInside('/A/B/c', '/a/b')).toBe(true);
  });

  it('formats feedback for Claude', () => {
    const t = S.formatFeedback([{ id: '1', path: '/p', text: 'why', excerpt: 'code', ts: 0 }]);
    expect(t).toContain('REJECTED');
    expect(t).toContain('why');
    expect(t).toContain('code');
  });
});
