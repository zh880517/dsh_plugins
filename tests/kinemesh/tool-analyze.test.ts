// kinemesh_analyze 工具层（M6d）：三出口的 DSH 出口。接线（落盘/返回结构/hint 规则）、
// 三段式自愈（无动画 / clip 缺失 / morph-only / 词表非法）、vocab 词表接线与 detail/curvesFor 投影。
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildAnimatedCubeGltf,
  buildMorphOnlyGltf,
  buildStaticCubeGltf,
  encodeGlb,
} from '../support/kinemesh-fixtures.js';
import { registerTools } from '../../plugins/kinemesh/src/tools.js';

interface RegisteredTool {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function analyzeExecute(): RegisteredTool['execute'] {
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
  const tool = registered.get('kinemesh_analyze');
  if (tool === undefined) throw new Error('kinemesh_analyze 没有注册');
  return tool.execute;
}

const workDir = await mkdtemp(path.join(tmpdir(), 'kinemesh-analyze-'));

async function writeFixture(name: string, json: Record<string, unknown>): Promise<string> {
  const file = path.join(workDir, name);
  await writeFile(file, Buffer.from(encodeGlb(json)));
  return file;
}

const animGlb = await writeFixture('cube-anim.glb', buildAnimatedCubeGltf());
const staticGlb = await writeFixture('cube-static.glb', buildStaticCubeGltf());
const morphGlb = await writeFixture('face-morph.glb', buildMorphOnlyGltf());

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('会话模型表接线（§6.10.1：Agent 工具直调也进表）', () => {
  it('execute 成功后用 exec.agent.id 记录会话与路径；无 exec / 失败不记录', async () => {
    const registered = new Map<string, RegisteredTool>();
    const recorded: Array<{ sessionId: string; absPath: string }> = [];
    const ctx = {
      tools: {
        register(definition: RegisteredTool): () => void {
          registered.set(definition.name, definition);
          return () => undefined;
        },
      },
    };
    registerTools(ctx, (sessionId, absPath) => recorded.push({ sessionId, absPath }));
    const info = registered.get('kinemesh_info')!;
    const run = info.execute as (args: Record<string, unknown>, exec?: unknown) => Promise<Record<string, unknown>>;

    const ok = await run({ path: animGlb }, { agent: { id: 'sess-1' } });
    expect(ok.ok).toBe(true);
    expect(recorded).toEqual([{ sessionId: 'sess-1', absPath: path.resolve(animGlb) }]);

    // 无 exec（CLI / MCP 进程口径没有会话概念）：不记录
    await run({ path: animGlb });
    expect(recorded).toHaveLength(1);

    // 执行失败（文件不存在）：不记录
    const bad = await run({ path: path.join(workDir, 'nope.glb') }, { agent: { id: 'sess-2' } });
    expect(bad.ok).toBe(false);
    expect(recorded).toHaveLength(1);
  });
});

describe('kinemesh_analyze 工具', () => {
  it('注册名是 kinemesh_analyze，schema 必填只有 path', async () => {
    const registered = new Map<string, { name: string; parameters: Record<string, unknown> }>();
    const ctx = {
      tools: {
        register(definition: { name: string; parameters: Record<string, unknown> }): () => void {
          registered.set(definition.name, definition);
          return () => undefined;
        },
      },
    };
    registerTools(ctx);
    const tool = registered.get('kinemesh_analyze');
    expect(tool?.name).toBe('kinemesh_analyze');
    expect(tool?.parameters.required).toEqual(['path']);
    expect(Object.keys(tool?.parameters.properties ?? {})).toEqual([
      'path', 'clip', 'out', 'range', 'sampleFps', 'joints', 'detail', 'curvesFor', 'smooth', 'loopMode', 'normalize', 'vocab', 'boneMap',
    ]);
  });

  it('指定 out：落盘中间文件 + 返回 summaryDigest + files 元数据，无 hint', async () => {
    const execute = analyzeExecute();
    const outDir = path.join(workDir, 'analysis-out');
    const result = await execute({ path: animGlb, out: outDir });
    expect(result.ok).toBe(true);
    expect(result.dir).toBe(outDir);
    expect(result.hint).toBeUndefined();
    const names = (result.files as Array<{ name: string }>).map((file) => file.name);
    expect(names).toEqual([
      'motion-summary.json',
      'motion-frames.csv',
      'motion-segments.json',
      'motion-keyframes.json',
      'motion-trajectory.json',
      'motion-trajectory.svg',
    ]);
    for (const file of result.files as Array<{ name: string; bytes: number }>) {
      const bytes = (await readFile(path.join(outDir, file.name))).byteLength;
      expect(bytes).toBe(file.bytes);
    }
    const digest = result.summaryDigest as { segments: unknown[]; facts: string[]; keyframeRender: { frames: number[]; views: string[] } };
    expect(Array.isArray(digest.segments)).toBe(true);
    expect(digest.facts.length).toBeGreaterThan(0);
    expect(digest.keyframeRender.mode).toBe('skeleton');
    expect(existsSync(path.join(outDir, 'motion-summary.json'))).toBe(true);
  });

  it('缺省 out：目录落在 <cwd>/.kinemeshtmp/run-* 并带自愈 hint（0.9.2）', async () => {
    const execute = analyzeExecute();
    const result = await execute({ path: animGlb });
    expect(result.ok).toBe(true);
    const dir = String(result.dir);
    expect(dir).toContain('.kinemeshtmp');
    expect(path.basename(dir)).toMatch(/^run-\d+-\d+$/);
    expect(dir.startsWith(tmpdir())).toBe(false);
    expect(result.hint).toBe('输出在当前工作目录的 .kinemeshtmp/ 下；若读文件被沙箱拦截，用 out 参数重跑指向工作区');
  });

  it('detail=summary 只落 summary.json；curvesFor 按骨骼名加曲线文件', async () => {
    const execute = analyzeExecute();
    const outDir = path.join(workDir, 'analysis-min');
    const result = await execute({ path: animGlb, out: outDir, detail: 'summary', curvesFor: ['bone_b'] });
    expect(result.ok).toBe(true);
    const names = (result.files as Array<{ name: string }>).map((file) => file.name);
    expect(names).toEqual(['motion-summary.json', 'motion-curves/bone_b.csv']);
    const csv = await readFile(path.join(outDir, 'motion-curves', 'bone_b.csv'), 'utf8');
    expect(csv.split('\n')[0]).toBe('frame,time,pos_x,pos_y,pos_z,speed,vx,vy,vz');
  });

  it('vocab 词表接线：命中词条覆盖 guess，summary.vocab 回显来源与条目数', async () => {
    const execute = analyzeExecute();
    const vocabPath = path.join(workDir, 'kinemesh-vocab.json');
    await writeFile(vocabPath, JSON.stringify({ entries: [{ term: 'custom-term', when: {} }] }), 'utf8');
    const outDir = path.join(workDir, 'analysis-vocab');
    const result = await execute({ path: animGlb, out: outDir, vocab: vocabPath });
    expect(result.ok).toBe(true);
    const digest = result.summaryDigest as { segments: Array<{ guess: string }>; facts: string[] };
    expect(digest.segments[0]?.guess).toBe('custom-term');
    const summary = JSON.parse(await readFile(path.join(outDir, 'motion-summary.json'), 'utf8')) as {
      vocab: { source: string; entries: number };
    };
    expect(summary.vocab.source).toBe(vocabPath);
    expect(summary.vocab.entries).toBe(1);
  });

  it('无动画资产：三段式自愈（data 层拒绝）', async () => {
    const execute = analyzeExecute();
    const result = await execute({ path: staticGlb });
    expect(result.ok).toBe(false);
    expect(String(result.what)).toContain('没有动画片段');
    expect(String(result.guidance)).toContain('kinemesh_info');
    expect(String(result.step)).toContain('当前这一步');
  });

  it('clip 缺失：三段式并列出可用片段', async () => {
    const execute = analyzeExecute();
    const result = await execute({ path: animGlb, clip: 'NoSuchClip' });
    expect(result.ok).toBe(false);
    expect(String(result.what)).toContain('NoSuchClip');
    expect(String(result.guidance)).toContain('Walk');
    expect(String(result.step)).toContain('当前这一步');
  });

  it('morph-only 动画：透传 core 拒绝（形态动画 → 建议 render）', async () => {
    const execute = analyzeExecute();
    const result = await execute({ path: morphGlb });
    expect(result.ok).toBe(false);
    expect(String(result.what)).toContain('形态动画');
    expect(String(result.guidance)).toContain('kinemesh_render');
    expect(String(result.step)).toContain('当前这一步');
  });

  it('词表 JSON 非法：三段式报错指向文件', async () => {
    const execute = analyzeExecute();
    const vocabPath = path.join(workDir, 'broken-vocab.json');
    await writeFile(vocabPath, '{ entries: [oopsy]', 'utf8');
    const result = await execute({ path: animGlb, vocab: vocabPath });
    expect(result.ok).toBe(false);
    expect(String(result.what)).toContain('词表');
    expect(String(result.what)).toContain(vocabPath);
    expect(String(result.guidance)).toContain('JSON');
    expect(String(result.step)).toContain('当前这一步');
  });

  it('词表 when 引用未知字段：三段式列出允许字段', async () => {
    const execute = analyzeExecute();
    const vocabPath = path.join(workDir, 'unknown-key-vocab.json');
    await writeFile(vocabPath, JSON.stringify({ entries: [{ term: 'x', when: { energyMin: 1 } }] }), 'utf8');
    const result = await execute({ path: animGlb, vocab: vocabPath });
    expect(result.ok).toBe(false);
    expect(String(result.what)).toContain('energyMin');
    expect(String(result.guidance)).toContain('rootSpeedMin');
  });

  it('sampleFps 越界：透传 core 三段式', async () => {
    const execute = analyzeExecute();
    const result = await execute({ path: animGlb, sampleFps: 99 });
    expect(result.ok).toBe(false);
    expect(String(result.what)).toContain('sampleFps');
    expect(String(result.guidance)).toContain('1–60');
  });
});
