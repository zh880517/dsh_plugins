// M6a 派生通道（附录 A.2–A.6）与 frames.csv 序列化：合成已知答案动画逐项对答案，
// 覆盖能量/档位/幅度/朝向/turnTotal/moveDir(Body)/接触去抖/topJoint/归一化。
import { describe, expect, it } from 'vitest';
import { computeChannels, debounceContact } from '../../plugins/kinemesh/src/core/motion/channels.js';
import { intensityLevel } from '../../plugins/kinemesh/src/core/motion/constants.js';
import { framesCsv } from '../../plugins/kinemesh/src/core/motion/report.js';
import { resolveNormalization } from '../../plugins/kinemesh/src/core/motion/normalize.js';
import { sampleClip } from '../../plugins/kinemesh/src/core/motion/sample.js';
import {
  buildChainRig,
  buildChainSwingClip,
  buildHumanoidRig,
  buildLinearWalkClip,
  buildRigScene,
  buildSineSwingClip,
  buildSpinClip,
} from '../support/kinemesh-rig-fixtures.js';

describe('channels · 线性位移（匀速直线走，speed=1 H/s）', () => {
  const rig = buildHumanoidRig();
  const sample = sampleClip(buildRigScene(rig.root, [buildLinearWalkClip(rig, { speed: 1, duration: 2 })]));
  const channels = computeChannels(sample);

  it('能量全程恒为 1.0 H/s，档位 extreme', () => {
    for (let k = 0; k < channels.frameCount; k += 1) {
      expect(channels.energy[k]).toBeCloseTo(1.0, 3);
      expect(channels.energyLevel[k]).toBe('extreme');
    }
  });

  it('root 轨迹线性推进、heading 0、moveDir/moveDirBody 全 forward、moveSpeed 1', () => {
    for (let k = 0; k < channels.frameCount; k += 1) {
      expect(channels.rootX[k]).toBeCloseTo(0, 4);
      expect(channels.rootY[k]).toBeCloseTo(0, 4);
      expect(channels.rootZ[k]).toBeCloseTo(k / 15, 4);
      expect(channels.heading[k]).toBeCloseTo(0, 4);
      expect(channels.turnTotal[k]).toBeCloseTo(0, 4);
      expect(channels.moveDir[k]).toBe('forward');
      expect(channels.moveDirBody[k]).toBe('forward');
      expect(channels.moveSpeed[k]).toBeCloseTo(1.0, 3);
    }
  });

  it('整体平移 → 双脚速度超阈不接触：airborne / air', () => {
    for (let k = 0; k < channels.frameCount; k += 1) {
      expect(channels.contactL[k]).toBe(false);
      expect(channels.contactR[k]).toBe(false);
      expect(channels.airborne[k]).toBe(true);
      expect(channels.support[k]).toBe('air');
    }
  });

  it('幅度恒为 0.176（双手 0.34 + 双脚 0.10 + 头 0，除以 5）', () => {
    for (let k = 0; k < channels.frameCount; k += 1) {
      expect(channels.amplitude[k]).toBeCloseTo(0.176, 3);
    }
  });

  it('topJoint 速度 1.0；全关节速度并列（浮点噪声内平手），id 落在 J15 集合', () => {
    for (let k = 0; k < channels.frameCount; k += 1) {
      expect(channels.topJointSpeed[k]).toBeCloseTo(1.0, 3);
      expect(channels.topJoint[k]).toMatch(/^(hips|spine|head|[LR]\.(UpperArm|LowerArm|Hand|UpperLeg|LowerLeg|Foot))$/);
    }
  });

  it('身高归一：scale=2 时能量/速度/位移减半、幅度减半', () => {
    const scaled = computeChannels(sample, { scale: 2 });
    expect(scaled.energy[10]).toBeCloseTo(0.5, 3);
    expect(scaled.moveSpeed[10]).toBeCloseTo(0.5, 3);
    expect(scaled.rootZ[15]).toBeCloseTo(0.5, 4);
    expect(scaled.amplitude[10]).toBeCloseTo(0.088, 3);
  });
});

describe('channels · 正弦摆动（右手单关节，period=4s，duration=4s）', () => {
  const rig = buildHumanoidRig();
  const sample = sampleClip(buildRigScene(rig.root, [buildSineSwingClip(rig)]));
  const channels = computeChannels(sample);

  it('能量有解析形状：峰值帧差分为 0、起/过零帧 0.049（1.2·0.3·15·sin6°/11.5）', () => {
    // k=15 / 45 是摆动峰值，速度恰为 0（对称弦长差分）
    expect(Math.abs(channels.energy[15])).toBeLessThan(1e-6);
    expect(Math.abs(channels.energy[45])).toBeLessThan(1e-6);
    // k=0（单侧差分）与 k=30（过零点中央差分）同为 0.3·15·sin(π/30) 的手速
    const peak = (1.2 * 0.3 * 15 * Math.sin(Math.PI / 30)) / 11.5;
    expect(channels.energy[0]).toBeCloseTo(peak, 4);
    expect(channels.energy[30]).toBeCloseTo(peak, 4);
    expect(channels.energyLevel[0]).toBe('static');
    expect(channels.energyLevel[15]).toBe('static');
  });

  it('topJoint：运动帧严格 R.Hand；全静止帧（手速恰为 0）并列取权重更大者 L.Hand', () => {
    for (let k = 0; k < channels.frameCount; k += 1) {
      expect(['L.Hand', 'R.Hand']).toContain(channels.topJoint[k]);
      expect(channels.contactL[k]).toBe(true);
      expect(channels.contactR[k]).toBe(true);
      expect(channels.airborne[k]).toBe(false);
      expect(channels.support[k]).toBe('double-support');
    }
    // 手在动的帧（差分速度 > 0）唯一最高
    expect(channels.topJoint[0]).toBe('R.Hand');
    expect(channels.topJoint[30]).toBe('R.Hand');
    // 摆动峰值帧（k=15/45）手速为 0 → 全关节并列 → 权重 1.2 的先者 L.Hand
    expect(channels.topJoint[15]).toBe('L.Hand');
    expect(channels.topJointSpeed[15]).toBeCloseTo(0, 6);
  });

  it('幅度随摆动振荡：峰值帧 0.236（手到 0.64）、回摆帧 0.116（手到 0.04）', () => {
    expect(channels.amplitude[15]).toBeCloseTo(0.236, 3);
    expect(channels.amplitude[45]).toBeCloseTo(0.116, 3);
    expect(channels.amplitude[0]).toBeCloseTo(0.176, 3);
  });

  it('rig 本体静止：root 全 0、heading 0、moveSpeed 0 → in-place', () => {
    for (let k = 0; k < channels.frameCount; k += 1) {
      expect(channels.rootZ[k]).toBeCloseTo(0, 6);
      expect(channels.heading[k]).toBeCloseTo(0, 6);
      expect(channels.moveSpeed[k]).toBeCloseTo(0, 6);
      expect(channels.moveDir[k]).toBe('in-place');
      expect(channels.moveDirBody[k]).toBe('in-place');
    }
  });
});

describe('channels · 720° 自转（turnTotal vs 净差）', () => {
  const rig = buildHumanoidRig();
  const sample = sampleClip(buildRigScene(rig.root, [buildSpinClip(rig)]));
  const channels = computeChannels(sample);

  it('heading 逐帧精确（12k° wrap），±180 接缝两侧 turnTotal 累计不受影响', () => {
    expect(channels.heading[0]).toBeCloseTo(0, 4);
    expect(channels.heading[14]).toBeCloseTo(168, 4);
    expect(Math.abs(channels.heading[15])).toBeCloseTo(180, 4);
    expect(channels.heading[16]).toBeCloseTo(-168, 4);
    expect(channels.heading[29]).toBeCloseTo(-12, 4);
    expect(channels.heading[30]).toBeCloseTo(0, 4);
    for (let k = 0; k < channels.frameCount; k += 1) {
      expect(channels.turnTotal[k]).toBeCloseTo(12 * k, 3);
    }
    expect(channels.turnTotal[59]).toBeCloseTo(708, 3);
  });

  it('圆周差分速度有解析解：内部帧 0.5554、端点帧 0.5582，档位 high', () => {
    // 内部帧：Σ w_j · r_j · 15·sin12° / Σw = 3.1187·2.048/11.5
    const interior = (15 * Math.sin((12 * Math.PI) / 180) * 2.048) / 11.5;
    // 端点帧（单侧差分）：弦长 2r·sin6° / Δt
    const endpoint = (30 * Math.sin((6 * Math.PI) / 180) * 2.048) / 11.5;
    expect(channels.energy[10]).toBeCloseTo(interior, 3);
    expect(channels.energy[30]).toBeCloseTo(interior, 3);
    expect(channels.energy[0]).toBeCloseTo(endpoint, 3);
    expect(channels.energyLevel[0]).toBe('high');
    expect(channels.energyLevel[10]).toBe('high');
  });

  it('脚速度 0.312 H/s 超 0.30 阈 → 全程不接触；hips 在轴上 → in-place、root 全 0', () => {
    for (let k = 0; k < channels.frameCount; k += 1) {
      expect(channels.contactL[k]).toBe(false);
      expect(channels.contactR[k]).toBe(false);
      expect(channels.airborne[k]).toBe(true);
      expect(channels.moveSpeed[k]).toBeCloseTo(0, 6);
      expect(channels.moveDir[k]).toBe('in-place');
      expect(channels.rootX[k]).toBeCloseTo(0, 6);
    }
    // 打击肢端：双 Hand 半径最大且并列，取权重同为 1.2 的先者 L.Hand
    expect(channels.topJoint[10]).toBe('L.Hand');
    expect(channels.topJointSpeed[10]).toBeCloseTo(0.34 * 15 * Math.sin((12 * Math.PI) / 180), 3);
  });
});

describe('channels · 非人形链式 rig（motion-top15 口径）', () => {
  it('topJoint = 方差最大的 seg_c；heading 走根骨骼回退（恒 0）；无足点 → air', () => {
    const chain = buildChainRig();
    const sample = sampleClip(buildRigScene(chain.root, [buildChainSwingClip(chain)]));
    const channels = computeChannels(sample);
    for (let k = 0; k < channels.frameCount; k += 1) {
      expect(channels.topJoint[k]).toBe('seg_c');
      expect(channels.heading[k]).toBeCloseTo(0, 6);
      expect(channels.amplitude[k]).toBe(0);
      expect(channels.moveDir[k]).toBe('in-place');
      expect(channels.airborne[k]).toBe(true);
      expect(channels.support[k]).toBe('air');
    }
    expect(channels.energy[0]).toBeGreaterThan(0);
  });
});

describe('frames.csv 序列化（§6.4 / A.14 圆整）', () => {
  it('表头 + 每采样帧一行，数值按 3/1 位小数圆整、布尔小写', () => {
    const rig = buildHumanoidRig();
    const sample = sampleClip(buildRigScene(rig.root, [buildLinearWalkClip(rig, { speed: 1, duration: 2 })]));
    const lines = framesCsv(computeChannels(sample)).trimEnd().split('\n');
    expect(lines).toHaveLength(31);
    expect(lines[0]).toBe(
      'frame,time,energy,energyLevel,root_x,root_y,root_z,heading,turnTotal,moveDir,moveDirBody,moveSpeed,contactL,contactR,airborne,support,topJoint,topJointSpeed,amplitude',
    );
    // topJoint 在全关节速度并列时由浮点噪声决定，不按名列断；其余列都有解析值
    const row = (k: number): string[] => lines[k + 1].split(',');
    expect(row(0)[0]).toBe('0');
    expect(row(0)[1]).toBe('0.000');
    expect(row(0)[2]).toBe('1.000');
    expect(row(0)[3]).toBe('extreme');
    expect(row(1)[0]).toBe('2');
    expect(row(1)[1]).toBe('0.067');
    expect(row(1)[2]).toBe('1.000');
    expect(row(1)[3]).toBe('extreme');
    expect(row(1)[6]).toBe('0.067'); // root_z = k/15
    expect(row(1)[7]).toBe('0.0'); // heading
    expect(row(1)[8]).toBe('0.0'); // turnTotal
    expect(row(1)[9]).toBe('forward');
    expect(row(1)[10]).toBe('forward');
    expect(row(1)[11]).toBe('1.000');
    expect(row(1)[12]).toBe('false');
    expect(row(1)[13]).toBe('false');
    expect(row(1)[14]).toBe('true');
    expect(row(1)[15]).toBe('air');
    expect(row(1)[17]).toBe('1.000');
    expect(row(1)[18]).toBe('0.176');
  });

  it('正弦摆动：能量 static 档、支撑描述 double-support 进 CSV', () => {
    const rig = buildHumanoidRig();
    const sample = sampleClip(buildRigScene(rig.root, [buildSineSwingClip(rig)]));
    const lines = framesCsv(computeChannels(sample)).trimEnd().split('\n');
    for (const k of [0, 15, 30]) {
      const row = lines[k + 1].split(',');
      expect(row[3]).toBe('static');
      expect(row[15]).toBe('double-support');
    }
    // 峰值帧能量圆整为 0.000
    expect(lines[16].split(',')[2]).toBe('0.000');
  });
});

describe('强度档位表（A.9：mean/peak 各判一档取更高级别）', () => {
  it('五档边界与组合', () => {
    expect(intensityLevel(0.049, 0.049)).toBe('static');
    expect(intensityLevel(0.05, 0.05)).toBe('low'); // 0.05 不满足 < 0.05
    expect(intensityLevel(0.3, 0.3)).toBe('medium'); // mean=medium、peak=low → 取高
    expect(intensityLevel(1.0, 1.0)).toBe('extreme');
    expect(intensityLevel(0.1, 3.5)).toBe('extreme'); // 峰值主导
    expect(intensityLevel(0.9, 0.5)).toBe('extreme'); // 均值主导
    expect(intensityLevel(0.55, 0.55)).toBe('high');
  });
});

describe('normalize（A.14：H ≤ 0 / 缺失 → 降级 none + warning）', () => {
  it('height 模式：scale = 身高；none 模式：scale = 1', () => {
    expect(resolveNormalization('height', 1.7)).toEqual({ mode: 'height', scale: 1.7, warnings: [] });
    expect(resolveNormalization('none', 1.7)).toEqual({ mode: 'none', scale: 1, warnings: [] });
  });

  it('身高缺失或 ≤ 0：降级 none 并提示不可跨资产比较', () => {
    for (const height of [null, 0, -3]) {
      const result = resolveNormalization('height', height);
      expect(result.mode).toBe('none');
      expect(result.scale).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('降级');
    }
  });
});

describe('接触去抖（A.6 回归：被拒翻转不透出，review 阻断 #2）', () => {
  it('单帧抖动被拒：输出保持当前状态', () => {
    expect(debounceContact([true, true, false, true, true])).toEqual([true, true, true, true, true]);
    expect(debounceContact([false, false, true, false, false])).toEqual([false, false, false, false, false]);
  });

  it('连续抖动（每次 1 帧）整段被拒', () => {
    expect(debounceContact([true, false, true, false, true])).toEqual([true, true, true, true, true]);
  });

  it('连续 2 帧翻转生效，生效帧 = 翻转第一帧（回填整段 run）', () => {
    expect(debounceContact([true, true, false, false, true, true])).toEqual([true, true, false, false, true, true]);
    // 生效后接单帧抖动不再透出：F 生效段后的孤立 T、再孤立 F 都被压平
    expect(debounceContact([true, true, false, false, true, false, true])).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('片首的孤立首值被平滑成后续状态（初始 state 也要求连续 2 帧才翻转）', () => {
    expect(debounceContact([false, true, true])).toEqual([false, true, true]);
    expect(debounceContact([])).toEqual([]);
  });
});
