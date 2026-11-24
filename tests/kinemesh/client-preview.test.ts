// client 侧纯函数直测（M6e §6.10）：页签可见性、能量归一/折线点、分段色带颜色、
// 帧号百分比、digest 摘要文案。交互与渲染在 client.tsx，不走 jsdom（与 handoff 同一套策略）。
import { describe, expect, it } from 'vitest';
import {
  clearPaneMemories,
  energyPoints,
  formatDigestHeadline,
  frameToPercent,
  hostPathOfFile,
  isModelFileName,
  normalizeEnergySeries,
  pickSendDigest,
  readPaneMemory,
  segmentColor,
  shouldShowPreviewTab,
  writePaneMemory,
} from '../../plugins/kinemesh/src/client.js';

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
