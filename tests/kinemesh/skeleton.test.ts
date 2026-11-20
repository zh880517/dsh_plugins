// M7 骨架识别与映射：字典查表（B.1–B.2）/ 约定识别（B.3）/ 标注截图批次（B.4）/
// kinemesh-bones.json（B.5）校验与确定性消费 / J15 解析链升级（映射文件 > 字典 > AI 兜底指引 >
// Top-15 回退）/ kinemesh_skeleton 三出口（DSH 工具 + CLI 投影）。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  buildChainRig,
  buildChainSwingClip,
  buildHumanoidRig,
  buildRigScene,
} from '../support/kinemesh-rig-fixtures.js';
import { encodeGlb } from '../support/kinemesh-fixtures.js';
import { KinemeshError } from '../../plugins/kinemesh/src/core/errors.js';
import {
  detectConvention,
  matchCanonical,
  parseBonesFile,
  checkBonesAgainstSkeleton,
  serializeBonesFile,
  type BonesFileData,
} from '../../plugins/kinemesh/src/core/analyze/bone-map.js';
import {
  buildSkeletonDigest,
  buildSkeletonReport,
  collectSkeletonSet,
} from '../../plugins/kinemesh/src/core/analyze/skeleton-report.js';
import { strideLabelBatches } from '../../plugins/kinemesh/src/core/analyze/label-batches.js';
import { sampleClip } from '../../plugins/kinemesh/src/core/motion/sample.js';
import type { CanonicalScene } from '../../plugins/kinemesh/src/core/types.js';
import { registerTools } from '../../plugins/kinemesh/src/tools.js';

// ———————— 字典查表（B.1–B.2）：四套标准约定 + 拼音兜底 ————————

describe('matchCanonical · 同义词表（B.1–B.2）', () => {
  it('Mixamo 命名：表序保证 ForeArm→lowerarm、UpLeg→upperleg、Leg→lowerleg、ToeBase→toe', () => {
    expect(matchCanonical('mixamorig:Hips')).toMatchObject({ canonical: 'hips', side: null, how: 'exact' });
    expect(matchCanonical('mixamorig:Spine2')).toMatchObject({ canonical: 'spine', how: 'exact' });
    expect(matchCanonical('mixamorig:LeftArm')).toMatchObject({ canonical: 'upperarm', side: 'L', how: 'exact' });
    expect(matchCanonical('mixamorig:LeftForeArm')).toMatchObject({ canonical: 'lowerarm', side: 'L', how: 'exact' });
    expect(matchCanonical('mixamorig:LeftUpLeg')).toMatchObject({ canonical: 'upperleg', side: 'L', how: 'exact' });
    expect(matchCanonical('mixamorig:LeftLeg')).toMatchObject({ canonical: 'lowerleg', side: 'L', how: 'exact' });
    expect(matchCanonical('mixamorig:LeftToeBase')).toMatchObject({ canonical: 'toe', side: 'L', how: 'exact' });
    expect(matchCanonical('mixamorig:RightHand')).toMatchObject({ canonical: 'hand', side: 'R', how: 'exact' });
  });

  it('Biped / UE / VRM / Rigify 命名：前缀剥离、side token、点分后缀都落到同一张表', () => {
    expect(matchCanonical('Bip01_L_Hand')).toMatchObject({ canonical: 'hand', side: 'L', how: 'exact' });
    expect(matchCanonical('Bip01 R Calf')).toMatchObject({ canonical: 'lowerleg', side: 'R', how: 'exact' });
    expect(matchCanonical('thigh_l')).toMatchObject({ canonical: 'upperleg', side: 'L', how: 'exact' });
    expect(matchCanonical('calf_r')).toMatchObject({ canonical: 'lowerleg', side: 'R', how: 'exact' });
    expect(matchCanonical('ball_l')).toMatchObject({ canonical: 'toe', side: 'L', how: 'exact' });
    expect(matchCanonical('J_Bip_C_Spine')).toMatchObject({ canonical: 'spine', side: null, how: 'exact' });
    expect(matchCanonical('J_Sec_L_UpperArm')).toMatchObject({ canonical: 'upperarm', side: 'L', how: 'exact' });
    expect(matchCanonical('upper_arm.L')).toMatchObject({ canonical: 'upperarm', side: 'L', how: 'exact' });
    expect(matchCanonical('forearm.R')).toMatchObject({ canonical: 'lowerarm', side: 'R', how: 'exact' });
  });

  it('中文工程命名与子串兜底：datui/shou 按表序兜底；缺 side 保留 side=null（缺口交 AI）', () => {
    expect(matchCanonical('datui_l')).toMatchObject({ canonical: 'upperleg', side: 'L', how: 'substring' });
    expect(matchCanonical('LeftShou')).toMatchObject({ canonical: 'hand', side: 'L', how: 'substring' });
    const armless = matchCanonical('Arm');
    expect(armless).toMatchObject({ canonical: 'upperarm', side: null, how: 'exact' });
    // 模糊匹配不做：无表命中 → null
    expect(matchCanonical('Bone01')).toBeNull();
    expect(matchCanonical('seg_a')).toBeNull();
  });

  it('左右同现 → side=null；数字 token 剥离（spine.001）；chest/torso 归 spine', () => {
    expect(matchCanonical('L_R_Arm')?.side).toBeNull();
    expect(matchCanonical('spine.001')).toMatchObject({ canonical: 'spine', how: 'exact' });
    expect(matchCanonical('Chest')).toMatchObject({ canonical: 'spine', how: 'exact' });
    expect(matchCanonical('Torso')).toMatchObject({ canonical: 'spine', how: 'exact' });
    expect(matchCanonical('LeftShoulder')).toMatchObject({ canonical: 'upperarm', side: 'L', how: 'exact' });
  });
});

describe('detectConvention · 约定识别（B.3）', () => {
  const mixamo = ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:LeftArm', 'mixamorig:LeftUpLeg', 'mixamorig:LeftFoot'];
  const biped = ['Bip01_L_Hand', 'Bip01_R_Hand', 'Bip01_L_Foot', 'Bip01_Spine', 'Bip01_Head'];
  const ue = ['thigh_l', 'thigh_r', 'calf_l', 'calf_r', 'upperarm_l', 'upperarm_r'];
  const rigify = ['upper_arm.L', 'forearm.R', 'hand.L', 'spine', 'spine.001'];

  it('四套标准约定：指纹过半判约定，不足 CONVENTION_MIN 判 custom', () => {
    expect(detectConvention(mixamo)).toMatchObject({ convention: 'mixamo', matched: 5, total: 5 });
    expect(detectConvention(biped)).toMatchObject({ convention: 'biped', matched: 5, total: 5 });
    expect(detectConvention(ue)).toMatchObject({ convention: 'ue', matched: 6, total: 6 });
    expect(detectConvention(rigify)).toMatchObject({ convention: 'rigify', matched: 3, total: 5 });
    // 混合命名无一过半 → custom
    expect(detectConvention(['Bone01', 'Bone02', 'Hips']).convention).toBe('custom');
    expect(detectConvention([]).convention).toBe('custom');
  });
});

// ———————— skeleton-report（§7.3 字段 + B.4 批次） ————————

describe('buildSkeletonReport · 字典全命中与 B.4 批次', () => {
  it('标准命名 rig 全自动映射全命中：CORE15 15/15、unmapped 空、auto 不出批次、结构统计对答案', () => {
    const rig = buildHumanoidRig();
    // 挂一块未命名网格：rig 纯骨骼无几何，Box3 为空拿不到 H；groundTips/对称容差都要用 H
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.0, 0.6));
    proxy.position.set(0, 0.45, 0);
    rig.root.add(proxy);
    rig.root.updateMatrixWorld(true);
    const report = buildSkeletonReport(buildRigScene(rig.root, []), { fileName: 'humanoid.glb' });
    expect(report.convention.convention).toBe('custom'); // 纯 Mixamo 风格名无 mixamorig: 前缀
    expect(report.coverage.core).toEqual({ hit: 15, total: 15 });
    expect(report.coverage.mapped).toBe(report.boneCount);
    expect(report.unmapped).toEqual([]);
    expect(report.bones.find((bone) => bone.name === 'LeftUpLeg')).toMatchObject({
      partGuess: 'upperleg-l',
      confidence: 'high',
      source: 'dict',
      parent: 'Hips',
      depth: 1,
    });
    expect(report.bones.find((bone) => bone.name === 'LeftToeBase')).toMatchObject({ partGuess: 'toe-l', source: 'dict' });
    // 结构统计（工具只数数）：叶 = Head/双手/双 Toe；贴地 = 双 Toe；对称对 = 双手 + 双 Toe
    expect(report.stats).toEqual({ limbChains: 5, groundTips: 2, symmetryPairs: 2, maxChainDepth: 4 });
    // shots=auto 且 CORE15 无缺口 → 不出批次
    expect(report.batches).toEqual([]);
    expect(report.schemaNote).toContain('kinemesh-bones.json');
    const digest = buildSkeletonDigest(report);
    expect(digest.facts.some((fact) => fact.includes('CORE15 缺口 0 个'))).toBe(true);
    expect(digest.facts.some((fact) => fact.includes('kinemesh-bones.json'))).toBe(true);
    // B.4 标注已实装：renderRecipe.boneLabels 指向 kinemesh_render 的 boneLabels 参数
    // （纯 report 构造不经渲染，digest.shots 恒为空数组）
    expect(digest.renderRecipe.boneLabels.renderParam).toBe(true);
    expect(digest.renderRecipe.boneLabels.guidance).toContain('boneLabels');
    expect(digest.shots).toEqual([]);
  });

  it('非标命名 rig：字典缺口 → AI 兜底指引 + 批次清单（≤12 单批全量）', () => {
    const chain = buildChainRig();
    const report = buildSkeletonReport(buildRigScene(chain.root, []), { fileName: 'chain.glb' });
    expect(report.coverage.core).toEqual({ hit: 0, total: 15 });
    expect(report.unmapped).toEqual(['seg_a', 'seg_b', 'seg_c']);
    expect(report.batches).toHaveLength(1);
    expect(report.batches[0]?.bones).toEqual(['seg_a', 'seg_b', 'seg_c']);
    expect(report.batches[0]?.files).toEqual(['labels-front-01.png', 'labels-side-01.png']);
    const digest = buildSkeletonDigest(report);
    expect(digest.facts.some((fact) => fact.includes('CORE15 缺口 15 个'))).toBe(true);
    expect(digest.facts.some((fact) => fact.includes('shots:"all"'))).toBe(true);
  });

  it('B.4 stride 分批：30 骨 → 3 批各 10，父子骨（相邻 DFS 序号）分属不同批', () => {
    const scene = buildLongChainScene(30);
    const report = buildSkeletonReport(scene, { fileName: 'long.glb' });
    expect(report.unmapped).toHaveLength(30);
    expect(report.batches).toHaveLength(3);
    expect(report.batches.map((batch) => batch.bones.length)).toEqual([10, 10, 10]);
    const batchOf = new Map<string, number>();
    for (const batch of report.batches) for (const name of batch.bones) batchOf.set(name, batch.batch);
    for (const bone of report.bones) {
      if (bone.parent === null) continue;
      expect(batchOf.get(bone.name)).not.toBe(batchOf.get(bone.parent));
    }
    // shots=all：全量 30 骨仍 3 批；shots=none：不出批次
    expect(buildSkeletonReport(scene, { fileName: 'long.glb', shots: 'all' }).batches).toHaveLength(3);
    expect(buildSkeletonReport(scene, { fileName: 'long.glb', shots: 'none' }).batches).toEqual([]);
  });

  it('B.4 纯函数 strideLabelBatches：60 目标 → B=5 每批 12、批内保 DFS 序、≤12 单批全量', () => {
    const targets = Array.from({ length: 60 }, (_, i) => ({ name: `b${String(i + 1).padStart(2, '0')}`, dfsIndex: i }));
    const batches = strideLabelBatches(targets);
    expect(batches).toHaveLength(5);
    for (const batch of batches) expect(batch).toHaveLength(12);
    // 第 i 批 = DFS 序号 ≡ i (mod 5)，批内保持 DFS 升序
    expect(batches[0]).toEqual(targets.filter((_, i) => i % 5 === 0).map((target) => target.name));
    expect(batches[4]).toEqual(targets.filter((_, i) => i % 5 === 4).map((target) => target.name));
    // 父子骨（链式：相邻 DFS 序号互为父子）必然分属不同批
    const batchOf = new Map(targets.map((target, i) => [target.name, i % 5]));
    for (let i = 1; i < targets.length; i += 1) {
      expect(batchOf.get(targets[i]!.name)).not.toBe(batchOf.get(targets[i - 1]!.name));
    }
    // 总数 ≤ 12：单批全量；空目标：无批次
    expect(strideLabelBatches(targets.slice(0, 12))).toEqual([targets.slice(0, 12).map((target) => target.name)]);
    expect(strideLabelBatches([])).toEqual([]);
  });

  it('B.4 report 级 60 骨链：5 批各 12，父子骨不同批（批号 1 起与 PNG 两位序号一致）', () => {
    const report = buildSkeletonReport(buildLongChainScene(60), { fileName: 'long60.glb' });
    expect(report.boneCount).toBe(60);
    expect(report.batches).toHaveLength(5);
    expect(report.batches.map((batch) => batch.bones.length)).toEqual([12, 12, 12, 12, 12]);
    expect(report.batches.map((batch) => batch.batch)).toEqual([1, 2, 3, 4, 5]);
    expect(report.batches[0]?.files).toEqual(['labels-front-01.png', 'labels-side-01.png']);
    const batchOf = new Map<string, number>();
    for (const batch of report.batches) for (const name of batch.bones) batchOf.set(name, batch.batch);
    for (const bone of report.bones) {
      if (bone.parent === null) continue;
      expect(batchOf.get(bone.name)).not.toBe(batchOf.get(bone.parent));
    }
  });

  it('shots=all 对全命中 rig 也出批次（17 骨 → 2 批 9/8）；多骨同槽按 rest 高度中位保留并注明', () => {
    const rig = buildHumanoidRig();
    const report = buildSkeletonReport(buildRigScene(rig.root, []), { fileName: 'humanoid.glb', shots: 'all' });
    expect(report.batches.map((batch) => batch.bones.length)).toEqual([9, 8]);

    const double = new THREE.Bone();
    double.name = 'Chest';
    double.position.set(0, 0.1, 0);
    rig.bones.Spine!.add(double);
    rig.root.updateMatrixWorld(true);
    const withChest = buildSkeletonReport(buildRigScene(rig.root, []), { fileName: 'humanoid.glb' });
    const spine = withChest.bones.filter((bone) => bone.partGuess === 'spine');
    expect(spine).toHaveLength(1);
    // Spine rest y=0.70、Chest rest y=0.80（挂 Spine 下 +0.1）→ 同命中 spine 取 rest 高度中位保留 Spine
    expect(spine[0]?.name).toBe('Spine');
    expect(withChest.notes.some((note) => note.includes('同命中 spine'))).toBe(true);
    expect(withChest.unmapped).toContain('Chest');
  });
});

// ———————— kinemesh-bones.json（B.5）：parse / check / serialize ————————

describe('parseBonesFile · schema v2 校验（三段式并列合法值清单）', () => {
  const quadrupedText = JSON.stringify({
    _meta: { archetype: 'quadruped', by: 'ai', notes: '狼' },
    root: 'Body_Root',
    head: 'Head_01',
    spine: ['Spine_01', 'Spine_02'],
    limbs: [
      { role: 'leg', tag: 'fl', bones: ['Leg_FL_1', 'Leg_FL_2'], tip: 'Foot_FL' },
      { role: 'tail', bones: ['Tail_1', 'Tail_2'], tip: 'Tail_2' },
    ],
  });

  it('合法 quadruped 文件：meta/limbs 保序解析；humanoid 简写走 bones', () => {
    const data = parseBonesFile(quadrupedText, 'bones.json');
    expect(data.meta).toMatchObject({ archetype: 'quadruped', by: 'ai' });
    expect(data.root).toBe('Body_Root');
    expect(data.limbs[0]).toMatchObject({ role: 'leg', tag: 'fl', tip: 'Foot_FL' });
    expect(data.bones.size).toBe(0);
    const humanoid = parseBonesFile(JSON.stringify({ _meta: { archetype: 'humanoid' }, bones: { Head_01: 'head', Hand_L: 'hand-l' } }), 'b.json');
    expect([...humanoid.bones.entries()]).toEqual([
      ['Head_01', 'head'],
      ['Hand_L', 'hand-l'],
    ]);
    // archetype 缺省 humanoid（容错口径）
    expect(parseBonesFile('{"bones": {"H": "hips"}}', 'b.json').meta.archetype).toBe('humanoid');
    // serialize 往返：写出即合法 schema
    const round = parseBonesFile(serializeBonesFile(data), 'round.json');
    expect(round.limbs).toHaveLength(2);
    expect(round.meta.archetype).toBe('quadruped');
  });

  it('非法输入逐类三段式：JSON / archetype / 缺 bones / 缺 root / 白名单外 / 缺 side / 双骨同槽 / leg>8', () => {
    expect(() => parseBonesFile('{ nope', 'b.json')).toThrow(/JSON 解析失败/);
    const expectBonesError = (text: string, messagePart: RegExp | string, guidancePart?: RegExp | string): void => {
      let thrown: unknown;
      try {
        parseBonesFile(text, 'b.json');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(KinemeshError);
      const bonesError = thrown as KinemeshError;
      expect(bonesError.message).toContain(messagePart);
      if (guidancePart !== undefined) expect(bonesError.guidance).toContain(guidancePart);
    };
    expectBonesError(JSON.stringify({ _meta: { archetype: 'centaur' }, bones: { H: 'hips' } }), 'centaur', 'humanoid');
    expectBonesError('{"_meta":{"archetype":"humanoid"}}', 'bones');
    expectBonesError(JSON.stringify({ _meta: { archetype: 'quadruped' }, head: 'H' }), 'root');
    expectBonesError('{"bones": {"H": "wing"}}', '白名单', 'hips / spine / head');
    expectBonesError('{"bones": {"H": "upperarm"}}', '缺 side', 'upperarm-l');
    expectBonesError('{"bones": {"A": "hips", "B": "hips"}}', 'hips');
    const nineLegs = Array.from({ length: 9 }, (_, i) => ({ role: 'leg', bones: [`L${i}`], tip: `L${i}` }));
    expectBonesError(JSON.stringify({ _meta: { archetype: 'multiped' }, root: 'R', limbs: nineLegs }), '超过 8', 'archetype');
  });

  it('checkBonesAgainstSkeleton：骨骼名必须存在；limb 链必须逐级相连；tip 必须是末节', () => {
    const rig = buildHumanoidRig();
    const humanoidParentOf = collectSkeletonSet(buildRigScene(rig.root, [])).parentOf;
    const chain = buildChainRig();
    const chainParentOf = collectSkeletonSet(buildRigScene(chain.root, [])).parentOf;
    const ghostData: BonesFileData = parseBonesFile(
      JSON.stringify({ bones: { Hips: 'hips', Ghost: 'head' } }),
      'b.json',
    );
    expect(() => checkBonesAgainstSkeleton(ghostData, 'b.json', humanoidParentOf)).toThrow(/Ghost/);
    const chainData = parseBonesFile(
      JSON.stringify({ _meta: { archetype: 'chain' }, root: 'seg_a', spine: ['seg_b'], limbs: [{ role: 'tail', bones: ['seg_a', 'seg_c'], tip: 'seg_c' }] }),
      'b.json',
    );
    // seg_c 的父是 seg_b，不是 seg_a → 非连续链
    expect(() => checkBonesAgainstSkeleton(chainData, 'b.json', chainParentOf)).toThrow(/连续链/);
    const tipData = parseBonesFile(
      JSON.stringify({ _meta: { archetype: 'chain' }, root: 'seg_a', limbs: [{ role: 'tail', bones: ['seg_b'], tip: 'seg_a' }] }),
      'b.json',
    );
    expect(() => checkBonesAgainstSkeleton(tipData, 'b.json', chainParentOf)).toThrow(/tip/);
    // 合法链：seg_a → seg_b → seg_c；root 兼链首不报错（部位标签按 root 优先）
    const okData = parseBonesFile(
      JSON.stringify({ _meta: { archetype: 'chain' }, root: 'seg_a', head: 'seg_c', limbs: [{ role: 'tail', bones: ['seg_a', 'seg_b', 'seg_c'], tip: 'seg_c' }] }),
      'b.json',
    );
    const mapping = checkBonesAgainstSkeleton(okData, 'b.json', chainParentOf);
    // 部位标签按 root > head > spine > limbs 首次引用优先：seg_c 兼 head 与尾链末节 → head
    expect(mapping.parts.get('seg_c')).toBe('head');
    expect(mapping.parts.get('seg_a')).toBe('root');
  });
});

// ———————— J15 解析链升级（A.0 + §7.4）：映射文件 > 字典 > AI 兜底指引 > Top-15 ————————

describe('sampleClip · joints=auto 解析链', () => {
  it('映射文件层：chain rig + humanoid 简写 → basis=bone-map，J15 槽位按映射钉死，不再回退 Top-15', () => {
    const chain = buildChainRig();
    const scene = buildRigScene(chain.root, [buildChainSwingClip(chain)]);
    const { parentOf } = collectSkeletonSet(scene);
    const data = parseBonesFile(
      JSON.stringify({ _meta: { archetype: 'humanoid', by: 'ai' }, bones: { seg_a: 'hips', seg_b: 'spine', seg_c: 'head' } }),
      'bones.json',
    );
    const mapping = checkBonesAgainstSkeleton(data, 'bones.json', parentOf);
    const sample = sampleClip(scene, { boneMap: mapping });
    expect(sample.jointBasis).toBe('bone-map');
    expect(sample.joints.map((joint) => joint.id)).toEqual(['hips', 'spine', 'head']);
    expect(sample.joints.map((joint) => joint.weight)).toEqual([0.2, 0.3, 1.0]);
    expect(sample.rootJoint?.name).toBe('seg_a');
    expect(sample.declaredJoints).toHaveLength(12);
    expect(sample.joints[0]?.objectName).toBe('seg_a');
    expect(sample.warnings.some((warning) => warning.includes('motion-top15'))).toBe(false);
  });

  it('字典层缺口 → 回退 Top-15 并附「AI 补映射」指引（写 kinemesh-bones.json 后确定性消费）', () => {
    const chain = buildChainRig();
    const sample = sampleClip(buildRigScene(chain.root, [buildChainSwingClip(chain)]));
    expect(sample.jointBasis).toBe('motion-top15');
    expect(sample.warnings.some((warning) => warning.includes('kinemesh-bones.json'))).toBe(true);
  });

  it('映射文件缺 hips：rootPos/heading 无参照，warnings 注明', () => {
    const chain = buildChainRig();
    const scene = buildRigScene(chain.root, [buildChainSwingClip(chain)]);
    const { parentOf } = collectSkeletonSet(scene);
    const data = parseBonesFile(JSON.stringify({ bones: { seg_b: 'spine', seg_c: 'head' } }), 'bones.json');
    const mapping = checkBonesAgainstSkeleton(data, 'bones.json', parentOf);
    const sample = sampleClip(scene, { boneMap: mapping });
    expect(sample.jointBasis).toBe('bone-map');
    expect(sample.rootJoint).toBeNull();
    expect(sample.warnings.some((warning) => warning.includes('hips'))).toBe(true);
  });
});

// ———————— 工具层三出口（DSH 出口 + CLI 投影）：fixtures 与执行 ————————

interface RegisteredTool {
  name: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function toolExecute(name: string): RegisteredTool['execute'] {
  const registered = new Map<string, RegisteredTool>();
  const ctx = {
    tools: {
      register(definition: RegisteredTool): () => void {
        registered.set(definition.name, definition);
        return () => undefined;
      },
    },
  };
  registerTools(ctx);
  const tool = registered.get(name);
  if (tool === undefined) throw new Error(`${name} 没有注册`);
  return tool.execute;
}

interface RigNodeSpec {
  name: string;
  parent: string | null;
  local?: [number, number, number];
}

const HUMANOID_NODES: RigNodeSpec[] = [
  { name: 'Hips', parent: null, local: [0, 1.0, 0] },
  { name: 'Spine', parent: 'Hips', local: [0, 0.1, 0] },
  { name: 'Head', parent: 'Spine', local: [0, 0.2, 0] },
  { name: 'LeftArm', parent: 'Spine', local: [-0.15, 0.1, 0] },
  { name: 'RightArm', parent: 'Spine', local: [0.15, 0.1, 0] },
  { name: 'LeftForeArm', parent: 'LeftArm', local: [-0.1, -0.15, 0] },
  { name: 'RightForeArm', parent: 'RightArm', local: [0.1, -0.15, 0] },
  { name: 'LeftHand', parent: 'LeftForeArm', local: [-0.03, -0.12, 0] },
  { name: 'RightHand', parent: 'RightForeArm', local: [0.03, -0.12, 0] },
  { name: 'LeftUpLeg', parent: 'Hips', local: [-0.08, -0.05, 0] },
  { name: 'RightUpLeg', parent: 'Hips', local: [0.08, -0.05, 0] },
  { name: 'LeftLeg', parent: 'LeftUpLeg', local: [0, -0.4, 0] },
  { name: 'RightLeg', parent: 'RightUpLeg', local: [0, -0.4, 0] },
  { name: 'LeftFoot', parent: 'LeftLeg', local: [0, -0.4, 0] },
  { name: 'RightFoot', parent: 'RightLeg', local: [0, -0.4, 0] },
  { name: 'LeftToeBase', parent: 'LeftFoot', local: [0, -0.06, 0.1] },
  { name: 'RightToeBase', parent: 'RightFoot', local: [0, -0.06, 0.1] },
];

function chainNodeSpecs(count: number): RigNodeSpec[] {
  const specs: RigNodeSpec[] = [{ name: 'b01', parent: null, local: [0, 0.2, 0] }];
  for (let i = 2; i <= count; i += 1) {
    specs.push({ name: `b${String(i).padStart(2, '0')}`, parent: `b${String(i - 1).padStart(2, '0')}`, local: [0, 0.3, 0] });
  }
  return specs;
}

/** 命名节点 rig + 未命名 cube 网格 + 单条 translation 动画（照 tests/support 的 glTF 打包风格，本地最小实现） */
function buildRigNodesGltf(specs: RigNodeSpec[], animNode: string): Record<string, unknown> {
  const names = specs.map((spec) => spec.name);
  const nodes = specs.map((spec) => {
    const children = specs.filter((other) => other.parent === spec.name).map((other) => names.indexOf(other.name));
    return {
      ...(spec.name === '' ? {} : { name: spec.name }),
      ...(spec.local === undefined ? {} : { translation: spec.local }),
      ...(children.length === 0 ? {} : { children }),
    };
  });
  const positions = new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
  ]);
  const indices = new Uint16Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3, 2, 6, 3, 6, 7,
  ]);
  const times = new Float32Array([0, 0.5]);
  const rest = specs.find((spec) => spec.name === animNode)?.local ?? ([0, 0, 0] as [number, number, number]);
  const restX = rest[0] ?? 0;
  const restY = rest[1] ?? 0;
  const restZ = rest[2] ?? 0;
  const translation = new Float32Array([restX, restY, restZ, restX + 0.4, restY, restZ]);
  const sections = [positions, indices, times, translation];
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
  const dataUri = `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;
  const animTarget = names.indexOf(animNode);
  // scenes.nodes 只列根节点（parent === null）+ 未命名网格节点：把全部索引都列成根会让
  // GLTFLoader 为每个节点同时创建「场景根」与「子节点」两份实例，骨架清单翻倍
  const rootIndices = specs.map((spec, index) => (spec.parent === null ? index : -1)).filter((index) => index >= 0);
  return {
    asset: { version: '2.0', generator: 'kinemesh-fixtures' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [...rootIndices, nodes.length] }],
    nodes: [
      ...nodes,
      { mesh: 0, translation: [0, 0, 0] }, // 未命名网格节点：进包围盒，不进骨骼清单
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }], // 未命名 mesh：只供包围盒，不进骨骼清单
    materials: [{ name: 'BodyMat', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.4, 1] } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
      { bufferView: 2, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [0.5] },
      { bufferView: 3, componentType: 5126, count: 2, type: 'VEC3', min: [restX, restY, restZ], max: [restX + 0.4, restY, restZ] },
    ],
    bufferViews: views.map((view) => ({ buffer: 0, byteOffset: view.offset, byteLength: view.byteLength })),
    buffers: [{ byteLength: cursor, uri: dataUri }],
    animations: [
      {
        name: 'Idle',
        samplers: [{ input: 2, output: 3 }],
        channels: [{ sampler: 0, target: { node: animTarget, path: 'translation' } }],
      },
    ],
  };
}

function buildLongChainScene(boneCount: number): CanonicalScene {
  const root = new THREE.Group();
  root.name = 'chain-root';
  let parent: THREE.Object3D = root;
  for (let i = 1; i <= boneCount; i += 1) {
    const bone = new THREE.Bone();
    bone.name = `seg_${String(i).padStart(2, '0')}`;
    bone.position.set(0, 0.3, 0);
    parent.add(bone);
    parent = bone;
  }
  root.updateMatrixWorld(true);
  return buildRigScene(root, []);
}

const workDir = await mkdtemp(path.join(tmpdir(), 'kinemesh-skeleton-'));
// chain 资产连同它的 kinemesh-bones.json 放独立子目录：映射文件按「资产同目录」被发现，
// 不污染同层 humanoid 资产的自动发现（发现顺序 B.5 的负向用例隔离）
const chainDir = path.join(workDir, 'chain-asset');

async function writeGlb(name: string, json: Record<string, unknown>, dir = workDir): Promise<string> {
  const file = path.join(dir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(file, Buffer.from(encodeGlb(json)));
  return file;
}

const humanoidGlb = await writeGlb('humanoid-rig.glb', buildRigNodesGltf(HUMANOID_NODES, 'Hips'));
const chainGlb = await writeGlb('chain-rig.glb', buildRigNodesGltf(chainNodeSpecs(14), 'b01'), chainDir);

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('kinemesh_skeleton · DSH 出口', () => {
  it('注册名与 schema：必填只有 path，属性为 path/shots/boneMap/out', () => {
    const registered = new Map<string, RegisteredTool>();
    registerTools({
      tools: {
        register(definition: RegisteredTool): () => void {
          registered.set(definition.name, definition);
          return () => undefined;
        },
      },
    });
    const tool = registered.get('kinemesh_skeleton');
    expect(tool?.name).toBe('kinemesh_skeleton');
    expect(tool?.parameters.required).toEqual(['path']);
    expect(Object.keys(tool?.parameters.properties ?? {})).toEqual(['path', 'shots', 'boneMap', 'out']);
  });

  it('标准命名 rig：字典全自动映射，digest 全命中、无批次、report 落盘', async () => {
    const execute = toolExecute('kinemesh_skeleton');
    const outDir = path.join(workDir, 'skel-humanoid');
    const result = await execute({ path: humanoidGlb, out: outDir });
    expect(result.ok).toBe(true);
    expect(result.hint).toBeUndefined();
    const files = result.files as Array<{ name: string; bytes: number }>;
    expect(files.map((file) => file.name)).toEqual(['skeleton-report.json']);
    expect(existsSync(path.join(outDir, 'skeleton-report.json'))).toBe(true);
    const digest = result.digest as {
      coverage: { mapped: number; total: number; core: { hit: number; total: number } };
      unmapped: string[];
      batches: unknown[];
      facts: string[];
    };
    expect(digest.coverage.core).toEqual({ hit: 15, total: 15 });
    expect(digest.coverage.mapped).toBe(digest.coverage.total);
    expect(digest.unmapped).toEqual([]);
    expect(digest.batches).toEqual([]);
    expect(digest.facts.some((fact) => fact.includes('CORE15 缺口 0 个'))).toBe(true);
  });

  it('非标命名 rig：缺口 → 两级指引 + 批次清单（14 骨 → 2 批 7/7）；shots=none 只出 report', async () => {
    const execute = toolExecute('kinemesh_skeleton');
    const outDir = path.join(workDir, 'skel-chain');
    const result = await execute({ path: chainGlb, out: outDir });
    const digest = result.digest as {
      coverage: { core: { hit: number } };
      unmapped: string[];
      batches: Array<{ batch: number; bones: string[]; files: string[] }>;
      facts: string[];
    };
    expect(digest.coverage.core.hit).toBe(0);
    expect(digest.unmapped).toHaveLength(14);
    expect(digest.batches).toHaveLength(2);
    expect(digest.batches.map((batch) => batch.bones.length)).toEqual([7, 7]);
    expect(digest.facts.some((fact) => fact.includes('CORE15 缺口 15 个'))).toBe(true);
    // B.4 已实装：有 playwright 的环境会真实渲染 2 批 × 2 视角标注截图（无则降级 shotsWarning）
    const shots = (digest as { shots?: string[] }).shots ?? [];
    if (shots.length > 0) {
      expect(shots).toHaveLength(4);
      expect(shots.every((file) => existsSync(file))).toBe(true);
    } else {
      expect((digest as { shotsWarning?: string }).shotsWarning).toContain('playwright');
    }
    const quiet = await execute({ path: chainGlb, out: path.join(workDir, 'skel-chain-none'), shots: 'none' });
    expect((quiet.digest as { batches: unknown[] }).batches).toEqual([]);
  }, 240_000);

  it('手写 kinemesh-bones.json（资产同目录自动发现）：skeleton 覆盖回显，analyze 确定性消费 bone-map', async () => {
    const bonesPath = path.join(chainDir, 'kinemesh-bones.json');
    await writeFile(
      bonesPath,
      JSON.stringify({ _meta: { archetype: 'humanoid', by: 'ai', notes: '测试映射' }, bones: { b01: 'hips', b02: 'spine', b03: 'head' } }),
      'utf8',
    );
    const execute = toolExecute('kinemesh_skeleton');
    const result = await execute({ path: chainGlb, out: path.join(workDir, 'skel-mapped') });
    const digest = result.digest as {
      boneMap: { source: string; archetype: string; mapped: number };
      coverage: { core: { hit: number } };
      unmapped: string[];
      batches: Array<{ bones: string[] }>;
    };
    expect(digest.boneMap?.source).toBe(bonesPath);
    expect(digest.boneMap).toMatchObject({ archetype: 'humanoid', mapped: 3 });
    expect(digest.coverage.core.hit).toBe(3);
    expect(digest.unmapped).toHaveLength(11);
    // auto：有缺口 → 出 1 批（11 ≤ 12 单批全量）
    expect(digest.batches).toHaveLength(1);
    const analyze = toolExecute('kinemesh_analyze');
    const outDir = path.join(workDir, 'analysis-mapped');
    const analysis = await analyze({ path: chainGlb, out: outDir, clip: 'Idle' });
    expect(analysis.ok).toBe(true);
    const summary = JSON.parse(await readFile(path.join(outDir, 'motion-summary.json'), 'utf8')) as {
      jointBasis: { basis: string; joints: Array<{ id: string; objectName: string }>; declaredJoints: string[] };
      boneMap?: { source: string; archetype: string; mapped: number };
      warnings: string[];
    };
    expect(summary.jointBasis.basis).toBe('bone-map');
    expect(summary.jointBasis.joints.map((joint) => [joint.id, joint.objectName])).toEqual([
      ['hips', 'b01'],
      ['spine', 'b02'],
      ['head', 'b03'],
    ]);
    expect(summary.jointBasis.declaredJoints).toHaveLength(12);
    expect(summary.boneMap).toMatchObject({ source: bonesPath, archetype: 'humanoid', mapped: 3 });
    expect(summary.warnings.some((warning) => warning.includes('motion-top15'))).toBe(false);
  }, 240_000);

  it('坏 boneMap 路径 / 坏 JSON / schema 非法 → 三段式 KinemeshError（不再静默成功）', async () => {
    const analyze = toolExecute('kinemesh_analyze');
    const missing = await analyze({ path: chainGlb, boneMap: path.join(workDir, 'no-such-bones.json') });
    expect(missing.ok).toBe(false);
    expect(String(missing.what)).toContain('不存在');
    expect(String(missing.what)).toContain('no-such-bones.json');
    expect(String(missing.guidance)).toContain('kinemesh-bones.json');
    expect(String(missing.step)).toContain('当前这一步');

    const skeleton = toolExecute('kinemesh_skeleton');
    const brokenPath = path.join(workDir, 'broken-bones.json');
    await writeFile(brokenPath, '{ archetype: [oopsy', 'utf8');
    const broken = await skeleton({ path: chainGlb, boneMap: brokenPath });
    expect(broken.ok).toBe(false);
    expect(String(broken.what)).toContain('JSON 解析失败');
    expect(String(broken.guidance)).toContain('JSON');

    const badSchemaPath = path.join(workDir, 'bad-schema-bones.json');
    await writeFile(badSchemaPath, JSON.stringify({ bones: { b01: 'upperarm' } }), 'utf8');
    const badSchema = await skeleton({ path: chainGlb, boneMap: badSchemaPath });
    expect(badSchema.ok).toBe(false);
    expect(String(badSchema.what)).toContain('side');
    expect(String(badSchema.guidance)).toContain('upperarm-l');
  });

  it('分析链的字典层不受映射文件缺省影响：humanoid GLB 默认走 humanoid-conventions', async () => {
    const analyze = toolExecute('kinemesh_analyze');
    const outDir = path.join(workDir, 'analysis-dict');
    const analysis = await analyze({ path: humanoidGlb, out: outDir, clip: 'Idle' });
    expect(analysis.ok).toBe(true);
    const summary = JSON.parse(await readFile(path.join(outDir, 'motion-summary.json'), 'utf8')) as {
      jointBasis: { basis: string };
      boneMap?: unknown;
    };
    expect(summary.jointBasis.basis).toBe('humanoid-conventions');
    expect(summary.boneMap).toBeUndefined();
  });
});

// ———————— CLI 投影：analyze 三 flag（--smooth/--joints/--bone-map）+ skeleton 子命令 ————————

const cliFile = path.resolve(import.meta.dirname, '..', '..', 'plugins', 'kinemesh', 'skill', 'cli', 'kinemesh.cjs');

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliFile, ...args], { encoding: 'utf8', timeout: 120_000 });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe.skipIf(!existsSync(cliFile))('kinemesh CLI · M7 投影', () => {
  it('USAGE 列出 --smooth/--joints/--bone-map 与 skeleton 子命令', () => {
    const { status, stdout } = runCli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('--smooth');
    expect(stdout).toContain('--joints');
    expect(stdout).toContain('--bone-map');
    expect(stdout).toContain('kinemesh skeleton <file>');
  });

  it('--joints 投影：未知关节给三段式（flag 真正进入 core 解析）', () => {
    const { status, stderr } = runCli(['analyze', humanoidGlb, '--joints', 'Nope', '--smooth', '3']);
    expect(status).toBe(1);
    const parsed = JSON.parse(stderr) as { ok: boolean; what: string; guidance: string; step: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.what).toContain('Nope');
    expect(parsed.guidance).toContain('kinemesh_info');
    expect(parsed.step).toContain('当前这一步');
  });

  it('--joints 合法值 + --smooth 走通（退出码 0，joints 投影为清单）', () => {
    const { status, stdout, stderr } = runCli(['analyze', humanoidGlb, '--joints', 'L.Hand,R.Hand', '--smooth', '3', '--out', path.join(workDir, 'cli-joints')]);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it('--bone-map 缺失路径给三段式；--bone-map 合法路径消费', () => {
    const missing = runCli(['analyze', chainGlb, '--bone-map', path.join(workDir, 'nope.json')]);
    expect(missing.status).toBe(1);
    const parsed = JSON.parse(missing.stderr) as { what: string };
    expect(parsed.what).toContain('不存在');
    const ok = runCli(['skeleton', chainGlb, '--bone-map', path.join(chainDir, 'kinemesh-bones.json'), '--out', path.join(workDir, 'cli-skeleton')]);
    expect(ok.status).toBe(0);
    const skeletonOut = JSON.parse(ok.stdout) as { ok: boolean; digest: { boneMap: { archetype: string } | null } };
    expect(skeletonOut.ok).toBe(true);
    expect(skeletonOut.digest.boneMap?.archetype).toBe('humanoid');
  }, 120_000);
});
