// 截图管线集成测试（设计文档 §4.5 验收）：真实 chromium + WebGL 渲染合成 FBX 出 PNG。
// chromium 未安装时整组跳过（npm i playwright && npx playwright install chromium 可启用）。
// B.4 骨骼名标注截图（render boneLabels / skeleton shots 真实出图）同在此文件验收。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildBinaryFbx, buildNamedRigGltf, encodeGlb, type NamedRigNodeSpec } from '../support/kinemesh-fixtures.js';
import { renderScreenshots } from '../../plugins/kinemesh/src/core/render/screenshot.js';
import { registerTools } from '../../plugins/kinemesh/src/tools.js';

let chromiumReady = false;
try {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  await browser.close();
  chromiumReady = true;
} catch {
  chromiumReady = false;
}

const workDir = await mkdtemp(path.join(tmpdir(), 'kinemesh-shot-test-'));

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  // PNG：8 字节签名 + IHDR chunk（宽度在 offset 16，高度在 20，大端）
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe.skipIf(!chromiumReady)('renderScreenshots × playwright', () => {
  const data = buildBinaryFbx();

  it('按 viewPreset 渲染两帧 PNG', async () => {
    const result = await renderScreenshots({
      data,
      fileName: 'cube-anim.fbx',
      viewInput: { viewPreset: 'front', clip: 'Take 001' },
      frames: [0, 30],
      width: 320,
      height: 240,
      outDir: workDir,
    });
    expect(result.images).toHaveLength(2);
    const payloads: Buffer[] = [];
    for (const file of result.images) {
      expect(existsSync(file)).toBe(true);
      expect(path.dirname(file).startsWith(workDir)).toBe(true);
      const bytes = readFileSync(file);
      payloads.push(bytes);
      expect(bytes.length).toBeGreaterThan(200); // 不是空图
      const size = pngSize(bytes);
      expect(size).toEqual({ width: 320, height: 240 });
    }
    // 两个帧的姿势不同（位移曲线），截图内容必须不一样
    expect(payloads[0].equals(payloads[1])).toBe(false);
    expect(result.images[0]).toMatch(/f0-az0\.png$/);
    expect(result.images[1]).toMatch(/f30-az0\.png$/);
  }, 60_000);

  it('orbit8 一次出 8 个方位', async () => {
    const result = await renderScreenshots({
      data,
      fileName: 'cube-anim.fbx',
      viewInput: { viewPreset: 'orbit8', clip: 'Take 001' },
      frames: [0],
      width: 160,
      height: 120,
      outDir: workDir,
    });
    expect(result.images).toHaveLength(8);
    expect(result.images[0]).toMatch(/az0\.png$/);
    expect(result.images[7]).toMatch(/az315\.png$/);
  }, 120_000);

  it('静态模型不指定 clip 也能出图', async () => {
    const result = await renderScreenshots({
      data,
      fileName: 'cube-anim.fbx',
      viewInput: { viewPreset: 'three-quarter' },
      frames: [0],
      width: 160,
      height: 120,
      outDir: workDir,
    });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatch(/static-f0-az45\.png$/);
  }, 60_000);

  it('frames 为空给指引', async () => {
    await expect(
      renderScreenshots({ data, fileName: 'cube.fbx', viewInput: {}, frames: [], outDir: workDir }),
    ).rejects.toThrow(/frames/);
  });

  it('帧号超出片段时长拒绝（0.5.1——曾静默出垃圾帧 ok:true）', async () => {
    await expect(
      renderScreenshots({
        data,
        fileName: 'cube-anim.fbx',
        viewInput: { viewPreset: 'front', clip: 'Take 001' },
        frames: [0, 9999],
        width: 160,
        height: 120,
        outDir: workDir,
      }),
    ).rejects.toThrow(/超出片段「Take 001」范围/);
  });
});

// ———————— B.4 骨骼名标注截图（render boneLabels + skeleton shots 真实出图） ————————

/** 非标命名链 rig（b01→b02→…）：全骨架 stride 批数 B = ceil(14/12) = 2，批内 7 骨 */
function chainSpecs(count: number): NamedRigNodeSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `b${String(i + 1).padStart(2, '0')}`,
    parent: i === 0 ? null : `b${String(i).padStart(2, '0')}`,
    local: [0, 0.25, 0],
  }));
}

/** Mixamo 风格人形命名（字典全命中，CORE15 15/15）：无缺口 rig + shots:"none" 用 */
const HUMANOID_SPECS: NamedRigNodeSpec[] = [
  { name: 'Hips', parent: null, local: [0, 1.0, 0] },
  { name: 'Spine', parent: 'Hips', local: [0, 0.1, 0] },
  { name: 'Head', parent: 'Spine', local: [0, 0.2, 0] },
  { name: 'LeftArm', parent: 'Spine', local: [-0.15, 0.1, 0] },
  { name: 'RightArm', parent: 'Spine', local: [0.15, 0.1, 0] },
  { name: 'LeftForeArm', parent: 'LeftArm', local: [-0.1, -0.15, 0] },
  { name: 'RightForeArm', parent: 'RightArm', local: [0.1, -0.15, 0] },
  { name: 'LeftHand', parent: 'LeftForeArm', local: [-0.03, -0.12, 0] },
  { name: 'RightHand', parent: 'RightForeArm', local: [0.03, -0.12, 0] },
  { name: 'LeftUpLeg', parent: 'Hips', local: [-0.08, -0.05, 0] },
  { name: 'RightUpLeg', parent: 'Hips', local: [0.08, -0.05, 0] },
  { name: 'LeftLeg', parent: 'LeftUpLeg', local: [0, -0.4, 0] },
  { name: 'RightLeg', parent: 'RightUpLeg', local: [0, -0.4, 0] },
  { name: 'LeftFoot', parent: 'LeftLeg', local: [0, -0.4, 0] },
  { name: 'RightFoot', parent: 'RightLeg', local: [0, -0.4, 0] },
  { name: 'LeftToeBase', parent: 'LeftFoot', local: [0, -0.06, 0.1] },
  { name: 'RightToeBase', parent: 'RightFoot', local: [0, -0.06, 0.1] },
];

function skeletonToolExecute(): ((args: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const registered = new Map<string, { name: string; execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }>();
  registerTools({
    tools: {
      register(definition: { name: string; execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }): () => void {
        registered.set(definition.name, definition as { name: string; execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> });
        return () => undefined;
      },
    },
  });
  const tool = registered.get('kinemesh_skeleton');
  if (tool === undefined) throw new Error('kinemesh_skeleton 没有注册');
  return tool.execute;
}

describe.skipIf(!chromiumReady)('B.4 骨骼名标注截图', () => {
  const rigGlb = encodeGlb(buildNamedRigGltf(chainSpecs(14)));

  it('render boneLabels：auto（第 1 批）与批次 2 都出图，两批像素不同（标签真的画上了）', async () => {
    const base = {
      data: rigGlb,
      fileName: 'rig.glb',
      viewInput: { viewPreset: 'front', mode: 'skeleton' },
      frames: [0],
      width: 320,
      height: 240,
      outDir: workDir,
    } as const;
    const first = await renderScreenshots({ ...base, boneLabels: 'auto' });
    const second = await renderScreenshots({ ...base, boneLabels: 2 });
    expect(first.images).toHaveLength(1);
    expect(second.images).toHaveLength(1);
    for (const file of [...first.images, ...second.images]) {
      expect(existsSync(file)).toBe(true);
      const bytes = readFileSync(file);
      expect(bytes.length).toBeGreaterThan(200); // 不是空图
      expect(pngSize(bytes)).toEqual({ width: 320, height: 240 });
    }
    // skeleton 模式下网格隐藏（0.6.10 起地面网格仍显示），画面主体是骨骼线 + 标签精灵：
    // 两批标签集不同 → 像素必须不同（标签没画上则两张都是同样的底图，测试即失败）
    expect(readFileSync(first.images[0]).equals(readFileSync(second.images[0]))).toBe(false);
  }, 120_000);

  it('skeleton shots:"all" 产出 labels-front/side-XX.png 且命名与批次数正确；无缺口 rig + shots:"none" 不出图', async () => {
    const rigFile = path.join(workDir, 'label-rig.glb');
    await writeFile(rigFile, Buffer.from(rigGlb));
    const execute = skeletonToolExecute();
    const outDir = path.join(workDir, 'skel-labels');
    const result = await execute({ path: rigFile, shots: 'all', out: outDir });
    expect(result.ok).toBe(true);
    const digest = result.digest as {
      batches: Array<{ batch: number; bones: string[] }>;
      shots: string[];
      facts: string[];
    };
    expect(digest.batches).toHaveLength(2);
    expect(digest.batches.map((batch) => batch.bones.length)).toEqual([7, 7]);
    expect(digest.shots.map((file) => path.basename(file))).toEqual([
      'labels-front-01.png',
      'labels-side-01.png',
      'labels-front-02.png',
      'labels-side-02.png',
    ]);
    for (const file of digest.shots) {
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file).length).toBeGreaterThan(200);
    }
    const files = result.files as Array<{ name: string }>;
    expect(files.map((file) => file.name)).toEqual([
      'skeleton-report.json',
      'labels-front-01.png',
      'labels-side-01.png',
      'labels-front-02.png',
      'labels-side-02.png',
    ]);
    expect(digest.facts.some((fact) => fact.includes('标注截图已渲染 4 张'))).toBe(true);

    // 无缺口 rig（字典全命中）+ shots:"none"：不出任何图
    const humanoidFile = path.join(workDir, 'humanoid-rig.glb');
    await writeFile(humanoidFile, Buffer.from(encodeGlb(buildNamedRigGltf(HUMANOID_SPECS))));
    const quietDir = path.join(workDir, 'skel-quiet');
    const quiet = await execute({ path: humanoidFile, shots: 'none', out: quietDir });
    expect(quiet.ok).toBe(true);
    const quietDigest = quiet.digest as { coverage: { core: { hit: number } }; batches: unknown[]; shots: string[] };
    expect(quietDigest.coverage.core.hit).toBe(15);
    expect(quietDigest.batches).toEqual([]);
    expect(quietDigest.shots).toEqual([]);
    expect(readdirSync(quietDir).filter((name) => name.endsWith('.png'))).toEqual([]);
  }, 240_000);
});
