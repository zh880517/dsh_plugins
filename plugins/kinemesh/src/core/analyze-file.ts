// 顶层入口：buffer + 文件名 → InfoReport / CanonicalScene。DSH 工具 / CLI / MCP 三出口共用这一份。
import { sceneToInfo } from './analyze/scene-info.js';
import { KinemeshError } from './errors.js';
import { detectFormat, unknownFormatError } from './registry.js';
import { getCachedScene } from './scene-cache.js';
import type { CanonicalScene, FormatEntry, InfoReport } from './types.js';

/** 性能预算（设计文档 §10 的默认值）：超过按「文件过大」报错并给减负指引 */
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const DETECT_HEAD_BYTES = 1024;

async function checkBudget(data: ArrayBuffer, fileName: string): Promise<void> {
  if (data.byteLength === 0) {
    throw new KinemeshError(`文件是空的：${fileName}`, '确认路径与文件本身（0 字节的文件没法分析），必要时重新导出。');
  }
  if (data.byteLength > MAX_FILE_BYTES) {
    throw new KinemeshError(
      `文件 ${(data.byteLength / 1024 / 1024).toFixed(0)} MiB，超过 ${MAX_FILE_BYTES / 1024 / 1024} MiB 的分析上限。`,
      '先离线给模型减负（减面 / 清理贴图 / 去掉多余动画 take）再分析，或对导出的 LOD 版本做信息提取。',
    );
  }
}

/** info 提取：buffer + 文件名 → InfoReport（glTF 走纯 JSON 快速路径） */
export async function analyzeModel(data: ArrayBuffer, fileName: string): Promise<InfoReport> {
  await checkBudget(data, fileName);
  const entry = detectFormat(headBytes(data), fileName);
  if (entry === null) throw unknownFormatError(fileName);
  return analyzeWith(entry, data, fileName);
}

/**
 * info 提取的缓存变体（M6f review 补接线，§6.2）：glTF 有 fastInfo → 纯 JSON 快速路径
 * （不构造场景、不进缓存）；无 fastInfo 的格式（FBX / OBJ，registry 里只有 glTF 有 fastInfo）
 * 的 entry.load 是 Node 端构造场景的最贵路径 → 走 path+mtime 进程内缓存。
 * sceneToInfo 只读（traverse + Box3，不改节点变换），复用缓存实例安全。
 */
export async function analyzeModelCached(absPath: string, data: ArrayBuffer, fileName: string): Promise<InfoReport> {
  await checkBudget(data, fileName);
  const entry = detectFormat(headBytes(data), fileName);
  if (entry === null) throw unknownFormatError(fileName);
  if (entry.fastInfo !== undefined) return entry.fastInfo(data, fileName);
  const scene = await getCachedScene(absPath, () => entry.load(data, { fileName }));
  return sceneToInfo(scene, {
    fileName,
    fileSize: data.byteLength,
    expectsAnimation: entry.hasAnimation,
  });
}

/**
 * 动作分析（M6d）专用：完整加载路径拿 CanonicalScene（glTF 不走快速路径——快速路径只有 min/max，
 * 无法逐帧采样，见设计文档 §6.2）。空文件 / 超限 / 未知格式的口径与 analyzeModel 一致。
 */
export async function loadModelScene(data: ArrayBuffer, fileName: string): Promise<{ entry: FormatEntry; scene: CanonicalScene }> {
  await checkBudget(data, fileName);
  const entry = detectFormat(headBytes(data), fileName);
  if (entry === null) throw unknownFormatError(fileName);
  const scene = await entry.load(data, { fileName });
  return { entry, scene };
}

export async function analyzeWith(entry: FormatEntry, data: ArrayBuffer, fileName: string): Promise<InfoReport> {
  if (entry.fastInfo !== undefined) return entry.fastInfo(data, fileName);
  const scene = await entry.load(data, { fileName });
  return sceneToInfo(scene, {
    fileName,
    fileSize: data.byteLength,
    expectsAnimation: entry.hasAnimation,
  });
}

function headBytes(data: ArrayBuffer): Uint8Array {
  return new Uint8Array(data, 0, Math.min(DETECT_HEAD_BYTES, data.byteLength));
}
