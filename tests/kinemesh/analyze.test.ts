// 「发送给 AI 分析」：请求解析与唤醒消息组装（设计文档 §5.1 的 client→host→agent 链路）。
import { describe, expect, it } from 'vitest';
import { composeAnalyzeMessage, parseAnalyzeRequest } from '../../plugins/kinemesh/src/analyze.js';

const VIEW = {
  camera: { azimuth: 45, elevation: 20, distance: 3.3, target: [0, 1, 0], fov: 40 },
  clip: null,
  frame: 12,
  mode: 'default',
};

describe('parseAnalyzeRequest', () => {
  it('缺 path / sessionId 给具体缺什么', () => {
    expect(parseAnalyzeRequest({}).ok).toBe(false);
    const noSession = parseAnalyzeRequest({ path: 'a.fbx' });
    expect(noSession.ok === false && noSession.message).toContain('sessionId');
  });

  it('完整请求解析出规范字段', () => {
    const parsed = parseAnalyzeRequest({ path: 'D:/a.fbx', sessionId: 's1', clip: 'Run', frame: 30, view: VIEW, note: '看膝盖' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.clip).toBe('Run');
      expect(parsed.request.frame).toBe(30);
      expect(parsed.request.note).toBe('看膝盖');
      expect(parsed.request.view).not.toBeNull();
    }
  });

  it('给了 clip 没给 frame：按第 0 帧', () => {
    const parsed = parseAnalyzeRequest({ path: 'a.fbx', sessionId: 's1', clip: 'Run' });
    expect(parsed.ok === true && parsed.request.frame).toBe(0);
  });

  it('view 不像 ViewState 时置 null（不猜）', () => {
    const parsed = parseAnalyzeRequest({ path: 'a.fbx', sessionId: 's1', view: 'front' });
    expect(parsed.ok === true && parsed.request.view).toBeNull();
  });
});

describe('composeAnalyzeMessage', () => {
  it('包含路径/片段/帧/视角与 kinemesh_render 指令', () => {
    const message = composeAnalyzeMessage({
      path: 'D:/assets/hero.fbx',
      sessionId: 's1',
      clip: 'Run',
      frame: 30,
      view: VIEW as never,
      note: null,
    });
    expect(message).toContain('hero.fbx');
    expect(message).toContain('「Run」');
    expect(message).toContain('帧号：30');
    expect(message).toContain('azimuth 45°');
    expect(message).toContain('kinemesh_render');
    expect(message).toContain('time = frame / 30');
  });

  it('静态模型与用户附言', () => {
    const message = composeAnalyzeMessage({
      path: 'a.glb',
      sessionId: 's1',
      clip: null,
      frame: null,
      view: null,
      note: '检查比例',
    });
    expect(message).toContain('（无动画/静态）');
    expect(message).toContain('检查比例');
    expect(message).toContain('缺省视角');
  });
});
