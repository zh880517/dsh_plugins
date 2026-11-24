// 格式注册表（设计文档 §4.1）：detect 用 magic bytes 优先、扩展名兜底。
// 新增格式 = 往 FORMAT_ENTRIES 里加一个 entry（长尾格式的 assimpjs 兜底以后也是这里加一行）。
import { KinemeshError } from './errors.js';
import { detectFbx, parseFbx } from './loaders/fbx.js';
import { detectGltf, parseGltf } from './loaders/gltf.js';
import { detectObj, parseObj } from './loaders/obj.js';
import { gltfJsonInfo } from './analyze/gltf-json.js';
import type { FormatEntry } from './types.js';

const FBX_ENTRY: FormatEntry = {
  id: 'fbx',
  extensions: ['.fbx'],
  hasAnimation: true,
  detect: detectFbx,
  load: (data, ctx) => parseFbx(data, ctx),
};

const GLTF_ENTRY: FormatEntry = {
  id: 'gltf',
  extensions: ['.gltf', '.glb', '.vrm'],
  hasAnimation: true,
  detect: detectGltf,
  load: (data, ctx) => parseGltf(data, ctx),
  fastInfo: (data, fileName) => gltfJsonInfo(data, fileName),
};

const OBJ_ENTRY: FormatEntry = {
  id: 'obj',
  extensions: ['.obj'],
  hasAnimation: false,
  detect: detectObj,
  load: (data, ctx) => parseObj(data, ctx),
};

export const FORMAT_ENTRIES: readonly FormatEntry[] = [FBX_ENTRY, GLTF_ENTRY, OBJ_ENTRY];

/** 找不到返回 null，由调用方给自愈指引（unknownFormatError） */
export function detectFormat(head: Uint8Array, fileName: string): FormatEntry | null {
  // 内容优先：magic / 结构特征先判，扩展名只是内容判不出来时的兜底提示
  for (const entry of FORMAT_ENTRIES) {
    if (entry.detect(head, '')) return entry;
  }
  for (const entry of FORMAT_ENTRIES) {
    if (entry.detect(head, fileName)) return entry;
  }
  return null;
}

/**
 * 纯内容格式探测（忽略文件名/扩展名）：文件浏览、同资产扫描、附件落盘等
 * 「不同项目命名约束不同」的场景用——判定只来自字节内容（FBX magic/ASCII 头、glTF JSON/GLB magic、OBJ 关键字）。
 */
export function detectFormatByContent(head: Uint8Array): FormatEntry | null {
  for (const entry of FORMAT_ENTRIES) {
    if (entry.detect(head, '')) return entry;
  }
  return null;
}

/** 内容嗅探：这个字节串看起来是不是可分析的模型（不看文件名） */
export function looksLikeModelBytes(head: Uint8Array): boolean {
  return detectFormatByContent(head) !== null;
}

/** 未识别/明确不支持的输入 → 「错在哪 + 正确姿势」（设计文档 §3.3） */
export function unknownFormatError(fileName: string): KinemeshError {
  const ext = extensionOf(fileName);
  if (ext === '.max') {
    return new KinemeshError(
      '.max 是 3ds Max 的私有工程格式，没有开源解析器。',
      '在 3ds Max 中：文件 → 导出 → FBX（勾选「烘焙动画」「嵌入媒体」），或导出 glTF/GLB 后重试。',
    );
  }
  if (ext === '.blend') {
    return new KinemeshError(
      '.blend 是 Blender 工程文件，本阶段动画支持有限。',
      '在 Blender 中导出 GLB/FBX 后分析；带动画的资产导出前先烘焙动作（物体 → 动画 → 烘焙动作）。',
    );
  }
  if (['.nif', '.psk', '.pskx', '.gr2', '.smd', '.mdl', '.usd', '.usda', '.usdc'].includes(ext)) {
    return new KinemeshError(
      `${ext} 是引擎/私有格式，本工具不直接解析。`,
      '用离线工具转成 GLB 后再进本工具：通用路线是 Blender 导入后导出 GLB，或对应引擎的官方导出器；转换时把约束/IK 烘焙成关键帧。',
    );
  }
  return new KinemeshError(
    `不认识的格式（${fileName}${ext === '' ? '' : `，扩展名 ${ext}`}）。`,
    '本工具支持 FBX / glTF / GLB / OBJ（VRM 按 GLB 处理）；其他格式先离线转 GLB（FBX2glTF / Blender 导出）再试。',
  );
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return '';
  return fileName.slice(dot).toLowerCase();
}
