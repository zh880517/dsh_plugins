// 进程内场景缓存（design.md §6.2）：`绝对路径 + mtime → 加载实例`。analyze / render / 面板
// 重复加载同一资产不再重复解析（解析 = loaders 的 entry.load，是 info/render 之外的贵路径）。
// 口径：host / CLI / MCP 各自进程内生效；不放 shared/、不做持久化、无 LRU 上限（§6.2 拍板）。
// 缓存复用安全的前提是采样后恢复 rest 姿态——sample.ts 的 finally 快照恢复是必经步骤（A.1）。
import { stat } from 'node:fs/promises';
import type { CanonicalScene } from './types.js';

const cache = new Map<string, CanonicalScene>();

/** stat 不可用时（文件在读后被删等竞态）退化为「永不命中」的键，不吞掉 load 本身的报错 */
async function mtimeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * 取缓存场景：命中（同路径同 mtime）直接返回同一实例，未命中才调 load 并入缓存。
 * load 抛错不进缓存；文件变化（mtime 变）自然产生新键、旧实例被替换。
 */
export async function getCachedScene(
  path: string,
  load: () => Promise<CanonicalScene> | CanonicalScene,
): Promise<CanonicalScene> {
  const mtime = await mtimeOf(path);
  const key = `${path}\u0000${mtime}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const scene = await load();
  cache.set(key, scene);
  return scene;
}

/** 测试钩子：清空缓存（进程内状态，不涉及磁盘） */
export function clearSceneCache(): void {
  cache.clear();
}

/** 测试 / 审计钩子：当前缓存条目数（命中与否用它断言） */
export function sceneCacheSize(): number {
  return cache.size;
}
