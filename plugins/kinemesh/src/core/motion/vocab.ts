// 词汇表文件机制（design.md §6.6.3 / A.8 / B.1）：guess 词表与前缀扩展的「由 AI 根据记忆调整」落地方式。
// 工具保持确定性、不学习；可调整的是数据——kinemesh-vocab.json 由 Agent 在用户工程里维护，
// analyze/skeleton 确定性消费。匹配逻辑（matchVocab）纯函数无 IO；本文件的 loadVocab 与
// scene-cache.ts 是 core 里仅有的 fs 入口，只被工具层（tools.ts / cli.ts / mcp-server.ts）调用。
//
// 条目 schema（when 只允许引用 A.8 段特征，防幻觉口径——字段集见 WHEN_KEYS）：
//   {
//     "term": "dodge",
//     "when": { "airborne": false, "rootSpeedMin": 1.2, "headingTurnMin": 45 },
//          ——或—— { "anyOf": [ {…}, {…} ] }（任一子条件组命中即可）
//     "action": "label" | "suppress" | "demote"   // 缺省 label
//   }
// 顶层对象形式可带 "prefixes": ["myns:"]（B.1 项目级前缀扩展，字典查表剥前缀用）。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { KinemeshError, reasonOf } from '../errors.js';

export type VocabAction = 'label' | 'suppress' | 'demote';

/** when 子条件：键与类型白名单（§6.6.3「字段保持最小，条件只引用工具已产出的通道值」） */
export interface VocabWhen {
  /** true = 段处于腾空（airRatio > 0.5，A.8 #1 口径）；false = 未腾空 */
  airborne?: boolean;
  /** 段根速度 ≥（H/s） */
  rootSpeedMin?: number;
  /** 段净转角 ≥（度，turnNet） */
  headingTurnMin?: number;
  /** 腾空帧占比 ≥（0–1） */
  airRatioMin?: number;
  /** 段内速度最高关节 =（J15 规范 id 或骨骼名） */
  peakJoint?: string;
  /** 段峰值能量 ≥（H/s） */
  peakEMin?: number;
  /** 段时长 ≤（秒） */
  durMax?: number;
  /** 段均值能量 ≥（H/s） */
  meanEMin?: number;
  /** 段均值能量 ≤（H/s） */
  meanEMax?: number;
  /** 段累计转角 ≥（度，turnTotal） */
  turnTotalMin?: number;
  /** 身体相对方向 =（A.5 方位词，如 back / left / right） */
  bodyDir?: string;
  /** hips 是否显著低于全片 P10（A.8 #10 口径） */
  hipsLow?: boolean;
}

/** when 顶层：条件组或 anyOf（任一子条件组命中即可；anyOf 不嵌套） */
export type VocabCondition = VocabWhen | { anyOf: VocabWhen[] };

export interface VocabEntry {
  /** 命中后打进 guess 的词条（如战斗向 dodge / cast / hit-react / roll） */
  term: string;
  when: VocabCondition;
  /** label（缺省，打 term）/ suppress（guess 置 other）/ demote（降级 gesture） */
  action?: VocabAction;
}

/** matchVocab 的输入特征 = A.8 段特征（describe 的 SegmentFeatures 子集） */
export interface VocabFeatures {
  dur: number;
  meanE: number;
  peakE: number;
  peakJoint: string;
  rootSpeed: number;
  turnNet: number;
  turnTotal: number;
  bodyDir: string;
  airRatio: number;
  hipsLow: boolean;
}

export interface LoadedVocab {
  /** 词表来源：文件路径或 'builtin'（summary.vocab 回显，可审计「这次 guess 用了哪套词」） */
  source: string;
  entries: VocabEntry[];
  /** B.1 前缀扩展（顶层 "prefixes" 字段，统一小写；builtin / 顶层数组形式为空数组） */
  prefixes: string[];
}

/** 约定文件名（资产同目录 / cwd 自动发现的文件名，§6.6.3） */
export const VOCAB_FILE_NAME = 'kinemesh-vocab.json';

const NUM_KEYS = new Set([
  'rootSpeedMin',
  'headingTurnMin',
  'airRatioMin',
  'peakEMin',
  'durMax',
  'meanEMin',
  'meanEMax',
  'turnTotalMin',
]);
const STRING_KEYS = new Set(['peakJoint', 'bodyDir']);
const BOOL_KEYS = new Set(['airborne', 'hipsLow']);
const WHEN_KEYS = new Set([...NUM_KEYS, ...STRING_KEYS, ...BOOL_KEYS]);
const ACTIONS = new Set<VocabAction>(['label', 'suppress', 'demote']);

// ———————— 匹配（纯函数，A.8 决策表前的优先判定） ————————

/** 单条 when 是否命中：所有给出的条件都成立才算命中（空条件 = 恒命中） */
function matchesWhen(features: VocabFeatures, when: VocabWhen): boolean {
  if (when.airborne !== undefined && when.airborne !== (features.airRatio > 0.5)) return false;
  if (when.rootSpeedMin !== undefined && features.rootSpeed < when.rootSpeedMin) return false;
  if (when.headingTurnMin !== undefined && features.turnNet < when.headingTurnMin) return false;
  if (when.airRatioMin !== undefined && features.airRatio < when.airRatioMin) return false;
  if (when.peakJoint !== undefined && features.peakJoint !== when.peakJoint) return false;
  if (when.peakEMin !== undefined && features.peakE < when.peakEMin) return false;
  if (when.durMax !== undefined && features.dur > when.durMax) return false;
  if (when.meanEMin !== undefined && features.meanE < when.meanEMin) return false;
  if (when.meanEMax !== undefined && features.meanE > when.meanEMax) return false;
  if (when.turnTotalMin !== undefined && features.turnTotal < when.turnTotalMin) return false;
  if (when.bodyDir !== undefined && features.bodyDir !== when.bodyDir) return false;
  if (when.hipsLow !== undefined && features.hipsLow !== when.hipsLow) return false;
  return true;
}

function matchesCondition(features: VocabFeatures, condition: VocabCondition): boolean {
  if ('anyOf' in condition) {
    return condition.anyOf.some((sub) => matchesWhen(features, sub));
  }
  return matchesWhen(features, condition);
}

/** 按序首条命中（A.8 first-match 不变）；没命中返回 null，走内置决策表 */
export function matchVocab(features: VocabFeatures, entries: VocabEntry[]): { term: string; action: VocabAction } | null {
  for (const entry of entries) {
    if (matchesCondition(features, entry.when)) {
      return { term: entry.term, action: entry.action ?? 'label' };
    }
  }
  return null;
}

// ———————— 解析与发现（loadVocab 与 scene-cache.ts 是 core 里仅有的 fs 入口，仅工具层调用） ————————

/** 词表文件全量解析产物：词条 + B.1 前缀扩展 */
export interface ParsedVocab {
  entries: VocabEntry[];
  prefixes: string[];
}

/** JSON 文本 → { entries, prefixes }；结构错误抛 KinemeshError（错在哪 + 正确姿势） */
export function parseVocabFile(text: string, sourcePath: string): ParsedVocab {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new KinemeshError(
      `词表文件 JSON 解析失败：${sourcePath}（${reasonOf(error)}）。`,
      `${VOCAB_FILE_NAME} 必须是合法 JSON：顶层为词条数组，或 {"entries": [...], "prefixes": [...]}；逐条检查逗号/引号后重跑。`,
    );
  }
  if (Array.isArray(data)) return { entries: data.map((raw, index) => validateEntry(raw, sourcePath, index)), prefixes: [] };
  if (typeof data !== 'object' || data === null) {
    throw new KinemeshError(
      `词表文件结构不对：${sourcePath} 的顶层既不是数组也不是对象。`,
      `顶层用词条数组或 {"entries": [...], "prefixes": [...]}；每条形如 {"term": "dodge", "when": {...}, "action": "label"}。`,
    );
  }
  const record = data as Record<string, unknown>;
  const rawEntries = Array.isArray(record.entries) ? record.entries : null;
  if (rawEntries === null) {
    throw new KinemeshError(
      `词表文件结构不对：${sourcePath} 的顶层既不是数组也没有 entries 数组。`,
      `顶层用词条数组或 {"entries": [...], "prefixes": [...]}；每条形如 {"term": "dodge", "when": {...}, "action": "label"}。`,
    );
  }
  let prefixes: string[] = [];
  if (record.prefixes !== undefined) {
    if (!Array.isArray(record.prefixes) || record.prefixes.some((item) => typeof item !== 'string' || item.trim() === '')) {
      throw new KinemeshError(
        `词表文件 prefixes 字段非法：${sourcePath}（必须是全非空字符串数组）。`,
        `"prefixes": ["myns:", "rig_"]——项目级骨骼名前缀，字典查表（B.1）剥前缀时与内置表合并使用。`,
      );
    }
    prefixes = (record.prefixes as string[]).map((item) => item.trim().toLowerCase());
  }
  return { entries: rawEntries.map((raw, index) => validateEntry(raw, sourcePath, index)), prefixes };
}

/** 兼容入口：只取词条（等价 parseVocabFile(...).entries） */
export function parseVocab(text: string, sourcePath: string): VocabEntry[] {
  return parseVocabFile(text, sourcePath).entries;
}

function validateEntry(raw: unknown, sourcePath: string, index: number): VocabEntry {
  const where = `${sourcePath} 第 ${index + 1} 条`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new KinemeshError(`词表条目不是对象：${where}。`, '每条词条必须是对象 {"term": …, "when": {…}, "action": …}。');
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.term !== 'string' || record.term.trim() === '') {
    throw new KinemeshError(`词表条目缺 term 或 term 不是非空字符串：${where}。`, 'term 是命中后打进 guess 的词条名，例如 "dodge"。');
  }
  if (record.action !== undefined && (typeof record.action !== 'string' || !ACTIONS.has(record.action as VocabAction))) {
    throw new KinemeshError(
      `词表条目 action 非法（${JSON.stringify(record.action)}）：${where}。`,
      'action 只允许 "label"（缺省，打词条）/ "suppress"（guess 置 other）/ "demote"（降级 gesture）。',
    );
  }
  return {
    term: record.term,
    when: validateCondition(record.when, sourcePath, index),
    ...(record.action === undefined ? {} : { action: record.action as VocabAction }),
  };
}

function validateCondition(raw: unknown, sourcePath: string, index: number): VocabCondition {
  const where = `${sourcePath} 第 ${index + 1} 条`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new KinemeshError(
      `词表条目缺 when 或 when 不是对象：${where}。`,
      `when 用条件对象（如 {"rootSpeedMin": 1.2}）或 {"anyOf": [{…}, …]}；允许的字段：${[...WHEN_KEYS].join(' / ')}。`,
    );
  }
  const record = raw as Record<string, unknown>;
  if (record.anyOf !== undefined) {
    if (!Array.isArray(record.anyOf) || record.anyOf.length === 0) {
      throw new KinemeshError(`词表 when.anyOf 必须是非空数组：${where}。`, 'anyOf 列出多个条件组，任一命中即可；不需要 anyOf 时直接写条件字段。');
    }
    const allowed = Object.keys(record).filter((key) => key !== 'anyOf');
    if (allowed.length > 0) {
      throw new KinemeshError(
        `词表 when 里 anyOf 与其他字段混用（${allowed.join('、')}）：${where}。`,
        'anyOf 是完整条件组的「或」组合；单组条件直接写在 when 里即可。',
      );
    }
    return { anyOf: record.anyOf.map((sub, subIndex) => validateWhenObject(sub, sourcePath, index, subIndex + 1)) };
  }
  return validateWhenObject(record, sourcePath, index);
}

function validateWhenObject(raw: unknown, sourcePath: string, index: number, subIndex?: number): VocabWhen {
  const where = `${sourcePath} 第 ${index + 1} 条${subIndex === undefined ? '' : ` anyOf[${subIndex}]`}`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new KinemeshError(`词表 when 条件组不是对象：${where}。`, '条件组是 {"字段": 阈值, …} 形式的对象。');
  }
  const when: VocabWhen = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!WHEN_KEYS.has(key)) {
      throw new KinemeshError(
        `词表 when 引用了未知字段「${key}」：${where}。`,
        `when 只允许引用工具已产出的段特征：${[...WHEN_KEYS].join(' / ')}。`,
      );
    }
    if (NUM_KEYS.has(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new KinemeshError(`词表 when 字段「${key}」必须是有限数字：${where}。`, `例如 "${key}": 1.2。`);
      }
      (when as Record<string, unknown>)[key] = value;
    } else if (STRING_KEYS.has(key)) {
      if (typeof value !== 'string' || value === '') {
        throw new KinemeshError(`词表 when 字段「${key}」必须是非空字符串：${where}。`, `例如 "${key}": "R.Hand"（用 summary.jointBasis 里的 id/骨骼名）。`);
      }
      (when as Record<string, unknown>)[key] = value;
    } else {
      if (typeof value !== 'boolean') {
        throw new KinemeshError(`词表 when 字段「${key}」必须是布尔值：${where}。`, `例如 "${key}": false。`);
      }
      (when as Record<string, unknown>)[key] = value;
    }
  }
  return when;
}

export interface LoadVocabOptions {
  /** vocab 参数显式指定的文件路径（发现顺序第一优先） */
  explicitPath?: string;
  /** 资产所在目录（找 <assetDir>/kinemesh-vocab.json） */
  assetDir?: string;
  /** 工作区目录（找 <cwd>/kinemesh-vocab.json） */
  cwd?: string;
}

/**
 * 发现顺序（§6.6.3）：explicit > `<assetDir>/kinemesh-vocab.json` > `<cwd>/kinemesh-vocab.json` > builtin。
 * 文件不存在 → 静默降级下一个来源，全部没有 → builtin（entries 空）；
 * 文件存在但 JSON/条目非法 → KinemeshError（自愈指引进 parseVocab）。
 */
export async function loadVocab(options: LoadVocabOptions = {}): Promise<LoadedVocab> {
  const candidates: string[] = [];
  if (options.explicitPath !== undefined && options.explicitPath.trim() !== '') {
    candidates.push(options.explicitPath.trim());
  }
  if (options.assetDir !== undefined && options.assetDir.trim() !== '') {
    candidates.push(path.join(options.assetDir, VOCAB_FILE_NAME));
  }
  if (options.cwd !== undefined && options.cwd.trim() !== '') {
    candidates.push(path.join(options.cwd, VOCAB_FILE_NAME));
  }
  for (const candidate of candidates) {
    const text = await readFile(candidate, 'utf8').catch(() => null);
    if (text === null) continue;
    const parsed = parseVocabFile(text, candidate);
    return { source: path.resolve(candidate), entries: parsed.entries, prefixes: parsed.prefixes };
  }
  return { source: 'builtin', entries: [], prefixes: [] };
}
