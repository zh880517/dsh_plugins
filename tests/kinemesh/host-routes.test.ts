// /kinemesh 路由：模型字节、info JSON、analyze 唤醒（followup）与 404/409、
// 会话模型清单（M6e /session-models）与预览曲线数据源（M6e /analysis）。
// 用假 ctx / 假 req / 假 res 直接驱动 host.ts 的 handler（与 aiworkflow host-routes 同一套做法）。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildAnimatedCubeGltf, buildBinaryFbx, buildCubeObj, encodeGlb } from '../support/kinemesh-fixtures.js';
import { apply } from '../../plugins/kinemesh/src/host.js';
import { loadModelScene } from '../../plugins/kinemesh/src/core/analyze-file.js';
import { sceneBoundsHeight } from '../../plugins/kinemesh/src/core/analyze/scene-info.js';
import { computeChannels } from '../../plugins/kinemesh/src/core/motion/channels.js';
import { sampleClip } from '../../plugins/kinemesh/src/core/motion/sample.js';
import { resolveNormalization } from '../../plugins/kinemesh/src/core/motion/normalize.js';
import { framesCsv, roundLength } from '../../plugins/kinemesh/src/core/motion/report.js';

const workDir = await mkdtemp(path.join(tmpdir(), 'kinemesh-routes-'));
const glbPath = path.join(workDir, 'cube-anim.fbx');
const objPath = path.join(workDir, 'cube.obj');
const gltfGlbPath = path.join(workDir, 'cube-anim.glb');

await writeFile(glbPath, Buffer.from(buildBinaryFbx()));
await writeFile(objPath, buildCubeObj(), 'utf8');
await writeFile(gltfGlbPath, Buffer.from(encodeGlb(buildAnimatedCubeGltf())));

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

interface FakeAgent {
  followup?: (message: unknown) => void;
}

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  chunks: Buffer[];
  ended: boolean;
  setHeader(name: string, value: string): void;
  end(body?: Buffer | string): void;
}

interface CapturedRoute {
  handler(req: { url?: string; method?: string }, res: FakeRes): Promise<void> | void;
}

function setup(options: { agents?: Record<string, FakeAgent> } = {}): {
  route: CapturedRoute;
  followups: Array<{ sessionId: string; message: unknown }>;
} {
  const followups: Array<{ sessionId: string; message: unknown }> = [];
  let route: CapturedRoute | null = null;
  const ctx = {
    tools: { register: () => () => undefined },
    webServer: {
      register: (registration: { handler: CapturedRoute['handler'] }) => {
        route = { handler: registration.handler };
        return () => undefined;
      },
    },
    get(name: string) {
      if (name === 'agents') {
        return {
          get(id: string) {
            const agent = options.agents?.[id];
            if (agent === undefined) return undefined;
            return {
              followup(message: unknown) {
                followups.push({ sessionId: id, message });
              },
            };
          },
        };
      }
      return undefined;
    },
    effect(callback: () => unknown) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => undefined;
    },
  };
  apply(ctx);
  if (route === null) throw new Error('路由没有注册');
  return { route, followups };
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    headers: {},
    chunks: [],
    ended: false,
    setHeader(name, value) {
      res.headers[name] = value;
    },
    end(body) {
      res.ended = true;
      if (typeof body === 'string') res.chunks.push(Buffer.from(body));
      else if (body !== undefined) res.chunks.push(body);
    },
  };
  return res;
}

async function invoke(route: CapturedRoute, method: string, url: string, body?: unknown): Promise<{ res: FakeRes; text: string }> {
  const res = makeRes();
  const chunks: Buffer[] = [];
  const request = {
    url,
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
  await route.handler(request as never, res);
  if (res.chunks.length === 0 && chunks.length > 0) res.chunks.push(...chunks);
  return { res, text: Buffer.concat(res.chunks).toString('utf8') };
}

describe('/kinemesh 路由', () => {
  it('GET /kinemesh/model 供模型字节（CORS + octet-stream）', async () => {
    const { route } = setup();
    const { res } = await invoke(route, 'GET', `/kinemesh/model?path=${encodeURIComponent(objPath)}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect((res.chunks[0]?.length ?? 0)).toBeGreaterThan(0);
  });

  it('GET /kinemesh/model 缺 path → 400，不存在 → 404', async () => {
    const { route } = setup();
    const missing = await invoke(route, 'GET', '/kinemesh/model');
    expect(missing.res.statusCode).toBe(400);
    const gone = await invoke(route, 'GET', `/kinemesh/model?path=${encodeURIComponent(path.join(workDir, 'no-such.obj'))}`);
    expect(gone.res.statusCode).toBe(404);
  });

  it('GET /kinemesh/info 返回 InfoReport', async () => {
    const { route } = setup();
    const { res, text } = await invoke(route, 'GET', `/kinemesh/info?path=${encodeURIComponent(glbPath)}`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(text) as { ok: boolean; info: { format: string; clips: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.info.format).toBe('fbx-binary');
    expect(body.info.clips).toHaveLength(1);
    const objInfo = await invoke(route, 'GET', `/kinemesh/info?path=${encodeURIComponent(objPath)}`);
    expect(objInfo.res.statusCode).toBe(200);
  });

  it('POST /kinemesh/analyze：在线 Agent 收到 followup 消息', async () => {
    const { route, followups } = setup({ agents: { s1: {} } });
    const { res, text } = await invoke(route, 'POST', '/kinemesh/analyze', {
      path: 'D:/assets/hero.fbx',
      sessionId: 's1',
      clip: 'Run',
      frame: 30,
      view: { camera: { azimuth: 45, elevation: 20, distance: 3.3, target: [0, 1, 0], fov: 40 } },
      note: '看膝盖',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(text).delivered).toBe(true);
    expect(followups).toHaveLength(1);
    const message = followups[0]?.message as { role: string; content: Array<{ type: string; text: string }> };
    expect(message.role).toBe('user');
    expect(message.content[0]?.text).toContain('hero.fbx');
    expect(message.content[0]?.text).toContain('kinemesh_render');
    expect(message.content[0]?.text).toContain('看膝盖');
  });

  it('POST /kinemesh/analyze：Agent 不在线 → 409 + 指引', async () => {
    const { route, followups } = setup();
    const { res, text } = await invoke(route, 'POST', '/kinemesh/analyze', { path: 'a.fbx', sessionId: 'ghost' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(text).error.message).toContain('Agent');
    expect(followups).toHaveLength(0);
  });

  it('未知路由 404；缺字段的 analyze 400', async () => {
    const { route } = setup({ agents: { s1: {} } });
    const notFound = await invoke(route, 'GET', '/kinemesh/other');
    expect(notFound.res.statusCode).toBe(404);
    const bad = await invoke(route, 'POST', '/kinemesh/analyze', { sessionId: 's1' });
    expect(bad.res.statusCode).toBe(400);
    expect(JSON.parse(bad.text).error.message).toContain('path');
  });

  it('analyze 的消息是合法用户态消息且 id 唯一', async () => {
    const { route, followups } = setup({ agents: { s1: {}, s2: {} } });
    await invoke(route, 'POST', '/kinemesh/analyze', { path: 'a.fbx', sessionId: 's1', clip: 'Run', frame: 0 });
    await invoke(route, 'POST', '/kinemesh/analyze', { path: 'b.fbx', sessionId: 's2' });
    const ids = followups.map((item) => (item.message as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('/kinemesh/session-models（M6e 会话模型清单）', () => {
  it('未用插件的会话返回空清单；缺 sessionId → 400', async () => {
    const { route } = setup();
    const empty = await invoke(route, 'GET', `/kinemesh/session-models?sessionId=no-such-session`);
    expect(empty.res.statusCode).toBe(200);
    const body = JSON.parse(empty.text) as { ok: boolean; models: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.models).toEqual([]);
    const missing = await invoke(route, 'GET', '/kinemesh/session-models');
    expect(missing.res.statusCode).toBe(400);
  });

  it('model/info/analyze 处理成功即记录（按首次出现顺序去重）；409 不记录', async () => {
    const { route } = setup({ agents: { s1: {}, s2: {} } });
    await invoke(route, 'GET', `/kinemesh/model?path=${encodeURIComponent(objPath)}&sessionId=s1`);
    await invoke(route, 'GET', `/kinemesh/model?path=${encodeURIComponent(objPath)}&sessionId=s1`);
    await invoke(route, 'GET', `/kinemesh/model?path=${encodeURIComponent(glbPath)}&sessionId=s1`);
    await invoke(route, 'POST', '/kinemesh/analyze', { path: objPath, sessionId: 's1' });
    await invoke(route, 'POST', '/kinemesh/analyze', { path: objPath, sessionId: 'ghost' }); // 409，不记录

    const body = JSON.parse(
      (await invoke(route, 'GET', `/kinemesh/session-models?sessionId=s1`)).text,
    ) as { ok: boolean; models: Array<{ path: string; name: string; animated: boolean; clips: string[]; bytes: number }> };
    expect(body.ok).toBe(true);
    expect(body.models).toHaveLength(2); // obj 去重为一条 + fbx
    expect(body.models[0]!.path).toBe(objPath);
    expect(body.models[0]!.name).toBe('cube.obj');
    expect(body.models[0]!.animated).toBe(false);
    expect(body.models[0]!.clips).toEqual([]);
    expect(body.models[0]!.bytes).toBeGreaterThan(0);
    expect(body.models[1]!.name).toBe('cube-anim.fbx');
    expect(body.models[1]!.animated).toBe(true);
    expect(body.models[1]!.clips).toHaveLength(1);

    const ghost = JSON.parse(
      (await invoke(route, 'GET', `/kinemesh/session-models?sessionId=ghost`)).text,
    ) as { models: unknown[] };
    expect(ghost.models).toEqual([]);

    // analyze 成功也记录（s2 独立清单）
    await invoke(route, 'POST', '/kinemesh/analyze', { path: gltfGlbPath, sessionId: 's2' });
    const s2 = JSON.parse(
      (await invoke(route, 'GET', `/kinemesh/session-models?sessionId=s2`)).text,
    ) as { models: Array<{ path: string; animated: boolean }> };
    expect(s2.models).toHaveLength(1);
    expect(s2.models[0]!.path).toBe(gltfGlbPath);
    expect(s2.models[0]!.animated).toBe(true);
  });
});

describe('/kinemesh/analysis（M6e 预览曲线数据源）', () => {
  it('返回 digest + segments + keyframes + energy，且 energy/frames 与 core channels 逐位一致', async () => {
    const { route } = setup();
    const { res, text } = await invoke(route, 'GET', `/kinemesh/analysis?path=${encodeURIComponent(gltfGlbPath)}`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(text) as {
      ok: boolean;
      summaryDigest: { clip: { name: string }; segments: unknown[]; loopCheck: unknown };
      segments: Array<{ frameStart: number; frameEnd: number; label: string; guess: string }>;
      keyframes: Array<{ frame: number }>;
      frames: number[];
      energy: number[];
    };
    expect(body.ok).toBe(true);
    expect(body.summaryDigest.clip.name).toBe('Walk');
    expect(body.segments.length).toBeGreaterThanOrEqual(1);
    expect(body.summaryDigest.segments.length).toBe(body.segments.length);
    expect(body.keyframes.length).toBeGreaterThanOrEqual(1);
    expect(body.summaryDigest.loopCheck).not.toBeNull();

    // 同一段代码的口径：路由 energy/frames 必须与 core 采样+通道逐位一致（§6.9 M6e 验收）
    const { scene } = await loadModelScene(encodeGlb(buildAnimatedCubeGltf()), 'cube-anim.glb');
    const scale = resolveNormalization('height', sceneBoundsHeight(scene)).scale;
    const channels = computeChannels(sampleClip(scene, {}), { scale });
    expect(body.energy).toEqual(channels.energy);
    expect(body.frames).toEqual(channels.frames);

    // 与中间文件（motion-frames.csv）一致：每行 energy 列 = 路由 energy 的 3 位小数圆整（A.14）
    const rows = framesCsv(channels).trimEnd().split('\n');
    expect(rows).toHaveLength(channels.energy.length + 1);
    for (let k = 0; k < channels.energy.length; k += 1) {
      const cell = Number(rows[k + 1]!.split(',')[2]!);
      expect(cell).toBe(Number(roundLength(body.energy[k]!)));
    }
  });

  it('clip 参数缺省取第一个 clip；指定不存在的 clip → 400 且提示可用 clip', async () => {
    const { route } = setup();
    const ok = await invoke(route, 'GET', `/kinemesh/analysis?path=${encodeURIComponent(gltfGlbPath)}&clip=Walk`);
    expect(ok.res.statusCode).toBe(200);
    const bad = JSON.parse(
      (await invoke(route, 'GET', `/kinemesh/analysis?path=${encodeURIComponent(gltfGlbPath)}&clip=Nope`)).text,
    ) as { error: { message: string } };
    expect(bad.error.message).toContain('找不到动画片段');
    expect(bad.error.message).toContain('Walk');
  });

  it('缺 path → 400；文件不存在 → 404；静态资产（无动画）→ 400 自愈文案', async () => {
    const { route } = setup();
    const missing = await invoke(route, 'GET', '/kinemesh/analysis');
    expect(missing.res.statusCode).toBe(400);
    const gone = await invoke(route, 'GET', `/kinemesh/analysis?path=${encodeURIComponent(path.join(workDir, 'no-such.glb'))}`);
    expect(gone.res.statusCode).toBe(404);
    const staticBody = JSON.parse(
      (await invoke(route, 'GET', `/kinemesh/analysis?path=${encodeURIComponent(objPath)}`)).text,
    ) as { error: { message: string } };
    expect(staticBody.error.message).toContain('没有动画片段');
  });
});

describe('POST /kinemesh/analyze 附带 digest（M6e 发送带 digest）', () => {
  const digest = {
    clip: { name: 'Walk', duration: 0.5, frames: 15, sampleFps: 15 },
    segments: [{ index: 0, frameStart: 0, frameEnd: 7, label: 'contact-move', guess: 'walk', level: 'low' }],
    loopCheck: { verdict: 'loop-ok', bestLoopRange: { frameStart: 0, frameEnd: 7 } },
    facts: ['frame 0–7：double-support，强度 low（均值 0.1、峰值 0.2），位移 2.0 身高，方向 forward，guess walk'],
    keyframeRender: { frames: [0, 7], views: ['front', 'side'], mode: 'skeleton', altModes: ['bones-overlay'] },
  };

  function textOf(item: { message: unknown }): string {
    const message = item.message as { content: Array<{ type: string; text: string }> };
    return message.content.map((part) => part.text).join('\n');
  }

  it('digest 对象 → followup 消息附 digest 段（clip/分段/loopCheck/配方），并保留 M3 视角指令', async () => {
    const { route, followups } = setup({ agents: { s1: {} } });
    const { res, text } = await invoke(route, 'POST', '/kinemesh/analyze', {
      path: gltfGlbPath,
      sessionId: 's1',
      clip: 'Walk',
      frame: 3,
      view: { camera: { azimuth: 45, elevation: 20, distance: 3.3, target: [0, 1, 0], fov: 40 } },
      digest,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(text).delivered).toBe(true);
    expect(followups).toHaveLength(1);
    const message = textOf(followups[0]!);
    expect(message).toContain('【动作分析 digest】');
    expect(message).toContain('clip「Walk」');
    expect(message).toContain('contact-move');
    expect(message).toContain('guess walk');
    expect(message).toContain('循环检测：loop-ok');
    expect(message).toContain('bestLoopRange 帧 0–7');
    expect(message).toContain('keyframeRender');
    expect(message).toContain('kinemesh_render');
    expect(message).toContain('azimuth 45°');
  });

  it('无 digest / digest 为字符串 → 消息保持 M3 原样，不附加 digest 段', async () => {
    const { route, followups } = setup({ agents: { s1: {}, s2: {} } });
    // 静态态发送的线上形态（review Important #1）：clip:null + digest:null → 正文「无动画/静态」且无 digest 段
    await invoke(route, 'POST', '/kinemesh/analyze', { path: 'a.fbx', sessionId: 's1', clip: null, frame: null, digest: null });
    await invoke(route, 'POST', '/kinemesh/analyze', { path: 'b.fbx', sessionId: 's2', digest: 'junk' });
    expect(followups).toHaveLength(2);
    const first = textOf(followups[0]!);
    expect(first).not.toContain('【动作分析 digest】');
    expect(first).toContain('无动画/静态');
    expect(textOf(followups[1]!)).not.toContain('【动作分析 digest】');
  });
});
