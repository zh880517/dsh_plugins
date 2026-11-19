// MCP Server 集成测试（M5）：真实子进程 + stdio JSON-RPC（newline 分帧）。
// 产物没构建时整组跳过（npm run build 后可用）。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildBinaryFbx, buildStaticCubeGltf, encodeGlb } from '../support/kinemesh-fixtures.js';

const mcpFile = path.resolve(import.meta.dirname, '..', '..', 'plugins', 'kinemesh', 'mcp', 'kinemesh-mcp.js');

const workDir = await mkdtemp(path.join(tmpdir(), 'kinemesh-mcp-'));
const fbxPath = path.join(workDir, 'cube-anim.fbx');
await writeFile(fbxPath, Buffer.from(buildBinaryFbx()));

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

interface Rpc {
  send(message: Record<string, unknown>): void;
  waitFor(id: number, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

function startServer(): Rpc {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [mcpFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') {
        try {
          const message = JSON.parse(line) as { id?: number };
          if (typeof message.id === 'number') {
            const resolve = pending.get(message.id);
            if (resolve !== undefined) {
              pending.delete(message.id);
              resolve(message);
            }
          }
        } catch {
          // 忽略非 JSON 行
        }
      }
      newline = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', () => undefined); // SDK 的启动日志，不参与断言
  return {
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    waitFor(id, timeoutMs = 60_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`等待 rpc ${id} 超时`));
        }, timeoutMs);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    close() {
      child.kill();
    },
  };
}

async function rpcCall(rpc: Rpc, id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  rpc.send({ jsonrpc: '2.0', id, method, params });
  return rpc.waitFor(id);
}

describe.skipIf(!existsSync(mcpFile))('kinemesh MCP Server（构建产物）', () => {
  it('initialize → tools/list → tools/call(kinemesh_info) 全链路', async () => {
    const rpc = startServer();
    try {
      const init = await rpcCall(rpc, 1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'kinemesh-test', version: '0' },
      });
      const serverInfo = (init.result as { serverInfo?: { name: string } }).serverInfo;
      expect(serverInfo?.name).toBe('kinemesh');
      rpc.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      const list = await rpcCall(rpc, 2, 'tools/list', {});
      const names = ((list.result as { tools: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name);
      expect(names).toContain('kinemesh_info');
      expect(names).toContain('kinemesh_analyze');
      expect(names).toContain('kinemesh_render');

      const call = await rpcCall(rpc, 3, 'tools/call', {
        name: 'kinemesh_info',
        arguments: { path: fbxPath },
      });
      const text = ((call.result as { content: Array<{ text: string }> }).content[0]?.text) ?? '';
      const parsed = JSON.parse(text) as { ok: boolean; format: string; clips: Array<{ name: string }> };
      expect(parsed.ok).toBe(true);
      expect(parsed.format).toBe('fbx-binary');
      expect(parsed.clips[0]?.name).toBe('Take 001');
    } finally {
      rpc.close();
    }
  }, 120_000);

  it('tools/call kinemesh_analyze：out 落盘 + summaryDigest 返回', async () => {
    const rpc = startServer();
    try {
      await rpcCall(rpc, 1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'kinemesh-test', version: '0' },
      });
      rpc.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const outDir = path.join(workDir, 'analysis-mcp');
      const call = await rpcCall(rpc, 5, 'tools/call', {
        name: 'kinemesh_analyze',
        arguments: { path: fbxPath, out: outDir, curvesFor: ['cube'] },
      });
      expect((call.result as { isError?: boolean }).isError).toBeUndefined();
      const text = ((call.result as { content: Array<{ text: string }> }).content[0]?.text) ?? '';
      const parsed = JSON.parse(text) as {
        ok: boolean;
        dir: string;
        files: Array<{ name: string }>;
        summaryDigest: { facts: string[] };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.dir).toBe(outDir);
      expect(parsed.files.some((file) => file.name === 'motion-curves/cube.csv')).toBe(true);
      expect(parsed.summaryDigest.facts.length).toBeGreaterThan(0);
    } finally {
      rpc.close();
    }
  }, 120_000);

  it('tools/call kinemesh_analyze 无动画资产走三段式错误文本（isError 标记）', async () => {
    const rpc = startServer();
    try {
      await rpcCall(rpc, 1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'kinemesh-test', version: '0' },
      });
      rpc.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const staticGlb = path.join(workDir, 'cube-static.glb');
      await writeFile(staticGlb, Buffer.from(encodeGlb(buildStaticCubeGltf())));
      const call = await rpcCall(rpc, 6, 'tools/call', {
        name: 'kinemesh_analyze',
        arguments: { path: staticGlb },
      });
      expect((call.result as { isError?: boolean }).isError).toBe(true);
      const text = ((call.result as { content: Array<{ text: string }> }).content[0]?.text) ?? '';
      const parsed = JSON.parse(text) as { ok: boolean; what: string; guidance: string; step: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.what).toContain('没有动画片段');
      expect(parsed.step).toContain('当前这一步');
    } finally {
      rpc.close();
    }
  }, 120_000);

  it('tools/call 缺参数走三段式错误文本（isError 标记）', async () => {
    const rpc = startServer();
    try {
      await rpcCall(rpc, 1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'kinemesh-test', version: '0' },
      });
      rpc.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const call = await rpcCall(rpc, 4, 'tools/call', {
        name: 'kinemesh_render',
        arguments: { path: fbxPath },
      });
      expect((call.result as { isError?: boolean }).isError).toBe(true);
      const text = ((call.result as { content: Array<{ text: string }> }).content[0]?.text) ?? '';
      const parsed = JSON.parse(text) as { ok: boolean; guidance: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.guidance).toContain('frames');
    } finally {
      rpc.close();
    }
  }, 120_000);
});
