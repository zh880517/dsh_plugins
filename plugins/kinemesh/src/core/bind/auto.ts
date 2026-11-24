// 自动识别同资产 mesh 文件（0.10.0）：动作-only 文件（没有网格）在预览/截图前，
// 自动找同资产的网格文件并绑定，用户不必先知道路径（对应需求「让工具自动识别然后绑定」）。
//
// 只有 path 文件**确实没有网格**时才触发；候选先按命名/目录启发式排序，再逐个解析确认 meshes 非空
// （最多试 3 个，避免长尾资产扫很久）。找到就带警告说明，找不到就退回无网格（骨架）渲染。
// Node 专用（读 fs + 解析）。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeModelCached } from '../analyze-file.js';
import { discoverCompanionMeshes } from './discover.js';

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

/** 最多解析多少个候选（每个都是一次完整场景加载） */
const MAX_CANDIDATE_PARSES = 3;

/**
 * 给一个「可能没有网格」的模型文件自动找同资产网格文件。
 * - path 文件有网格 → 不触发（companion=null、无警告）；
 * - path 文件解析失败 → 不触发（错误交给后续渲染/分析链路报）；
 * - 找到 → companion + 一条「已自动识别」警告；找不到 → 一条「如何显式指定」警告。
 */
export async function autoResolveCompanion(
  primaryAbs: string,
  primaryData: ArrayBuffer,
  primaryFileName: string = path.basename(primaryAbs),
): Promise<AutoCompanionResolution> {
  let hasMesh: boolean;
  try {
    const report = await analyzeModelCached(primaryAbs, primaryData, primaryFileName);
    hasMesh = report.meshes.length > 0;
  } catch {
    // 解析失败（损坏/格式不支持）：不在这里二次报错，交给调用方原有的错误链路
    return { companion: null, warnings: [] };
  }
  if (hasMesh) return { companion: null, warnings: [] };

  const candidates = await discoverCompanionMeshes(primaryAbs);
  if (candidates.length === 0) {
    return { companion: null, warnings: [missingMeshWarning()] };
  }

  const tried: string[] = [];
  for (const candidate of candidates.slice(0, MAX_CANDIDATE_PARSES)) {
    let companion: ResolvedCompanionFile | null = null;
    try {
      const buffer = await readFile(candidate.path);
      const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
      const report = await analyzeModelCached(candidate.path, data, candidate.name);
      if (report.meshes.length > 0) {
        companion = { data, fileName: candidate.name, abs: candidate.path, reason: candidate.reason };
      } else {
        tried.push(candidate.name);
      }
    } catch {
      tried.push(candidate.name);
    }
    if (companion !== null) {
      const alternatives = candidates
        .filter((entry) => entry.path !== candidate.path)
        .map((entry) => entry.name)
        .slice(0, 3);
      return {
        companion,
        warnings: [
          `path 文件没有网格（动画-only）：已自动识别同资产的网格文件「${candidate.name}」（${candidate.reason}）并交给绑定；` +
            '绑定按骨骼名自动匹配（未命中骨骼保持 rest 姿态）。替换网格用 mesh 参数显式指定。' +
            (alternatives.length > 0 ? `其它候选：${alternatives.join('、')}。` : ''),
        ],
      };
    }
  }
  return {
    companion: null,
    warnings: [
      `path 文件没有网格（动画-only），同资产没有找到可用的网格文件` +
        (tried.length > 0 ? `（已尝试：${tried.join('、')}）` : '') +
        `：按骨架预览/截图；要带网格请用 mesh 参数指定网格文件。`,
    ],
  };
}

function missingMeshWarning(): string {
  return (
    'path 文件没有网格（动画-only），同资产目录里也没有发现候选网格文件：按骨架预览/截图；' +
    '要带网格请用 mesh 参数指定网格文件（先 kinemesh_info 确认该文件 meshes 非空）。'
  );
}


