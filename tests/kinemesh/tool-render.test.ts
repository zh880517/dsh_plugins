// kinemesh_render 工具：真实 chromium 渲染合成 FBX（chromium 缺席时整组跳过）。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildBinaryFbx } from '../support/kinemesh-fixtures.js';
import { registerTools } from '../../plugins/kinemesh/src/tools.js';

const workDir = await mkdtemp(path.join(tmpdir(), 'kinemesh-render-'));
const fbxPath = path.join(workDir, 'cube-anim.fbx');
await writeFile(fbxPath, Buffer.from(buildBinaryFbx()));

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

let chromiumReady = false;
try {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  await browser.close();
  chromiumReady = true;
} catch {
  chromiumReady = false;
}

interface RegisteredTool {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function renderExecute(): RegisteredTool['execute'] {
  let registered: RegisteredTool | undefined;
  const ctx = {
    tools: {
      register(definition: RegisteredTool): () => void {
        if (definition.name === 'kinemesh_render') registered = definition;
        return () => undefined;
      },
    },
  };
  registerTools(ctx);
  if (registered === undefined) throw new Error('kinemesh_render 没有注册');
  return registered.execute;
}

describe.skipIf(!chromiumReady)('kinemesh_render 工具', () => {
  it('渲染两帧并返回 PNG 绝对路径', async () => {
    const execute = renderExecute();
    const result = await execute({
      path: fbxPath,
      frames: [0, 30],
      clip: 'Take 001',
      viewPreset: 'front',
      width: 320,
      height: 240,
      out: workDir,
    });
    expect(result.ok).toBe(true);
    const images = result.images as string[];
    expect(images).toHaveLength(2);
    expect(images.every((file) => path.isAbsolute(file))).toBe(true);
    expect((result.hint as string).length).toBeGreaterThan(0);
  }, 120_000);

  it('缺 frames 给三段式指引', async () => {
    const execute = renderExecute();
    const result = await execute({ path: 'x.fbx' });
    expect(result.ok).toBe(false);
    expect(String(result.guidance)).toContain('frames');
    expect(String(result.step)).toContain('当前这一步');
  });

  it('playwright 缺席时给安装指引（在无 chromium 的环境才有意义）', async () => {
    if (chromiumReady) return; // 本机有 chromium，跳过这个口径
    const execute = renderExecute();
    const result = await execute({ path: 'x.fbx', frames: [0] });
    expect(result.ok).toBe(false);
    expect(String(result.guidance)).toContain('playwright');
  });
});
