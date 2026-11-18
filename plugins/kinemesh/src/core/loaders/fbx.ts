// FBX loader：three.js 的 FBXLoader 同时吃二进制（≥6400）与 ASCII（≥7.0），
// Node 端解析用 LoadingManager 的贴图桩挡掉浏览器 API（见 node-textures.ts）。
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { KinemeshError, reasonOf } from '../errors.js';
import type { CanonicalScene, LoadContext } from '../types.js';
import { stubNodeTextures } from './node-textures.js';

/** FBX 二进制头：'Kaydara FBX Binary  ' + 0x00 0x1A 0x00 */
const BINARY_MAGIC = 'Kaydara FBX Binary  \x00\x1a\x00';

export function isFbxBinary(data: ArrayBuffer): boolean {
  if (data.byteLength < BINARY_MAGIC.length) return false;
  const head = new TextDecoder('latin1').decode(new Uint8Array(data, 0, BINARY_MAGIC.length));
  return head === BINARY_MAGIC;
}

export function parseFbx(data: ArrayBuffer, ctx: LoadContext): CanonicalScene {
  const binary = isFbxBinary(data);
  const manager = new THREE.LoadingManager();
  stubNodeTextures(manager);
  const loader = new FBXLoader(manager);
  let group: THREE.Group;
  try {
    group = loader.parse(data, '');
  } catch (error) {
    throw new KinemeshError(
      `FBX 解析失败：${reasonOf(error)}`,
      '确认文件是完整导出的 FBX（ASCII ≥7.0 / 二进制 ≥6400）；' +
        '文件损坏时回到 DCC 软件重新导出，勾选「烘焙动画」「嵌入媒体」；' +
        '私人/加密 FBX 先另存为普通 FBX 再分析。',
      { cause: error },
    );
  }
  return {
    object: group,
    animations: group.animations ?? [],
    meta: {
      format: binary ? 'fbx-binary' : 'fbx-ascii',
      unitScaleFactor: null,
      upAxis: null,
      fps: null,
    },
  };
}

/** detect 用：FBX 二进制 magic，或 ASCII 文本里出现 FBXHeaderExtension */
export function detectFbx(head: Uint8Array, fileName: string): boolean {
  if (head.byteLength >= BINARY_MAGIC.length) {
    const text = new TextDecoder('latin1').decode(head.subarray(0, BINARY_MAGIC.length));
    if (text === BINARY_MAGIC) return true;
  }
  if (fileName.toLowerCase().endsWith('.fbx')) return true;
  const ascii = new TextDecoder('utf-8', { fatal: false }).decode(head.subarray(0, Math.min(head.byteLength, 1024)));
  return /FBXHeaderExtension\s*:/.test(ascii) || /^;\s*FBX\s+\d/m.test(ascii);
}
