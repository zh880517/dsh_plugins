// 交接单落盘：`<HANDOFF_HOME>/<sessionId>-<yyyyMMdd-HHmmss>.md`。
//
// 这是交接里**唯一不可撤销的前置写操作**：备份写成功才允许 append 替换（fail closed，
// design.md §4.3）。因此这里不吞异常——目录建不出来、文件写不进去都直接抛给调用方。
//
// `HANDOFF_HOME` 只在调用时读取（不在模块加载时固化），测试用临时目录重定向，
// 不碰真实 home；未设置时退回 `~/.dsh/handoff`（design.md §6）。

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 默认交接备份目录：`~/.dsh/handoff`。 */
export function handoffHome(): string {
  const override = process.env['HANDOFF_HOME'];
  if (override !== undefined && override.trim() !== '') return path.resolve(override.trim());
  return path.join(os.homedir(), '.dsh', 'handoff');
}

/** 写一次备份需要的全部输入。 */
export interface HandoffBackupRequest {
  /** DSH 会话 id；只用作文件名前缀。 */
  readonly sessionId: string;
  /** 交接单正文（markdown）。 */
  readonly doc: string;
  /** 覆盖时间戳，单测用；缺省取当前时间（本地时区）。 */
  readonly now?: Date | undefined;
  /** 覆盖根目录，单测用；缺省读 `HANDOFF_HOME`，再退回 `~/.dsh/handoff`。 */
  readonly home?: string | undefined;
}

/** 把会话 id 收敛成安全文件名：只保留字母、数字与 `._-`。 */
function safeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return cleaned === '' ? 'session' : cleaned;
}

/** `yyyyMMdd-HHmmss`（本地时区）。 */
function timestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * 交接单备份文件名：`<sessionId>-<yyyyMMdd-HHmmss>.md`。
 *
 * @param sessionId - DSH 会话 id。
 * @param now - 时间戳来源。
 * @returns 文件名（不含目录）。
 */
export function handoffBackupFileName(sessionId: string, now: Date): string {
  return `${safeSessionId(sessionId)}-${timestamp(now)}.md`;
}

/**
 * 把交接单写到备份目录，返回写入的绝对路径。
 *
 * 目录不存在时自建（`recursive: true`）；正文末尾补一个换行（已有则不重复补）。
 * 任何失败都抛错，调用方必须据此放弃交接。
 *
 * @param request - 会话 id、正文与可选的时间/目录覆盖。
 * @returns 备份文件的绝对路径。
 */
export async function writeBackup(request: HandoffBackupRequest): Promise<string> {
  const home =
    request.home !== undefined && request.home.trim() !== '' ? path.resolve(request.home.trim()) : handoffHome();
  const file = path.resolve(path.join(home, handoffBackupFileName(request.sessionId, request.now ?? new Date())));
  const body = request.doc.endsWith('\n') ? request.doc : `${request.doc}\n`;
  try {
    await mkdir(home, { recursive: true });
    await writeFile(file, body, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`handoff backup failed: ${reason}`, { cause: error });
  }
  return file;
}
