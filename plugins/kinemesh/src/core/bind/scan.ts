// 同资产 mesh 文件内容扫描（0.10.1「不依赖文件名」）：动作文件没有网格时，在它附近找
// 「真的有网格、且骨骼能和动作对上」的模型文件——判定全部来自**文件内容**（FBX 的 Geometry/Model
// 节点、glTF 的 meshes/skins 节点），不依赖文件名或目录命名约定。
//
// 扫描范围：动作文件所在目录 / 上一级（角色目录）/ 上两级（资产根），各向下 3 层、最多 400 个模型文件；
// 先用便宜的字节探测（不解析场景）找出有网格的文件，ASCII FBX 还能直接抽骨骼名；
// 二进制 FBX 等无法便宜抽骨骼的格式，只对排序靠前的少数候选做一次真实解析补骨骼名。
// 进程内按「路径 + mtime + 大小」缓存探测结果，同一资产反复预览不重复读文件。
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { detectFormatByContent } from '../registry.js';
import path from 'node:path';
import { loadModelScene } from '../analyze-file.js';
import { nodeNameKey } from './names.js';

/** 一次内容扫描的预算（长尾资产不扫全盘） */
const MAX_DEPTH = 3;
const MAX_FILES = 400;
const MAX_RESULTS = 6;
/** 无法便宜抽骨骼名的格式（二进制 FBX），最多解析几个候选来评分 */
const MAX_PARSE_CANDIDATES = 4;
/**
 * 自动配对的最低骨骼覆盖率：低于它说明只是「部分骨骼同名」（典型是跨角色的附加/受击动画，
 * 5 根脊柱骨在任意双足角色上都能对上），不应自动绑定——显式 mesh 参数仍然可用。
 */
const MIN_AUTO_COVERAGE = 0.35;
export interface CompanionMeshMatch {
  path: string;
  name: string;
  bytes: number;
  /** 命中动作骨骼的数量（按骨骼名归一化后比较） */
  matchedBones: number;
  /** 网格文件自身的骨骼数（拿不到时为 0） */
  meshBones: number;
  /** matchedBones / meshBones（0 表示未知或无骨骼） */
  coverage: number;
  /** 相对扫描根的目录深度（越小越靠近动作文件） */
  depth: number;
  /** 命中理由（给 warnings / 面板展示） */
  reason: string;
}

interface Probe {
  path: string;
  name: string;
  bytes: number;
  hasMesh: boolean;
  /** ASCII FBX / glTF 可直接抽骨骼名；二进制 FBX 为 null（需解析） */
  boneNames: string[] | null;
  /** 相对扫描根的目录深度 */
  depth: number;
}

interface CachedProbe {
  mtimeMs: number;
  size: number;
  probe: Omit<Probe, 'depth'> | null;
}

const probeCache = new Map<string, CachedProbe>();

/** 测试钩子：清空探测缓存（进程内状态，不涉及磁盘） */
export function clearCompanionScanCache(): void {
  probeCache.clear();
}

/** 从场景对象收集骨骼名（给自动扫描/候选报告用） */
export function collectBoneNames(root: { traverse: (callback: (child: unknown) => void) => void }): string[] {
  const names: string[] = [];
  root.traverse((child) => {
    const bone = child as { isBone?: boolean; name?: string };
    if (bone.isBone === true && typeof bone.name === 'string' && bone.name !== '') names.push(bone.name);
  });
  return names;
}

/**
 * 动作侧的「骨架节点名」：骨骼名 + 动画轨道驱动的节点名。
 * 动作-only 的 glTF 没有 skin，节点会是一般 Object3D（不是 Bone）——只收骨骼会漏掉，
 * 所以运动轨道里的节点名也一并算作骨架节点（用于跟网格侧骨骼名做覆盖率匹配）。
 */
export function collectSkeletonNames(scene: {
  object: { traverse: (callback: (child: unknown) => void) => void };
  animations: ReadonlyArray<{ tracks: ReadonlyArray<{ name: string }> }>;
}): string[] {
  const names = new Set(collectBoneNames(scene.object));
  for (const clip of scene.animations) {
    for (const track of clip.tracks) {
      const parsed = parseTrackNodeName(track.name);
      if (parsed !== '') names.add(parsed);
    }
  }
  return [...names];
}

/** 轨道名取节点名（与 three 的 PropertyBinding 解析口径一致，避免手写正则偏差） */
function parseTrackNodeName(trackName: string): string {
  // three 的 parseTrackName 在 core/bind/remap 已用；这里为避免把 three 依赖带进纯扫描逻辑，
  // 只做「最后一个属性段之前的节点名」提取（`Hips.quaternion` → `Hips`）。
  const lastDot = trackName.lastIndexOf('.');
  return lastDot > 0 ? trackName.slice(0, lastDot) : trackName;
}

/**
 * 内容扫描：找「有网格 + 骨骼能对上」的候选模型文件（按骨骼覆盖率排序）。
 * @param absPath 动作文件绝对路径
 * @param animationBoneNames 动作文件的骨骼名（用于覆盖率评分；空数组时只按文件内容筛网格）
 */
export async function findCompanionMeshes(
  absPath: string,
  animationBoneNames: readonly string[],
  options: { maxResults?: number; maxFiles?: number; maxDepth?: number } = {},
): Promise<CompanionMeshMatch[]> {
  const self = path.resolve(absPath);
  const files = await collectNearbyModelFiles(self, options.maxFiles ?? MAX_FILES, options.maxDepth ?? MAX_DEPTH);
  if (files.length === 0) return [];

  const probes: Probe[] = [];
  const batch = 16;
  for (let offset = 0; offset < files.length; offset += batch) {
    const chunk = files.slice(offset, offset + batch);
    const results = await Promise.all(chunk.map((entry) => probeModelFile(entry.abs, entry.depth)));
    for (const probe of results) if (probe !== null) probes.push(probe);
  }

  const animationKeys = new Set(animationBoneNames.map((name) => nodeNameKey(name)));
  const meshProbes = probes.filter((probe) => probe.hasMesh);
  if (meshProbes.length === 0) return [];

  // 无法便宜抽骨骼（二进制 FBX）：按「近 / 小」优先，最多解析几个补骨骼名
  const unknown = meshProbes
    .filter((probe) => probe.boneNames === null)
    .sort((left, right) => left.bytes - right.bytes);
  const parseBudget = Math.min(MAX_PARSE_CANDIDATES, unknown.length);
  const resolved = new Map<string, { boneNames: string[]; hasMesh: boolean }>();
  await Promise.all(
    unknown.slice(0, parseBudget).map(async (probe) => {
      const parsed = await parseBonesOf(probe.path);
      if (parsed !== null) resolved.set(probe.path, parsed);
    }),
  );

  const matches: CompanionMeshMatch[] = [];
  for (const probe of meshProbes) {
    const boneNames = probe.boneNames ?? resolved.get(probe.path)?.boneNames ?? null;
    const hasMesh = probe.boneNames === null ? (resolved.get(probe.path)?.hasMesh ?? probe.hasMesh) : probe.hasMesh;
    if (hasMesh !== true) continue;
    const stats = scoreBones(boneNames, animationKeys);
    if (animationKeys.size > 0 && stats.matchedBones === 0) continue; // 骨骼一根都对不上：不可能是它的 mesh
    const coverage = stats.meshBones > 0 ? stats.matchedBones / stats.meshBones : 0;
    // 覆盖率太低（只有部分骨骼同名，典型是跨角色的附加动画）→ 不自动绑定，避免把动作套到别的角色上
    if (animationKeys.size > 0 && coverage < MIN_AUTO_COVERAGE) continue;
    matches.push({
      path: probe.path,
      name: probe.name,
      bytes: probe.bytes,
      matchedBones: stats.matchedBones,
      meshBones: stats.meshBones,
      coverage,
      depth: probe.depth,
      reason:
        stats.meshBones > 0
          ? `骨骼名匹配 ${stats.matchedBones} 个（覆盖率 ${Math.round(coverage * 100)}%）`
          : '文件里有网格（骨骼名需解析确认）',
    });
  }
  matches.sort((left, right) => {
    if (right.coverage !== left.coverage) return right.coverage - left.coverage;
    if (right.matchedBones !== left.matchedBones) return right.matchedBones - left.matchedBones;
    if (left.bytes !== right.bytes) return left.bytes - right.bytes;
    if (left.depth !== right.depth) return left.depth - right.depth;
    return left.path.localeCompare(right.path);
  });
  return matches.slice(0, options.maxResults ?? MAX_RESULTS);
}

// ———————— 目录遍历 ————————

interface ModelFileRef {
  abs: string;
  depth: number;
}

/** 动作文件附近收集候选文件：所在目录 / 上一级 / 上两级，各向下 maxDepth 层（不看文件名/扩展名） */
async function collectNearbyModelFiles(absPath: string, maxFiles: number, maxDepth: number): Promise<ModelFileRef[]> {
  const ownDir = path.dirname(absPath);
  const roots = [ownDir, path.dirname(ownDir), path.dirname(path.dirname(ownDir))];
  const files: ModelFileRef[] = [];
  const seen = new Set<string>();
  const seenDirs = new Set<string>();
  for (const root of roots) {
    if (seenDirs.has(root)) continue;
    seenDirs.add(root);
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (queue.length > 0 && files.length < maxFiles) {
      const current = queue.shift()!;
      if (current.depth > maxDepth) continue;
      const entries = await readdir(current.dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || SKIP_DIR_NAMES.has(entry.name)) continue;
          queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        const abs = path.join(current.dir, entry.name);
        if (path.resolve(abs) === absPath) continue; // 动作文件自己
        const key = path.resolve(abs).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        files.push({ abs, depth: current.depth });
        if (files.length >= maxFiles) break;
      }
    }
    if (files.length >= maxFiles) break;
  }
  return files;
}

/** 明显不是模型资产的目录（避免扫贴图/缓存目录） */
const SKIP_DIR_NAMES = new Set(['node_modules', 'Library', 'obj', 'Temp', 'Logs', 'UserSettings', 'PackageCache']);

// ———————— 便宜探测（不解析场景） ————————

/** 只读文件头（自愈：读不到返回 null） */
async function readHead(abs: string, bytes: number): Promise<Buffer | null> {
  try {
    const handle = await open(abs, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function probeModelFile(abs: string, depth: number): Promise<Probe | null> {
  const info = await stat(abs).catch(() => undefined);
  if (info === undefined || !info.isFile()) return null;
  const cached = probeCache.get(abs);
  if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached.probe === null ? null : { ...cached.probe, depth };
  }
  let probe: Omit<Probe, 'depth'> | null = null;
  try {
    // 内容探测（忽略扩展名）：先读头判格式，非模型文件直接跳过，不做全量读取
    const head = await readHead(abs, 4096);
    const entry = head === null ? null : detectFormatByContent(head);
    if (entry !== null) {
      const data = await readFile(abs);
      probe = probeBuffer(abs, data, entry.id);
    }
  } catch {
    probe = null;
  }
  probeCache.set(abs, { mtimeMs: info.mtimeMs, size: info.size, probe });
  return probe === null ? null : { ...probe, depth };
}

/** 按内容格式做便宜探测：是否有网格 + 能便宜拿到的骨骼名 */
function probeBuffer(abs: string, data: Buffer, format: string): Omit<Probe, 'depth'> | null {
  const name = path.basename(abs);
  const base = { path: abs, name, bytes: data.byteLength };
  if (format === 'fbx') {
    if (isFbxBinary(data)) {
      const text = data.toString('latin1');
      // 二进制 FBX 的节点名以明文字符串存放：有 Geometry 节点 = 有网格（骨骼名留给解析）
      return { ...base, hasMesh: text.includes('Geometry'), boneNames: null };
    }
    const text = data.toString('utf8');
    return {
      ...base,
      hasMesh: /(^|\n)\s*Geometry:/.test(text),
      boneNames: extractAsciiFbxBones(text),
    };
  }
  if (format === 'gltf') {
    // 内容判格式：GLB 有 'glTF' magic，否则按 JSON 文本解析（扩展名无关）
    const json = isGlb(data) ? readGlbJson(data) : parseJsonText(data);
    if (json === null) return null;
    return { ...base, hasMesh: gltfHasMesh(json), boneNames: gltfBoneNames(json) };
  }
  if (format === 'obj') {
    // OBJ 只有静态网格、没有骨骼：可以当网格，但骨骼覆盖率会是 0
    return { ...base, hasMesh: true, boneNames: [] };
  }
  return null;
}

function isGlb(data: Buffer): boolean {
  return data.length >= 4 && data.toString('latin1', 0, 4) === 'glTF';
}

function parseJsonText(data: Buffer): Record<string, unknown> | null {
  try {
    return JSON.parse(data.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isFbxBinary(data: Buffer): boolean {
  const magic = 'Kaydara FBX Binary  \x00\x1a\x00';
  return data.length >= magic.length && data.toString('latin1', 0, magic.length) === magic;
}

/** ASCII FBX 直接抽骨骼名（Model: id, "Model::Name", "LimbNode"|"Bone"|"Root"） */
function extractAsciiFbxBones(text: string): string[] {
  const names: string[] = [];
  const pattern = /(?:^|\n)\s*Model:\s*\d+\s*,\s*"([^"]*)"\s*,\s*"(LimbNode|Bone|Root)"\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = (match[1] ?? '').replace(/^Model::/, '').replace(/^Model\|/, '');
    if (raw !== '') names.push(raw);
  }
  return names;
}

function readGlbJson(data: Buffer): Record<string, unknown> | null {
  if (data.length < 20) return null;
  const magic = data.readUInt32LE(0);
  if (magic !== 0x46546c67) return null; // 'glTF'
  const chunkLength = data.readUInt32LE(12);
  const chunkType = data.readUInt32LE(16);
  if (chunkType !== 0x4e4f534a) return null; // 'JSON'
  try {
    return JSON.parse(data.toString('utf8', 20, Math.min(20 + chunkLength, data.length))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function gltfHasMesh(json: Record<string, unknown>): boolean {
  return Array.isArray(json.meshes) && json.meshes.length > 0;
}

/** glTF 骨骼名：skins[].joints 指向的节点名（没有 skin 时为空 = 不能当绑定位） */
function gltfBoneNames(json: Record<string, unknown>): string[] {
  const nodes = Array.isArray(json.nodes) ? (json.nodes as Array<Record<string, unknown>>) : [];
  const skins = Array.isArray(json.skins) ? (json.skins as Array<Record<string, unknown>>) : [];
  const names: string[] = [];
  for (const skin of skins) {
    const joints = Array.isArray(skin.joints) ? (skin.joints as number[]) : [];
    for (const index of joints) {
      const node = nodes[index];
      const name = node !== undefined && typeof node.name === 'string' ? node.name : '';
      if (name !== '') names.push(name);
    }
  }
  return [...new Set(names)];
}

// ———————— 二进制候选补骨骼名（解析一次） ————————

async function parseBonesOf(abs: string): Promise<{ boneNames: string[]; hasMesh: boolean } | null> {
  try {
    const data = await readFile(abs);
    const { scene } = await loadModelScene(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      path.basename(abs),
    );
    let hasMesh = false;
    scene.object.traverse((child) => {
      if ((child as { isMesh?: boolean }).isMesh === true) hasMesh = true;
    });
    return { boneNames: collectBoneNames(scene.object), hasMesh };
  } catch {
    // 解析失败（含 Node 端不支持的内嵌视频贴图等）：不参与评分
    return null;
  }
}

function scoreBones(boneNames: readonly string[] | null, animationKeys: Set<string>): { matchedBones: number; meshBones: number } {
  if (boneNames === null) return { matchedBones: 0, meshBones: 0 };
  const unique = new Set(boneNames.map((name) => nodeNameKey(name)));
  let matched = 0;
  for (const key of unique) if (animationKeys.has(key)) matched += 1;
  return { matchedBones: matched, meshBones: unique.size };
}
