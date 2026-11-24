// CLI 集成测试（M4）：对构建产物 skill/cli/kinemesh.cjs 走真实子进程。
// 产物没构建时整组跳过（npm run build 后可用）。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildAnimatedCubeGltf, buildBinaryFbx, buildCubeAnimationOnlyGltf, buildSkinnedMeshOnlyGltf, buildStaticCubeGltf, encodeGlb } from '../support/kinemesh-fixtures.js';

const cliFile = path.resolve(import.meta.dirname, '..', '..', 'plugins', 'kinemesh', 'skill', 'cli', 'kinemesh.cjs');

const workDir = await mkdtemp(path.join(tmpdir(), 'kinemesh-cli-'));
const fbxPath = path.join(workDir, 'cube-anim.fbx');
await writeFile(fbxPath, Buffer.from(buildBinaryFbx()));
const glbPath = path.join(workDir, 'cube-anim.glb');
await writeFile(glbPath, Buffer.from(encodeGlb(buildAnimatedCubeGltf())));
const staticGlbPath = path.join(workDir, 'cube-static.glb');
await writeFile(staticGlbPath, Buffer.from(encodeGlb(buildStaticCubeGltf())));
const meshOnlyGlbPath = path.join(workDir, 'mesh-only.glb');
await writeFile(meshOnlyGlbPath, Buffer.from(encodeGlb(buildSkinnedMeshOnlyGltf())));
const animOnlyGlbPath = path.join(workDir, 'anim-only.glb');
await writeFile(animOnlyGlbPath, Buffer.from(encodeGlb(buildCubeAnimationOnlyGltf())));

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
    expect(stdout).toContain('analyze');
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

  it('未知选项：stderr 三段式（0.5.1——曾静默忽略导致输出落错目录）', () => {
    const { status, stderr } = runCli(['skeleton', glbPath, '--outt', workDir]);
    expect(status).toBe(1);
    const parsed = JSON.parse(stderr) as { ok: boolean; what: string; guidance: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.what).toContain('--outt');
    expect(parsed.guidance).toContain('--help');
  });

  it('--out / --out-dir 互为别名：skeleton --out-dir 等效 --out（不再被吞）', () => {
    const outDir = path.join(workDir, 'alias-out');
    const { status, stdout } = runCli(['skeleton', glbPath, '--shots', 'none', '--out-dir', outDir]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { ok: boolean; dir: string };
    expect(parsed.ok).toBe(true);
    expect(path.resolve(parsed.dir)).toBe(path.resolve(outDir));
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

  it('analyze：--out 落盘 + stdout 返回 summaryDigest（与工具同构）', () => {
    const outDir = path.join(workDir, 'analysis-cli');
    const { status, stdout, stderr } = runCli(['analyze', fbxPath, '--out', outDir]);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      dir: string;
      files: Array<{ name: string; bytes: number; what: string }>;
      summaryDigest: { segments: unknown[]; facts: string[]; keyframeRender: unknown };
      hint?: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dir).toBe(outDir);
    expect(parsed.files[0]?.name).toBe('motion-summary.json');
    expect(parsed.summaryDigest.facts.length).toBeGreaterThan(0);
    expect(parsed.hint).toBeUndefined();
    expect(existsSync(path.join(outDir, 'motion-summary.json'))).toBe(true);
  }, 60_000);

  it('analyze：缺省 out 落临时目录并带 hint；--curves-for 加曲线文件', () => {
    const { status, stdout } = runCli(['analyze', fbxPath, '--curves-for', 'cube']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { ok: boolean; hint?: string; files: Array<{ name: string }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.hint).toContain('out 参数重跑');
    expect(parsed.files.some((file) => file.name === 'motion-curves/cube.csv')).toBe(true);
  }, 60_000);

  it('analyze：clip 不存在给三段式', () => {
    const { status, stderr } = runCli(['analyze', fbxPath, '--clip', 'Nope']);
    expect(status).toBe(1);
    const parsed = JSON.parse(stderr) as { ok: boolean; what: string; guidance: string; step: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.what).toContain('Nope');
    expect(parsed.step).toContain('当前这一步');
  });

  it('analyze：无动画资产给三段式', () => {
    const { status, stderr } = runCli(['analyze', staticGlbPath]);
    expect(status).toBe(1);
    const parsed = JSON.parse(stderr) as { ok: boolean; guidance: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.guidance).toContain('kinemesh_info');
  });

  it('analyze：词表缺失静默降级 builtin；词表 JSON 非法给三段式', async () => {
    // 词表文件不存在 → 静默降级 builtin（发现顺序口径），正常成功
    const missing = runCli(['analyze', fbxPath, '--vocab', path.join(workDir, 'no-such-vocab.json')]);
    expect(missing.status).toBe(0);
    const badVocab = path.join(workDir, 'bad-vocab.json');
    await writeFile(badVocab, '{ nope', 'utf8');
    const bad = runCli(['analyze', fbxPath, '--vocab', badVocab]);
    expect(bad.status).toBe(1);
    const parsed = JSON.parse(bad.stderr) as { ok: boolean; what: string; guidance: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.what).toContain('词表');
    expect(parsed.guidance).toContain('JSON');
  }, 60_000);

  it('analyze：枚举 flag 非法给三段式指引', () => {
    const badDetail = runCli(['analyze', fbxPath, '--detail', 'everything']);
    expect(badDetail.status).toBe(1);
    const parsed = JSON.parse(badDetail.stderr) as { ok: boolean; guidance: string; step: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.guidance).toContain('--detail');
    expect(parsed.step).toContain('当前这一步');
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

  it('info --mesh：返回网格文件报告 + 绑定体检（0.10.0 独立 mesh 文件）', () => {
    const { status, stdout } = runCli(['info', animOnlyGlbPath, '--mesh', meshOnlyGlbPath]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      meshes: unknown[];
      companion: { fileName: string; meshes: unknown[] };
      binding: { plan: { mesh: string; animation: string }; report: { ok: boolean; matchedTracks: number } };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.meshes).toEqual([]); // 动画-only 文件自身没有网格
    expect(parsed.companion.fileName).toBe('mesh-only.glb');
    expect(parsed.binding.plan).toMatchObject({ mesh: 'companion', animation: 'primary' });
    expect(parsed.binding.report.ok).toBe(true);
    expect(parsed.binding.report.matchedTracks).toBeGreaterThan(0);
  }, 60_000);

  it('info（动画-only、不带 mesh）：警告提示 mesh 参数', () => {
    const { status, stdout } = runCli(['info', animOnlyGlbPath]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { warnings: string[] };
    expect(parsed.warnings.join('\n')).toContain('动画-only');
    expect(parsed.warnings.join('\n')).toContain('mesh 参数');
  }, 60_000);

  it('render --mesh：动画-only 文件 + 独立网格文件绑定出图（chromium 可用时）', async () => {
    let chromiumReady = false;
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      await browser.close();
      chromiumReady = true;
    } catch {
      chromiumReady = false;
    }
    if (!chromiumReady) return;
    const outDir = path.join(workDir, 'bound-shots');
    const { status, stdout, stderr } = runCli([
      'render',
      animOnlyGlbPath,
      '--mesh',
      meshOnlyGlbPath,
      '--clip',
      'Walk',
      '--frames',
      '0,15',
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
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      images: string[];
      binding: { plan: { mesh: string; animation: string }; facts: string[] };
    };
    expect(parsed.images).toHaveLength(2);
    expect(parsed.binding.plan).toMatchObject({ mesh: 'companion', animation: 'primary' });
    for (const file of parsed.images) expect(existsSync(file)).toBe(true);
  }, 120_000);
});
