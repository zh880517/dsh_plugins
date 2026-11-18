// 截图管线集成测试（设计文档 §4.5 验收）：真实 chromium + WebGL 渲染合成 FBX 出 PNG。
// chromium 未安装时整组跳过（npm i playwright && npx playwright install chromium 可启用）。
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildBinaryFbx } from '../support/kinemesh-fixtures.js';
import { renderScreenshots } from '../../plugins/kinemesh/src/core/render/screenshot.js';

let chromiumReady = false;
try {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  await browser.close();
  chromiumReady = true;
} catch {
  chromiumReady = false;
}

const workDir = await mkdtemp(path.join(tmpdir(), 'kinemesh-shot-test-'));

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  // PNG：8 字节签名 + IHDR chunk（宽度在 offset 16，高度在 20，大端）
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe.skipIf(!chromiumReady)('renderScreenshots × playwright', () => {
  const data = buildBinaryFbx();

  it('按 viewPreset 渲染两帧 PNG', async () => {
    const result = await renderScreenshots({
      data,
      fileName: 'cube-anim.fbx',
      viewInput: { viewPreset: 'front', clip: 'Take 001' },
      frames: [0, 30],
      width: 320,
      height: 240,
      outDir: workDir,
    });
    expect(result.images).toHaveLength(2);
    const payloads: Buffer[] = [];
    for (const file of result.images) {
      expect(existsSync(file)).toBe(true);
      expect(path.dirname(file).startsWith(workDir)).toBe(true);
      const bytes = readFileSync(file);
      payloads.push(bytes);
      expect(bytes.length).toBeGreaterThan(200); // 不是空图
      const size = pngSize(bytes);
      expect(size).toEqual({ width: 320, height: 240 });
    }
    // 两个帧的姿势不同（位移曲线），截图内容必须不一样
    expect(payloads[0].equals(payloads[1])).toBe(false);
    expect(result.images[0]).toMatch(/f0-az0\.png$/);
    expect(result.images[1]).toMatch(/f30-az0\.png$/);
  }, 60_000);

  it('orbit8 一次出 8 个方位', async () => {
    const result = await renderScreenshots({
      data,
      fileName: 'cube-anim.fbx',
      viewInput: { viewPreset: 'orbit8', clip: 'Take 001' },
      frames: [0],
      width: 160,
      height: 120,
      outDir: workDir,
    });
    expect(result.images).toHaveLength(8);
    expect(result.images[0]).toMatch(/az0\.png$/);
    expect(result.images[7]).toMatch(/az315\.png$/);
  }, 120_000);

  it('静态模型不指定 clip 也能出图', async () => {
    const result = await renderScreenshots({
      data,
      fileName: 'cube-anim.fbx',
      viewInput: { viewPreset: 'three-quarter' },
      frames: [0],
      width: 160,
      height: 120,
      outDir: workDir,
    });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatch(/static-f0-az45\.png$/);
  }, 60_000);

  it('frames 为空给指引', async () => {
    await expect(
      renderScreenshots({ data, fileName: 'cube.fbx', viewInput: {}, frames: [], outDir: workDir }),
    ).rejects.toThrow(/frames/);
  });
});
