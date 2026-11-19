// M6f：clip:"*" 批量、range 切片、场景缓存、morph-only 批量拒绝（design.md §6.7 / §6.2 / A.14 / §6.9 M6f）。
// 向后兼容红线：单 clip 的返回结构不变——summary/digest 顶层字段、files 文件名与 M6d 一致；
// 批量只体现在 batch 标记、clips[] 字段与 `<clip>/` 文件名前缀（增量分支）。
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildHumanoidRig,
  buildLinearWalkClip,
  buildMorphOnlyClip,
  buildPunchClip,
  buildRigScene,
  buildTwoClipCubeGltf,
  type HumanoidRig,
} from '../support/kinemesh-rig-fixtures.js';
import { buildMorphOnlyGltf, encodeGlb } from '../support/kinemesh-fixtures.js';
import { analyzeClip } from '../../plugins/kinemesh/src/core/motion/analyze.js';
import { clearSceneCache, getCachedScene, sceneCacheSize } from '../../plugins/kinemesh/src/core/scene-cache.js';
import { sceneToInfo } from '../../plugins/kinemesh/src/core/analyze/scene-info.js';
import { KinemeshError } from '../../plugins/kinemesh/src/core/errors.js';
import type { CanonicalScene } from '../../plugins/kinemesh/src/core/types.js';
import { registerTools, runAnalyze } from '../../plugins/kinemesh/src/tools.js';

/** 人形 rig + 两个已知答案 clip 的场景（walk 匀速前移 / punch 三段打击） */
function twoClipScene(rig: HumanoidRig): CanonicalScene {
  return buildRigScene(rig.root, [buildLinearWalkClip(rig), buildPunchClip(rig)]);
}

const workDir = await mkdtemp(path.join(tmpdir(), 'kinemesh-m6f-'));
const twoClipGlb = path.join(workDir, 'tool-two-clips.glb');
await writeFile(twoClipGlb, Buffer.from(encodeGlb(buildTwoClipCubeGltf())));

afterAll(async () => {
  clearSceneCache();
  await rm(workDir, { recursive: true, force: true });
});

describe('M6f · clip:"*" 批量（core 层）', () => {
  const rig = buildHumanoidRig();
  const scene = twoClipScene(rig);
  const batch = analyzeClip(scene, { clipName: '*' });

  it('批量标记 + summary.clips[] / digest.clips[] 逐 clip 内联', () => {
    expect(batch.batch).toBe(true);
    expect(batch.summary.clips?.map((entry) => entry.name)).toEqual(['Walk', 'Punch']);
    expect(batch.digest.clips?.map((entry) => entry.name)).toEqual(['Walk', 'Punch']);
    expect(batch.digest.clips?.[0]?.digest.clip.name).toBe('Walk');
    expect(batch.digest.clips?.[1]?.digest.clip.name).toBe('Punch');
    // 每 clip 的 digest 是完整 digest：分段表 + loopCheck + facts + keyframeRender 配方
    for (const entry of batch.digest.clips ?? []) {
      expect(entry.digest.segments.length).toBeGreaterThan(0);
      expect(entry.digest.loopCheck).not.toBeNull();
      expect(entry.digest.facts.length).toBeGreaterThan(0);
      expect(entry.digest.keyframeRender.frames.length).toBeGreaterThan(0);
    }
  });

  it('批量中间文件按 <clip>/ 子目录分桶（每 clip 一套 6 文件）', () => {
    expect(batch.files.map((file) => file.name)).toEqual([
      'Walk/motion-summary.json',
      'Walk/motion-frames.csv',
      'Walk/motion-segments.json',
      'Walk/motion-keyframes.json',
      'Walk/motion-trajectory.json',
      'Walk/motion-trajectory.svg',
      'Punch/motion-summary.json',
      'Punch/motion-frames.csv',
      'Punch/motion-segments.json',
      'Punch/motion-keyframes.json',
      'Punch/motion-trajectory.json',
      'Punch/motion-trajectory.svg',
    ]);
  });

  it('批量结果与逐 clip 单独分析一致（同一场景上互不污染）', () => {
    const walkSingle = analyzeClip(scene, { clipName: 'Walk' });
    const punchSingle = analyzeClip(scene, { clipName: 'Punch' });
    const byName = new Map((batch.summary.clips ?? []).map((entry) => [entry.name, entry]));
    const walkEntry = byName.get('Walk')!;
    const punchEntry = byName.get('Punch')!;
    expect(walkEntry.summary.clipStats.energy.mean).toBeCloseTo(walkSingle.summary.clipStats.energy.mean, 9);
    expect(walkEntry.summary.clipStats.mainDir).toBe(walkSingle.summary.clipStats.mainDir);
    expect(walkEntry.summary.loopCheck?.verdict).toBe(walkSingle.summary.loopCheck?.verdict);
    expect(walkEntry.summary.segments.map((segment) => segment.guess)).toEqual(
      walkSingle.summary.segments.map((segment) => segment.guess),
    );
    expect(punchEntry.summary.clipStats.energy.max).toBeCloseTo(punchSingle.summary.clipStats.energy.max, 9);
    expect(punchEntry.summary.segments.map((segment) => segment.guess)).toEqual(
      punchSingle.summary.segments.map((segment) => segment.guess),
    );
  });

  it('批量 summary/digest envelope 在返回值里；每个 <clip>/motion-summary.json 是该 clip 的完整 summary', () => {
    // 批量口径（§6.7）：返回的 summary.clips[] / digest.clips[] 逐 clip 内联（上面两条已断言）；
    // 落盘文件按 clip 分子目录，每份 motion-summary.json 就是该 clip 自己的 summary（不含 clips 字段）
    const summaryFile = batch.files.find((file) => file.name === 'Walk/motion-summary.json')!;
    const parsed = JSON.parse(summaryFile.content) as { clip: { name: string }; clips?: unknown };
    expect(parsed.clip.name).toBe('Walk');
    expect(parsed.clips).toBeUndefined();
    const batchEntry = (batch.summary.clips ?? []).find((entry) => entry.name === 'Walk')!;
    expect(batchEntry.summary.clip.name).toBe('Walk');
    expect(batchEntry.summary.clip.name).toBe(parsed.clip.name);
  });

  it('单 clip 向后兼容：无 batch 标记、无 clips 字段、文件不带前缀', () => {
    const singleRig = buildHumanoidRig();
    const single = analyzeClip(buildRigScene(singleRig.root, [buildLinearWalkClip(singleRig)]));
    expect(single.batch).toBeUndefined();
    expect(single.summary.clips).toBeUndefined();
    expect(single.digest.clips).toBeUndefined();
    expect(single.files.map((file) => file.name)).toEqual([
      'motion-summary.json',
      'motion-frames.csv',
      'motion-segments.json',
      'motion-keyframes.json',
      'motion-trajectory.json',
      'motion-trajectory.svg',
    ]);
  });

  it('重名 clip 去重：子目录追加 -2，不互相覆盖', () => {
    const dupRig = buildHumanoidRig();
    const dupScene = buildRigScene(dupRig.root, [
      buildLinearWalkClip(dupRig, { speed: 1 }),
      buildLinearWalkClip(dupRig, { speed: 0.5 }),
    ]);
    const dup = analyzeClip(dupScene, { clipName: '*' });
    const dirs = new Set(dup.files.map((file) => file.name.split('/')[0]));
    expect([...dirs]).toEqual(['Walk', 'Walk-2']);
    // 两个同名 clip 的内容确实不同（速度不同 → 位移不同）
    const digests = dup.digest.clips ?? [];
    expect(digests[0]!.digest.clipStats.rootTotalDisp).toBeCloseTo(2, 2);
    expect(digests[1]!.digest.clipStats.rootTotalDisp).toBeCloseTo(1, 2);
  });

  it('无动画资产批量走三段式拒绝（与单 clip 口径一致）', () => {
    const staticRig = buildHumanoidRig();
    expect(() => analyzeClip(buildRigScene(staticRig.root, []), { clipName: '*' })).toThrow(KinemeshError);
  });
});

describe('M6f · range 切片（core 层，帧号按全片口径）', () => {
  const rig = buildHumanoidRig();
  const scene = buildRigScene(rig.root, [buildLinearWalkClip(rig)]);
  const sliced = analyzeClip(scene, { clipName: 'Walk', range: [0.5, 1.5] });

  it('只采样 [t0,t1] 网格点，帧号不重置（15fps 网格 k=8..22 → 全片 frame 16..44）', () => {
    expect(sliced.summary.clip.frameCount).toBe(15);
    expect(sliced.summary.clip.frames).toBe(60); // 全片口径总帧数不因切片改变
    const csv = sliced.files.find((file) => file.name === 'motion-frames.csv')!.content.trimEnd().split('\n');
    expect(csv.length).toBe(16); // 表头 + 15 行
    expect(csv[1]!.split(',')[0]).toBe('16');
    expect(csv[15]!.split(',')[0]).toBe('44');
  });

  it('summary.clip 标注 range；duration/frames 保持全片口径', () => {
    expect(sliced.summary.clip.range).toEqual([0.5, 1.5]);
    expect(sliced.summary.clip.duration).toBe(2);
    expect(sliced.digest.clip.range).toEqual([0.5, 1.5]);
  });

  it('切片统计按切片段计算：位移 ≈ 1×(1.5−8/15)、主方向不变', () => {
    expect(sliced.summary.clipStats.rootTotalDisp).toBeCloseTo(0.9667, 2);
    expect(sliced.summary.clipStats.mainDir).toBe('forward');
    expect(sliced.summary.segments.length).toBe(1);
  });

  it('range 校验三段式：t0 ≥ t1、负值与 t1 越界', () => {
    expect(() => analyzeClip(scene, { clipName: 'Walk', range: [1, 1] })).toThrow(/range 参数不合法/);
    expect(() => analyzeClip(scene, { clipName: 'Walk', range: [-1, 1] })).toThrow(/range 参数不合法/);
    expect(() => analyzeClip(scene, { clipName: 'Walk', range: [0, 3] })).toThrow(/range 越界/);
  });

  it('range 切片总长 < 0.4s：合法分析不崩且产出单段 summary（M6b 短单段潜伏缺陷回归）', () => {
    // 4 采样帧 = 0.267s < SEG_MIN_SECONDS：cutSegments 的短段合并无邻居可并，须保留单段而非崩溃
    const short = analyzeClip(scene, { clipName: 'Walk', range: [0, 0.25] });
    expect(short.summary.clip.frameCount).toBe(4);
    expect(short.summary.clip.range).toEqual([0, 0.25]);
    expect(short.summary.segments.length).toBe(1);
    expect(short.summary.facts.length).toBeGreaterThan(0);
  });

  it('range 与 clip:"*" 互斥（批量按各 clip 全片分析）', () => {
    expect(() => analyzeClip(scene, { clipName: '*', range: [0, 1] })).toThrow(/不能同用/);
  });
});

describe('M6f · morph-only 在批量/切片路径下仍走三段式拒绝（A.14）', () => {
  it('批量中混入 morph-only clip → 整体拒绝并点名该 clip', () => {
    const rig = buildHumanoidRig();
    const scene = buildRigScene(rig.root, [buildLinearWalkClip(rig), buildMorphOnlyClip()]);
    let message = '';
    try {
      analyzeClip(scene, { clipName: '*' });
    } catch (error) {
      message = error instanceof KinemeshError ? error.message : '';
    }
    expect(message).toContain('形态动画');
    expect(message).toContain('Blink');
  });

  it('morph-only clip + range 切片同样拒绝', () => {
    const rig = buildHumanoidRig();
    const scene = buildRigScene(rig.root, [buildMorphOnlyClip()]);
    expect(() => analyzeClip(scene, { range: [0, 0.5] })).toThrow(KinemeshError);
  });
});

describe('M6f · 场景缓存（core/scene-cache.ts，path+mtime）', () => {
  it('同路径同 mtime 命中同一实例，不重复解析；mtime 变化重新加载；clearSceneCache 清空', async () => {
    clearSceneCache();
    const file = path.join(workDir, 'cache-target.glb');
    await writeFile(file, Buffer.from(encodeGlb(buildTwoClipCubeGltf())));
    let loads = 0;
    const load = (): CanonicalScene => {
      loads += 1;
      return buildRigScene(buildHumanoidRig().root, []);
    };
    const first = await getCachedScene(file, load);
    expect(loads).toBe(1);
    expect(sceneCacheSize()).toBe(1);
    const second = await getCachedScene(file, load);
    expect(loads).toBe(1); // 命中：不再解析
    expect(second).toBe(first); // 同一实例
    // mtime 变化（用 utimes 固定推进，避免文件系统时间精度抖动）→ 新键 → 重新加载
    const future = new Date(Date.now() + 60_000);
    await utimes(file, future, future);
    const third = await getCachedScene(file, load);
    expect(loads).toBe(2);
    expect(third).not.toBe(first);
    expect(sceneCacheSize()).toBe(2);
    clearSceneCache();
    expect(sceneCacheSize()).toBe(0);
  });

  it('runAnalyze 接缓存：重复分析命中（条目数不变、digest 一致），mtime 变化后重新解析', async () => {
    clearSceneCache();
    const file = path.join(workDir, 'cache-run.glb');
    await writeFile(file, Buffer.from(encodeGlb(buildTwoClipCubeGltf())));
    const data = await readFile(file);
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const context = { absPath: file, assetDir: workDir };
    const first = await runAnalyze(buffer, 'cache-run.glb', { clip: '*', out: path.join(workDir, 'cache-run-out') }, context);
    expect(sceneCacheSize()).toBe(1);
    const second = await runAnalyze(buffer, 'cache-run.glb', { clip: '*', out: path.join(workDir, 'cache-run-out') }, context);
    expect(sceneCacheSize()).toBe(1); // 命中：不产生新条目
    expect(JSON.stringify(second.summaryDigest)).toBe(JSON.stringify(first.summaryDigest));
    const future = new Date(Date.now() + 120_000);
    await utimes(file, future, future);
    await runAnalyze(buffer, 'cache-run.glb', { clip: '*', out: path.join(workDir, 'cache-run-out') }, context);
    expect(sceneCacheSize()).toBe(2);
  });
});

describe('M6f · 缓存复用安全：采样后 rest 姿态已恢复（A.1 必经步骤的回归测试）', () => {
  it('同一场景实例先批量 analyze 再取信息/再 analyze：结果与首次一致、骨骼回 rest 位', () => {
    clearSceneCache();
    const rig = buildHumanoidRig();
    const scene = twoClipScene(rig);
    const hipsRest = rig.bones.Hips.getWorldPosition(new THREE.Vector3());
    const infoBefore = sceneToInfo(scene, { fileName: 'rig.glb', fileSize: 100, expectsAnimation: true });

    const first = analyzeClip(scene, { clipName: '*' }); // 动画姿态写入（finally 恢复）
    const second = analyzeClip(scene, { clipName: '*' }); // 同一实例再次分析（缓存命中的消费方式）
    expect(JSON.stringify(second.digest)).toBe(JSON.stringify(first.digest));

    const infoAfter = sceneToInfo(scene, { fileName: 'rig.glb', fileSize: 100, expectsAnimation: true });
    expect(infoAfter).toEqual(infoBefore); // 信息提取不受残留姿态影响
    const hipsAfter = rig.bones.Hips.getWorldPosition(new THREE.Vector3());
    expect(hipsAfter.distanceTo(hipsRest)).toBeLessThan(1e-9);
  });
});

// ———————— 工具层（DSH 出口）：批量 / range / morph-only 三段式 ————————

interface RegisteredTool {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function analyzeExecute(): RegisteredTool['execute'] {
  const registered = new Map<string, RegisteredTool>();
  const ctx = {
    tools: {
      register(definition: RegisteredTool): () => void {
        registered.set(definition.name, definition);
        return () => undefined;
      },
    },
  };
  registerTools(ctx);
  const tool = registered.get('kinemesh_analyze');
  if (tool === undefined) throw new Error('kinemesh_analyze 没有注册');
  return tool.execute;
}

describe('M6f · 工具层：clip:"*" 批量落盘 <clip>/ 分桶 + digest.clips[] 逐 clip', () => {
  it('execute({clip:"*"}) → files 按 Walk//Jump 分桶、summaryDigest.clips[] 逐 clip', async () => {
    const execute = analyzeExecute();
    const outDir = path.join(workDir, 'tool-batch-out');
    const result = await execute({ path: twoClipGlb, clip: '*', out: outDir });
    expect(result.ok).toBe(true);
    const names = (result.files as Array<{ name: string }>).map((file) => file.name);
    expect(names.filter((name) => name.startsWith('Walk/'))).toHaveLength(6);
    expect(names.filter((name) => name.startsWith('Jump/'))).toHaveLength(6);
    const digest = result.summaryDigest as {
      batch: true;
      clips: Array<{ name: string; digest: { clip: { name: string }; segments: unknown[] } }>;
    };
    expect(digest.batch).toBe(true);
    expect(digest.clips.map((entry) => entry.name)).toEqual(['Walk', 'Jump']);
    expect(digest.clips.map((entry) => entry.digest.clip.name)).toEqual(['Walk', 'Jump']);
    expect(digest.clips[0]?.digest.segments.length).toBeGreaterThan(0);
    expect(existsSync(path.join(outDir, 'Walk', 'motion-summary.json'))).toBe(true);
    expect(existsSync(path.join(outDir, 'Jump', 'motion-summary.json'))).toBe(true);
  });

  it('morph-only 资产 clip:"*"：三段式拒绝（批量路径的自愈口径）', async () => {
    const morphGlb = path.join(workDir, 'tool-batch-morph.glb');
    await writeFile(morphGlb, Buffer.from(encodeGlb(buildMorphOnlyGltf())));
    const execute = analyzeExecute();
    const result = await execute({ path: morphGlb, clip: '*' });
    expect(result.ok).toBe(false);
    expect(String(result.what)).toContain('形态动画');
    expect(String(result.guidance)).toContain('kinemesh_render');
    expect(String(result.step)).toContain('当前这一步');
  });

  it('execute({clip, range}) → summaryDigest.clip 标注 range；非法 range 三段式', async () => {
    const execute = analyzeExecute();
    const outDir = path.join(workDir, 'tool-range-out');
    const result = await execute({ path: twoClipGlb, clip: 'Walk', range: [0, 0.25], out: outDir });
    expect(result.ok).toBe(true);
    const digest = result.summaryDigest as { clip: { range?: [number, number] } };
    expect(digest.clip.range).toEqual([0, 0.25]);
    const bad = await execute({ path: twoClipGlb, range: [1, 0] });
    expect(bad.ok).toBe(false);
    expect(String(bad.what)).toContain('range');
  });
});
