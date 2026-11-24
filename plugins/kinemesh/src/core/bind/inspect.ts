// mesh 参数绑定体检（0.10.0）：kinemesh_info 的 mesh 参数用——加载两个文件、自动识别角色、
// 试算骨骼绑定，返回 mesh 文件的结构报告 + 绑定可行性（不只是路径检查，AI 能直接据此决定怎么渲染）。
//
// Node 专用（读 fs 缓存 + sceneToInfo）；绑定失败不致命：info 仍返回主报告，error 段给三段式。
import { loadModelScene } from '../analyze-file.js';
import { sceneToInfo } from '../analyze/scene-info.js';
import { KinemeshError } from '../errors.js';
import { getCachedScene } from '../scene-cache.js';
import type { CanonicalScene, InfoReport } from '../types.js';
import { applyPlan, sceneFacts, type CompanionBinding } from './bundle.js';
import type { ClipBindingReport } from './remap.js';
import { planCompanion, type CompanionPlan } from './roles.js';

export interface CompanionInspectionInput {
  data: ArrayBuffer;
  fileName: string;
  abs: string;
}

export interface CompanionInspection {
  /** mesh 参数文件的 InfoReport（网格/骨骼/贴图/包围盒） */
  companionInfo: InfoReport;
  /** 角色自动识别结果（可能因两侧都缺网格/动画为 null） */
  plan: CompanionPlan | null;
  /** 绑定报告（网格与动画同源时为 null） */
  report: ClipBindingReport | null;
  /** 给 AI 读的中文事实句 */
  facts: string[];
  warnings: string[];
  /** 非致命问题（mesh 参数配错 / 骨骼完全不匹配）：info 仍成功，但绑定不可用 */
  error: { what: string; guidance: string } | null;
}

/** 加载两个文件并试算绑定（场景走 path+mtime 进程内缓存） */
export async function inspectCompanion(
  primary: CompanionInspectionInput,
  companion: CompanionInspectionInput,
): Promise<CompanionInspection> {
  const primaryScene = await cachedScene(primary);
  const companionScene = await cachedScene(companion);
  const companionInfo = sceneToInfo(companionScene, {
    fileName: companion.fileName,
    fileSize: companion.data.byteLength,
    expectsAnimation: true,
  });

  const names = { primary: primary.fileName, companion: companion.fileName };
  const facts: string[] = [];
  const warnings: string[] = [];
  let plan: CompanionPlan | null = null;
  let report: ClipBindingReport | null = null;
  let error: { what: string; guidance: string } | null = null;

  try {
    plan = planCompanion(sceneFacts(primaryScene), sceneFacts(companionScene), names);
  } catch (cause) {
    error = toErrorMessage(cause);
    return { companionInfo, plan, report, facts, warnings, error };
  }

  try {
    const binding: CompanionBinding = applyPlan(primaryScene, companionScene, plan, names);
    report = binding.report;
    facts.push(...binding.facts);
    warnings.push(...binding.warnings);
  } catch (cause) {
    error = toErrorMessage(cause);
  }
  return { companionInfo, plan, report, facts, warnings, error };
}

async function cachedScene(input: CompanionInspectionInput): Promise<CanonicalScene> {
  return getCachedScene(input.abs, async () => (await loadModelScene(input.data, input.fileName)).scene);
}

function toErrorMessage(cause: unknown): { what: string; guidance: string } {
  if (cause instanceof KinemeshError) return { what: cause.message, guidance: cause.guidance };
  return { what: cause instanceof Error ? cause.message : String(cause), guidance: '确认两个文件都能被 kinemesh_info 解析后重试。' };
}

/** info 输出里的绑定段（紧凑 JSON，数值由 core 产出） */
export function companionBindingJson(inspection: CompanionInspection): Record<string, unknown> {
  return {
    plan: inspection.plan,
    report: inspection.report,
    facts: inspection.facts,
    warnings: inspection.warnings,
    ...(inspection.error === null ? {} : { error: inspection.error }),
  };
}


