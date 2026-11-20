// 骨架识别与映射（design.md §7 / 附录 B.0–B.5，M7 实现唯一依据）。
// 分工红线（§7 拍板 #12）：工具只做**字典查表**（B.1 归一 + B.2 同义词表，纯数据）与
// **约定识别**（B.3 指纹），模糊匹配与几何启发不做——识别缺口一律回退 AI（读
// skeleton-report / 标注截图 → 写 kinemesh-bones.json → 工具确定性消费）。
// 结构：match / detect / parse / check 全部纯逻辑（无 fs）；loadBonesFile / serializeBonesFile
// 是仅有的两个 fs 入口，只被工具层调用。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { KinemeshError, reasonOf } from '../errors.js';
import { CONVENTION_MIN } from '../motion/constants.js';
import { sideOf } from './humanoid.js';

// ———————— B.0 canonical 部件集（白名单，映射产物只允许这些 id） ————————

/** CORE15（= J15，一律小写、side 显式） */
export const CORE15_IDS = [
  'hips',
  'spine',
  'head',
  'upperarm-l',
  'upperarm-r',
  'lowerarm-l',
  'lowerarm-r',
  'hand-l',
  'hand-r',
  'upperleg-l',
  'upperleg-r',
  'lowerleg-l',
  'lowerleg-r',
  'foot-l',
  'foot-r',
] as const;

/** EXTRA（可选，接触检测用） */
export const EXTRA_IDS = ['toe-l', 'toe-r', 'neck', 'chest'] as const;

export type CoreId = (typeof CORE15_IDS)[number] | (typeof EXTRA_IDS)[number];

export const ARCHETYPES = ['humanoid', 'quadruped', 'winged', 'multiped', 'chain', 'custom'] as const;
export type Archetype = (typeof ARCHETYPES)[number];

export const LIMB_ROLES = ['leg', 'arm', 'wing', 'tail'] as const;
export type LimbRole = (typeof LIMB_ROLES)[number];

/** 带左右侧的 canonical 部位（B.2 表键）；hips/spine/head/neck/chest 无侧别 */
const SIDED_CANONICALS = new Set(['toe', 'foot', 'lowerleg', 'upperleg', 'hand', 'lowerarm', 'upperarm']);

/** canonical + side → B.0 白名单 id；带侧 canonical 缺 side 时返回 null（工具不做几何猜测，缺口交 AI） */
export function coreIdOf(canonical: string, side: 'L' | 'R' | null): string | null {
  if (SIDED_CANONICALS.has(canonical)) {
    return side === null ? null : `${canonical}-${side.toLowerCase()}`;
  }
  return canonical;
}

// ———————— B.1 名称归一 ————————

/** 归一产物：raw = 原名小写（CamelCase 边界已插分隔；B.3 指纹看它）；lower = 剥前缀后的全名；
 *  tokens = 主体 token 列表（已去 side / 纯数字） */
export interface NormalizedName {
  raw: string;
  lower: string;
  side: 'L' | 'R' | null;
  tokens: string[];
}

/**
 * 前缀表（B.1，循环剥到不再匹配；vocab 扩展文件（kinemesh-vocab.json）的 prefixes 字段追加项目级前缀）。
 * 剥除条件：前缀后紧跟分隔符/结尾，或前缀自带分隔符结尾（armature|）——防止 blockhead 这类词误剥。
 */
const PREFIXES = ['mixamorig', 'bip001', 'bip01', 'bip', 'j_bip_c', 'j_sec_c', 'def_c', 'armature|', 'block'];

const SEPARATOR_SPLIT = /[_:.\- ]+/;
const SIDE_TOKENS = new Set(['l', 'left', 'r', 'right']);

/** 分词：分隔符切分 + CamelCase 边界 + 字母/数字边界（bip01 → bip/01、spine01 → spine/01） */
function tokenize(lower: string): string[] {
  const spaced = lower.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced
    .toLowerCase()
    .split(SEPARATOR_SPLIT)
    .flatMap((token) => (token === '' ? [] : token.split(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/)))
    .filter((token) => token !== '');
}

/** B.1 名称归一：lowercase → side 识别（复用 humanoid.ts 口径）→ 剥前缀（内置 + vocab 扩展） →
 *  去 side/纯数字 token。extraPrefixes 来自 kinemesh-vocab.json 的 prefixes 字段（已小写化）。 */
export function normalizeBoneName(rawName: string, extraPrefixes: readonly string[] = []): NormalizedName {
  // CamelCase 边界先按原始大小写插入分隔，再统一小写
  const spaced = rawName.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const lower = spaced.toLowerCase();
  const side = sideOf(lower);
  // 剥前缀（循环剥到不再匹配）
  const allPrefixes = extraPrefixes.length === 0 ? PREFIXES : [...new Set([...PREFIXES, ...extraPrefixes])];
  let stripped = lower;
  let looped = true;
  while (looped) {
    looped = false;
    for (const prefix of allPrefixes) {
      if (!stripped.startsWith(prefix)) continue;
      const rest = stripped.slice(prefix.length);
      const boundary = rest === '' || /[a-z0-9]/.test(prefix.slice(-1)) === false || SEPARATOR_SPLIT.test(rest[0] ?? '');
      if (!boundary) continue;
      stripped = rest;
      looped = true;
      break;
    }
  }
  // 分词 + 去 side token 与纯数字 token → 主体 token 列表
  const tokens = tokenize(stripped).filter((token) => !SIDE_TOKENS.has(token) && !/^\d+$/.test(token));
  const strippedLower = stripped.replace(/^[_:.\- ]+/, '');
  return { raw: lower, lower: strippedLower === '' ? lower : strippedLower, side, tokens };
}

// ———————— B.2 同义词表（L1；对主体 token 按表序精确匹配，再对全名子串兜底） ————————

interface SynonymRow {
  canonical: string;
  /** 精确 token（含 spine0–spine9 展开） */
  exact: string[];
  /** 全名子串兜底（多为拼音） */
  substring: string[];
}

/** 表序即优先级：forearm 行在 arm（upperarm）行上、upleg 行在 leg（lowerleg）行上 */
const SYNONYMS: SynonymRow[] = [
  { canonical: 'toe', exact: ['toe', 'toes', 'ball', 'toebase'], substring: ['thumb'] },
  { canonical: 'foot', exact: ['foot', 'feet', 'ankle'], substring: ['jiao'] },
  { canonical: 'lowerleg', exact: ['leg', 'calf', 'shin', 'knee', 'lowerleg'], substring: ['xiaotui'] },
  { canonical: 'upperleg', exact: ['thigh', 'upleg', 'upperleg'], substring: ['datui'] },
  { canonical: 'hand', exact: ['hand', 'palm', 'wrist'], substring: ['shou'] },
  { canonical: 'lowerarm', exact: ['forearm', 'lowerarm', 'elbow'], substring: ['xiaobi'] },
  { canonical: 'upperarm', exact: ['upperarm', 'arm', 'clavicle', 'collar', 'shoulder'], substring: ['gebo'] },
  { canonical: 'head', exact: ['head'], substring: ['tou'] },
  { canonical: 'neck', exact: ['neck'], substring: ['bozi'] },
  {
    canonical: 'spine',
    exact: ['spine', ...Array.from({ length: 10 }, (_, i) => `spine${i}`), 'chest', 'torso'],
    substring: [],
  },
  { canonical: 'hips', exact: ['hips', 'hip', 'pelvis'], substring: ['ku'] },
];

export interface CanonicalMatch {
  /** B.2 canonical 部位（表键） */
  canonical: string;
  side: 'L' | 'R' | null;
  /** exact = 主体 token 精确命中；substring = 全名子串兜底（置信低一档） */
  how: 'exact' | 'substring';
}

/**
 * L1 字典查表（纯数据，无启发式）：先对主体 token 按「token 序 → 连接串最长优先 → 表序」精确匹配，
 * 再按表序对全名做子串兜底；两轮都落空返回 null（缺口回退 AI，红线不做模糊匹配）。
 * 表序保证 Mixamo ForeArm→lowerarm 先于 Arm→upperarm、UpLeg→upperleg 先于 Leg→lowerleg 语义。
 */
export function matchCanonical(rawName: string, extraPrefixes: readonly string[] = []): CanonicalMatch | null {
  const normalized = normalizeBoneName(rawName, extraPrefixes);
  const tokens = normalized.tokens;
  // 精确匹配：起点按 token 序，连接串按最长优先；命中即返回（表序由 SYNONYMS 数组序保证）
  for (let start = 0; start < tokens.length; start += 1) {
    for (let end = tokens.length; end > start; end -= 1) {
      const run = tokens.slice(start, end).join('');
      for (const row of SYNONYMS) {
        if (row.exact.includes(run)) {
          return { canonical: row.canonical, side: normalized.side, how: 'exact' };
        }
      }
    }
  }
  // 子串兜底：按表序对剥前缀后的全名做 includes
  for (const row of SYNONYMS) {
    for (const sub of row.substring) {
      if (normalized.lower.includes(sub)) {
        return { canonical: row.canonical, side: normalized.side, how: 'substring' };
      }
    }
  }
  return null;
}

// ———————— B.3 约定识别（convention） ————————

export type Convention = 'mixamo' | 'biped' | 'ue' | 'vrm' | 'rigify' | 'custom';

export interface ConventionDetection {
  convention: Convention;
  /** 胜出指纹的命中骨骼数 */
  matched: number;
  /** 参与识别的骨骼总数 */
  total: number;
  /** matched / total（2 位小数随 report 回显） */
  score: number;
}

/** 家族指纹（B.3）：mixamo/biped/vrm 看原始名前缀，ue 看原始名后缀+主体 token，rigify 看点分后缀。
 *  指纹一律吃 raw（原名小写、未剥前缀），否则 mixamorig:/bip01/j_bip 这类前缀自身会被 B.1 剥掉。 */
const FINGERPRINTS: Array<{ id: Exclude<Convention, 'custom'>; hit: (raw: string, tokens: string[]) => boolean }> = [
  { id: 'mixamo', hit: (raw) => raw.startsWith('mixamorig:') },
  { id: 'biped', hit: (raw) => /^bip0\d+[_ ]/.test(raw) },
  {
    id: 'ue',
    hit: (raw, tokens) => /_(l|r)$/.test(raw) && tokens.some((token) => ['thigh', 'calf', 'upperarm', 'lowerarm'].includes(token)),
  },
  { id: 'vrm', hit: (raw) => raw.startsWith('j_bip') },
  { id: 'rigify', hit: (raw) => /(upper_arm|forearm|hand)\.[lr]$/.test(raw) },
];

/** score = 指纹命中骨数 / 总骨数；convention = argmax 且 ≥ CONVENTION_MIN，否则 custom（B.3） */
export function detectConvention(boneNames: string[], extraPrefixes: readonly string[] = []): ConventionDetection {
  const counts = new Map<Convention, number>();
  for (const name of boneNames) {
    const normalized = normalizeBoneName(name, extraPrefixes);
    for (const fingerprint of FINGERPRINTS) {
      if (fingerprint.hit(normalized.raw, normalized.tokens)) {
        counts.set(fingerprint.id, (counts.get(fingerprint.id) ?? 0) + 1);
        break;
      }
    }
  }
  const total = boneNames.length;
  let best: Convention = 'custom';
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  const score = total > 0 ? bestCount / total : 0;
  if (bestCount === 0 || score < CONVENTION_MIN) return { convention: 'custom', matched: bestCount, total, score };
  return { convention: best, matched: bestCount, total, score };
}

// ———————— B.5 kinemesh-bones.json（映射文件，schema v2） ————————

/** 约定文件名（资产同目录 / cwd 自动发现，B.5 发现顺序的缺省文件名） */
export const BONES_FILE_NAME = 'kinemesh-bones.json';

export interface BonesFileMeta {
  archetype: Archetype;
  /** 自由文本（识别约定回显用，不做枚举校验） */
  convention?: string;
  by?: string;
  notes?: string;
}

export interface BonesLimb {
  role: LimbRole;
  /** 自由短标签（fl/fr/bl/br/l/r…，仅展示用） */
  tag?: string;
  /** 有序：从链首到 tip（子→父逐级相连，校验见 checkBonesAgainstSkeleton） */
  bones: string[];
  /** 指端；必须等于 bones 最后一节 */
  tip: string;
}

export interface BonesFileData {
  meta: BonesFileMeta;
  root: string | null;
  head: string | null;
  spine: string[];
  limbs: BonesLimb[];
  /** humanoid 简写：骨骼名 → CORE/EXTRA id（schema 里是对象，解析后用 Map 保序） */
  bones: Map<string, string>;
}

const WHITELIST_TEXT = `${[...CORE15_IDS, ...EXTRA_IDS].join(' / ')}`;

/** JSON 文本 → BonesFileData；schema 校验失败抛 KinemeshError（错在哪 + 正确姿势并列合法值清单，B.5） */
export function parseBonesFile(text: string, sourcePath: string): BonesFileData {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new KinemeshError(
      `映射文件 JSON 解析失败：${sourcePath}（${reasonOf(error)}）。`,
      `${BONES_FILE_NAME} 必须是合法 JSON（schema v2）：{_meta: {archetype, …}, root?, head?, spine?, limbs?, bones?}；逐项检查逗号/引号后重跑。`,
    );
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new KinemeshError(
      `映射文件结构不对：${sourcePath} 顶层必须是对象。`,
      `schema v2 顶层形如 {"_meta": {"archetype": "humanoid"}, "bones": {"Head_01": "head"}}；非 humanoid 再给 root/head/spine/limbs。`,
    );
  }
  const record = data as Record<string, unknown>;

  // ————— _meta.archetype：缺省 humanoid，出现即必须 ∈ B.0 枚举 —————
  let rawArchetype: unknown = 'humanoid';
  if (record._meta !== undefined) {
    if (typeof record._meta !== 'object' || record._meta === null || Array.isArray(record._meta)) {
      throw new KinemeshError(
        `映射文件 _meta 不是对象：${sourcePath}。`,
        `_meta 形如 {"archetype": "quadruped", "convention": "custom", "by": "ai", "notes": "…"}；archetype 合法值：${ARCHETYPES.join(' / ')}。`,
      );
    }
    const meta = record._meta as Record<string, unknown>;
    if (meta.archetype !== undefined) rawArchetype = meta.archetype;
    for (const key of ['convention', 'by', 'notes'] as const) {
      if (meta[key] !== undefined && typeof meta[key] !== 'string') {
        throw new KinemeshError(`映射文件 _meta.${key} 必须是字符串：${sourcePath}。`, `例如 "_meta": {"${key}": "…"}。`);
      }
    }
  }
  if (typeof rawArchetype !== 'string' || !ARCHETYPES.includes(rawArchetype as Archetype)) {
    throw new KinemeshError(
      `映射文件 archetype 非法（${JSON.stringify(rawArchetype)}）：${sourcePath}。`,
      `archetype 只允许：${ARCHETYPES.join(' / ')}（B.0 枚举）。`,
    );
  }
  const archetype = rawArchetype as Archetype;
  const metaSource = (record._meta ?? {}) as Record<string, unknown>;
  const meta: BonesFileMeta = {
    archetype,
    ...(typeof metaSource.convention === 'string' ? { convention: metaSource.convention } : {}),
    ...(typeof metaSource.by === 'string' ? { by: metaSource.by } : {}),
    ...(typeof metaSource.notes === 'string' ? { notes: metaSource.notes } : {}),
  };

  const textAt = (key: string, value: unknown): string => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new KinemeshError(
        `映射文件 ${key} 必须是非空字符串：${sourcePath}。`,
        `${key} 写场景里真实存在的骨骼名（先 kinemesh_info 查 bones 列表）。`,
      );
    }
    return value;
  };
  const stringList = (key: string, value: unknown): string[] => {
    if (!Array.isArray(value)) {
      throw new KinemeshError(`映射文件 ${key} 必须是字符串数组：${sourcePath}。`, `例如 "${key}": ["Spine_01", "Spine_02"]。`);
    }
    return value.map((entry, index) => textAt(`${key}[${index}]`, entry));
  };

  // ————— root / head / spine（非 humanoid 用；humanoid 忽略） —————
  const root = record.root === undefined ? null : textAt('root', record.root);
  const head = record.head === undefined ? null : textAt('head', record.head);
  const spine = record.spine === undefined ? [] : stringList('spine', record.spine);

  // ————— limbs（每条 role ∈ {leg, arm, wing, tail}、bones 有序、tip 指端） —————
  const limbs: BonesLimb[] = [];
  if (record.limbs !== undefined) {
    if (!Array.isArray(record.limbs)) {
      throw new KinemeshError(`映射文件 limbs 必须是数组：${sourcePath}。`, `每条形如 {"role": "leg", "tag": "fl", "bones": ["Leg_FL_1", "Leg_FL_2"], "tip": "Foot_FL"}。`);
    }
    record.limbs.forEach((raw, index) => {
      const where = `limbs[${index}]`;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new KinemeshError(`映射文件 ${where} 不是对象：${sourcePath}。`, `每条肢链形如 {"role": "leg", "bones": […], "tip": "…"}。`);
      }
      const limb = raw as Record<string, unknown>;
      if (typeof limb.role !== 'string' || !LIMB_ROLES.includes(limb.role as LimbRole)) {
        throw new KinemeshError(
          `映射文件 ${where}.role 非法（${JSON.stringify(limb.role)}）：${sourcePath}。`,
          `role 只允许：${LIMB_ROLES.join(' / ')}。`,
        );
      }
      const bones = stringList(`${where}.bones`, limb.bones);
      if (bones.length === 0) {
        throw new KinemeshError(`映射文件 ${where}.bones 是空数组：${sourcePath}。`, '每条肢链至少要有一节骨骼，tip 指向最后一节。');
      }
      const tag = limb.tag === undefined ? undefined : textAt(`${where}.tag`, limb.tag);
      const tip = textAt(`${where}.tip`, limb.tip);
      limbs.push({ role: limb.role as LimbRole, bones, tip, ...(tag === undefined ? {} : { tag }) });
    });
  }

  // ————— bones 简写（humanoid：CORE15；值必须在 B.0 白名单内） —————
  const bones = new Map<string, string>();
  if (record.bones !== undefined) {
    if (typeof record.bones !== 'object' || record.bones === null || Array.isArray(record.bones)) {
      throw new KinemeshError(`映射文件 bones 必须是对象（骨骼名 → canonical id）：${sourcePath}。`, `例如 "bones": {"Head_01": "head", "Hand_L": "hand-l"}。`);
    }
    for (const [boneName, value] of Object.entries(record.bones as Record<string, unknown>)) {
      if (boneName.trim() === '') {
        throw new KinemeshError(`映射文件 bones 有空骨骼名键：${sourcePath}。`, '键写场景里真实存在的骨骼名（先 kinemesh_info 查 bones 列表）。');
      }
      if (typeof value !== 'string') {
        throw new KinemeshError(`映射文件 bones["${boneName}"] 必须是字符串：${sourcePath}。`, `值用 B.0 白名单 id：${WHITELIST_TEXT}。`);
      }
      // 缺 side 先判（B.5 明确示例：upperarm → 报错，必须 upperarm-l/-r），再判白名单
      if ((SIDED_CANONICALS.has(value) || value.startsWith('toe')) && !/-(l|r)$/.test(value)) {
        throw new KinemeshError(
          `映射文件 bones["${boneName}"] 的值「${value}」缺 side：${sourcePath}。`,
          `带侧别部位必须显式给左右，例如 "${value}-l" 与 "${value}-r" 两个键值。`,
        );
      }
      if (!(CORE15_IDS as readonly string[]).includes(value) && !(EXTRA_IDS as readonly string[]).includes(value)) {
        throw new KinemeshError(
          `映射文件 bones["${boneName}"] 的值「${value}」不在 B.0 白名单：${sourcePath}。`,
          `值只允许：${WHITELIST_TEXT}（side 必须显式，如 upperarm-l / upperarm-r）。`,
        );
      }
      const taken = [...bones.entries()].find(([, existing]) => existing === value);
      if (taken !== undefined) {
        throw new KinemeshError(
          `映射文件同一 canonical id「${value}」被两根骨骼占用（${taken[0]} 与 ${boneName}）：${sourcePath}。`,
          '一个 canonical id 只映射一根骨骼；脊柱家族多余骨骼不要写进 bones，交给字典中位保留或留空。',
        );
      }
      bones.set(boneName, value);
    }
  }

  // ————— archetype 相关必填 —————
  if (archetype === 'humanoid' && bones.size === 0) {
    throw new KinemeshError(
      `映射文件 archetype=humanoid 但没有 bones 映射：${sourcePath}。`,
      `humanoid 只需 bones 简写：{"_meta": {"archetype": "humanoid"}, "bones": {"Head_01": "head", …}}；值用白名单 id：${WHITELIST_TEXT}。`,
    );
  }
  if (archetype !== 'humanoid' && root === null) {
    throw new KinemeshError(
      `映射文件 archetype=${archetype} 但缺 root：${sourcePath}。`,
      `非 humanoid 时 root 必填（head/spine/limbs 按需，bones 字段此时忽略）；root 写根骨骼名。`,
    );
  }
  const legLimbs = limbs.filter((limb) => limb.role === 'leg').length;
  if (legLimbs > 8) {
    throw new KinemeshError(
      `映射文件 leg 肢链数 ${legLimbs} 超过 8：${sourcePath}。`,
      'leg 肢链数 > 8 通常意味着 archetype 判错了（如把触手/装饰链写成了 leg）；复核 archetype（合法值：' +
        `${ARCHETYPES.join(' / ')}）或把非腿链改成 wing/tail/arm 后重写文件。`,
    );
  }
  return { meta, root, head, spine, limbs, bones };
}

/** 写出辅助（AI 兜底流程产出前的模板 / 测试构造）；BonesFileData → schema v2 JSON 文本 */
export function serializeBonesFile(data: BonesFileData): string {
  const out: Record<string, unknown> = {
    _meta: {
      archetype: data.meta.archetype,
      ...(data.meta.convention === undefined ? {} : { convention: data.meta.convention }),
      ...(data.meta.by === undefined ? {} : { by: data.meta.by }),
      ...(data.meta.notes === undefined ? {} : { notes: data.meta.notes }),
    },
    ...(data.root === null ? {} : { root: data.root }),
    ...(data.head === null ? {} : { head: data.head }),
    ...(data.spine.length === 0 ? {} : { spine: data.spine }),
    ...(data.limbs.length === 0
      ? {}
      : {
          limbs: data.limbs.map((limb) => ({
            role: limb.role,
            ...(limb.tag === undefined ? {} : { tag: limb.tag }),
            bones: limb.bones,
            tip: limb.tip,
          })),
        }),
    ...(data.bones.size === 0 ? {} : { bones: Object.fromEntries(data.bones) }),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * 映射文件对骨架的确定性校验（B.5：骨骼名必须存在、limb 链逐级相连、tip 是末节、leg ≤ 8 已在
 * parse 阶段拦）。parentOf 是「骨架集合内最近父骨」表（骨骼名 → 父名，根为 null），由调用方
 * 从场景构建。通过后返回可直接消费的 BonesMapping。
 */
export interface BonesMapping {
  /** 映射文件来源路径（summary.boneMap.source / skeleton-report 回显） */
  source: string;
  archetype: Archetype;
  root: string | null;
  head: string | null;
  spine: string[];
  limbs: BonesLimb[];
  /** humanoid 简写（coreId → 骨骼名）；非 humanoid 为空表 */
  core: Map<string, string>;
  /** 全部被映射骨骼（骨骼名 → 部位标签：coreId 或 root/head/spine/limb:<role>[:tag]） */
  parts: Map<string, string>;
}

export function checkBonesAgainstSkeleton(data: BonesFileData, sourcePath: string, parentOf: Map<string, string | null>): BonesMapping {
  const parts = new Map<string, string>();
  const referenced: Array<{ name: string; part: string }> = [];
  const humanoid = data.meta.archetype === 'humanoid';

  if (humanoid) {
    for (const [boneName, coreId] of data.bones) {
      referenced.push({ name: boneName, part: coreId });
    }
  } else {
    if (data.root !== null) referenced.push({ name: data.root, part: 'root' });
    if (data.head !== null) referenced.push({ name: data.head, part: 'head' });
    for (const name of data.spine) referenced.push({ name, part: 'spine' });
    data.limbs.forEach((limb, index) => {
      const label = limb.tag === undefined ? `limb:${limb.role}` : `limb:${limb.role}:${limb.tag}`;
      for (const name of limb.bones) referenced.push({ name, part: label });
      referenced.push({ name: limb.tip, part: label });
    });
  }

  // 骨骼名必须存在于骨架
  const missing = referenced.filter((entry) => !parentOf.has(entry.name));
  if (missing.length > 0) {
    const names = [...new Set(missing.map((entry) => entry.name))].join('、');
    throw new KinemeshError(
      `映射文件引用的骨骼不存在于骨架：${names}（${sourcePath}）。`,
      '骨骼名要与场景完全一致（区分大小写）；先 kinemesh_info 查 bones 列表，逐个核对映射文件后再重跑。',
    );
  }
  // 部位标签按 root > head > spine > limbs 优先取首次引用（同一骨骼承担多角色不报错——
  // 链形 rig 的 root 兼尾链首节属正常写法；humanoid 的 core id 唯一性已在 parse 阶段保证）
  for (const entry of referenced) {
    if (!parts.has(entry.name)) parts.set(entry.name, entry.part);
  }

  // 肢链：子→父必须逐级相连，tip 必须是 bones 最后一节
  data.limbs.forEach((limb, index) => {
    const where = `limbs[${index}]（${limb.role}${limb.tag === undefined ? '' : ` ${limb.tag}`}）`;
    for (let k = 0; k + 1 < limb.bones.length; k += 1) {
      const child = limb.bones[k + 1]!;
      const parent = limb.bones[k]!;
      if (parentOf.get(child) !== parent) {
        throw new KinemeshError(
          `映射文件 ${where} 不是连续链：「${child}」的直接父骨是「${parentOf.get(child) ?? '(无)'}」，不是「${parent}」。`,
          'limbs[].bones 按 链首→tip 顺序写，相邻两项必须逐级父子相连；按 skeleton-report 的 parent/children 层级抄写。',
        );
      }
    }
    if (limb.tip !== limb.bones[limb.bones.length - 1]) {
      throw new KinemeshError(
        `映射文件 ${where} 的 tip「${limb.tip}」不是 bones 最后一节「${limb.bones[limb.bones.length - 1]}」。`,
        'tip 必须等于 bones 数组最后一节（指端）；把 tip 改成末节骨骼名。',
      );
    }
  });

  return {
    source: sourcePath,
    archetype: data.meta.archetype,
    root: humanoid ? null : data.root,
    head: humanoid ? null : data.head,
    spine: humanoid ? [] : data.spine,
    limbs: humanoid ? [] : data.limbs,
    core: humanoid ? data.bones : new Map(),
    parts,
  };
}

// ———————— B.6 info 集成的纯统计（scene-info / gltf-json 共用） ————————

/** info 的 bones 摘要（B.6）：convention = detectConvention 结果（无骨骼 null）；mapped = 字典自动命中骨数 */
export function summarizeBones(boneNames: string[]): { convention: string | null; mapped: number } {
  if (boneNames.length === 0) return { convention: null, mapped: 0 };
  let mapped = 0;
  for (const name of boneNames) {
    if (matchCanonical(name) !== null) mapped += 1;
  }
  return { convention: detectConvention(boneNames).convention, mapped };
}

/** info 的映射计数（B.6）：有映射文件时覆盖字典计数；parse 级（不做骨架名校验——那是 analyze/skeleton 的职责） */
export function mappedCountOf(data: BonesFileData): number {
  if (data.meta.archetype === 'humanoid') return data.bones.size;
  const names = new Set<string>();
  if (data.root !== null) names.add(data.root);
  if (data.head !== null) names.add(data.head);
  for (const name of data.spine) names.add(name);
  for (const limb of data.limbs) for (const name of limb.bones) names.add(name);
  return names.size;
}

// ———————— 文件发现与读取（唯一 fs 入口，仅工具层调用） ————————

export interface LoadBonesOptions {
  /** boneMap 参数显式指定的路径（B.5 发现顺序第一优先；不存在直接报错，不静默跳过） */
  explicitPath?: string;
  /** 资产所在目录（找 <assetDir>/kinemesh-bones.json） */
  assetDir?: string;
  /** 工作区目录（找 <cwd>/kinemesh-bones.json） */
  cwd?: string;
}

export interface LoadedBones {
  source: string;
  data: BonesFileData;
}

function isMissingFile(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * 发现顺序（B.5）：boneMap 参数 > 资产同目录 kinemesh-bones.json > cwd > 无。
 * 显式路径读不到 → KinemeshError（存在性校验，不再静默成功）；发现路径读不到 → 静默跳下一个；
 * 读到了但 JSON/schema 非法 → parseBonesFile 的三段式 KinemeshError。
 */
export async function loadBonesFile(options: LoadBonesOptions = {}): Promise<LoadedBones | null> {
  const explicit = options.explicitPath?.trim();
  if (explicit !== undefined && explicit !== '') {
    let text: string;
    try {
      text = await readFile(explicit, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) {
        throw new KinemeshError(
          `boneMap 指定的映射文件不存在：${explicit}。`,
          `确认路径拼写；缺省可把 kinemesh-bones.json 放在资产同目录（发现顺序：boneMap 参数 > 资产同目录 > 工作区）。schema v2 见 kinemesh_skeleton 报告尾注。`,
        );
      }
      throw new KinemeshError(`映射文件读取失败：${explicit}（${reasonOf(error)}）。`, '确认文件存在且可读（Windows 路径用正斜杠或双反斜杠）后重试。');
    }
    return { source: path.resolve(explicit), data: parseBonesFile(text, explicit) };
  }
  const candidates: string[] = [];
  if (options.assetDir !== undefined && options.assetDir.trim() !== '') candidates.push(path.join(options.assetDir, BONES_FILE_NAME));
  if (options.cwd !== undefined && options.cwd.trim() !== '') candidates.push(path.join(options.cwd, BONES_FILE_NAME));
  for (const candidate of candidates) {
    const text = await readFile(candidate, 'utf8').catch(() => null);
    if (text === null) continue;
    return { source: path.resolve(candidate), data: parseBonesFile(text, candidate) };
  }
  return null;
}
