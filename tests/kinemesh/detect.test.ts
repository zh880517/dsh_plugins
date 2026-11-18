// 格式探测：magic bytes 优先、扩展名兜底；未识别格式给自愈指引（设计文档 §3.3）。
import { describe, expect, it } from 'vitest';
import {
  buildAnimatedCubeGltf,
  buildBinaryFbx,
  buildCubeObj,
  encodeGltfBytes,
  encodeGlb,
  encodeText,
} from '../support/kinemesh-fixtures.js';
import { KinemeshError } from '../../plugins/kinemesh/src/core/errors.js';
import { analyzeModel } from '../../plugins/kinemesh/src/core/analyze-file.js';
import { detectFormat } from '../../plugins/kinemesh/src/core/registry.js';

function headOf(data: ArrayBuffer): Uint8Array {
  return new Uint8Array(data, 0, Math.min(1024, data.byteLength));
}

describe('detectFormat', () => {
  it('FBX 二进制 magic → fbx entry', () => {
    const entry = detectFormat(headOf(buildBinaryFbx()), 'x.fbx');
    expect(entry?.id).toBe('fbx');
  });

  it('GLB magic → gltf entry；gltf JSON → gltf entry', () => {
    expect(detectFormat(headOf(encodeGlb(buildAnimatedCubeGltf())), 'x.glb')?.id).toBe('gltf');
    expect(detectFormat(headOf(encodeGltfBytes(buildAnimatedCubeGltf())), 'x.gltf')?.id).toBe('gltf');
  });

  it('OBJ 关键字行 → obj entry', () => {
    expect(detectFormat(headOf(encodeText(buildCubeObj())), 'x.obj')?.id).toBe('obj');
  });

  it('无 magic 时按扩展名兜底', () => {
    const json = encodeText('{"asset":{"version":"2.0"}}');
    expect(detectFormat(headOf(json), 'x.gltf')?.id).toBe('gltf');
    expect(detectFormat(headOf(encodeText('v 0 0 0')), 'mesh.obj')?.id).toBe('obj');
    expect(detectFormat(headOf(encodeText('whatever')), 'a.fbx')?.id).toBe('fbx');
    expect(detectFormat(headOf(encodeText('whatever')), 'a.bin')).toBeNull();
  });
});

describe('analyzeModel 的输入守卫', () => {
  it('空文件报错并给指引', async () => {
    await expect(analyzeModel(new ArrayBuffer(0), 'empty.fbx')).rejects.toThrow(/空的/);
  });

  it('.max 给 3ds Max 导出指引', async () => {
    const error = await analyzeModel(encodeText('nonsense'), 'hero.max').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KinemeshError);
    expect((error as KinemeshError).guidance).toContain('3ds Max');
    expect((error as KinemeshError).guidance).toContain('FBX');
  });

  it('私有引擎格式给离线转 GLB 指引', async () => {
    const error = await analyzeModel(encodeText('nonsense'), 'model.nif').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KinemeshError);
    expect((error as KinemeshError).guidance).toContain('GLB');
  });

  it('未知扩展名给支持范围', async () => {
    const error = await analyzeModel(encodeText('nonsense'), 'thing.weird').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KinemeshError);
    expect((error as KinemeshError).guidance).toContain('FBX / glTF / GLB / OBJ');
  });
});
