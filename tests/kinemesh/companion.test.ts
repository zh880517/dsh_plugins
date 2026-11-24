// 独立 mesh 文件（0.10.0）：自动识别「谁提供网格/谁提供动画」+ 按骨骼名绑定动画的回归。
// 覆盖：轨道重绑定（精确名 / 命名空间归一化 / 部分骨骼 / 完全不匹配）、角色自动识别与三段式、
// 同资产网格文件发现、info 的 mesh 参数体检、预览面板 chip 文案。
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { afterAll, describe, expect, it } from 'vitest';
import { bindScenes, loadSceneFromData, sceneFacts } from '../../plugins/kinemesh/src/core/bind/bundle.js';
import { findCompanionMeshes } from '../../plugins/kinemesh/src/core/bind/scan.js';
import { bindClipsToModel } from '../../plugins/kinemesh/src/core/bind/remap.js';
import { planCompanion, type SceneFacts } from '../../plugins/kinemesh/src/core/bind/roles.js';
import { KinemeshError } from '../../plugins/kinemesh/src/core/errors.js';
import type { CanonicalScene } from '../../plugins/kinemesh/src/core/types.js';
import { registerTools } from '../../plugins/kinemesh/src/tools.js';
import { basenameOf, meshBindingChip } from '../../plugins/kinemesh/src/client.js';
import {
  buildCubeAnimationOnlyGltf,
  buildSkinnedMeshOnlyGltf,
  encodeGlb,
} from '../support/kinemesh-fixtures.js';

const workDir = await mkdtemp(path.join(tmpdir(), 'kinemesh-companion-'));

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ———————— 轨道重绑定（core/bind/remap） ————————

function rigWithBones(names: string[]): THREE.Group {
  const root = new THREE.Group();
  for (const name of names) {
    const bone = new THREE.Bone();
    bone.name = name;
    root.add(bone);
  }
  return root;
}

function quaternionClip(name: string, nodeNames: string[]): THREE.AnimationClip {
  const tracks = nodeNames.map(
    (nodeName) => new THREE.QuaternionKeyframeTrack(`${nodeName}.quaternion`, [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  );
  return new THREE.AnimationClip(name, 1, tracks);
}

describe('bindClipsToModel：动画轨道按骨骼名绑定到 mesh 骨架', () => {
  it('精确同名：轨道保留、命中数正确', () => {
    const mesh = rigWithBones(['Hips', 'Spine']);
    const clip = quaternionClip('Walk', ['Hips', 'Spine']);
    const { clips, report } = bindClipsToModel(mesh, [clip]);
    expect(report.ok).toBe(true);
    expect(report.matchedTracks).toBe(2);
    expect(report.totalTracks).toBe(2);
    expect(report.matchedBones).toBe(2);
    expect(report.meshBones).toBe(2);
    expect(report.renamedTracks).toBe(0);
    expect(report.unmatchedNodeCount).toBe(0);
    expect(clips[0]!.tracks.map((track) => track.name)).toEqual(['Hips.quaternion', 'Spine.quaternion']);
  });

  it('mixamorig: 前缀：three 的 parseTrackName 原生去前缀，轨道名不变也能命中', () => {
    const mesh = rigWithBones(['Hips']);
    const clip = quaternionClip('Walk', ['mixamorig:Hips']);
    const { clips, report } = bindClipsToModel(mesh, [clip]);
    expect(report.ok).toBe(true);
    expect(report.matchedTracks).toBe(1);
    expect(report.matchedBones).toBe(1);
    // parseTrackName 已把 nodeName 归一成 Hips，命中精确名 → 不改名
    expect(report.renamedTracks).toBe(0);
    expect(clips[0]!.tracks[0]!.name).toBe('mixamorig:Hips.quaternion');
  });

  it('Armature| 前缀（parseTrackName 不去）：按归一化名命中并改写轨道名', () => {
    const mesh = rigWithBones(['Hips']);
    const clip = quaternionClip('Walk', ['Armature|Hips']);
    const { clips, report } = bindClipsToModel(mesh, [clip]);
    expect(report.ok).toBe(true);
    expect(report.renamedTracks).toBe(1);
    expect(report.matchedTracks).toBe(1);
    expect(clips[0]!.tracks[0]!.name).toBe('Hips.quaternion');
  });

  it('完全同名优先于归一化：不误改轨道名', () => {
    const mesh = rigWithBones(['Armature|Hips', 'Hips']);
    const clip = quaternionClip('Walk', ['Armature|Hips']);
    const { clips, report } = bindClipsToModel(mesh, [clip]);
    expect(report.renamedTracks).toBe(0);
    expect(clips[0]!.tracks[0]!.name).toBe('Armature|Hips.quaternion');
  });

  it('部分骨骼动画（如 5 根脊柱的受击附加动画）：命中一根也算成功，其余骨骼保持 rest', () => {
    const mesh = rigWithBones(['Hips', 'Spine', 'Head', 'LeftArm', 'RightArm']);
    const clip = quaternionClip('Hit', ['Hips']);
    const { report } = bindClipsToModel(mesh, [clip]);
    expect(report.ok).toBe(true);
    expect(report.matchedBones).toBe(1);
    expect(report.meshBones).toBe(5);
    expect(report.unmatchedNodeCount).toBe(0);
    expect(report.warnings).toEqual([]);
  });

  it('动画里的道具/相机节点没有对应骨骼：丢弃 + 警告列名', () => {
    const mesh = rigWithBones(['Hips']);
    const clip = quaternionClip('Walk', ['Hips', 'IKHand.R', 'Camera']);
    const { clips, report } = bindClipsToModel(mesh, [clip]);
    expect(report.ok).toBe(true);
    expect(report.matchedTracks).toBe(1);
    expect(report.unmatchedNodeCount).toBe(2);
    expect(report.unmatchedNodes).toEqual(['IKHand.R', 'Camera']);
    expect(report.warnings.join('\n')).toContain('IKHand.R');
    expect(clips[0]!.tracks).toHaveLength(1);
  });

  it('完全不匹配：ok=false + 明确警告（调用方据此报错）', () => {
    const mesh = rigWithBones(['Hips']);
    const clip = quaternionClip('Walk', ['Foo', 'Bar']);
    const { clips, report } = bindClipsToModel(mesh, [clip]);
    expect(report.ok).toBe(false);
    expect(report.matchedTracks).toBe(0);
    expect(report.warnings.join('\n')).toContain('完全不匹配');
    expect(clips[0]!.tracks).toHaveLength(0);
  });

  // ———————— 0.10.1：根骨骼静止姿态差校正（真实资产 Haylee：mesh 导 Z-up、动作导 Y-up） ————————

  /** 造一对根骨骼 rest 朝向不同的场景：mesh 根 = Rx(-90°)，动作根 = identity；子骨骼同名 */
  function rotatedRig(meshRootQuaternion: THREE.Quaternion, rootPosition: [number, number, number], childPosition: [number, number, number]) {
    const root = new THREE.Group();
    const top = new THREE.Bone();
    top.name = 'Bip001';
    top.quaternion.copy(meshRootQuaternion);
    top.position.set(...rootPosition);
    const child = new THREE.Bone();
    child.name = 'Bip001_Spine';
    child.position.set(...childPosition);
    top.add(child);
    root.add(top);
    return { root, top, child };
  }

  it('根骨骼 rest 朝向不同：按静止姿态差校正根轨道，子骨骼轨道保持原样', () => {
    const mesh = rotatedRig(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
      [0, 0, 0],
      [0, 0, 1],
    );
    const anim = rotatedRig(new THREE.Quaternion(), [0, 0, 0], [0, 1, 0]);
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5);
    const clip = new THREE.AnimationClip('Attack', 1, [
      new THREE.QuaternionKeyframeTrack('Bip001.quaternion', [0, 1], [0, 0, 0, 1, turn.x, turn.y, turn.z, turn.w]),
      new THREE.VectorKeyframeTrack('Bip001.position', [0, 1], [0, 0, 0, 0, 0.2, 0]),
      new THREE.QuaternionKeyframeTrack('Bip001_Spine.quaternion', [0, 1], [0, 0, 0, 1, 0, 0.1, 0, 0.995]),
    ]);

    const { clips, report } = bindClipsToModel(mesh.root, [clip], anim.root);
    expect(report.correctedRoots).toEqual(['Bip001']);
    expect(report.warnings.join('\n')).toContain('根骨骼静止朝向');
    const rootTrack = clips[0]!.tracks.find((track) => track.name === 'Bip001.quaternion') as THREE.QuaternionKeyframeTrack;
    // 校正后：q_t = q_meshRest · q_animRest⁻¹ · q_anim(t) = Rx(-90°) · turn
    const expected = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
      .multiply(turn);
    const actual = new THREE.Quaternion(
      rootTrack.values[4]!,
      rootTrack.values[5]!,
      rootTrack.values[6]!,
      rootTrack.values[7]!,
    );
    expect(actual.angleTo(expected)).toBeLessThan(5e-3);
    // 子骨骼不是映射链根：局部轨道原样保留
    const childTrack = clips[0]!.tracks.find((track) => track.name === 'Bip001_Spine.quaternion') as THREE.QuaternionKeyframeTrack;
    const childValues = Array.from(childTrack.values.slice(4));
    expect(childValues[1]).toBeCloseTo(0.1, 5);
    expect(childValues[3]).toBeCloseTo(0.995, 5);
  });

  it('根骨骼静止姿态一致（跨导出但同 up-axis）：不做校正', () => {
    const mesh = rotatedRig(new THREE.Quaternion(), [0, 0, 0], [0, 0, 1]);
    const anim = rotatedRig(new THREE.Quaternion(), [0, 0, 0], [0, 0, 1]);
    const clip = quaternionClip('Attack', ['Bip001']);
    const { report } = bindClipsToModel(mesh.root, [clip], anim.root);
    expect(report.correctedRoots).toEqual([]);
    expect(report.warnings.join('\n')).not.toContain('根骨骼静止朝向');
  });
});

// ———————— 角色自动识别（core/bind/roles） ————————

const ANIM_ONLY: SceneFacts = { hasMesh: false, meshCount: 0, clipCount: 1, boneCount: 5 };
const MESH_ONLY: SceneFacts = { hasMesh: true, meshCount: 2, clipCount: 0, boneCount: 88 };
const MESH_AND_ANIM: SceneFacts = { hasMesh: true, meshCount: 2, clipCount: 1, boneCount: 88 };

describe('planCompanion：谁提供网格 / 谁提供动画（自动识别）', () => {
  it('标准用法：path = 动画-only，mesh 参数 = 网格文件', () => {
    const plan = planCompanion(ANIM_ONLY, MESH_ONLY, { primary: 'hit.fbx', companion: 'skin.fbx' });
    expect(plan).toMatchObject({ mesh: 'companion', animation: 'primary' });
    expect(plan.warnings).toEqual([]);
  });

  it('两个参数传反（path = 网格，mesh = 动画）：自动纠正', () => {
    const plan = planCompanion(MESH_ONLY, ANIM_ONLY, { primary: 'skin.fbx', companion: 'hit.fbx' });
    expect(plan).toMatchObject({ mesh: 'primary', animation: 'companion' });
    expect(plan.warnings.join('\n')).toContain('动画改用');
  });

  it('path 自带网格+动画、mesh 参数也有网格：网格按 mesh 参数，并警告 path 网格被忽略', () => {
    const plan = planCompanion(MESH_AND_ANIM, MESH_AND_ANIM, { primary: 'idle.fbx', companion: 'skin.fbx' });
    expect(plan).toMatchObject({ mesh: 'companion', animation: 'primary' });
    expect(plan.warnings.join('\n')).toContain('自带网格');
  });

  it('两侧都没有网格：三段式拒绝（guidance 指向角色网格文件）', () => {
    expect(() => planCompanion(ANIM_ONLY, ANIM_ONLY)).toThrow(KinemeshError);
    try {
      planCompanion(ANIM_ONLY, ANIM_ONLY);
    } catch (error) {
      const typed = error as KinemeshError;
      expect(typed.message).toContain('都没有网格');
      expect(typed.guidance).toContain('mesh 参数');
    }
  });

  it('两侧都没有动画：三段式拒绝', () => {
    expect(() => planCompanion(MESH_ONLY, MESH_ONLY)).toThrow(/都没有动画片段/);
  });

  it('网格与动画都来自 mesh 参数文件：警告另一侧没被用上', () => {
    const plan = planCompanion({ hasMesh: false, meshCount: 0, clipCount: 0, boneCount: 0 }, MESH_AND_ANIM, {
      primary: 'empty.fbx',
      companion: 'full.fbx',
    });
    expect(plan).toMatchObject({ mesh: 'companion', animation: 'companion' });
    expect(plan.warnings.join('\n')).toContain('另一侧文件没有用上');
  });
});

// ———————— 同资产候选网格文件发现（core/bind/scan：内容扫描，不依赖文件名） ————————

/** 造一个「便宜探测」能识别的 ASCII FBX 文本桩：Geometry 段落 = 有网格，Model 行 = 骨骼名 */
function asciiFbxStub(bones: string[], withMesh: boolean): string {
  const geometry = withMesh ? ['\tGeometry: 100, "Geometry::", "Mesh" {', '\t}'] : [];
  const models = bones.map((name, index) => `\tModel: ${1000 + index}, "Model::${name}", "LimbNode" {`);
  return [
    '; FBX 7.4.0 project file ---- (probe stub)',
    'FBXHeaderExtension: 1003 {',
    '\tFBXVersion: 7400',
    '}',
    'Objects:  {',
    ...geometry,
    ...models,
    '}',
    'Connections:  {',
    '}',
  ].join('\n');
}

describe('findCompanionMeshes：内容扫描（不依赖文件名/目录名）', () => {
  const assetRoot = path.join(workDir, 'asset400');
  const characterDir = path.join(assetRoot, '4001_bigclaw');

  it('按骨骼覆盖率选网格：名字随便起，覆盖率高的胜出；动作文件/无网格文件被排除', async () => {
    await mkdir(path.join(characterDir, 'hit'), { recursive: true });
    await mkdir(path.join(characterDir, 'weird-dir'), { recursive: true });
    const anim = path.join(characterDir, 'hit', 'decide_spine_shake.fbx');
    await writeFile(anim, asciiFbxStub(['Hips', 'Spine'], false), 'utf8');
    // 覆盖率 100%：骨骼名完全对上（文件名与目录名都故意没有 skin/mesh 之类关键词）
    await writeFile(path.join(characterDir, 'weird-dir', 'aaaa.fbx'), asciiFbxStub(['Hips', 'Spine'], true), 'utf8');
    // 覆盖率 50%：多出两根不相关骨骼
    await writeFile(path.join(characterDir, 'weird-dir', 'zzzz.fbx'), asciiFbxStub(['Hips', 'Spine', 'Tail', 'Wing'], false), 'utf8');
    await writeFile(path.join(characterDir, 'weird-dir', 'bbbb.fbx'), asciiFbxStub(['Hips', 'Spine', 'Tail', 'Wing'], true), 'utf8');
    // 骨骼完全对不上：排除
    await writeFile(path.join(characterDir, 'weird-dir', 'cccc.fbx'), asciiFbxStub(['Foo', 'Bar'], true), 'utf8');

    const candidates = await findCompanionMeshes(anim, ['Hips', 'Spine']);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.name).toBe('aaaa.fbx');
    expect(candidates[0]!.coverage).toBe(1);
    const names = candidates.map((candidate) => candidate.name);
    expect(names).not.toContain('decide_spine_shake.fbx'); // 动作文件自身
    expect(names).not.toContain('zzzz.fbx'); // 没有网格
    expect(names).not.toContain('cccc.fbx'); // 骨骼对不上
    expect(candidates.map((candidate) => candidate.coverage)).toEqual(
      [...candidates.map((candidate) => candidate.coverage)].sort((left, right) => right - left),
    );
  });

  it('附近没有可用网格时返回空数组（不抛错）', async () => {
    const emptyDir = path.join(workDir, 'empty-asset', 'anim');
    await mkdir(emptyDir, { recursive: true });
    const file = path.join(emptyDir, 'only.fbx');
    await writeFile(file, asciiFbxStub(['Hips'], false), 'utf8');
    // 附近的其它夹具里有网格，但没有一个骨骼叫 NoSuchBone_XYZ → 全部被覆盖率过滤
    expect(await findCompanionMeshes(file, ['NoSuchBone_XYZ'])).toEqual([]);
  });
});

// ———————— 加载 + 绑定合成场景（core/bind/bundle） ————————

describe('bindScenes：两个文件的角色识别与合成', () => {
  const meshGlb = new Uint8Array(encodeGlb(buildSkinnedMeshOnlyGltf()));
  const animGlb = new Uint8Array(encodeGlb(buildCubeAnimationOnlyGltf()));

  it('标准顺序：mesh 文件做网格、动画-only 文件的片段绑定过去', async () => {
    const meshScene = await loadSceneFromData(meshGlb.buffer as ArrayBuffer, 'mesh.glb');
    const animScene = await loadSceneFromData(animGlb.buffer as ArrayBuffer, 'anim.glb');
    expect(sceneFacts(meshScene)).toMatchObject({ hasMesh: true, clipCount: 0 });
    expect(sceneFacts(animScene)).toMatchObject({ hasMesh: false, clipCount: 1 });

    const bound = bindScenes(animScene, meshScene, 'mesh.glb', 'anim.glb');
    expect(bound.plan).toMatchObject({ mesh: 'companion', animation: 'primary' });
    expect(bound.report?.ok).toBe(true);
    expect(bound.scene.animations).toHaveLength(1);
    expect(bound.scene.object).toBe(meshScene.object);
    expect(bound.facts.length).toBeGreaterThanOrEqual(2);
  });

  it('参数传反（path = 网格文件、mesh = 动画文件）也能自动纠正并绑定', async () => {
    const meshScene = await loadSceneFromData(meshGlb.buffer as ArrayBuffer, 'mesh.glb');
    const animScene = await loadSceneFromData(animGlb.buffer as ArrayBuffer, 'anim.glb');
    const bound = bindScenes(meshScene, animScene, 'anim.glb', 'mesh.glb');
    expect(bound.plan).toMatchObject({ mesh: 'primary', animation: 'companion' });
    expect(bound.report?.ok).toBe(true);
    expect(bound.warnings.join('\n')).toContain('动画改用');
  });

  it('骨骼完全不匹配：抛三段式 KinemeshError', async () => {
    const animScene = await loadSceneFromData(animGlb.buffer as ArrayBuffer, 'anim.glb');
    // 另一套命名（Hips 系）的网格场景：动画节点 rig/bone_a 一个都命中不了
    const foreignMesh = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'Hips';
    foreignMesh.add(hips);
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    body.name = 'body';
    foreignMesh.add(body);
    const foreignScene: CanonicalScene = {
      object: foreignMesh,
      animations: [],
      meta: { format: 'obj', unitScaleFactor: null, upAxis: null, fps: null },
    };
    expect(() => bindScenes(animScene, foreignScene, 'foreign.fbx', 'anim.glb')).toThrow(/完全不匹配/);
  });
});

// ———————— info 工具的 mesh 参数（体检 + 绑定报告） ————————

interface RegisteredTool {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function infoTool(): RegisteredTool['execute'] {
  const registered = new Map<string, RegisteredTool>();
  registerTools({
    tools: {
      register(definition: RegisteredTool): () => void {
        registered.set(definition.name, definition);
        return () => undefined;
      },
    },
  });
  const tool = registered.get('kinemesh_info');
  if (tool === undefined) throw new Error('kinemesh_info 没有注册');
  return tool.execute;
}

describe('kinemesh_info 的 mesh 参数', () => {
  it('返回 mesh 文件结构信息 + 绑定体检（plan/report/facts）', async () => {
    const dir = path.join(workDir, 'paired');
    await mkdir(dir, { recursive: true });
    const animFile = path.join(dir, 'anim.glb');
    const meshFile = path.join(dir, 'mesh.glb');
    await writeFile(animFile, new Uint8Array(encodeGlb(buildCubeAnimationOnlyGltf())));
    await writeFile(meshFile, new Uint8Array(encodeGlb(buildSkinnedMeshOnlyGltf())));

    const result = await infoTool()({ path: animFile, mesh: meshFile });
    expect(result.ok).toBe(true);
    expect((result.companion as { fileName: string }).fileName).toBe('mesh.glb');
    const binding = result.binding as {
      plan: { mesh: string; animation: string };
      report: { ok: boolean; matchedTracks: number; totalTracks: number };
      facts: string[];
    };
    expect(binding.plan).toMatchObject({ mesh: 'companion', animation: 'primary' });
    expect(binding.report.ok).toBe(true);
    expect(binding.report.matchedTracks).toBeGreaterThan(0);
    expect(binding.facts.join('\n')).toContain('网格来自');
  });

  it('动画-only 文件不带 mesh：警告提示 mesh 参数 + 同资产候选网格文件', async () => {
    const root = path.join(workDir, 'asset500');
    const animDir = path.join(root, 'animation');
    const basicDir = path.join(root, 'basic');
    await mkdir(animDir, { recursive: true });
    await mkdir(basicDir, { recursive: true });
    const animFile = path.join(animDir, 'attack.glb');
    await writeFile(animFile, new Uint8Array(encodeGlb(buildCubeAnimationOnlyGltf())));
    await writeFile(path.join(basicDir, 'asset500_skin.glb'), new Uint8Array(encodeGlb(buildSkinnedMeshOnlyGltf())));

    const result = await infoTool()({ path: animFile });
    expect(result.ok).toBe(true);
    const warnings = result.warnings as string[];
    expect(warnings.join('\n')).toContain('动画-only');
    expect(warnings.join('\n')).toContain('asset500_skin.glb');
  });
});

// ———————— 预览面板 chip 文案（纯函数） ————————

describe('预览面板 mesh 绑定 chip', () => {
  it('basenameOf 处理 Windows / POSIX 路径', () => {
    expect(basenameOf('D:/assets/basic/hero_skin.fbx')).toBe('hero_skin.fbx');
    expect(basenameOf('D:\\assets\\basic\\hero_skin.fbx')).toBe('hero_skin.fbx');
  });

  it('无绑定返回空串；有报告时带命中骨骼数', () => {
    expect(meshBindingChip(null, '')).toBe('');
    expect(meshBindingChip(null, 'D:/a/hero_skin.fbx')).toBe('hero_skin.fbx');
    const binding = {
      report: {
        meshNodes: 96,
        meshBones: 88,
        animNodes: 6,
        matchedNodes: 6,
        matchedBones: 5,
        totalTracks: 18,
        matchedTracks: 18,
        unmatchedNodes: [],
        unmatchedNodeCount: 0,
        renamedTracks: 0,
        ok: true,
        warnings: [],
      },
      facts: [],
      warnings: [],
      plan: { mesh: 'companion' as const, animation: 'primary' as const, warnings: [] },
      scene: {} as never,
    };
    expect(meshBindingChip(binding, 'D:/a/hero_skin.fbx')).toBe('hero_skin.fbx · 5/88 骨');
  });
});
