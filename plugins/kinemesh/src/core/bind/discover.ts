// 同资产 mesh 文件自动发现（0.10.0「独立 mesh 文件」）：动作-only 文件没有网格时，
// 在它所在资产的常见位置找「像角色 mesh 的文件」，给预览/截图自动绑定用。
//
// 判定是**启发式命名 + 目录约定**，不解析文件内容（解析交给调用方，校验 meshes 非空）；
// 只收窄候选范围：本目录 / 上一级角色目录 / 上两级资产目录 / 这些目录下的 basic|mesh|model|body|skin 子目录。
// 游戏资产的实际布局（实测）：<角色>/hit/xxx.fbx（动作-only）+ <角色>/basic/<角色>_skin.fbx。
import { readdir } from 'node:fs/promises';
import path from 'node:path';

export interface CompanionCandidate {
  path: string;
  name: string;
  /** 排序分（越大越像 mesh 文件） */
  score: number;
  /** 命中理由（警告里给用户看：为什么选中它） */
  reason: string;
}

const MODEL_EXTENSIONS = new Set(['.fbx', '.glb', '.gltf', '.obj']);
/** 常见 mesh 目录名（资产里角色网格通常放这些目录） */
const MESH_DIR_NAMES = /^(basic|mesh|meshes|model|models|body|skin|char|character)$/i;
/** 文件名里像动画的词——命中则降权（避免把另一段动作当成网格文件） */
const ANIM_NAME_HINTS = /(attack|idle|run|walk|hit|behit|dead|dodge|skill|jump|stand|stun|turn|charge|cast|born|start|end|loop|pose|anim)/i;
/** 文件名里像网格的词（分数从高到低，取第一个命中的） */
const MESH_NAME_HINTS: ReadonlyArray<{ pattern: RegExp; score: number; reason: string }> = [
  { pattern: /_skin\b/i, score: 140, reason: '文件名含 _skin' },
  { pattern: /skin/i, score: 120, reason: '文件名含 skin' },
  { pattern: /mesh/i, score: 100, reason: '文件名含 mesh' },
  { pattern: /body/i, score: 80, reason: '文件名含 body' },
  { pattern: /model/i, score: 70, reason: '文件名含 model' },
  { pattern: /char(acter)?/i, score: 60, reason: '文件名含 character' },
];

/** 一次发现最多返回的候选数（调用方按分数从高到低逐个校验/尝试） */
export const MAX_COMPANION_CANDIDATES = 5;

/**
 * 发现同资产的候选 mesh 文件（按分数降序）。
 * 只看动作文件附近的目录（含 basic/ 之类约定子目录），不递归全盘；排除动作文件本身。
 */
export async function discoverCompanionMeshes(absPath: string): Promise<CompanionCandidate[]> {
  const self = path.resolve(absPath);
  const ownDir = path.dirname(self);
  const characterDir = path.dirname(ownDir);
  const assetDir = path.dirname(characterDir);
  const dirs = await collectCandidateDirs([ownDir, characterDir, assetDir]);

  const candidates: CompanionCandidate[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!MODEL_EXTENSIONS.has(ext)) continue;
      const filePath = path.join(dir, entry.name);
      if (path.resolve(filePath) === self) continue;
      const key = path.resolve(filePath).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(scoreCandidate(filePath, entry.name, dir, ownDir, characterDir));
    }
  }
  return candidates
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, MAX_COMPANION_CANDIDATES);
}

/** 目录清单：本目录 / 角色目录 / 资产目录 + 各自下的 mesh 约定子目录（dedupe） */
async function collectCandidateDirs(seeds: string[]): Promise<string[]> {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const push = (dir: string): void => {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    dirs.push(dir);
  };
  /** 只展开一层「mesh 约定」子目录（basic/、mesh/ 等），不做全递归 */
  const expand = async (dir: string): Promise<void> => {
    push(dir);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && MESH_DIR_NAMES.test(entry.name)) push(path.join(dir, entry.name));
    }
  };
  for (const seed of seeds) await expand(seed);
  return dirs;
}

/** 打分：目录约定 + 文件名关键词 − 动画词降权 + 与角色目录名的词干重合 */
function scoreCandidate(filePath: string, fileName: string, dir: string, ownDir: string, characterDir: string): CompanionCandidate {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const reasons: string[] = [];
  let score = 0;
  const dirBase = path.basename(dir);
  if (MESH_DIR_NAMES.test(dirBase)) {
    score += 40;
    reasons.push(`${dirBase}/ 目录`);
  } else if (path.resolve(dir) === path.resolve(ownDir)) {
    score += 10;
  }
  for (const hint of MESH_NAME_HINTS) {
    if (hint.pattern.test(stem)) {
      score += hint.score;
      reasons.push(hint.reason);
      break;
    }
  }
  if (ANIM_NAME_HINTS.test(stem) && !/skin|mesh|body|model/i.test(stem)) score -= 90;
  const characterStem = path.basename(characterDir).toLowerCase();
  if (characterStem !== '' && stem.toLowerCase().startsWith(characterStem)) {
    score += 30;
    reasons.push('文件名以角色目录名开头');
  }
  return {
    path: filePath,
    name: fileName,
    score,
    reason: reasons.length === 0 ? '同目录附近的模型文件' : reasons.join(' + '),
  };
}
