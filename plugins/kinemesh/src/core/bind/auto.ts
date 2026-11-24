// 自动识别同资产 mesh 文件（0.10.0；0.10.1 改为内容扫描、不依赖文件名）：
// 动作-only 文件（没有网格）在预览/截图前，自动在附近找「真的有网格、骨骼能和动作对上」的模型文件并绑定。
//
// 判定全部来自文件内容（core/bind/scan.ts）：先字节探测出有网格的文件（FBX 的 Geometry、glTF 的 meshes），
// 再按骨骼名覆盖率排序；文件名/目录名不参与判定（各项目命名约束不同）。
// Node 专用（读 fs + 解析）。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadModelScene } from '../analyze-file.js';
import { getCachedScene } from '../scene-cache.js';
import { collectSkeletonNames, findCompanionMeshes } from './scan.js';

export interface ResolvedCompanionFile {
  data: ArrayBuffer;
  fileName: string;
  abs: string;
  /** 发现理由（自动识别时写进 warnings） */
  reason: string;
}

export interface AutoCompanionResolution {
  companion: ResolvedCompanionFile | null;
  warnings: string[];
}

/**
 * 给一个「可能没有网格」的模型文件自动找同资产网格文件（内容扫描 + 骨骼覆盖率评分）。
 * - path 文件有网格 → 不触发（companion=null、无警告）；
 * - path 文件解析失败 → 不触发（错误交给后续渲染/分析链路报）；
 * - 找到 → companion + 一条「已自动识别」警告（含覆盖率与其它候选）；找不到 → 「如何显式指定」警告。
 */
export async function autoResolveCompanion(
  primaryAbs: string,
  primaryData: ArrayBuffer,
  primaryFileName: string = path.basename(primaryAbs),
): Promise<AutoCompanionResolution> {
  let hasMesh: boolean;
  let skeletonNames: string[];
  try {
    const scene = await getCachedScene(
      primaryAbs,
      async () => (await loadModelScene(primaryData, primaryFileName)).scene,
    );
    hasMesh = false;
    scene.object.traverse((child) => {
      if ((child as { isMesh?: boolean }).isMesh === true) hasMesh = true;
    });
    skeletonNames = collectSkeletonNames(scene);
  } catch {
    // 解析失败（损坏/格式不支持）：不在这里二次报错，交给调用方原有的错误链路
    return { companion: null, warnings: [] };
  }
  if (hasMesh) return { companion: null, warnings: [] };

  const matches = await findCompanionMeshes(primaryAbs, skeletonNames);
  if (matches.length === 0) {
    return { companion: null, warnings: [missingMeshWarning()] };
  }
  const top = matches[0]!;
  try {
    const buffer = await readFile(top.path);
    const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    const alternatives = matches.slice(1, 4).map((match) => match.name);
    // 多个候选骨骼覆盖率并列时明确说明「只是按体积/目录近选了一个」——各项目对 LOD/皮肤变体的选择规则不同
    const tied = matches
      .slice(1)
      .filter((match) => Math.abs(match.coverage - top.coverage) < 1e-6 && match.matchedBones === top.matchedBones)
      .map((match) => match.name);
    return {
      companion: { data, fileName: top.name, abs: top.path, reason: top.reason },
      warnings: [
        `path 文件没有网格（动画-only）：已按文件内容自动识别同资产的网格文件「${top.name}」并交给绑定（${top.reason}）；` +
          '绑定按骨骼名自动匹配（未命中骨骼保持 rest 姿态）。替换网格用 mesh 参数显式指定。' +
          (alternatives.length > 0 ? `其它候选：${alternatives.join('、')}。` : '') +
          (tied.length > 0
            ? `其中 ${tied.length} 个候选骨骼覆盖率与它并列（${tied.join('、')}）——不同项目对 LOD/皮肤变体的取舍规则不同，` +
              '已按文件体积从小到大选；要指定的变体请用 mesh 参数。'
            : ''),
      ],
    };
  } catch {
    return { companion: null, warnings: [missingMeshWarning()] };
  }
}

function missingMeshWarning(): string {
  return (
    'path 文件没有网格（动画-only），附近也没有找到「有网格且骨骼能对上」的模型文件：按骨架预览/截图；' +
    '要带网格请用 mesh 参数指定网格文件（先 kinemesh_info 确认该文件 meshes 非空）。'
  );
}
