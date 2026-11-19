// kinemesh_info 工具层：路径解析、成功返回、三段式自愈文案（错在哪/正确姿势/当前这一步）。
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  // ———————— B.6：bones.convention / bones.mapped（M7 review 补齐） ————————

  /** humanoid 命名 skin 的最小 GLB（5 关节链 + 蒙皮 cube；fastInfo 纯 JSON 路径） */
  function buildHumanoidSkinGltf(): Record<string, unknown> {
    const joints = ['Hips', 'Spine', 'Head', 'LeftArm', 'RightArm'];
    const nodes = [
      { name: 'Hips', children: [1] },
      { name: 'Spine', children: [2, 3, 4] },
      { name: 'Head' },
      { name: 'LeftArm' },
      { name: 'RightArm' },
      { name: 'cube', mesh: 0, skin: 0 },
    ];
    const positions = new Float32Array([
      -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
      -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    ]);
    const indices = new Uint16Array([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3, 2, 6, 3, 6, 7,
    ]);
    const ibm = new Float32Array(5 * 16); // 5 个单位 MAT4（fastInfo 不读数值）
    const sections = [positions, indices, ibm];
    const chunks: Uint8Array[] = [];
    const views: Array<{ offset: number; byteLength: number }> = [];
    let cursor = 0;
    for (const part of sections) {
      const bytes = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
      views.push({ offset: cursor, byteLength: part.byteLength });
      chunks.push(bytes);
      cursor += part.byteLength;
      const padding = (4 - (cursor % 4)) % 4;
      if (padding !== 0) {
        chunks.push(new Uint8Array(padding));
        cursor += padding;
      }
    }
    const bytes = new Uint8Array(cursor);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return {
      asset: { version: '2.0', generator: 'kinemesh-fixtures' },
      scene: 0,
      scenes: [{ name: 'Scene', nodes: [0, 5] }],
      nodes,
      meshes: [{ name: 'Body', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
      materials: [{ name: 'BodyMat', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.4, 1] } }],
      skins: [{ name: 'Rig', joints: [0, 1, 2, 3, 4], inverseBindMatrices: 2 }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
        { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
        { bufferView: 2, componentType: 5126, count: 5, type: 'MAT4' },
      ],
      bufferViews: views.map((view) => ({ buffer: 0, byteOffset: view.offset, byteLength: view.byteLength })),
      buffers: [{ byteLength: cursor, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}` }],
    };
  }

  it('B.6：skin 关节名走字典计数（convention=custom、mapped=字典命中数）', async () => {
    const file = await writeFixture('humanoid-skin.glb', new Uint8Array(encodeGlb(buildHumanoidSkinGltf())));
    const { tool } = setup();
    const result = await tool.execute({ path: file });
    expect(result.ok).toBe(true);
    expect(result.bones).toMatchObject({ count: 5, maxDepth: 2, humanoidLike: true, convention: 'custom', mapped: 5 });
  });

  it('B.6：资产旁 kinemesh-bones.json 时 mapped 取映射计数（fastInfo 路径覆盖）', async () => {
    const dir = path.join(workDir, 'mapped-asset');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'humanoid-skin.glb');
    await writeFile(file, new Uint8Array(encodeGlb(buildHumanoidSkinGltf())));
    await writeFile(path.join(dir, 'kinemesh-bones.json'), JSON.stringify({ _meta: { archetype: 'humanoid' }, bones: { Hips: 'hips', Spine: 'spine', Head: 'head' } }), 'utf8');
    const { tool } = setup();
    const result = await tool.execute({ path: file });
    expect(result.ok).toBe(true);
    expect(result.bones).toMatchObject({ count: 5, convention: 'custom', mapped: 3 });
  });

  it('B.6：FBX 场景路径同样接映射计数（sceneToInfo 侧）', async () => {
    const dir = path.join(workDir, 'fbx-mapped');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'cube-anim.fbx');
    await writeFile(file, new Uint8Array(buildBinaryFbx()));
    await writeFile(path.join(dir, 'kinemesh-bones.json'), JSON.stringify({ _meta: { archetype: 'humanoid' }, bones: { Hips: 'hips', Spine: 'spine', Head: 'head' } }), 'utf8');
    const { tool } = setup();
    const result = await tool.execute({ path: file });
    expect(result.ok).toBe(true);
    expect(result.bones).toMatchObject({ count: 0, convention: null, mapped: 3 });
  });
});
