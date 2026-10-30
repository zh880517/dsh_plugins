// T5 备份：路径格式、目录自建、HANDOFF_HOME 重定向、写失败抛错。
// 全部写操作都落在 os.tmpdir() 里的临时目录，不碰真实 home。
// 设计文档：docs/plugins/handoff/design.md §4.3 / §6
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handoffBackupFileName, handoffHome, writeBackup } from '../../plugins/handoff/src/backup.js';

/** 本地时间 2026-10-30 14:30:05（用本地构造，断言与时区无关）。 */
const NOW = new Date(2026, 9, 30, 14, 30, 5);
const STAMP = '20261030-143005';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-backup-'));
});

afterEach(() => {
  delete process.env.HANDOFF_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('handoffBackupFileName / handoffHome', () => {
  it('文件名是 <sessionId>-<yyyyMMdd-HHmmss>.md', () => {
    expect(handoffBackupFileName('session-abc', NOW)).toBe(`session-abc-${STAMP}.md`);
  });

  it('默认目录是 ~/.dsh/handoff', () => {
    delete process.env.HANDOFF_HOME;
    expect(handoffHome()).toBe(path.join(os.homedir(), '.dsh', 'handoff'));
  });

  it('HANDOFF_HOME 可重定向', () => {
    process.env.HANDOFF_HOME = path.join(tmp, 'custom');
    expect(handoffHome()).toBe(path.join(tmp, 'custom'));
  });

  it('会话 id 里的路径分隔符不会逃出备份目录', () => {
    const name = handoffBackupFileName('../../etc/passwd', NOW);
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    expect(name.endsWith(`-${STAMP}.md`)).toBe(true);
  });
});

describe('writeBackup', () => {
  it('按 HANDOFF_HOME 落盘，目录不存在时自建，返回绝对路径', async () => {
    const home = path.join(tmp, 'nested', 'handoff');
    process.env.HANDOFF_HOME = home;
    const file = await writeBackup({ sessionId: 'session-abc', doc: '# 交接：备份\n\n正文', now: NOW });

    expect(file).toBe(path.join(home, `session-abc-${STAMP}.md`));
    expect(path.isAbsolute(file)).toBe(true);
    expect(fs.existsSync(path.dirname(file))).toBe(true);
    // 正文原样落盘，只补一个换行
    expect(fs.readFileSync(file, 'utf8')).toBe('# 交接：备份\n\n正文\n');
  });

  it('正文已以换行结尾时不重复补', async () => {
    process.env.HANDOFF_HOME = tmp;
    const file = await writeBackup({ sessionId: 'session-abc', doc: '已带换行\n', now: NOW });
    expect(fs.readFileSync(file, 'utf8')).toBe('已带换行\n');
  });

  it('显式 home 参数优先于 HANDOFF_HOME', async () => {
    process.env.HANDOFF_HOME = path.join(tmp, 'env-home');
    const explicit = path.join(tmp, 'explicit-home');
    const file = await writeBackup({ sessionId: 's1', doc: 'x', now: NOW, home: explicit });

    expect(file).toBe(path.join(explicit, `s1-${STAMP}.md`));
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'env-home'))).toBe(false);
  });

  it('写失败时抛错（调用方 fail closed）', async () => {
    const blocker = path.join(tmp, 'not-a-directory');
    fs.writeFileSync(blocker, 'x', 'utf8');
    process.env.HANDOFF_HOME = blocker;

    await expect(writeBackup({ sessionId: 's1', doc: 'x', now: NOW })).rejects.toThrow(/handoff backup failed/);
  });

  it('目标路径被目录占用时也抛错', async () => {
    process.env.HANDOFF_HOME = tmp;
    // 预先在目标文件名位置建一个目录，writeFile 会失败（EISDIR / EPERM）
    fs.mkdirSync(path.join(tmp, `s1-${STAMP}.md`));
    await expect(writeBackup({ sessionId: 's1', doc: 'x', now: NOW })).rejects.toThrow(/handoff backup failed/);
  });
});
