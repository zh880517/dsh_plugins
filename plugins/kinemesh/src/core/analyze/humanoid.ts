// Humanoid 惯例识别（设计文档 §4.3）：骨骼命名匹配 hips/spine/head… 常见分类，
// 命中的分类数足够多就认为「像人形骨架」，提示可重定向。纯启发式，不追求覆盖所有命名。
const CATEGORIES: Array<[string, RegExp]> = [
  ['pelvis', /hips|pelvis/],
  ['spine', /spine|torso|chest|ribs/],
  ['neck', /neck/],
  ['head', /head|skull|jaw|eye/],
  ['shoulder', /shoulder|clavicle|collar/],
  ['arm', /arm|bicep|tricep/],
  ['elbow', /elbow/],
  ['hand', /hand|palm|finger|thumb|index|middle|ring|pinky/],
  ['leg', /leg|thigh|upleg|calf|shin|knee/],
  ['foot', /foot|ankle|toe|ball_?roll|heel/],
];

/** 至少命中这么多身体分类才判定 humanoidLike */
const MIN_CATEGORIES = 4;

// ———————— J15 关节命名惯例（M6 附录 A.0：关节集解析的纯逻辑部分） ————————

/** J15 部件类 + 足点 Toe（Toe 不进 J15，只作接触/打击的足点候选，见附录 A.6/A.8） */
export type JointKind =
  | 'hips'
  | 'spine'
  | 'head'
  | 'upper-arm'
  | 'lower-arm'
  | 'hand'
  | 'upper-leg'
  | 'lower-leg'
  | 'foot'
  | 'toe';

export interface JointClassification {
  kind: JointKind;
  side: 'L' | 'R' | null;
}

/**
 * 按命名惯例把一根骨骼分到部件类（附录 A.0）。特异性序：先具体后泛称——
 * ForeArm 要先于 arm、UpLeg 要先于 leg、Toe 要先于 foot，否则会被泛称抢走。
 * 语义上属于中轴的（hips/spine/head）不带左右侧。
 */
const JOINT_KIND_PATTERNS: Array<[JointKind, RegExp]> = [
  ['toe', /toe|ball_?roll|ball/],
  ['hand', /hand|palm|wrist/],
  ['lower-arm', /lowerarm|forearm|elbow/],
  ['upper-arm', /arm|bicep|tricep/],
  ['foot', /foot|ankle|heel/],
  ['upper-leg', /upleg|upperleg|thigh/],
  ['lower-leg', /lowerleg|calf|shin|knee|leg/],
  ['hips', /hips|pelvis/],
  ['spine', /spine|torso|chest|ribs/],
  ['head', /head|skull|jaw/],
];

/** 去掉命名空间与常见前缀：mixamorig:Hips / b_Enable01 / Bip01-L-Hand → 可匹配的小写。
 *  M7 起由 bone-map.ts 复用（B.1 名称归一的基座），不再各写一份。 */
export function normalize(name: string): string {
  return name.toLowerCase().replace(/^.*:/, '').replace(/^(b_|bip01[_-]?|def-|joint_|jnt_|ctl_)+/i, '');
}

/** 左右侧识别：Left 前缀、或独立分隔的 l/r（hand_l / L Hand / Bip01-L-Hand）。
 *  独立 l/r 要求两侧都是分隔符或端点，避免 leg/roll/forearm 这类词误判。
 *  左右同时出现（L_R_Arm）→ side=null（B.1 口径：都有或都无 → 未知，缺口交映射文件补）。
 *  M7 起由 bone-map.ts 复用（B.1 side 识别同口径）。 */
export function sideOf(name: string): 'L' | 'R' | null {
  const hasL = /left/.test(name) || /(^|[^a-z])l(?![a-z])/.test(name);
  const hasR = /right/.test(name) || /(^|[^a-z])r(?![a-z])/.test(name);
  if (hasL && hasR) return null;
  if (hasL) return 'L';
  if (hasR) return 'R';
  return null;
}

export function classifyJointName(rawName: string): JointClassification | null {
  const name = normalize(rawName);
  if (name === '') return null;
  const side = sideOf(name);
  for (const [kind, pattern] of JOINT_KIND_PATTERNS) {
    if (pattern.test(name)) {
      const unilateral = kind === 'hips' || kind === 'spine' || kind === 'head';
      return { kind, side: unilateral ? null : side };
    }
  }
  return null;
}

export function isHumanoidLike(boneNames: string[]): boolean {
  return matchedCategories(boneNames).length >= MIN_CATEGORIES;
}

export function matchedCategories(boneNames: string[]): string[] {
  const hit = new Set<string>();
  for (const raw of boneNames) {
    const name = normalize(raw);
    if (name === '') continue;
    for (const [category, pattern] of CATEGORIES) {
      if (!hit.has(category) && pattern.test(name)) hit.add(category);
    }
  }
  return [...hit];
}
