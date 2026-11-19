// glTF 纯 JSON 快速路径（设计文档 §4.3）：片段/骨骼/网格/包围盒全部来自 JSON，不碰二进制。
import { describe, expect, it } from 'vitest';
import {
  buildAnimatedCubeGltf,
  buildStaticCubeGltf,
  encodeGlb,
  encodeText,
} from '../support/kinemesh-fixtures.js';
import { analyzeModel } from '../../plugins/kinemesh/src/core/analyze-file.js';
import { gltfJsonInfo } from '../../plugins/kinemesh/src/core/analyze/gltf-json.js';

describe('gltfJsonInfo（.gltf 文本）', () => {
  const report = gltfJsonInfo(encodeText(JSON.stringify(buildAnimatedCubeGltf())), 'cube.gltf');

  it('format/file 信息', () => {
    expect(report.format).toBe('gltf');
    expect(report.fileName).toBe('cube.gltf');
    expect(report.fileSize).toBeGreaterThan(0);
  });

  it('动画片段：名称/时长/通道/rootMotion', () => {
    expect(report.clips).toHaveLength(1);
    const clip = report.clips[0];
    expect(clip?.name).toBe('Walk');
    expect(clip?.duration).toBeCloseTo(0.5, 5);
    expect(clip?.channels).toBe(2);
    expect(clip?.fps).toBeNull();
    expect(clip?.rootMotion).toBe(true); // rig 是根节点，translation 净位移 2
  });

  it('骨骼：数量/深度/非人形命名 + B.6 convention/mapped（bone_a/bone_b 无字典命中）', () => {
    expect(report.bones).toEqual({ count: 2, maxDepth: 1, humanoidLike: false, convention: 'custom', mapped: 0 });
  });

  it('网格：三角面/顶点/蒙皮比例/材质', () => {
    expect(report.meshes).toHaveLength(1);
    expect(report.meshes[0]).toEqual({
      name: 'Body',
      triangles: 12,
      vertices: 8,
      skinnedRatio: 1, // 唯一实例 cube 节点带 skin
      materials: 1,
    });
  });

  it('包围盒来自 POSITION accessor 的 min/max', () => {
    expect(report.bounds).not.toBeNull();
    expect(report.bounds?.min).toEqual([-0.5, -0.5, -0.5]);
    expect(report.bounds?.max).toEqual([0.5, 0.5, 0.5]);
    expect(report.bounds?.heightMeters).toBeCloseTo(1, 5);
  });

  it('静态模型给「没有动画」提示，正常尺寸不给单位警告', () => {
    const staticReport = gltfJsonInfo(encodeText(JSON.stringify(buildStaticCubeGltf())), 'static.gltf');
    expect(staticReport.clips).toHaveLength(0);
    expect(staticReport.warnings.some((warning) => warning.includes('没有解析到动画片段'))).toBe(true);
    expect(staticReport.warnings.some((warning) => warning.includes('疑似单位错误'))).toBe(false);
  });
});

describe('GLB 容器', () => {
  it('glb 走同一份 JSON 快速路径，format 标 glb', async () => {
    const report = await analyzeModel(encodeGlb(buildAnimatedCubeGltf()), 'cube.glb');
    expect(report.format).toBe('glb');
    expect(report.clips[0]?.name).toBe('Walk');
  });

  it('GLB 版本不对给指引', () => {
    const good = new Uint8Array(encodeGlb(buildAnimatedCubeGltf()));
    good[4] = 1; // version 1
    const data = good.buffer.slice(good.byteOffset, good.byteOffset + good.byteLength) as ArrayBuffer;
    expect(() => gltfJsonInfo(data, 'old.glb')).toThrow(/glTF 2\.0/);
  });

  it('JSON 损坏给指引', async () => {
    const broken = encodeText('{"asset": {');
    const error = await analyzeModel(broken, 'broken.gltf').catch((e: unknown) => e);
    expect((error as Error).message).toContain('JSON');
  });

  it('不是 glTF 的 JSON 给指引', async () => {
    const error = await analyzeModel(encodeText('{"hello": "world"}'), 'notgl.gltf').catch((e: unknown) => e);
    expect((error as Error).message).toContain('asset');
  });
});
