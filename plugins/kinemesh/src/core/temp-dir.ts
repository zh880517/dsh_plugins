// 产物临时目录（0.9.2，用户拍板）：统一放到**当前工作目录下的 `.kinemeshtmp/`**，
// 不再散落到系统临时目录（Windows 上是 `...\AppData\Local\Temp\kinemesh-shots\run-…`），
// 也不要多套一层 `tmp` / `kinemesh-shots` 子文件夹——所有 run 直接是 `.kinemeshtmp/run-<时间戳>-<pid>`。
//
// · 目录可写性：cwd 不可写（只读工作区）时退回系统临时目录，保证插件任何环境下都能出图；
// · 测试/定制：`KINEMESH_TMP_DIR` 环境变量可指定根目录（CLI/测试用）；
// · 该目录已在仓库 .gitignore 里，不会被误提交。
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** 目录名（相对 cwd）：`.kinemeshtmp` */
export const TEMP_DIR_NAME = '.kinemeshtmp';

/** 环境变量：覆盖临时根目录（绝对路径；测试把产物导向自己的临时目录） */
export const TEMP_DIR_ENV = 'KINEMESH_TMP_DIR';

/** 本次 run 的子目录名：`run-<时间戳>-<pid>`（同类 run 相互隔离，避免互相覆盖） */
export function runDirName(now = Date.now(), pid = process.pid): string {
  return `run-${now}-${pid}`;
}

/**
 * 临时根目录（不创建）：优先 KINEMESH_TMP_DIR，其次 `<cwd>/.kinemeshtmp`。
 * 注意这里只做路径拼接，不保证可写——写之前用 ensureTempDir。
 */
export function tempRootDir(): string {
  const override = process.env[TEMP_DIR_ENV];
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim());
  return path.join(process.cwd(), TEMP_DIR_NAME);
}

/** 建目录（递归）；cwd 不可写时退回系统临时目录下的 `.kinemeshtmp`。返回实际使用的根目录 */
export function ensureTempDir(target: string): string {
  try {
    mkdirSync(target, { recursive: true });
    return target;
  } catch {
    const fallback = path.join(tmpdir(), TEMP_DIR_NAME);
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

/** 本次 run 的产物目录：`<根>/run-<时间戳>-<pid>`（缺省自动建好并返回） */
export function createRunDir(kind?: string): string {
  const root = ensureTempDir(tempRootDir());
  const dir = path.join(root, kind === undefined ? runDirName() : `${kind}-${runDirName()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
