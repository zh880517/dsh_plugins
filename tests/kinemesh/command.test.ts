// `/kinemesh` 命令（0.6.0 交互重构）：替代原输入框「动析」按钮。
// 纯逻辑直测：扩展名判定、路径提取、消息组装、附件择优、附件内容落盘、runCommand 全分支
// （附件 / 仅路径 / 无模型 / Agent 离线 / 非模型附件忽略）。运行时注册在 host.ts 装配。
import { describe, expect, it } from 'vitest';
import {
  COMMAND_NAME,
  attachmentTempDir,
  composeCommandMessage,
  extractFilePaths,
  isModelFileName,
  looksLikeModelBytes,
  materializeAttachmentContent,
  runCommand,
  selectModelAttachments,
  splitRequest,
  type CommandDeps,
} from '../../plugins/kinemesh/src/command.js';

/** 合成 FBX 二进制头（只需能被 looksLikeModelBytes 认作模型） */
const FAKE_FBX = new Uint8Array(Buffer.from('Kaydara FBX Binary  \x00\x1a\x00' + 'x'.repeat(32), 'latin1'));

function fakeDeps(overrides: Partial<CommandDeps> = {}): CommandDeps & {
  delivered: Array<{ agentId: string; text: string }>;
  written: Array<{ fileName: string; bytes: number }>;
  recorded: Array<{ sessionId: string; absPath: string }>;
} {
  const delivered: Array<{ agentId: string; text: string }> = [];
  const written: Array<{ fileName: string; bytes: number }> = [];
  const recorded: Array<{ sessionId: string; absPath: string }> = [];
  return {
    delivered,
    written,
    recorded,
    readAttachment: async () => null,
    deliver: (agentId, text) => {
      delivered.push({ agentId, text });
      return true;
    },
    writeAttachment: async (fileName, data) => {
      written.push({ fileName, bytes: data.byteLength });
      return `/tmp/${fileName}`;
    },
    record: (sessionId, absPath) => recorded.push({ sessionId, absPath }),
    ...overrides,
  };
}

describe('/kinemesh 命令名与扩展名', () => {
  it('命令名是 kinemesh（DSH 命令名正则要求小写字母开头）', () => {
    expect(COMMAND_NAME).toBe('kinemesh');
    expect(/^[a-z][a-z0-9-]*$/.test(COMMAND_NAME)).toBe(true);
  });

  it('四个模型扩展名大小写不敏感；非模型拒绝', () => {
    for (const name of ['a.fbx', 'B.GLB', 'c.gltf', 'd.Obj']) expect(isModelFileName(name)).toBe(true);
    for (const name of ['a.max', 'b.blend', 'c.png', 'readme.txt']) expect(isModelFileName(name)).toBe(false);
  });
});

describe('输入解析：路径与要求分离', () => {
  it('提取 Windows / UNC / ~ / 引号包裹路径，非模型路径不计入待分析', () => {
    const text = '分析 E:\\art\\hero.fbx 和 "D:\\my art\\enemy.glb" 以及 C:\\doc\\readme.txt 的攻击强度';
    const paths = extractFilePaths(text);
    expect(paths).toContain('E:\\art\\hero.fbx');
    expect(paths).toContain('D:\\my art\\enemy.glb');
    expect(paths).toContain('C:\\doc\\readme.txt');
    const split = splitRequest(text);
    expect(split.paths).toEqual(['E:\\art\\hero.fbx', 'D:\\my art\\enemy.glb']);
    expect(split.request).not.toContain('hero.fbx');
    expect(split.request).toContain('攻击强度');
  });

  it('没有路径时 request 原文保留（含中文要求）', () => {
    const split = splitRequest('分析这段攻击是否循环');
    expect(split.paths).toEqual([]);
    expect(split.request).toBe('分析这段攻击是否循环');
  });
});

describe('注入消息组装', () => {
  it('列出全部路径 + 用户要求 + 工具使用指引 + 防幻觉约束', () => {
    const message = composeCommandMessage(['E:\\a.fbx', 'E:\\b.glb'], '看强度');
    expect(message).toContain('- E:\\a.fbx');
    expect(message).toContain('- E:\\b.glb');
    expect(message).toContain('用户要求：看强度');
    expect(message).toContain('kinemesh_analyze');
    expect(message).toContain('kinemesh_render');
    expect(message).toContain('数值一律引用工具产出');
  });

  it('无要求时给缺省任务描述', () => {
    expect(composeCommandMessage(['E:\\a.fbx'], '')).toContain('分析这些动画的动作内容、强度、运动方向与是否循环');
  });
});

describe('附件择优与内容落盘', () => {
  it('只挑模型附件，保持原顺序', () => {
    const picked = selectModelAttachments([{ name: 'a.fbx' }, { name: 'x.png' }, { name: 'b.glb' }]);
    expect(picked.map((item) => item.name)).toEqual(['a.fbx', 'b.glb']);
  });

  it('内容来源：Uint8Array / ArrayBuffer / dataUrl / 嵌套对象字段', () => {
    expect(materializeAttachmentContent('a.fbx', FAKE_FBX)?.fileName).toBe('a.fbx');
    const arrayBuffer = FAKE_FBX.buffer.slice(FAKE_FBX.byteOffset, FAKE_FBX.byteOffset + FAKE_FBX.byteLength);
    expect(materializeAttachmentContent('a.fbx', arrayBuffer)).not.toBeNull();
    const base64 = Buffer.from(FAKE_FBX).toString('base64');
    expect(materializeAttachmentContent('a.fbx', `data:application/octet-stream;base64,${base64}`)).not.toBeNull();
    expect(materializeAttachmentContent('a.fbx', { data: FAKE_FBX })).not.toBeNull();
  });

  it('拿不到模型字节时返回 null（提示改用手写路径）', () => {
    expect(materializeAttachmentContent('a.fbx', 'E:\\art\\hero.fbx')).toBeNull();
    expect(materializeAttachmentContent('a.fbx', { unrelated: 1 })).toBeNull();
    expect(materializeAttachmentContent('a.fbx', null)).toBeNull();
  });

  it('模型头嗅探：FBX 二进制 / GLB / glTF JSON / OBJ 文本', () => {
    expect(looksLikeModelBytes(FAKE_FBX)).toBe(true);
    expect(looksLikeModelBytes(new Uint8Array(Buffer.from('glTF' + 'x'.repeat(20))))).toBe(true);
    expect(looksLikeModelBytes(new Uint8Array(Buffer.from(JSON.stringify({ asset: { version: '2.0' } }) + ' '.repeat(20))))).toBe(true);
    expect(looksLikeModelBytes(new Uint8Array(Buffer.from('v 0 0 0\nvn 0 1 0\nf 1 2 3\n')))).toBe(true);
    expect(looksLikeModelBytes(new Uint8Array(Buffer.from('not a model at all, just text')))).toBe(false);
  });

  it('临时目录落在系统临时区（不污染用户目录）', () => {
    expect(attachmentTempDir()).toContain('kinemesh-command-attachments');
  });
});

describe('runCommand 全分支', () => {
  it('附件可解析：落盘 → 记录会话模型 → 注入 Agent（含路径与要求）', async () => {
    const deps = fakeDeps({ readAttachment: async () => FAKE_FBX });
    const outcome = await runCommand(
      { agentId: 'sess-1', rawInput: '分析攻击强度与是否循环', attachments: [{ attachmentId: 'a1', name: 'attack_00.fbx', bytes: 40 }] },
      deps,
    );
    expect(outcome.kind).toBe('success');
    expect(deps.written).toEqual([{ fileName: 'attack_00.fbx', bytes: FAKE_FBX.byteLength }]);
    expect(deps.recorded).toEqual([{ sessionId: 'sess-1', absPath: '/tmp/attack_00.fbx' }]);
    expect(deps.delivered).toHaveLength(1);
    expect(deps.delivered[0]!.text).toContain('/tmp/attack_00.fbx');
    expect(deps.delivered[0]!.text).toContain('分析攻击强度与是否循环');
  });

  it('命令里直接写路径（无附件）也能工作', async () => {
    const deps = fakeDeps();
    const outcome = await runCommand({ agentId: 'sess-1', rawInput: 'E:\\art\\hero.fbx 看强度', attachments: [] }, deps);
    expect(outcome.kind).toBe('success');
    expect(deps.delivered[0]!.text).toContain('hero.fbx');
  });

  it('附件读不出内容 + 无路径：error 且给用法提示', async () => {
    const deps = fakeDeps({ readAttachment: async () => null });
    const outcome = await runCommand(
      { agentId: 'sess-1', rawInput: '看看', attachments: [{ attachmentId: 'a1', name: 'attack_00.fbx', bytes: 40 }] },
      deps,
    );
    expect(outcome.kind).toBe('error');
    expect(outcome.text).toContain('没有可分析的模型文件');
    expect(outcome.text).toContain('/kinemesh');
    expect(outcome.text).toContain('attack_00.fbx');
    expect(deps.delivered).toHaveLength(0);
  });

  it('Agent 离线：解析成功但投递失败 → error（附路径，便于重试）', async () => {
    const deps = fakeDeps({ readAttachment: async () => FAKE_FBX, deliver: () => false });
    const outcome = await runCommand(
      { agentId: 'sess-1', rawInput: '分析', attachments: [{ attachmentId: 'a1', name: 'a.fbx', bytes: 40 }] },
      deps,
    );
    expect(outcome.kind).toBe('error');
    expect(outcome.text).toContain('Agent 不在线');
    expect(outcome.text).toContain('/tmp/a.fbx');
  });

  it('非模型附件被忽略并提示；不影响模型附件分析', async () => {
    const deps = fakeDeps({ readAttachment: async () => FAKE_FBX });
    const outcome = await runCommand(
      {
        agentId: 'sess-1',
        rawInput: '',
        attachments: [
          { attachmentId: 'a1', name: 'a.fbx', bytes: 40 },
          { attachmentId: 'a2', name: 'shot.png', bytes: 10 },
        ],
      },
      deps,
    );
    expect(outcome.kind).toBe('success');
    expect(outcome.text).toContain('已忽略非模型附件');
    expect(deps.written).toHaveLength(1);
    expect(deps.written[0]!.fileName).toBe('a.fbx');
  });

  it('写盘失败按「读不出」处理，不中断其余文件', async () => {
    const deps = fakeDeps({
      readAttachment: async () => FAKE_FBX,
      writeAttachment: async (fileName) => {
        if (fileName === 'bad.fbx') throw new Error('disk full');
        return `/tmp/${fileName}`;
      },
    });
    const outcome = await runCommand(
      {
        agentId: 'sess-1',
        rawInput: '',
        attachments: [
          { attachmentId: 'a1', name: 'bad.fbx', bytes: 40 },
          { attachmentId: 'a2', name: 'ok.fbx', bytes: 40 },
        ],
      },
      deps,
    );
    expect(outcome.kind).toBe('success');
    expect(outcome.text).toContain('bad.fbx');
    expect(deps.delivered[0]!.text).toContain('/tmp/ok.fbx');
  });
});
