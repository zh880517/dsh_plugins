// 角色分配（0.10.0「独立 mesh 文件」）：给定 path 文件与 mesh 参数文件，自动判断
// 「谁提供网格、谁提供动画」——用户不必记住参数顺序（自动识别，错序也能纠正），
// 两个文件都缺网格/动画时给出三段式自愈文案。
//
// 纯逻辑（不碰 three / fs），Node 与浏览器（预览面板）共用；单测直调。
import { KinemeshError } from '../errors.js';

/** 一侧场景的判定事实（由已加载场景统计出来） */
export interface SceneFacts {
  /** 有没有可渲染的网格（isMesh） */
  hasMesh: boolean;
  /** 网格数（与 hasMesh 同步，给报告/提示用） */
  meshCount: number;
  /** 动画片段数 */
  clipCount: number;
  /** 骨骼数（信息性字段） */
  boneCount: number;
}

export type SceneSide = 'primary' | 'companion';

export interface CompanionNames {
  /** path 文件（缺省「path 文件」） */
  primary: string;
  /** mesh 参数文件（缺省「mesh 文件」） */
  companion: string;
}

export interface CompanionPlan {
  /** 哪个文件提供网格（渲染主体） */
  mesh: SceneSide;
  /** 哪个文件提供动画片段 */
  animation: SceneSide;
  /** 自动纠正/注意事项（透传到工具 warnings） */
  warnings: string[];
}

/**
 * 自动识别两侧角色：
 * · 网格优先 mesh 参数文件；它没有网格时退回 path 文件自带的网格；
 * · 动画优先 path 文件；它没有动画时改用 mesh 参数文件的片段（支持两个参数传反）。
 * 两侧都没有网格 / 都没有动画 → KinemeshError（三段式）。
 */
export function planCompanion(
  primary: SceneFacts,
  companion: SceneFacts,
  names: CompanionNames = { primary: 'path 文件', companion: 'mesh 参数文件' },
): CompanionPlan {
  const warnings: string[] = [];

  let mesh: SceneSide;
  if (companion.hasMesh) {
    mesh = 'companion';
    if (primary.hasMesh) {
      warnings.push(
        `${names.primary} 自带网格，但按 mesh 参数改用「${names.companion}」的网格做渲染主体` +
          `（想用 ${names.primary} 自己的网格，去掉 mesh 参数）。`,
      );
    }
  } else if (primary.hasMesh) {
    mesh = 'primary';
    warnings.push(`mesh 参数文件「${names.companion}」没有网格，网格改用 ${names.primary} 自带的。`);
  } else {
    throw new KinemeshError(
      `两个文件都没有网格（mesh）：${names.primary}、${names.companion} 都只有骨架/动画。`,
      'mesh 参数要指向角色网格文件（例如游戏资产里的 basic/*_skin.fbx，可先用 kinemesh_info 确认 meshes 非空）；' +
        '纯动画文件只能做骨架预览与动作分析，无法带网格出图。',
    );
  }

  let animation: SceneSide;
  if (primary.clipCount > 0) {
    animation = 'primary';
  } else if (companion.clipCount > 0) {
    animation = 'companion';
    warnings.push(`path 文件「${names.primary}」没有动画片段，动画改用 mesh 参数文件「${names.companion}」的片段。`);
  } else {
    throw new KinemeshError(
      `两个文件都没有动画片段：${names.primary}、${names.companion}。`,
      'mesh 参数只负责「给动作套网格」，动画得来自 path 文件（先 kinemesh_info 确认 clips 非空）；' +
        '要渲染静态模型请去掉 mesh 参数直接渲染 path 文件。',
    );
  }

  if (mesh === animation) {
    warnings.push(
      `网格与动画都来自${mesh === 'primary' ? ` ${names.primary}` : `「${names.companion}」`}：` +
        `另一侧文件没有用上（${mesh === 'primary' ? 'mesh 参数文件' : 'path 文件'}既没有网格也没有可用动画）。`,
    );
  }
  return { mesh, animation, warnings };
}

/** 角色分配 → 给 AI 读的中文事实句（info/CLI/MCP 共用） */
export function assignmentFacts(plan: CompanionPlan, names: CompanionNames = { primary: 'path 文件', companion: 'mesh 参数文件' }): string[] {
  const meshLabel = plan.mesh === 'primary' ? names.primary : `「${names.companion}」`;
  const animLabel = plan.animation === 'primary' ? names.primary : `「${names.companion}」`;
  return [`网格来自 ${meshLabel}，动画来自 ${animLabel}；骨骼按名字自动绑定。`];
}
