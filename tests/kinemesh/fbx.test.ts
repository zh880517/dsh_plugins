// FBX：合成二进制 + 合成 ASCII 走完整解析；真实 Mixamo 样例（tests/fixtures/kinemesh/samba-dancing.fbx，
// 不入库）存在时做集成断言——骨骼/人形识别/单位体检都有真实数据兜底。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAsciiFbx, buildBinaryFbx } from '../support/kinemesh-fixtures.js';
import { analyzeModel } from '../../plugins/kinemesh/src/core/analyze-file.js';

const SAMBA_PATH = path.resolve(import.meta.dirname, '..', 'fixtures', 'kinemesh', 'samba-dancing.fbx');

describe('analyzeModel × FBX（合成）', () => {
  it('二进制 FBX：clip/时长/通道/网格统计', async () => {
    const report = await analyzeModel(buildBinaryFbx(), 'cube-anim.fbx');
    expect(report.format).toBe('fbx-binary');
    expect(report.clips).toHaveLength(1);
    expect(report.clips[0]).toMatchObject({ name: 'Take 001', channels: 1, rootMotion: false });
    expect(report.clips[0]?.duration).toBeCloseTo(2, 3);
    expect(report.bones).toEqual({ count: 0, maxDepth: null, humanoidLike: false });
    expect(report.meshes).toHaveLength(1);
    // FBXLoader 无法去重时按「多边形角点」生成顶点：4 片三角面 = 12 个角点
    expect(report.meshes[0]).toMatchObject({ name: 'cube', triangles: 4, vertices: 12, materials: 1 });
    expect(report.bounds?.min).toEqual([-0.5, -0.5, -0.5]);
    expect(report.bounds?.max).toEqual([0.5, 0.5, 0.5]);
    expect(report.warnings).toHaveLength(0);
  });

  it('ASCII FBX：同一棵树走文本解析', async () => {
    const report = await analyzeModel(new TextEncoder().encode(buildAsciiFbx()).buffer as ArrayBuffer, 'cube-ascii.fbx');
    expect(report.format).toBe('fbx-ascii');
    expect(report.clips).toHaveLength(1);
    expect(report.clips[0]?.name).toBe('Take 001');
    expect(report.clips[0]?.duration).toBeCloseTo(2, 3);
    expect(report.meshes[0]).toMatchObject({ triangles: 4, vertices: 12 });
  });

  it('损坏的 FBX 给重导出指引', async () => {
    const bytes = new Uint8Array(buildBinaryFbx());
    bytes.fill(0xff, 100, 400);
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const error = await analyzeModel(data, 'broken.fbx').catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain('FBX');
  });
});

describe('analyzeModel × FBX（真实 Mixamo 样例，可选）', () => {
  const hasSample = existsSync(SAMBA_PATH);

  it.skipIf(!hasSample)('samba-dancing.fbx：骨骼/人形/厘米体检', async () => {
    const raw = readFileSync(SAMBA_PATH);
    const data = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    const report = await analyzeModel(data, 'samba-dancing.fbx');
    expect(report.format).toBe('fbx-binary');
    expect(report.clips.length).toBeGreaterThanOrEqual(1);
    expect(report.clips.some((clip) => clip.duration > 1 && clip.channels > 0)).toBe(true);
    expect(report.bones.count).toBeGreaterThan(50);
    expect(report.bones.humanoidLike).toBe(true);
    expect(report.meshes.length).toBeGreaterThanOrEqual(1);
    expect(report.meshes.every((mesh) => mesh.triangles > 0)).toBe(true);
    // Mixamo 的 FBX 是厘米：高度 ≈180 → 单位体检必须标出来
    expect((report.bounds?.heightMeters ?? 0)).toBeGreaterThan(10);
    expect(report.warnings.some((warning) => warning.includes('疑似单位错误'))).toBe(true);
  }, 30_000);
});
