// CLI 集成测试（M4）：对构建产物 skill/cli/kinemesh.cjs 走真实子进程。
// 产物没构建时整组跳过（npm run build 后可用）。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildBinaryFbx } from '../support/kinemesh-fixtures.js';

const cliFile = path.resolve(import.meta.dirname, '..', '..', 'plugins', 'kinemesh', 'skill', 'cli', 'kinemesh.cjs');

const workDir = await mkdtemp(path.join(tmpdir(), 'kinemesh-cli-'));
const fbxPath = path.join(workDir, 'cube-anim.fbx');
await writeFile(fbxPath, Buffer.from(buildBinaryFbx()));

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliFile, ...args], { encoding: 'utf8', timeout: 120_000 });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe.skipIf(!existsSync(cliFile))('kinemesh CLI（构建产物）', () => {
  it('info：stdout 输出 InfoReport JSON', () => {
    const { status, stdout, stderr } = runCli(['info', fbxPath]);
    expect(status).toBe(0);
    expect(stderr).toBe('');
    const parsed = JSON.parse(stdout) as { ok: boolean; format: string; clips: Array<{ name: string; duration: number }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.format).toBe('fbx-binary');
    expect(parsed.clips[0]?.name).toBe('Take 001');
  }, 30_000);

  it('--help：退出码 0，输出用法', () => {
    const { status, stdout } = runCli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('kinemesh info <file>');
    expect(stdout).toContain('render');
  });

  it('未知命令：stderr 三段式 + 非零退出码', () => {
    const { status, stderr } = runCli(['dance']);
    expect(status).not.toBe(0);
    const parsed = JSON.parse(stderr) as { ok: boolean; what: string; guidance: string; step: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.what).toContain('dance');
    expect(parsed.guidance).toContain('info');
    expect(parsed.step).toContain('命令');
  });

  it('info 缺文件参数：stderr 指引 + 非零退出码', () => {
    const { status, stderr } = runCli(['info']);
    expect(status).not.toBe(0);
    const parsed = JSON.parse(stderr) as { ok: boolean; guidance: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.guidance).toContain('file');
  });

  it('.max 给 3ds Max 指引', async () => {
    const maxPath = path.join(workDir, 'hero.max');
    await writeFile(maxPath, 'nonsense', 'utf8');
    const { status, stderr } = runCli(['info', maxPath]);
    expect(status).toBe(1);
    const parsed = JSON.parse(stderr) as { ok: boolean; guidance: string };
    expect(parsed.guidance).toContain('3ds Max');
  });

  it('render 缺 --frames：stderr 指引', () => {
    const { status, stderr } = runCli(['render', fbxPath]);
    expect(status).toBe(1);
    const parsed = JSON.parse(stderr) as { ok: boolean; guidance: string };
    expect(parsed.guidance).toContain('frames');
  });

  it('render：按视角出 PNG（chromium 可用时）', async () => {
    let chromiumReady = false;
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      await browser.close();
      chromiumReady = true;
    } catch {
      chromiumReady = false;
    }
    if (!chromiumReady) {
      expect(runCli(['render', fbxPath, '--frames', '0']).status).not.toBe(0);
      return;
    }
    const outDir = path.join(workDir, 'shots');
    const { status, stdout, stderr } = runCli([
      'render',
      fbxPath,
      '--clip',
      'Take 001',
      '--frames',
      '0,30',
      '--view-preset',
      'front',
      '--width',
      '320',
      '--height',
      '240',
      '--out-dir',
      outDir,
    ]);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { ok: boolean; images: string[] };
    expect(parsed.images).toHaveLength(2);
    for (const file of parsed.images) expect(existsSync(file)).toBe(true);
  }, 120_000);
});
