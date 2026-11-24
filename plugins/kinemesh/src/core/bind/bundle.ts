// 独立 mesh 文件绑定（0.10.0）：动作文件不带 mesh 时，用另一个 mesh 文件做渲染主体，
// 把动作片段按骨骼名绑定过去。本模块是「加载 + 角色自动识别 + 绑定」的共用入口，
// 三个出口（DSH 预览面板 / 截图页 / CLI·MCP）都用它，保证「预览里看到的 = 截图拿到的」。
//
// 浏览器安全：只依赖 registry（格式探测）与 three；Node 端同样可跑（loader 内部对贴图做了桩）。
import { KinemeshError } from '../errors.js';
import { detectFormat, unknownFormatError } from '../registry.js';
import type { CanonicalScene } from '../types.js';
import { bindClipsToModel, bindingFacts, type ClipBindingReport } from './remap.js';
import { assignmentFacts, planCompanion, type CompanionNames, type CompanionPlan, type SceneFacts } from './roles.js';

export interface SceneSource {
  data: ArrayBuffer;
  fileName: string;
}

/** 已加载场景的结构判定事实（角色分配用） */
export function sceneFacts(scene: CanonicalScene): SceneFacts {
  let meshCount = 0;
  let boneCount = 0;
  scene.object.traverse((child) => {
    if ((child as { isMesh?: boolean }).isMesh === true) meshCount += 1;
    if ((child as { isBone?: boolean }).isBone === true) boneCount += 1;
  });
  return {
    hasMesh: meshCount > 0,
    meshCount,
    clipCount: scene.animations.length,
    boneCount,
  };
}

/** 格式探测 + 解析一个模型字节流（浏览器/Node 通用；空文件给三段式） */
export async function loadSceneFromData(data: ArrayBuffer, fileName: string): Promise<CanonicalScene> {
  if (data.byteLength === 0) {
    throw new KinemeshError(`文件是空的：${fileName}`, '确认路径与文件本身（0 字节的文件没法分析），必要时重新导出。');
  }
  const head = new Uint8Array(data, 0, Math.min(1024, data.byteLength));
  const entry = detectFormat(head, fileName);
  if (entry === null) throw unknownFormatError(fileName);
  return entry.load(data, { fileName });
}

/** 绑定结果：scene 是可直接交给 viewer 的最终场景（mesh 对象 + 重绑定后的动画） */
export interface CompanionBinding {
  scene: CanonicalScene;
  plan: CompanionPlan;
  /** null = 两侧网格/动画来自同一文件（无需绑定） */
  report: ClipBindingReport | null;
  /** 给 AI 读的中文事实句（角色分配 + 命中统计） */
  facts: string[];
  warnings: string[];
}

/**
 * 按已识别好的角色分配合成最终场景（bindScenes 的第二步；info 需要在 plan 报错时仍能拿到
 * 角色信息，所以拆开）。完全不匹配时抛 KinemeshError（三段式）。
 */
export function applyPlan(
  primary: CanonicalScene,
  companion: CanonicalScene,
  plan: CompanionPlan,
  names: CompanionNames = { primary: 'path 文件', companion: 'mesh 参数文件' },
): CompanionBinding {
  const warnings = [...plan.warnings];
  const facts = assignmentFacts(plan, names);
  const meshScene = plan.mesh === 'primary' ? primary : companion;

  // 网格与动画同源：不需要绑定（mesh 参数文件本身带动画，或 path 文件自带网格+动画）
  if (plan.mesh === plan.animation) {
    return { scene: meshScene, plan, report: null, facts, warnings };
  }

  const animScene = plan.animation === 'primary' ? primary : companion;
  if (animScene.animations.length === 0) {
    throw new KinemeshError(
      `动画侧没有可用片段：${plan.animation === 'primary' ? names.primary : names.companion} 没有解析到 AnimationClip。`,
      '先 kinemesh_info 确认哪个文件的 clips 非空，再把动画文件作为 path、网格文件作为 mesh 参数。',
    );
  }
  const { clips, report } = bindClipsToModel(meshScene.object, animScene.animations, animScene.object);
  if (!report.ok) {
    throw new KinemeshError(
      `动画与 mesh 骨骼完全不匹配：动画 ${report.animNodes} 个节点没有一个命中 mesh 骨架（${report.meshBones} 根骨骼，` +
        `示例节点：${report.unmatchedNodes.join('、')}）。`,
      '确认两个文件来自同一套 rig（骨骼名要能对上，如 Bip001_Spine / mixamorig:Hips 这类）；' +
        '动画只导出部分骨骼也能绑定（例如 5 根脊柱的受击附加动画），但至少要命中一根；' +
        '分别对两个文件跑 kinemesh_info 对比 bones/convention，或先用 kinemesh_skeleton 看骨骼清单。',
    );
  }
  warnings.push(...report.warnings);
  facts.push(...bindingFacts(report));
  const scene: CanonicalScene = {
    object: meshScene.object,
    animations: clips,
    meta: meshScene.meta,
  };
  return { scene, plan, report, facts, warnings };
}

/**
 * 把 mesh 文件与动画文件合成一个可渲染场景：
 * 自动识别谁提供网格、谁提供动画（支持两个参数传反），按骨骼名把动画轨道重绑定到 mesh 骨架。
 */
export function bindScenes(primary: CanonicalScene, companion: CanonicalScene, companionFileName: string, primaryFileName = 'path 文件'): CompanionBinding {
  const names: CompanionNames = { primary: primaryFileName, companion: companionFileName };
  const plan = planCompanion(sceneFacts(primary), sceneFacts(companion), names);
  return applyPlan(primary, companion, plan, names);
}

export interface CompanionLoad {
  scene: CanonicalScene;
  /** null = 没给 mesh 参数（不涉及绑定） */
  binding: CompanionBinding | null;
}

/** 加载 path 文件（可选再加载 mesh 参数文件）并完成自动绑定；没给 mesh 时不涉及绑定 */
export async function loadSceneWithCompanion(primary: SceneSource, companion?: SceneSource): Promise<CompanionLoad> {
  const primaryScene = await loadSceneFromData(primary.data, primary.fileName);
  if (companion === undefined) return { scene: primaryScene, binding: null };
  const companionScene = await loadSceneFromData(companion.data, companion.fileName);
  const binding = bindScenes(primaryScene, companionScene, companion.fileName, primary.fileName);
  return { scene: binding.scene, binding };
}
