// 产物临时目录（0.9.2）：统一落到 <cwd>/.kinemeshtmp/run-<时间戳>-<pid>/，不再散落到系统临时目录。
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createRunDir,
  ensureTempDir,
  runDirName,
  TEMP_DIR_ENV,
  TEMP_DIR_NAME,
  tempRootDir,
} from '../../plugins/kinemesh/src/core/temp-dir.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'kinemesh-tempdir-'));

afterAll(() => {
  delete process.env[TEMP_DIR_ENV];
  rmSync(scratch, { recursive: true, force: true });
});

describe('产物临时目录（.kinemeshtmp）', () => {
  it('缺省根目录 = 当前工作目录下的 .kinemeshtmp（不是系统临时目录）', () => {
    delete process.env[TEMP_DIR_ENV];
    const root = tempRootDir();
    expect(path.basename(root)).toBe(TEMP_DIR_NAME);
    expect(root).toBe(path.join(process.cwd(), TEMP_DIR_NAME));
  });

  it('KINEMESH_TMP_DIR 可覆盖根目录（测试/自定义）', () => {
    process.env[TEMP_DIR_ENV] = path.join(scratch, 'custom-root');
    expect(tempRootDir()).toBe(path.resolve(scratch, 'custom-root'));
  });

  it('run 目录名格式 run-<时间戳>-<pid>（同类 run 互相隔离）', () => {
    expect(runDirName()).toMatch(/^run-\d+-\d+$/);
    expect(runDirName(1700000000000, 4242)).toBe('run-1700000000000-4242');
  });

  it('createRunDir 自动建目录，且只有一层 .kinemeshtmp/run-* （没有多余的 tmp/kinemesh-* 子层）', () => {
    process.env[TEMP_DIR_ENV] = path.join(scratch, 'mk');
    const dir = createRunDir();
    expect(existsSync(dir)).toBe(true);
    expect(path.dirname(dir)).toBe(path.join(scratch, 'mk'));
    expect(path.basename(dir)).toMatch(/^run-\d+-\d+$/);
  });

  it('ensureTempDir 幂等（重复调用不报错）', () => {
    const target = path.join(scratch, 'idem', 'nested');
    expect(ensureTempDir(target)).toBe(target);
    expect(ensureTempDir(target)).toBe(target);
    expect(existsSync(target)).toBe(true);
  });
});
