// 顶层入口：buffer + 文件名 → InfoReport。DSH 工具 / CLI / MCP 三出口共用这一份。
import { sceneToInfo } from './analyze/scene-info.js';
import { KinemeshError } from './errors.js';
import { detectFormat, unknownFormatError } from './registry.js';
import type { FormatEntry, InfoReport } from './types.js';

/** 性能预算（设计文档 §10 的默认值）：超过按「文件过大」报错并给减负指引 */
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const DETECT_HEAD_BYTES = 1024;

export async function analyzeModel(data: ArrayBuffer, fileName: string): Promise<InfoReport> {
  if (data.byteLength === 0) {
    throw new KinemeshError(`文件是空的：${fileName}`, '确认路径与文件本身（0 字节的文件没法分析），必要时重新导出。');
  }
  if (data.byteLength > MAX_FILE_BYTES) {
    throw new KinemeshError(
      `文件 ${(data.byteLength / 1024 / 1024).toFixed(0)} MiB，超过 ${MAX_FILE_BYTES / 1024 / 1024} MiB 的分析上限。`,
      '先离线给模型减负（减面 / 清理贴图 / 去掉多余动画 take）再分析，或对导出的 LOD 版本做信息提取。',
    );
  }
  const entry = detectFormat(headBytes(data), fileName);
  if (entry === null) throw unknownFormatError(fileName);
  return analyzeWith(entry, data, fileName);
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
