// kinemesh_info 工具层：路径解析、成功返回、三段式自愈文案（错在哪/正确姿势/当前这一步）。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildAnimatedCubeGltf,
  buildBinaryFbx,
  buildCubeObj,
  encodeGltfBytes,
  encodeGlb,
  encodeText,
} from '../support/kinemesh-fixtures.js';
import { registerTools } from '../../plugins/kinemesh/src/tools.js';

interface RegisteredTool {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function setup(): { tool: RegisteredTool; dispose: () => void } {
  const registered = new Map<string, RegisteredTool>();
  const ctx = {
    tools: {
      register(definition: RegisteredTool): () => void {
        registered.set(definition.name, definition);
        return () => {
          registered.delete(definition.name);
        };
      },
    },
  };
  const dispose = registerTools(ctx);
  const tool = registered.get('kinemesh_info');
  if (tool === undefined) throw new Error('kinemesh_info 没有注册成功');
  return { tool, dispose };
}

const workDir = await mkdtemp(path.join(tmpdir(), 'kinemesh-info-'));

async function writeFixture(name: string, bytes: Uint8Array): Promise<string> {
  const file = path.join(workDir, name);
  await writeFile(file, bytes);
  return file;
}

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('kinemesh_info', () => {
  it('注册的工具名是 kinemesh_info，dispose 可释放', () => {
    const { tool, dispose } = setup();
    expect(tool.name).toBe('kinemesh_info');
    expect(() => dispose()).not.toThrow();
  });

  it('缺 path 给三段式指引', async () => {
    const { tool } = setup();
    const result = await tool.execute({});
    expect(result.ok).toBe(false);
    expect(String(result.guidance)).toContain('path');
    expect(String(result.step)).toContain('当前这一步');
  });

  it('glb 文件返回完整 info（相对路径按 cwd 解析）', async () => {
    const file = await writeFixture('cube.glb', new Uint8Array(encodeGlb(buildAnimatedCubeGltf())));
    const { tool } = setup();
    const result = await tool.execute({ path: file });
    expect(result.ok).toBe(true);
    expect(result.format).toBe('glb');
    expect(result.clips).toHaveLength(1);
    expect(result.bones).toMatchObject({ count: 2 });
  });

  it('fbx / obj 各走一条路径', async () => {
    const { tool } = setup();
    const fbx = await writeFixture('cube.fbx', new Uint8Array(buildBinaryFbx()));
    const fbxResult = await tool.execute({ path: fbx });
    expect(fbxResult.ok).toBe(true);
    expect(fbxResult.format).toBe('fbx-binary');

    const obj = await writeFixture('cube.obj', new TextEncoder().encode(buildCubeObj()));
    const objResult = await tool.execute({ path: obj });
    expect(objResult.ok).toBe(true);
    expect(objResult.format).toBe('obj');
  });

  it('.max 文件给 3ds Max 导出指引（三段式）', async () => {
    const file = await writeFixture('hero.max', new TextEncoder().encode('nonsense'));
    const { tool } = setup();
    const result = await tool.execute({ path: file });
    expect(result.ok).toBe(false);
    expect(String(result.what)).toContain('.max');
    expect(String(result.guidance)).toContain('3ds Max');
    expect(String(result.step)).toContain('当前这一步');
  });

  it('不存在的路径给可读指引', async () => {
    const { tool } = setup();
    const result = await tool.execute({ path: path.join(workDir, 'no-such-file.fbx') });
    expect(result.ok).toBe(false);
    expect(String(result.guidance)).toContain('路径');
  });

  it('gltf 文本文件也能读', async () => {
    const file = await writeFixture('cube.gltf', new TextEncoder().encode(JSON.stringify(buildAnimatedCubeGltf())));
    const { tool } = setup();
    const result = await tool.execute({ path: file });
    expect(result.ok).toBe(true);
    expect(result.format).toBe('gltf');
  });
});
