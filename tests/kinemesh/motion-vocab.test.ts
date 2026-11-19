// M6d core：vocab 文件机制（发现顺序/解析校验/三种 action）+ 决策表扩展点 + curvesFor 曲线文件
// + summary.vocab 回显。匹配与分段用合成 rig（已知答案）；文件发现用临时目录。
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { analyzeClip } from '../../plugins/kinemesh/src/core/motion/analyze.js';
import { KinemeshError } from '../../plugins/kinemesh/src/core/errors.js';
import {
  loadVocab,
  matchVocab,
  parseVocab,
  type VocabFeatures,
  type VocabWhen,
} from '../../plugins/kinemesh/src/core/motion/vocab.js';
import {
  buildBackpedalClip,
  buildHumanoidRig,
  buildPunchClip,
  buildRigScene,
} from '../support/kinemesh-rig-fixtures.js';

const base: VocabFeatures = {
  dur: 0.5,
  meanE: 0.6,
  peakE: 3.0,
  peakJoint: 'R.Hand',
  rootSpeed: 0.1,
  turnNet: 5,
  turnTotal: 5,
  bodyDir: 'in-place',
  airRatio: 0,
  hipsLow: false,
};

function when(partial: Partial<VocabWhen>): VocabWhen {
  return partial;
}

describe('M6d · matchVocab（A.8 表前按序首条命中）', () => {
  it('条件组全命中才命中；空条件恒命中', () => {
    expect(matchVocab(base, [{ term: 'attack', when: when({ peakEMin: 2, durMax: 0.8, peakJoint: 'R.Hand' }) }]))
      .toEqual({ term: 'attack', action: 'label' });
    expect(matchVocab(base, [{ term: 'no', when: when({ peakEMin: 2, peakJoint: 'L.Foot' }) }])).toBeNull();
    expect(matchVocab(base, [{ term: 'always', when: {} }])).toEqual({ term: 'always', action: 'label' });
  });

  it('action 语义：缺省 label / suppress / demote；first-match 按序', () => {
    const entries = [
      { term: 'second', when: when({ peakEMin: 2 }) },
      { term: 'never', when: when({ peakEMin: 99 }) },
    ];
    expect(matchVocab(base, entries)?.term).toBe('second');
    expect(matchVocab(base, [{ term: 'x', when: {}, action: 'suppress' }])).toEqual({ term: 'x', action: 'suppress' });
    expect(matchVocab(base, [{ term: 'x', when: {}, action: 'demote' }])).toEqual({ term: 'x', action: 'demote' });
  });

  it('anyOf 任一子条件组命中即可；airborne 按 airRatio>0.5 口径；hipsLow/turnTotalMin/bodyDir 可引用', () => {
    expect(matchVocab(base, [{ term: 'dodge', when: { anyOf: [when({ airRatioMin: 0.5 }), when({ rootSpeedMin: 1.2 })] } }])).toBeNull();
    expect(matchVocab(base, [{ term: 'dodge', when: { anyOf: [when({ airRatioMin: 0.5 }), when({ rootSpeedMin: 0.05 })] } }]))
      .toEqual({ term: 'dodge', action: 'label' });
    expect(matchVocab(base, [{ term: 'air', when: when({ airborne: true }) }])).toBeNull();
    expect(matchVocab(base, [{ term: 'ground', when: when({ airborne: false }) }])).not.toBeNull();
    expect(matchVocab(base, [{ term: 'low', when: when({ hipsLow: true }) }])).toBeNull();
    expect(matchVocab(base, [{ term: 'spin', when: when({ turnTotalMin: 270 }) }])).toBeNull();
    expect(matchVocab(base, [{ term: 'back', when: when({ bodyDir: 'back' }) }])).toBeNull();
  });
});

// 临时目录在模块顶层准备（describe 回调里不能 top-level await）
const home = await mkdtemp(path.join(tmpdir(), 'kinemesh-vocab-'));
const assetDir = path.join(home, 'assets');
const cwd = path.join(home, 'work');
await mkdir(assetDir, { recursive: true });
await mkdir(cwd, { recursive: true });
const vocabJson = JSON.stringify({ entries: [{ term: 'dodge', when: when({ rootSpeedMin: 1.2 }) }] });
const vocabJson2 = JSON.stringify({ entries: [{ term: 'from-cwd', when: {} }] });

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('M6d · loadVocab 发现顺序与解析校验', () => {
  it('explicit > 资产同目录 > cwd > builtin，逐级静默降级', async () => {
    const explicit = path.join(home, 'my-vocab.json');
    await writeFile(explicit, vocabJson, 'utf8');
    await writeFile(path.join(assetDir, 'kinemesh-vocab.json'), vocabJson2, 'utf8');
    await writeFile(path.join(cwd, 'kinemesh-vocab.json'), vocabJson, 'utf8');

    const hit = await loadVocab({ explicitPath: explicit, assetDir, cwd });
    expect(hit.source).toBe(path.resolve(explicit));
    expect(hit.entries).toHaveLength(1);
    expect(hit.entries[0]?.term).toBe('dodge');

    // explicit 缺失 → 资产同目录
    const asset = await loadVocab({ assetDir, cwd });
    expect(asset.source).toBe(path.resolve(path.join(assetDir, 'kinemesh-vocab.json')));
    expect(asset.entries[0]?.term).toBe('from-cwd');

    // 资产同目录也没有 → cwd
    const emptyAsset = path.join(home, 'assets-empty');
    await mkdir(emptyAsset, { recursive: true });
    const cwdHit = await loadVocab({ assetDir: emptyAsset, cwd });
    expect(cwdHit.source).toBe(path.resolve(path.join(cwd, 'kinemesh-vocab.json')));
    expect(cwdHit.entries[0]?.term).toBe('dodge');

    // 全都没有 → builtin
    const builtin = await loadVocab({ assetDir: emptyAsset, cwd: path.join(home, 'nope') });
    expect(builtin).toEqual({ source: 'builtin', entries: [] });
  });

  it('JSON 非法 / 结构不对 / 条目非法 → KinemeshError（错在哪 + 正确姿势）', async () => {
    const bad = path.join(home, 'bad.json');
    await writeFile(bad, '{ nope', 'utf8');
    expect(() => parseVocab('{ nope', bad)).toThrowError(/JSON 解析失败/);
    expect(() => parseVocab('{"entries": "no"}', bad)).toThrowError(/entries/);
    expect(() => parseVocab(JSON.stringify({ entries: [{ term: 'x', when: { rootSpeedMin: 'fast' } }] }), bad)).toThrowError(/rootSpeedMin/);
    expect(() => parseVocab(JSON.stringify({ entries: [{ term: 'x', when: { magic: 1 } }] }), bad)).toThrowError(/magic/);
    expect(() => parseVocab(JSON.stringify({ entries: [{ term: 'x', when: {}, action: 'promote' }] }), bad)).toThrowError(/action/);
    expect(() => parseVocab(JSON.stringify({ entries: [{ term: '', when: {} }] }), bad)).toThrowError(/term/);
    expect(() => parseVocab(JSON.stringify({ entries: [{ term: 'x', when: { anyOf: [] } }] }), bad)).toThrowError(/anyOf/);
  });
});

describe('M6d · describe 决策表 vocab 扩展点（analyzeClip 端到端）', () => {
  function run(clip: THREE.AnimationClip, vocab?: { source: string; entries: ReturnType<typeof parseVocab> }) {
    const rig = buildHumanoidRig();
    return analyzeClip(buildRigScene(rig.root, [clip]), vocab ? { vocab } : {});
  }

  it('label 词条覆盖 guess（strike-punch → attack-punch），label 与 basis 依据保留', () => {
    const { summary } = run(buildPunchClip(buildHumanoidRig()), {
      source: 'test-vocab',
      entries: parseVocab(JSON.stringify({ entries: [{ term: 'attack-punch', when: when({ peakJoint: 'R.Hand', peakEMin: 2 }) }] }), 'mem'),
    });
    expect(summary.vocab).toEqual({ source: 'test-vocab', entries: 1 });
    expect(summary.segments[1]?.guess).toBe('attack-punch');
    expect(summary.segments[1]?.label).toBe('action');
    expect(summary.segments[1]?.features.basis).toContain('vocab「attack-punch」命中');
    expect(summary.segments[1]?.features.basis).toContain('R.Hand');
    expect(summary.facts.some((fact) => fact.includes('guess attack-punch'))).toBe(true);
  });

  it('suppress 命中 guess 置 other；demote 命中降级 gesture；未命中段走原表', () => {
    // 词条条件收窄到打击段（A.8 #8 口径：peakE≥2 ∧ dur≤0.8s），避免整片命中后段被合并
    const strikeOnly = (action: string): string =>
      JSON.stringify({ entries: [{ term: 'misfire', when: when({ peakEMin: 2, durMax: 0.8 }), action }] });

    const suppressed = run(buildPunchClip(buildHumanoidRig()), { source: 'mem', entries: parseVocab(strikeOnly('suppress'), 'mem') });
    expect(suppressed.summary.segments[1]?.guess).toBe('other');
    expect(suppressed.summary.segments[1]?.label).toBe('action'); // label（确定性层）不动
    // 抑制改变了前段 guess（other）→ recover 链 #12 判据不再成立，收招段落回 #13 gesture（确定性后果）
    expect(suppressed.summary.segments[2]?.guess).toBe('gesture');

    const demoted = run(buildBackpedalClip(buildHumanoidRig()), {
      source: 'mem',
      entries: parseVocab(
        JSON.stringify({ entries: [{ term: 'meh', when: when({ bodyDir: 'back', rootSpeedMin: 0.3 }), action: 'demote' }] }),
        'mem',
      ),
    });
    expect(demoted.summary.segments[0]?.guess).toBe('gesture');
    expect(demoted.summary.segments[0]?.label).toBe('contact-move'); // demote 只降 guess，label 不动

    // 条件永不命中 → 整片走原表（M6b 基线不变）
    const noHit = run(buildPunchClip(buildHumanoidRig()), {
      source: 'mem',
      entries: parseVocab(JSON.stringify({ entries: [{ term: 'zzz', when: when({ peakEMin: 99 }) }] }), 'mem'),
    });
    expect(noHit.summary.segments.map((segment) => segment.guess)).toEqual(['gesture', 'strike-punch', 'recover']);
  });

  it('无词表时 summary.vocab 是 builtin 占位，guess 与 M6b 基线一致', () => {
    const { summary } = run(buildBackpedalClip(buildHumanoidRig()));
    expect(summary.vocab).toEqual({ source: 'builtin', entries: 0 });
    expect(summary.segments[0]?.guess).toBe('backpedal');
  });
});

describe('M6d · curvesFor / detail=full 曲线文件（§6.4 motion-curves/<joint>.csv）', () => {
  it('curvesFor 指定关节出曲线；数量、列头与帧数正确', () => {
    const rig = buildHumanoidRig();
    const { files, summary } = analyzeClip(buildRigScene(rig.root, [buildBackpedalClip(rig)]), {
      curvesFor: ['R.Hand', 'L.Foot'],
    });
    const names = files.map((file) => file.name);
    expect(names).toContain('motion-curves/R.Hand.csv');
    expect(names).toContain('motion-curves/L.Foot.csv');
    const csv = files.find((file) => file.name === 'motion-curves/R.Hand.csv')!;
    const lines = csv.content.trimEnd().split('\n');
    expect(lines[0]).toBe('frame,time,pos_x,pos_y,pos_z,speed,vx,vy,vz');
    expect(lines).toHaveLength(1 + summary.clip.frameCount);
  });

  it('detail=full 出全部关节曲线；summary+curvesFor 组合也出曲线', () => {
    const rig = buildHumanoidRig();
    const jointCount = analyzeClip(buildRigScene(rig.root, [buildBackpedalClip(rig)])).summary.jointBasis.joints.length;
    const full = analyzeClip(buildRigScene(rig.root, [buildBackpedalClip(rig)]), { detail: 'full' });
    const curveCount = full.files.filter((file) => file.name.startsWith('motion-curves/')).length;
    expect(curveCount).toBe(jointCount);

    const combo = analyzeClip(buildRigScene(rig.root, [buildBackpedalClip(rig)]), {
      detail: 'summary',
      curvesFor: ['Hips'],
    });
    expect(combo.files.map((file) => file.name)).toEqual(['motion-summary.json', 'motion-curves/hips.csv']);
  });

  it('找不到关节给三段式自愈（KinemeshError，guidance 列出可用关节）', () => {
    const rig = buildHumanoidRig();
    let caught: unknown;
    try {
      analyzeClip(buildRigScene(rig.root, [buildBackpedalClip(rig)]), { curvesFor: ['Nope'] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KinemeshError);
    expect((caught as KinemeshError).message).toContain('找不到曲线关节');
    expect((caught as KinemeshError).guidance).toContain('R.Hand');
  });
});
