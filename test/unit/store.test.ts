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

  it('config defaults and validation', () => {
    expect(S.readConfig(sb.env)).toEqual(S.DEFAULT_CONFIG);
    fs.mkdirSync(S.globalDir(sb.env), { recursive: true });
    fs.writeFileSync(S.configPath(sb.env), JSON.stringify({ storage: 'home', dirName: '../evil', trackBash: false }));
    expect(S.readConfig(sb.env)).toEqual({ storage: 'home', dirName: '.claude-review', trackBash: false });
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
