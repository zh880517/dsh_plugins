// OBJ loader：静态模型，无动画。MTL 旁车在 info 阶段不读（材质名 OBJLoader 自带）。
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { KinemeshError, reasonOf } from '../errors.js';
import type { CanonicalScene, LoadContext } from '../types.js';

export function parseObj(data: ArrayBuffer, _ctx: LoadContext): CanonicalScene {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(data));
  let group;
  try {
    group = new OBJLoader().parse(text);
  } catch (error) {
    throw new KinemeshError(`OBJ 解析失败：${reasonOf(error)}`, '确认文件是文本 OBJ（顶点 v / 面 f 行完整）；损坏文件回到导出工具重新导出。', {
      cause: error,
    });
  }
  return {
    object: group,
    animations: [],
    meta: { format: 'obj', unitScaleFactor: null, upAxis: null, fps: null },
  };
}

/** detect 用：OBJ 关键字行或扩展名 */
export function detectObj(head: Uint8Array, fileName: string): boolean {
  if (fileName.toLowerCase().endsWith('.obj')) return true;
  const ascii = new TextDecoder('utf-8', { fatal: false }).decode(head.subarray(0, Math.min(head.byteLength, 1024)));
  return /^(v|vn|vt|f|o|g|s|mtllib|usemtl|p|l)\s/m.test(ascii);
}
