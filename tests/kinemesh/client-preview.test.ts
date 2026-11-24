// client 侧纯函数直测（M6e §6.10）：页签可见性、能量归一/折线点、分段色带颜色、
// 帧号百分比、digest 摘要文案。交互与渲染在 client.tsx，不走 jsdom（与 handoff 同一套策略）。
import { describe, expect, it } from 'vitest';
import {
  clampFrame,
  clearPaneMemories,
  computeTickStep,
  energyPoints,
  formatDigestHeadline,
  frameTicks,
  frameToPercent,
  hostPathOfFile,
  isModelFileName,
  normalizeEnergySeries,
  pickSendDigest,
  readPaneMemory,
  resolveRestoreTarget,
  segmentColor,
  shouldShowPreviewTab,
  stepFrame,
  writePaneMemory,
} from '../../plugins/kinemesh/src/client.js';

describe('时间轴帧号刻度（0.6.3：短动作帧数少，需要刻度才好定位）', () => {
  it('短动作（16 帧）用 2 帧步长：0/2/4/.../16，标签数 9 不挤', () => {
    const step = computeTickStep(16);
    expect(step).toBe(2);
    const ticks = frameTicks(16);
    expect(ticks).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16]);
    expect(ticks.length).toBeLessThanOrEqual(9);
  });

  it('极短动作（6 帧）用 1 帧步长：每个帧号都标出来', () => {
    expect(computeTickStep(6)).toBe(1);
    expect(frameTicks(6)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('长动作自动放大步长，标签数恒 ≤ 9（2s/10s/60s）', () => {
    for (const maxFrame of [42, 60, 300, 1800]) {
      const ticks = frameTicks(maxFrame);
      expect(ticks.length).toBeLessThanOrEqual(9);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBe(maxFrame); // 末帧（总帧数）必须可见
    }
  });

  it('末帧与上一步过近时用末帧替换，避免标签重叠；结果升序无重复', () => {
    const ticks = frameTicks(17, 2);
    expect(ticks[ticks.length - 1]).toBe(17);
    expect(new Set(ticks).size).toBe(ticks.length);
    for (let i = 1; i < ticks.length; i += 1) expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!);
  });

  it('边界：maxFrame 0 返回单刻度 [0]；负数按 0 处理', () => {
    expect(frameTicks(0)).toEqual([0]);
    expect(frameTicks(-5)).toEqual([0]);
    expect(computeTickStep(0)).toBe(1);
  });
});

describe('预览状态记忆（0.6.0：切面板/页签回来数据不丢）', () => {
  it('写入后可读回同样内容；不同 persistKey 互不影响', () => {
    clearPaneMemories();
    writePaneMemory('standalone', { path: 'E:\\a.fbx', clip: 'Take 001', frame: 42, mode: 'skeleton' });
    writePaneMemory('tab', { path: 'E:\\b.glb', clip: '', frame: 0, mode: 'default' });
    expect(readPaneMemory('standalone')).toEqual({ path: 'E:\\a.fbx', clip: 'Take 001', frame: 42, mode: 'skeleton' });
    expect(readPaneMemory('tab')).toEqual({ path: 'E:\\b.glb', clip: '', frame: 0, mode: 'default' });
    expect(readPaneMemory('missing')).toBeNull();
  });

  it('空路径不覆盖已有记忆（避免误清）', () => {
    clearPaneMemories();
    writePaneMemory('standalone', { path: 'E:\\a.fbx', clip: 'x', frame: 1, mode: 'default' });
    writePaneMemory('standalone', { path: '   ', clip: '', frame: 0, mode: 'default' });
    expect(readPaneMemory('standalone')?.path).toBe('E:\\a.fbx');
  });

  it('写入是快照拷贝：外部对象后续修改不影响记忆', () => {
    clearPaneMemories();
    const memory = { path: 'E:\\a.fbx', clip: 'c', frame: 3, mode: 'default' as const };
    writePaneMemory('k', memory);
    memory.frame = 99;
    expect(readPaneMemory('k')?.frame).toBe(3);
  });
});

describe('加载后恢复目标（0.6.2：自动选首个 clip + 恢复记忆进度）', () => {
  it('无记忆：取第一个 clip、第 0 帧（旧实现恒为静态 = 播放按钮永久 disabled）', () => {
    expect(resolveRestoreTarget(null, 'E:\\a.fbx', ['Take 001', 'Idle'], 60)).toEqual({ clip: 'Take 001', frame: 0 });
  });

  it('记忆命中同一路径且 clip 仍存在：恢复 clip 与帧号', () => {
    const memory = { path: 'E:\\a.fbx', clip: 'Idle', frame: 42, mode: 'default' as const };
    expect(resolveRestoreTarget(memory, 'E:\\a.fbx', ['Take 001', 'Idle'], 60)).toEqual({ clip: 'Idle', frame: 42 });
  });

  it('路径不同：不套用记忆（取首个 clip + 0 帧）', () => {
    const memory = { path: 'E:\\other.fbx', clip: 'Idle', frame: 42, mode: 'default' as const };
    expect(resolveRestoreTarget(memory, 'E:\\a.fbx', ['Take 001'], 60)).toEqual({ clip: 'Take 001', frame: 0 });
  });

  it('记忆里的 clip 已不存在：回落首个 clip；帧号按 maxFrame 夹紧', () => {
    const memory = { path: 'E:\\a.fbx', clip: 'Gone', frame: 999, mode: 'default' as const };
    expect(resolveRestoreTarget(memory, 'E:\\a.fbx', ['Take 001'], 16)).toEqual({ clip: 'Take 001', frame: 16 });
  });

  it('静态资产（无 clip）：clip 为空串、帧 0', () => {
    expect(resolveRestoreTarget(null, 'E:\\static.fbx', [], 0)).toEqual({ clip: '', frame: 0 });
  });
});

describe('拖入文件（0.5.3）：扩展名判定 + 桌面版真实路径解析', () => {
  it('isModelFileName：四个支持扩展名大小写不敏感；其他类型拒绝', () => {
    for (const name of ['a.fbx', 'B.GLB', 'c.gltf', 'd.Obj', 'path/x.fbx']) {
      expect(isModelFileName(name)).toBe(true);
    }
    for (const name of ['a.max', 'b.blend', 'c.png', 'd', 'e.fbx.bak']) {
      expect(isModelFileName(name)).toBe(false);
    }
  });

  it('hostPathOfFile：有 preload 桥时返回真实路径，无桥/抛错时返回 null', () => {
    const scope = globalThis as { __DSH_HOST_PATHS__?: { pathFor?: (file: File) => unknown } };
    const saved = scope.__DSH_HOST_PATHS__;
    const file = { name: 'hero.fbx' } as File;
    try {
      scope.__DSH_HOST_PATHS__ = { pathFor: () => 'E:\\assets\\hero.fbx' };
      expect(hostPathOfFile(file)).toBe('E:\\assets\\hero.fbx');

      scope.__DSH_HOST_PATHS__ = { pathFor: () => '   ' };
      expect(hostPathOfFile(file)).toBeNull();

      scope.__DSH_HOST_PATHS__ = { pathFor: () => 42 };
      expect(hostPathOfFile(file)).toBeNull();

      scope.__DSH_HOST_PATHS__ = {
        pathFor: () => {
          throw new Error('boom');
        },
      };
      expect(hostPathOfFile(file)).toBeNull();

      delete scope.__DSH_HOST_PATHS__;
      expect(hostPathOfFile(file)).toBeNull();
    } finally {
      if (saved === undefined) delete scope.__DSH_HOST_PATHS__;
      else scope.__DSH_HOST_PATHS__ = saved;
    }
  });
});

describe('页签可见性（§6.9 M6e：未用插件的会话无页签）', () => {
  it('没拿到会话 id 时不出现页签', () => {
    expect(shouldShowPreviewTab('', true)).toBe(false);
    expect(shouldShowPreviewTab('   ', true)).toBe(false);
  });

  it('拿到会话但没用过 kinemesh 时不出现页签', () => {
    expect(shouldShowPreviewTab('s1', false)).toBe(false);
  });

  it('会话用过 kinemesh 时出现页签', () => {
    expect(shouldShowPreviewTab('s1', true)).toBe(true);
  });
});

describe('能量曲线归一与折线点', () => {
  it('峰值归一到 1，其余按比例；负值截 0', () => {
    expect(normalizeEnergySeries([1, 2, 4])).toEqual([0.25, 0.5, 1]);
    expect(normalizeEnergySeries([-1, 0, 2])).toEqual([0, 0, 1]);
  });

  it('空序列返回空；全零恒 0', () => {
    expect(normalizeEnergySeries([])).toEqual([]);
    expect(normalizeEnergySeries([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('折线点铺满坐标空间：首点在左下沿、峰值到顶', () => {
    const points = energyPoints([0, 0.5, 1], 100, 40);
    expect(points).toHaveLength(3);
    expect(points[0]).toEqual([0, 40]);
    expect(points[1]).toEqual([50, 20]);
    expect(points[2]).toEqual([100, 0]);
  });

  it('空序列/非法尺寸返回空点列；单点也成点列', () => {
    expect(energyPoints([], 100, 40)).toEqual([]);
    expect(energyPoints([1], 0, 40)).toEqual([]);
    expect(energyPoints([1], 100, 40)).toEqual([[0, 40]]);
  });
});

describe('分段色带颜色与帧号百分比', () => {
  it('label 分类着色：已知 label 各有颜色，未知 label 用同一兜底色', () => {
    expect(segmentColor('idle')).toBe(segmentColor('idle'));
    expect(segmentColor('idle')).not.toBe(segmentColor('contact-move'));
    expect(segmentColor('contact-move')).not.toBe(segmentColor('action'));
    expect(segmentColor('action')).not.toBe(segmentColor('airborne'));
    expect(segmentColor('no-such-label')).toBe(segmentColor('another-unknown'));
  });

  it('frameToPercent：0/max → 0/100，越界截断，maxFrame ≤ 0 恒 0', () => {
    expect(frameToPercent(0, 100)).toBe(0);
    expect(frameToPercent(50, 100)).toBe(50);
    expect(frameToPercent(100, 100)).toBe(100);
    expect(frameToPercent(150, 100)).toBe(100);
    expect(frameToPercent(-5, 100)).toBe(0);
    expect(frameToPercent(10, 0)).toBe(0);
    expect(frameToPercent(Number.NaN, 100)).toBe(0);
  });
});

describe('播放条帧号口径（0.7.0：首帧/末帧/逐帧都走 clampFrame + stepFrame）', () => {
  it('clampFrame 夹紧到 [0, maxFrame] 并取整', () => {
    expect(clampFrame(0, 60)).toBe(0);
    expect(clampFrame(30, 60)).toBe(30);
    expect(clampFrame(-3, 60)).toBe(0);
    expect(clampFrame(999, 60)).toBe(60);
    expect(clampFrame(12.6, 60)).toBe(13);
    expect(clampFrame(5, 0)).toBe(0);
    expect(clampFrame(Number.NaN, 60)).toBe(0);
  });

  it('stepFrame 前后各一帧，首末帧静止不绕回', () => {
    expect(stepFrame(10, 1, 60)).toBe(11);
    expect(stepFrame(10, -1, 60)).toBe(9);
    expect(stepFrame(0, -1, 60)).toBe(0); // 已在首帧：不绕到末帧
    expect(stepFrame(60, 1, 60)).toBe(60); // 已在末帧：不绕回首帧
  });

  it('stepFrame 非法入参与退化区间不产生负帧/越界帧', () => {
    expect(stepFrame(Number.NaN, 1, 60)).toBe(1);
    expect(stepFrame(10, Number.NaN, 60)).toBe(10);
    expect(stepFrame(10, 1, 0)).toBe(0);
    expect(stepFrame(10, 5, -1)).toBe(0);
  });

  it('maxFrame 非整数按四舍五入夹紧（duration×fps 浮点误差不产生半帧）', () => {
    expect(clampFrame(68, 67.9999)).toBe(68);
    expect(clampFrame(68.4, 67.9999)).toBe(68);
    expect(stepFrame(66, 1, 68.0001)).toBe(67);
  });
});

describe('digest 摘要文案（发送 chip）', () => {
  it('clip 名 + 段数 + loopCheck verdict 组成一行', () => {
    const headline = formatDigestHeadline({
      clip: { name: 'Walk', duration: 0.5, frames: 15 },
      segments: [
        { frameStart: 0, frameEnd: 7, label: 'contact-move', guess: 'walk', level: 'low' },
        { frameStart: 8, frameEnd: 15, label: 'idle', guess: 'idle', level: 'low' },
      ],
      loopCheck: { verdict: 'loop-ok', bestLoopRange: { frameStart: 0, frameEnd: 7 } },
    });
    expect(headline).toContain('Walk');
    expect(headline).toContain('2 段');
    expect(headline).toContain('loop-ok');
  });

  it('空 digest / 非对象返回空串；只有部分字段也能成句', () => {
    expect(formatDigestHeadline(null)).toBe('');
    expect(formatDigestHeadline(undefined)).toBe('');
    expect(formatDigestHeadline({})).toBe('');
    expect(formatDigestHeadline({ clip: { name: 'Idle' } })).toContain('Idle');
  });
});

describe('发送 digest 挑选（review Important #1：静态态不附错配 digest）', () => {
  const analysis = { summaryDigest: { clip: { name: 'Walk' }, segments: [{ frameStart: 0, frameEnd: 7 }] } };

  it('静态态（clip === ""）不附 digest——analysis 缓存是缺省第一个 clip 的，附上会与正文「无动画/静态」互斥', () => {
    expect(pickSendDigest('', analysis)).toBeNull();
    expect(pickSendDigest('', null)).toBeNull();
  });

  it('选定 clip 时附当前 analysis 的 summaryDigest；无分析数据时不附', () => {
    expect(pickSendDigest('Walk', analysis)).toBe(analysis.summaryDigest);
    expect(pickSendDigest('Walk', null)).toBeNull();
  });
});
