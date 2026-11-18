// /kinemesh 路由：模型字节、info JSON、analyze 唤醒（followup）与 404/409。
// 用假 ctx / 假 req / 假 res 直接驱动 host.ts 的 handler（与 aiworkflow host-routes 同一套做法）。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildBinaryFbx, buildCubeObj } from '../support/kinemesh-fixtures.js';
import { apply } from '../../plugins/kinemesh/src/host.js';

const workDir = await mkdtemp(path.join(tmpdir(), 'kinemesh-routes-'));
const glbPath = path.join(workDir, 'cube-anim.fbx');
const objPath = path.join(workDir, 'cube.obj');

await writeFile(glbPath, Buffer.from(buildBinaryFbx()));
await writeFile(objPath, buildCubeObj(), 'utf8');

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
