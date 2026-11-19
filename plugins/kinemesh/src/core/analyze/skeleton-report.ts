// skeleton-report 组装（design.md §7.3 / 附录 B.3–B.7）：场景遍历出骨骼清单（名称/层级/rest 世界
// 坐标）→ 字典查表与映射文件叠加 partGuess → convention 判定、映射覆盖统计、结构统计、
// B.4 标注截图 stride 批次清单（只出渲染配方，渲染由 kinemesh_render 执行）。
// 本模块吃 CanonicalScene（three）；bone-map.ts 保持纯逻辑，场景相关都在这里。
import * as THREE from 'three';
import { CONVENTION_MIN, LABELS_PER_SHOT } from '../motion/constants.js';
import {
  CORE15_IDS,
  detectConvention,
  matchCanonical,
  coreIdOf,
  type Archetype,
  type BonesMapping,
  type ConventionDetection,
} from './bone-map.js';
import { sceneBoundsHeight } from './scene-info.js';
import type { CanonicalScene } from '../types.js';

// ———————— 场景骨骼清单 ————————

export interface SkeletonNode {
  name: string;
  /** 骨架集合内最近父骨名；根骨为 null */
  parent: string | null;
  /** 骨架集合内深度（根骨 = 0） */
  depth: number;
  /** 骨架集合内直接子骨名（DFS 序） */
  children: string[];
  /** rest 世界坐标（模型单位，3 位小数） */
  restWorldPos: [number, number, number];
  /** 在完整清单里的 DFS 序号（B.4 批次分配用） */
  dfsIndex: number;
}

export interface SkeletonSet {
  nodes: SkeletonNode[];
  /** 骨骼名 → 最近父骨名（根为 null）；映射文件对骨架校验用 */
  parentOf: Map<string, string | null>;
}

/** 与 sample.ts collectCandidates 同口径：有 Bone 收 Bone，否则收命名节点；空名节点跳过。
 *  Mesh 一律跳过——骨架清单是关节，不是渲染网格（GLTFLoader 还会给未命名 mesh 起别名 mesh_0）。 */
export function collectSkeletonSet(scene: CanonicalScene): SkeletonSet {
  const root = scene.object;
  let hasBones = false;
  root.traverse((obj) => {
    if (obj !== root && (obj as THREE.Bone).isBone) hasBones = true;
  });
  const raw: Array<{ node: SkeletonNode; object: THREE.Object3D }> = [];
  const walk = (obj: THREE.Object3D, parent: SkeletonNode | null): void => {
    for (const child of obj.children) {
      let node: SkeletonNode | null = null;
      if (child.name !== '' && !(child as THREE.Mesh).isMesh && (!hasBones || (child as THREE.Bone).isBone)) {
        node = {
          name: child.name,
          parent: parent === null ? null : parent.name,
          depth: parent === null ? 0 : parent.depth + 1,
          children: [],
          restWorldPos: [0, 0, 0],
          dfsIndex: 0,
        };
        raw.push({ node, object: child });
      }
      walk(child, node ?? parent);
    }
  };
  walk(root, null);
  root.updateMatrixWorld(true);
  const scratch = new THREE.Vector3();
  const nodes = raw.map((entry, index) => {
    const node = entry.node;
    entry.object.getWorldPosition(scratch);
    node.dfsIndex = index;
    node.restWorldPos = [scratch.x, scratch.y, scratch.z].map((axis) => Number(axis.toFixed(3))) as [number, number, number];
    return node;
  });
  const byName = new Map(nodes.map((node) => [node.name, node]));
  for (const node of nodes) {
    if (node.parent !== null) byName.get(node.parent)?.children.push(node.name);
  }
  const parentOf = new Map(nodes.map((node) => [node.name, node.parent]));
  return { nodes, parentOf };
}

// ———————— skeleton-report（§7.3 字段） ————————

export interface SkeletonBoneEntry {
  name: string;
  parent: string | null;
  depth: number;
  children: string[];
  restWorldPos: [number, number, number];
  /** B.0 canonical id / 非人形部位标签（root/head/spine/limb:<role>[:tag]）；未映射为 null */
  partGuess: string | null;
  /** high = 精确 token / 映射文件；medium = 子串兜底；null = 未映射 */
  confidence: 'high' | 'medium' | null;
  /** file = 映射文件；dict = 字典查表；null = 未映射 */
  source: 'file' | 'dict' | null;
}

export interface LabelBatch {
  /** 1 起两序号（PNG 命名里的两位 batch） */
  batch: number;
  bones: string[];
  views: ['front', 'side'];
  mode: 'skeleton';
  frames: [0];
  /** 每视角一张：labels-<view>-<batch 两位>.png（B.4 命名） */
  files: string[];
}

export interface SkeletonReport {
  fileName: string;
  boneCount: number;
  bones: SkeletonBoneEntry[];
  convention: ConventionDetection;
  coverage: {
    mapped: number;
    total: number;
    core: { hit: number; total: number };
  };
  unmapped: string[];
  /** 结构统计（工具只数数不判定，给 AI 当原料，§7.2） */
  stats: { limbChains: number; groundTips: number; symmetryPairs: number; maxChainDepth: number };
  archetype: Archetype | null;
  boneMap: { source: string; archetype: Archetype; mapped: number } | null;
  /** B.7 非人形通道泛化说明（archetype ≠ humanoid 时非空） */
  generalization: string[] | null;
  /** 多骨同槽中位保留 / 缺 side 未映射等非致命说明 */
  notes: string[];
  batches: LabelBatch[];
  renderRecipe: {
    frames: [0];
    views: ['front', 'side'];
    mode: 'skeleton';
    shots: 'auto' | 'none' | 'all';
    note: string;
  };
  /** 映射文件 schema 尾注（B.5，AI 写文件的唯一模板来源） */
  schemaNote: string;
  constants: { CONVENTION_MIN: number; LABELS_PER_SHOT: number };
}

const GROUND_TIP_RATIO = 0.05;
const SYMMETRY_TOLERANCE = 0.02;

/** B.7 非人形通道泛化说明（archetype ≠ humanoid 时进 report；通道实现在后续里程碑） */
function generalizationNotes(archetype: Archetype): string[] {
  return [
    `archetype=${archetype}：非人形骨架，动作分析通道按 B.7 泛化口径执行——分析关节集 AS = {root, head（若有）, spine 中位骨（若有）, 每条 limb 的首/中/末骨}（limb > 8 取位移方差 Top-8，AS 上限 27）。`,
    '能量权重按链位（与 J15 表同源）：root 0.2 / spine 0.3 / head 1.0 / limb 首 0.6 / 中 0.8 / 末（tip）1.0；tail 同 limb 口径。',
    'heading 回退序：① 左右对称 leg 且有 head 按原式；② 有 head 取 pos(head)−pos(root) 投影 XZ；③ 根骨骼世界四元数 × (0,0,1)。',
    '接触检测泛化为「贴地肢链 tip」：tip rest 高度与全部 limb tip 最低高度差 < 0.05H 的 limb 视为腿（映射 role 仅供展示）；无贴地 limb 时 contact 置 null + warning。',
    'amplitude 末端 = 非贴地 limb 的 tips + head；强度档位阈值按人形运动校准，非人形仅作横向参考。',
    '本版本 analyze 通道尚未切换到泛化实现（仍按 J15/Top-15 口径分析），映射文件先落工程，通道切换在后续里程碑交付。',
  ];
}

const SCHEMA_NOTE = [
  'kinemesh-bones.json schema v2（写 <资产目录>/kinemesh-bones.json；工具确定性消费）：',
  '{',
  '  "_meta": { "archetype": "humanoid | quadruped | winged | multiped | chain | custom", "convention": "可选", "by": "ai", "notes": "可选" },',
  '  "root": "非 humanoid 必填（humanoid 忽略）",',
  '  "head": "按需",',
  '  "spine": ["Spine_01", "Spine_02"],',
  '  "limbs": [ { "role": "leg | arm | wing | tail", "tag": "fl（自由短标签，仅展示）", "bones": ["Leg_FL_1", "Leg_FL_2"], "tip": "Foot_FL" } ],',
  '  "bones": { "Head_01": "head", "Hand_L": "hand-l" }',
  '}',
  'humanoid：只需 bones 简写（CORE15+EXTRA id：hips / spine / head / upperarm-l|r / lowerarm-l|r / hand-l|r /',
  'upperleg-l|r / lowerleg-l|r / foot-l|r / toe-l|r / neck / chest，side 必须显式，一个 id 一根骨骼）；',
  '非 humanoid：root 必填，head/spine/limbs 按需，bones 字段忽略；limbs[].bones 按 链首→tip 逐级父子相连，tip = 末节。',
].join('\n');

export interface BuildSkeletonOptions {
  fileName: string;
  /** 已对骨架校验过的映射文件（loadBonesFile + checkBonesAgainstSkeleton 产物）；无映射文件为 null */
  mapping: BonesMapping | null;
  /** 'auto'（缺省，CORE15 有缺口才出批次）/ 'none' / 'all' */
  shots?: 'auto' | 'none' | 'all';
}

export function buildSkeletonReport(scene: CanonicalScene, options: BuildSkeletonOptions): SkeletonReport {
  const shots = options.shots ?? 'auto';
  const mapping = options.mapping ?? null;
  const { nodes } = collectSkeletonSet(scene);
  const notes: string[] = [];
  const byName = new Map(nodes.map((node) => [node.name, node]));

  // ————— partGuess：映射文件（确定性）优先，其余走字典（B.1–B.2），多骨同槽按 rest 高度中位保留 —————
  const fileParts = mapping?.parts ?? new Map<string, string>();
  const dictCandidates: Array<{ node: SkeletonNode; match: NonNullable<ReturnType<typeof matchCanonical>> }> = [];
  for (const node of nodes) {
    const filePart = fileParts.get(node.name);
    if (filePart !== undefined) continue;
    const match = matchCanonical(node.name);
    if (match !== null) dictCandidates.push({ node, match });
  }
  // 字典按 core id 分组（带侧 canonical 缺 side 的记 note 且回 AI 兜底）
  const groups = new Map<string, Array<{ node: SkeletonNode; how: 'exact' | 'substring' }>>();
  for (const { node, match } of dictCandidates) {
    const coreId = coreIdOf(match.canonical, match.side);
    if (coreId === null) {
      notes.push(`「${node.name}」命中 ${match.canonical} 但缺 side，工具不做几何猜测，留待映射文件补。`);
      continue;
    }
    const group = groups.get(coreId) ?? [];
    group.push({ node, how: match.how });
    groups.set(coreId, group);
  }
  const partByNode = new Map<SkeletonNode, { partGuess: string; confidence: 'high' | 'medium'; source: 'file' | 'dict' }>();
  for (const [boneName, part] of fileParts) {
    const node = byName.get(boneName);
    if (node === undefined) continue;
    partByNode.set(node, { partGuess: part, confidence: 'high', source: 'file' });
  }
  for (const [coreId, group] of groups) {
    if (group.length === 1) {
      partByNode.set(group[0]!.node, { partGuess: coreId, confidence: group[0]!.how === 'exact' ? 'high' : 'medium', source: 'dict' });
      continue;
    }
    // 多骨命中同一 canonical：取 rest 高度中位者（稳定排序：高度并列按 DFS 序），其余丢弃并注明（B.2）
    const sorted = [...group].sort((a, b) => a.node.restWorldPos[1] - b.node.restWorldPos[1] || a.node.dfsIndex - b.node.dfsIndex);
    const kept = sorted[Math.floor((sorted.length - 1) / 2)]!;
    partByNode.set(kept.node, { partGuess: coreId, confidence: kept.how === 'exact' ? 'high' : 'medium', source: 'dict' });
    const dropped = sorted.filter((entry) => entry !== kept).map((entry) => `「${entry.node.name}」`);
    notes.push(
      `「${kept.node.name}」与 ${dropped.join('、')} 同命中 ${coreId}：按 rest 高度中位保留「${kept.node.name}」，其余未映射。`,
    );
  }

  const bones: SkeletonBoneEntry[] = nodes.map((node) => {
    const part = partByNode.get(node);
    return {
      name: node.name,
      parent: node.parent,
      depth: node.depth,
      children: [...node.children],
      restWorldPos: node.restWorldPos,
      partGuess: part?.partGuess ?? null,
      confidence: part?.confidence ?? null,
      source: part?.source ?? null,
    };
  });

  // ————— 约定识别（B.3）与映射覆盖 —————
  const convention = detectConvention(nodes.map((node) => node.name));
  const coreIds = new Set(CORE15_IDS as readonly string[]);
  const mappedEntries = bones.filter((entry) => entry.source !== null);
  const coreHit = new Set(mappedEntries.map((entry) => entry.partGuess).filter((part) => part !== null && coreIds.has(part))).size;
  const unmapped = bones.filter((entry) => entry.partGuess === null).map((entry) => entry.name);

  // ————— 结构统计（工具只数数）：叶链数 / 贴地 tips / 镜像对称对 / 最大深度 —————
  const height = sceneBoundsHeight(scene);
  const leaves = bones.filter((entry) => entry.children.length === 0);
  const minTipY = leaves.reduce((min, entry) => Math.min(min, entry.restWorldPos[1]), Number.POSITIVE_INFINITY);
  const groundTips =
    leaves.length > 0 && height !== null && Number.isFinite(minTipY)
      ? leaves.filter((entry) => entry.restWorldPos[1] - minTipY < GROUND_TIP_RATIO * height).length
      : 0;
  const xs = bones.map((entry) => entry.restWorldPos[0]).sort((a, b) => a - b);
  const centerX = xs.length > 0 ? xs[Math.floor((xs.length - 1) / 2)]! : 0;
  // 拿不到 H（场景无几何）时对称判定没有容差基准，如实记 0 对
  let symmetryPairs = 0;
  if (height !== null) {
    const tolerance = SYMMETRY_TOLERANCE * height;
    const paired = new Set<string>();
    for (const entry of leaves) {
      if (paired.has(entry.name)) continue;
      const mirror = leaves.find(
        (other) =>
          !paired.has(other.name) &&
          other !== entry &&
          Math.abs(entry.restWorldPos[0] + other.restWorldPos[0] - 2 * centerX) <= tolerance &&
          Math.abs(entry.restWorldPos[1] - other.restWorldPos[1]) <= tolerance &&
          Math.abs(entry.restWorldPos[2] - other.restWorldPos[2]) <= tolerance,
      );
      if (mirror !== undefined) {
        paired.add(entry.name);
        paired.add(mirror.name);
        symmetryPairs += 1;
      }
    }
  }
  const maxChainDepth = bones.reduce((max, entry) => Math.max(max, entry.depth), 0);

  // ————— B.4 标注截图批次：第 i 批 = DFS 序号 ≡ i (mod B)，父子骨必然分属不同批 —————
  const mappedNames = new Set([...partByNode.keys()].map((node) => node.name));
  const batchTargets: Array<{ name: string; dfsIndex: number }> =
    shots === 'all'
      ? nodes.map((node) => ({ name: node.name, dfsIndex: node.dfsIndex }))
      : shots === 'none'
        ? []
        : unmapped.length > 0 && 15 - coreHit > 0
          ? nodes.filter((node) => !mappedNames.has(node.name)).map((node) => ({ name: node.name, dfsIndex: node.dfsIndex }))
          : [];
  const batchCount = Math.max(1, Math.ceil(batchTargets.length / LABELS_PER_SHOT));
  const batches: LabelBatch[] = [];
  for (let i = 0; i < batchCount && batchTargets.length > 0; i += 1) {
    const names = batchTargets.filter((target) => target.dfsIndex % batchCount === i).map((target) => target.name);
    if (names.length === 0) continue;
    const label = String(i + 1).padStart(2, '0');
    batches.push({
      batch: i + 1,
      bones: names,
      views: ['front', 'side'],
      mode: 'skeleton',
      frames: [0],
      files: [`labels-front-${label}.png`, `labels-side-${label}.png`],
    });
  }

  const archetype = mapping?.archetype ?? null;
  const report: SkeletonReport = {
    fileName: options.fileName,
    boneCount: bones.length,
    bones,
    convention,
    coverage: { mapped: mappedEntries.length, total: bones.length, core: { hit: coreHit, total: 15 } },
    unmapped,
    stats: { limbChains: leaves.length, groundTips, symmetryPairs, maxChainDepth },
    archetype,
    boneMap:
      mapping === null
        ? null
        : { source: mapping.source, archetype: mapping.archetype, mapped: mapping.parts.size },
    generalization: archetype !== null && archetype !== 'humanoid' ? generalizationNotes(archetype) : null,
    notes,
    batches,
    renderRecipe: {
      frames: [0],
      views: ['front', 'side'],
      mode: 'skeleton',
      shots,
      note:
        '标注截图由既有 kinemesh_render 执行：frames [0]（rest 姿态）、viewPreset front/side、mode skeleton、' +
        '相机拉远（distance ×2.2 近似正交）；PNG 命名 labels-<view>-<batch 两位>.png。' +
        'AI 读图时对照本报告的 restWorldPos/层级 与图中骨骼位置定案，结论写 <资产目录>/kinemesh-bones.json。',
    },
    schemaNote: SCHEMA_NOTE,
    constants: { CONVENTION_MIN, LABELS_PER_SHOT },
  };
  return report;
}

export function skeletonReportJson(report: SkeletonReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

// ———————— digest（§7.3：convention、unmapped 清单、report/截图路径 + 两级指引 fact） ————————

export interface SkeletonDigest {
  fileName: string;
  boneCount: number;
  convention: ConventionDetection;
  coverage: SkeletonReport['coverage'];
  unmapped: string[];
  stats: SkeletonReport['stats'];
  archetype: Archetype | null;
  boneMap: SkeletonReport['boneMap'];
  batches: LabelBatch[];
  renderRecipe: SkeletonReport['renderRecipe'];
  /** 中文事实句：convention 句 + 映射句 + 未映射句 + 固定两级指引（B.6）+ 非人形 B.7 摘要 */
  facts: string[];
  reportFile: 'skeleton-report.json';
}

export function buildSkeletonDigest(report: SkeletonReport): SkeletonDigest {
  const facts: string[] = [];
  facts.push(
    `约定识别：${report.convention.convention}（指纹命中 ${report.convention.matched}/${report.convention.total}，score ${report.convention.score.toFixed(2)}，阈值 ${report.constants.CONVENTION_MIN}）`,
  );
  const sourceText = report.boneMap === null ? '无映射文件，来源字典查表' : `映射文件 ${report.boneMap.source}（archetype ${report.boneMap.archetype}）`;
  facts.push(
    `映射覆盖：${report.coverage.mapped}/${report.coverage.total} 根骨骼（CORE15 ${report.coverage.core.hit}/15，${sourceText}）`,
  );
  if (report.unmapped.length > 0) {
    const shown = report.unmapped.slice(0, 10).join('、');
    const more = report.unmapped.length > 10 ? ` 等 ${report.unmapped.length} 根` : '';
    facts.push(`未映射骨骼 ${report.unmapped.length} 根：${shown}${more}（完整清单见 skeleton-report.json）`);
  }
  if (report.generalization !== null) {
    facts.push(`非人形骨架（${report.archetype}）：通道泛化说明与结构统计见 skeleton-report.json；强度档位按人形校准，非人形仅作横向参考。`);
  }
  // B.6 固定两级指引 fact（中文，{n} = CORE15 缺口数）
  facts.push(
    `CORE15 缺口 ${15 - report.coverage.core.hit} 个：① 读 skeleton-report.json，先判 archetype（人形/四足/带翼/多足/链形/自定义，` +
      `参考结构统计 limbChains/groundTips/symmetryPairs）——人形按名称/层级/rest 坐标对应部位，非人形给出 root/head/脊柱/肢链 → ` +
      `写 <资产目录>/kinemesh-bones.json（schema 见 report 尾注）；② 命名不透明时以 shots:"all" 重跑取标注截图再定案 → 重跑 analyze`,
  );
  return {
    fileName: report.fileName,
    boneCount: report.boneCount,
    convention: report.convention,
    coverage: report.coverage,
    unmapped: report.unmapped,
    stats: report.stats,
    archetype: report.archetype,
    boneMap: report.boneMap,
    batches: report.batches,
    renderRecipe: report.renderRecipe,
    facts,
    reportFile: 'skeleton-report.json',
  };
}
