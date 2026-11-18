// ViewState 解析：预设/自定义、缺省值、校验错误与 orbit8 展开（设计文档 §4.2）。
import { describe, expect, it } from 'vitest';
import { KinemeshError } from '../../plugins/kinemesh/src/core/errors.js';
import {
  cameraFromPosition,
  cameraPosition,
  orbit8Azimuths,
  resolveView,
  type SceneFrame,
} from '../../plugins/kinemesh/src/core/viewstate.js';

const SCENE: SceneFrame = { center: [0, 1, 0], radius: 1.5, clips: ['Run', 'Idle'] };

describe('resolveView', () => {
  it('viewPreset=front：方位角 0、距离按包围球缺省', () => {
    const { view, orbit8, warnings } = resolveView({ viewPreset: 'front' }, SCENE);
    expect(orbit8).toBe(false);
    expect(view.camera.azimuth).toBe(0);
    expect(view.camera.elevation).toBe(0);
    expect(view.camera.distance).toBeCloseTo(1.5 * 2.2, 6);
    expect(view.camera.target).toEqual([0, 1, 0]);
    expect(view.camera.fov).toBe(40);
    expect(warnings).toHaveLength(0);
  });

  it('什么都不给：three-quarter 缺省 + 提示', () => {
    const { view, warnings } = resolveView({}, SCENE);
    expect(view.camera.azimuth).toBe(45);
    expect(view.camera.elevation).toBe(20);
    expect(warnings.some((warning) => warning.includes('缺省视角'))).toBe(true);
  });

  it('view 与 viewPreset 二选一', () => {
    const input = { view: {}, viewPreset: 'front' };
    expect(() => resolveView(input, SCENE)).toThrow(KinemeshError);
  });

  it('未知 preset 给可选值', () => {
    try {
      resolveView({ viewPreset: 'top' }, SCENE);
      expect.unreachable();
    } catch (error) {
      expect((error as KinemeshError).guidance).toContain('orbit8');
    }
  });

  it('clip 必须存在于场景；frame 必须是非负整数', () => {
    expect(() => resolveView({ viewPreset: 'front', clip: 'Jump' }, SCENE)).toThrow(/没有动画片段/);
    expect(() => resolveView({ viewPreset: 'front', clip: 'Run', frame: 1.5 }, SCENE)).toThrow(/非负整数/);
    const ok = resolveView({ viewPreset: 'front', clip: 'Run', frame: 12 }, SCENE);
    expect(ok.view.clip).toBe('Run');
    expect(ok.view.frame).toBe(12);
  });

  it('frame 给了但没给 clip：忽略并提示', () => {
    const { view, warnings } = resolveView({ viewPreset: 'front', frame: 12 }, SCENE);
    expect(view.frame).toBe(12);
    expect(view.clip).toBeNull();
    expect(warnings.some((warning) => warning.includes('frame 被忽略'))).toBe(true);
  });

  it('orbit8 标记 + 八方位表', () => {
    const { orbit8 } = resolveView({ viewPreset: 'orbit8', clip: 'Run' }, SCENE);
    expect(orbit8).toBe(true);
    expect(orbit8Azimuths()).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
  });

  it('view 对象：字段可省略，按场景缺省', () => {
    const { view } = resolveView({ view: { camera: { azimuth: 90 } } }, SCENE);
    expect(view.camera.azimuth).toBe(90);
    expect(view.camera.elevation).toBe(0);
    expect(view.camera.distance).toBeCloseTo(3.3, 6);
    expect(view.camera.target).toEqual([0, 1, 0]);
    expect(view.camera.fov).toBe(40);
  });
});

describe('球坐标换算', () => {
  it('cameraPosition 与 cameraFromPosition 互逆', () => {
    const camera = {
      azimuth: 137,
      elevation: -12.5,
      distance: 3.2,
      target: [1, 2, 3] as [number, number, number],
      fov: 40,
    };
    const position = cameraPosition(camera);
    const back = cameraFromPosition(position, camera.target, camera.fov);
    expect(back.azimuth).toBeCloseTo(137, 4);
    expect(back.elevation).toBeCloseTo(-12.5, 4);
    expect(back.distance).toBeCloseTo(3.2, 4);
    expect(back.target).toEqual(camera.target);
  });

  it('方位角归一化到 [0, 360)', () => {
    expect(cameraFromPosition(cameraPosition({ azimuth: -90, elevation: 0, distance: 1, target: [0, 0, 0], fov: 40 }), [0, 0, 0], 40).azimuth).toBe(270);
  });
});
