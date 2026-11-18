// OBJ：静态模型（无动画），材质按 usemtl 计数；走 CanonicalScene 场景路径。
import { describe, expect, it } from 'vitest';
import { buildCubeObj, encodeText } from '../support/kinemesh-fixtures.js';
import { analyzeModel } from '../../plugins/kinemesh/src/core/analyze-file.js';

describe('analyzeModel × OBJ', () => {
  it('cube.obj → 12 三角面 / 36 顶点 / 1 材质 / 无骨骼无动画', async () => {
    const report = await analyzeModel(encodeText(buildCubeObj()), 'cube.obj');
    expect(report.format).toBe('obj');
    expect(report.clips).toHaveLength(0);
    expect(report.bones).toEqual({ count: 0, maxDepth: null, humanoidLike: false });
    expect(report.meshes).toHaveLength(1);
    // OBJLoader 生成非索引几何：每个角点一个顶点（12 面 × 3）
    expect(report.meshes[0]).toMatchObject({ name: 'cube', triangles: 12, vertices: 36, materials: 1 });
    expect(report.bounds?.heightMeters).toBeCloseTo(1, 5);
    // OBJ 是静态格式（hasAnimation=false），不触发「无动画」提示
    expect(report.warnings).toHaveLength(0);
  });
});
