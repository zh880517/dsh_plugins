// glTF / GLB loader（CanonicalScene 路径，viewer 用）。
// info 提取走 gltf-json.ts 的纯 JSON 快速路径，不经过这里。
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KinemeshError, reasonOf } from '../errors.js';
import type { CanonicalScene, LoadContext, SourceFormat } from '../types.js';
import { stubNodeTextures } from './node-textures.js';

/** GLB 容器 magic：'glTF' */
export function isGlb(data: ArrayBuffer): boolean {
  if (data.byteLength < 4) return false;
  return new TextDecoder('latin1').decode(new Uint8Array(data, 0, 4)) === 'glTF';
}

export function parseGltf(data: ArrayBuffer, ctx: LoadContext): Promise<CanonicalScene> {
  const format: SourceFormat = isGlb(data) ? 'glb' : 'gltf';
  const manager = new THREE.LoadingManager();
  stubNodeTextures(manager);
  const loader = new GLTFLoader(manager);
  return new Promise((resolve, reject) => {
    try {
      loader.parse(
        data,
        '',
        (gltf) => {
          resolve({
            object: gltf.scene,
            animations: gltf.animations ?? [],
            meta: { format, unitScaleFactor: null, upAxis: 'y', fps: null },
          });
        },
        (error) => {
          reject(new KinemeshError(`glTF 解析失败：${reasonOf(error)}`, gltfGuidance(format, ctx), { cause: error }));
        },
      );
    } catch (error) {
      reject(new KinemeshError(`glTF 解析失败：${reasonOf(error)}`, gltfGuidance(format, ctx), { cause: error }));
    }
  });
}

function gltfGuidance(format: SourceFormat, ctx: LoadContext): string {
  if (format === 'gltf') {
    return (
      '.gltf 是 JSON + 外部 .bin/贴图 的组合：确认 .bin 与贴图和 .gltf 在同一目录；' +
      `单独分析一个 .gltf 文件时优先改用内嵌资源的 GLB（${ctx.fileName} 缺少旁车文件时必然失败）。`
    );
  }
  return '确认 GLB 完整（未截断）且版本是 glTF 2.0；Draco/Meshopt/KTX2 压缩的 GLB 需要解码器，转换后的文件可回原工具重新导出为不压缩版本验证。';
}

/** detect 用：GLB magic 或「JSON 且带 asset 字段」或扩展名 */
export function detectGltf(head: Uint8Array, fileName: string): boolean {
  if (head.byteLength >= 4 && new TextDecoder('latin1').decode(head.subarray(0, 4)) === 'glTF') return true;
  const lower = fileName.toLowerCase();
  const byExt = lower.endsWith('.gltf') || lower.endsWith('.glb') || lower.endsWith('.vrm');
  const ascii = new TextDecoder('utf-8', { fatal: false }).decode(head.subarray(0, Math.min(head.byteLength, 1024)));
  const trimmed = ascii.trimStart();
  const looksJson = trimmed.startsWith('{') && trimmed.includes('"asset"');
  return looksJson || byExt;
}
