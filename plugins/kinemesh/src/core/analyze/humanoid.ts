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

/** 去掉命名空间与常见前缀：mixamorig:Hips / b_Enable01 / Bip01-L-Hand → 可匹配的小写 */
function normalize(name: string): string {
  return name.toLowerCase().replace(/^.*:/, '').replace(/^(b_|bip01[_-]?|def-|joint_|jnt_|ctl_)+/i, '');
}
