// CLI 入口（M4）：`node kinemesh.cjs info <file>` / `render` / `analyze` / `skeleton`（M6d/M7）。
// 契约（设计文档 §5.2）：stdout 出 JSON、图片落盘、非零退出码 + stderr 报错（Agent 解析友好）。
// 构建成单文件 CJS（skill/cli/kinemesh.cjs，three.js 全内联；playwright 保持外部依赖）。
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { analyzeModelCached } from './core/analyze-file.js';
import { KinemeshError, reasonOf } from './core/errors.js';
import { renderScreenshots } from './core/render/screenshot.js';
import { runAnalyze, runSkeleton, type AnalyzeToolParams, type SkeletonToolParams } from './tools.js';
import type { ViewMode } from './core/viewstate.js';

/** 构建期注入的插件版本（0.9.4；源码直跑时为 undefined → 'dev'）。自定义环境需要版本号时用它。 */
declare const __KINEMESH_VERSION__: string | undefined;

/** CLI 版本：`--version` 输出（第三方 Agent 用来确认手上是哪一版） */
function cliVersion(): string {
  return typeof __KINEMESH_VERSION__ === 'string' && __KINEMESH_VERSION__ !== '' ? __KINEMESH_VERSION__ : 'dev';
}

const USAGE = `kinemesh — 3D 模型/动画资源的分析 CLI

用法：
  kinemesh info <file>
      输出模型结构信息 JSON（动画片段/骨骼/网格/贴图/包围盒/单位体检）。

  kinemesh analyze <file> [选项]
      对动画片段做动作分析，产出中间文件目录；stdout 返回 {ok,dir,files,summaryDigest}。
      --clip <name|*>          动画片段名（先 info 查）；"*" 批量分析全部 clips（返回 clips[]、按 <clip>/ 分桶）
      --range <t0,t1>          秒切片 [t0,t1]（帧号仍按全片口径，结果可直接喂 render）
      --detail <name>          summary / standard / full（缺省 standard；full=+全部关节曲线）
      --curves-for <joints>    指定关节加出 motion-curves/<joint>.csv（逗号分隔，如 L.Hand,R.Hand）
      --sample-fps <n>         采样率 1–60（缺省 15）
      --smooth <n>             能量平滑窗口（采样帧，缺省 5）
      --joints <joints>        关节 id/骨骼名清单（逗号分隔，如 L.Hand,R.Foot）；缺省 auto
      --loop-mode <name>       strict / pose-only（bestLoopRange 口径，缺省 strict）
      --normalize <name>       height / none（缺省 height，数值单位为身高倍数）
      --bone-map <file>        kinemesh-bones.json 映射文件路径（缺省按 资产同目录 > 工作区 发现；
                               joints=auto 时解析顺序：映射文件 > 字典查表 > Top-15 回退）
      --out <dir>              中间文件输出目录（缺省 <当前工作目录>/.kinemeshtmp/run-<时间戳>-<pid>/）
      --vocab <file>           kinemesh-vocab.json 词汇表路径（缺省按 资产同目录 > 工作区 > builtin 发现）

  kinemesh skeleton <file> [选项]
      骨架识别与映射：stdout 返回 {ok,dir,files,digest}（skeleton-report.json 落盘）。
      --shots <name>           标注截图批次 auto / none / all（缺省 auto：CORE15 有缺口才渲染）。
                               shots:auto/all 真实渲染骨骼名标注截图 labels-<view>-<两位批次>.png
                               （front/side × 每批，进同一输出目录与 digest.shots；需要 playwright）
      --bone-map <file>        kinemesh-bones.json 映射文件路径（缺省按 资产同目录 > 工作区 发现）
      --out <dir>              输出目录（缺省 <当前工作目录>/.kinemeshtmp/run-<时间戳>-<pid>/）

  kinemesh render <file> [选项]
      按视角 + 帧号渲染 PNG（写入输出目录，stdout 返回绝对路径数组）。
      --clip <name>            动画片段名（先 info 查）；静态模型省略
      --frames 0,15,30         帧号列表（逗号分隔，≤64 个）；或 --frame 30 单帧
      --view-preset <name>     front / side / back / three-quarter / orbit8（八方位连拍）
      --azimuth <deg> --elevation <deg> --distance <n> --target x,y,z --fov <deg>
                               自定义球坐标视角（与 --view-preset 二选一）
      --mode <name>            default / solid / wireframe / skeleton / bones-overlay
                               （省略 = 按模型自动选：无 mesh 骨架 / 贴图解不出来素模 / 有贴图 default；
                                 只给视角预设时逐帧按身体包围盒自动取景，带位移的动作不会跑出画面）
      --bone-labels <batch>    骨骼名文字标注（B.4，与 --mode skeleton|bones-overlay 联用）：
                               auto（缺省第 1 批）/ all（全部骨骼名，允许重叠，调试）/ 批次号（1 起，
                               stride 分批防叠；骨架识别单批读图用）
      --width <px> --height <px>
      --out-dir <dir>          PNG 输出目录（缺省 <当前工作目录>/.kinemeshtmp/run-<时间戳>-<pid>/）

  kinemesh --help
  kinemesh --version       打印 CLI 版本（第三方 Agent 用来确认手上是哪一版）

输出契约：成功 → stdout 一行 JSON（ok:true）；失败 → stderr 一行 JSON（ok:false 带
what/guidance/step 三段式）+ 非零退出码。截图需要 playwright：
  npm i playwright && npx playwright install chromium
`;

interface ParsedArgv {
  command: string;
  positional: string[];
  flags: Record<string, string>;
}

/** 各子命令的合法 flag（含互为别名的 --out / --out-dir）；未知选项三段式报错而非静默忽略 */
const KNOWN_FLAGS: Record<string, string[]> = {
  info: [],
  analyze: ['clip', 'out', 'out-dir', 'range', 'sample-fps', 'joints', 'detail', 'curves-for', 'smooth', 'loop-mode', 'normalize', 'vocab', 'bone-map'],
  skeleton: ['shots', 'bone-map', 'out', 'out-dir'],
  render: ['clip', 'frames', 'frame', 'view-preset', 'azimuth', 'elevation', 'distance', 'target', 'fov', 'mode', 'bone-labels', 'width', 'height', 'out-dir', 'out'],
};

/** --out / --out-dir 互为别名：analyze/skeleton 规范为 --out，render 规范为 --out-dir */
function normalizeFlagAliases(command: string, flags: Record<string, string>): void {
  if (command === 'analyze' || command === 'skeleton') {
    if (flags.out === undefined && flags['out-dir'] !== undefined) flags.out = flags['out-dir'];
  } else if (command === 'render') {
    if (flags['out-dir'] === undefined && flags.out !== undefined) flags['out-dir'] = flags.out;
  }
}

function parseArgv(argv: string[]): ParsedArgv {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let command = '';
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token.startsWith('--')) {
      const inline = token.slice(2);
      const eq = inline.indexOf('=');
      if (eq >= 0) {
        flags[inline.slice(0, eq)] = inline.slice(eq + 1);
        continue;
      }
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith('--')) {
        flags[inline] = value;
        index += 1;
      } else {
        flags[inline] = 'true';
      }
      continue;
    }
    if (command === '') command = token;
    else positional.push(token);
  }
  return { command, positional, flags };
}

function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(homedir(), input.slice(2));
  return input;
}

function fail(message: string, guidance: string, step: string): number {
  process.stderr.write(
    `${JSON.stringify({ ok: false, what: message, guidance, step: `当前这一步：${step}` })}\n`,
  );
  return 1;
}

async function readModel(fileArg: string | undefined): Promise<{ data: ArrayBuffer; abs: string } | null> {
  if (fileArg === undefined || fileArg.trim() === '') {
    fail('缺少模型文件路径。', 'kinemesh info <file> / render <file> …（file 支持 ~ 与相对路径）', '读取模型');
    return null;
  }
  const abs = path.resolve(expandHome(fileArg.trim()));
  try {
    const buffer = await readFile(abs);
    return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer, abs };
  } catch (error) {
    fail(reasonOf(error), '确认路径存在且可读；相对路径按当前工作目录解析。', `读取 ${abs}`);
    return null;
  }
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function runInfo(fileArg: string | undefined): Promise<number> {
  const loaded = await readModel(fileArg);
  if (loaded === null) return 1;
  try {
    // M6f：info 的场景构造路径（FBX/OBJ 无 fastInfo）走 path+mtime 进程内缓存
    const report = await analyzeModelCached(loaded.abs, loaded.data, path.basename(loaded.abs));
    emit({ ok: true, ...report });
    return 0;
  } catch (error) {
    if (error instanceof KinemeshError) return fail(error.message, error.guidance, `分析 ${loaded.abs}`);
    return fail(reasonOf(error), '确认文件是完整的模型文件后重试。', `分析 ${loaded.abs}`);
  }
}

function numberFlag(flags: Record<string, string>, name: string): number | undefined {
  const raw = flags[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function buildView(flags: Record<string, string>): unknown | undefined {
  const hasCustom =
    flags.azimuth !== undefined ||
    flags.elevation !== undefined ||
    flags.distance !== undefined ||
    flags.target !== undefined ||
    flags.fov !== undefined;
  if (!hasCustom) return undefined;
  const targetRaw = flags.target ?? '0,0,0';
  const target = targetRaw.split(',').map((axis) => Number(axis.trim()));
  return {
    camera: {
      azimuth: numberFlag(flags, 'azimuth') ?? 0,
      elevation: numberFlag(flags, 'elevation') ?? 0,
      distance: numberFlag(flags, 'distance'),
      target,
      fov: numberFlag(flags, 'fov'),
    },
  };
}

/** --bone-labels 解析（B.4）：undefined = 未给；null = 非法值（已输出三段式 stderr） */
function boneLabelsFlag(flags: Record<string, string>): number | 'auto' | 'all' | null | undefined {
  const raw = flags['bone-labels'];
  if (raw === undefined || raw === '' || raw === 'true') return undefined;
  if (raw === 'auto' || raw === 'all') return raw;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    fail(
      `--bone-labels 的值「${raw}」不合法。`,
      '取 auto（第 1 批）/ all（全部骨骼名，调试）/ 批次号（≥1 整数），例如 --bone-labels 2；与 --mode skeleton 或 bones-overlay 联用。',
      '解析渲染参数',
    );
    return null;
  }
  return value;
}

async function runRender(fileArg: string | undefined, flags: Record<string, string>): Promise<number> {
  const framesRaw = flags.frames ?? flags.frame;
  if (framesRaw === undefined || framesRaw === 'true') {
    return fail('缺少 --frames。', '给帧号列表，例如 --frames 0,15,30；静态模型 --frames 0。', '解析渲染参数');
  }
  const frames = framesRaw
    .split(',')
    .map((token) => Number(token.trim()))
    .filter((value) => Number.isInteger(value) && value >= 0);
  if (frames.length === 0) {
    return fail('frames 里没有合法帧号。', '帧号是非负整数，逗号分隔：--frames 0,15,30。', '解析渲染参数');
  }
  const boneLabels = boneLabelsFlag(flags);
  if (boneLabels === null) return 1;
  const loaded = await readModel(fileArg);
  if (loaded === null) return 1;
  const view = buildView(flags);
  const viewInput = {
    view,
    viewPreset: view === undefined ? flags['view-preset'] : undefined,
    mode: flags.mode as ViewMode | undefined,
    clip: flags.clip,
  };
  try {
    const result = await renderScreenshots({
      data: loaded.data,
      fileName: path.basename(loaded.abs),
      viewInput,
      frames,
      width: numberFlag(flags, 'width'),
      height: numberFlag(flags, 'height'),
      outDir: flags['out-dir'] === undefined ? undefined : expandHome(flags['out-dir']),
      boneLabels,
    });
    emit({ ok: true, images: result.images, count: result.images.length, warnings: result.warnings, hint: '用读图工具逐张查看后再给结论。' });
    return 0;
  } catch (error) {
    if (error instanceof KinemeshError) return fail(error.message, error.guidance, `渲染 ${loaded.abs}`);
    return fail(reasonOf(error), '减少帧数/降低分辨率后重试；确认模型能被 info 解析。', `渲染 ${loaded.abs}`);
  }
}

/** 枚举 flag 校验：undefined = 未给；null = 非法值（已输出三段式 stderr，调用方直接返回 1） */
function enumFlag(flags: Record<string, string>, name: string, allowed: string[], guidance: string): string | null | undefined {
  const raw = flags[name];
  if (raw === undefined || raw === '') return undefined;
  if (!allowed.includes(raw)) {
    fail(`--${name} 的值「${raw}」不合法。`, guidance, '解析 analyze 参数');
    return null;
  }
  return raw;
}

/** --range t0,t1 解析（M6f）：undefined = 未给；null = 不合法（已输出三段式 stderr） */
function rangeFlag(flags: Record<string, string>, name: string): [number, number] | null | undefined {
  const raw = flags[name];
  if (raw === undefined || raw === '') return undefined;
  const parts = raw.split(',').map((token) => Number(token.trim()));
  const t0 = parts[0]!;
  const t1 = parts[1]!;
  if (parts.length !== 2 || !Number.isFinite(t0) || !Number.isFinite(t1) || t0 >= t1) {
    fail(`--${name} 的值「${raw}」不合法。`, '--range 是 [t0,t1] 秒，逗号分隔且 t0 < t1（t1 ≤ 片段时长，先 info 查）；例如 --range 0.5,2。', '解析 analyze 参数');
    return null;
  }
  return [t0, t1];
}

async function runAnalyzeCli(fileArg: string | undefined, flags: Record<string, string>): Promise<number> {
  const detail = enumFlag(flags, 'detail', ['summary', 'standard', 'full'], '--detail 取 summary / standard / full（缺省 standard）。');
  if (detail === null) return 1;
  const loopMode = enumFlag(flags, 'loop-mode', ['strict', 'pose-only'], '--loop-mode 取 strict / pose-only（缺省 strict）。');
  if (loopMode === null) return 1;
  const normalize = enumFlag(flags, 'normalize', ['height', 'none'], '--normalize 取 height / none（缺省 height）。');
  if (normalize === null) return 1;
  const range = rangeFlag(flags, 'range');
  if (range === null) return 1;
  const curvesFor = flags['curves-for'] === undefined
    ? undefined
    : flags['curves-for'].split(',').map((token) => token.trim()).filter((token) => token !== '');
  const joints = flags.joints === undefined
    ? undefined
    : flags.joints.split(',').map((token) => token.trim()).filter((token) => token !== '');
  const loaded = await readModel(fileArg);
  if (loaded === null) return 1;
  const params: AnalyzeToolParams = {
    clip: flags.clip,
    range,
    sampleFps: numberFlag(flags, 'sample-fps'),
    detail: detail as AnalyzeToolParams['detail'],
    curvesFor: curvesFor === undefined || curvesFor.length === 0 ? undefined : curvesFor,
    joints: joints === undefined || joints.length === 0 ? undefined : joints,
    loopMode: loopMode as AnalyzeToolParams['loopMode'],
    normalize: normalize as AnalyzeToolParams['normalize'],
    smooth: numberFlag(flags, 'smooth'),
    out: flags.out,
    vocab: flags.vocab === undefined ? undefined : expandHome(flags.vocab),
    boneMap: flags['bone-map'] === undefined ? undefined : expandHome(flags['bone-map']),
  };
  try {
    const result = await runAnalyze(loaded.data, path.basename(loaded.abs), params, {
      assetDir: path.dirname(loaded.abs),
      absPath: loaded.abs,
    });
    emit(result);
    return 0;
  } catch (error) {
    if (error instanceof KinemeshError) return fail(error.message, error.guidance, `分析 ${loaded.abs}`);
    return fail(reasonOf(error), '确认模型能被 info 解析后重试；必要时缩小参数范围（降低 --sample-fps / 换 --clip）。', `分析 ${loaded.abs}`);
  }
}

async function runSkeletonCli(fileArg: string | undefined, flags: Record<string, string>): Promise<number> {
  const shots = enumFlag(flags, 'shots', ['auto', 'none', 'all'], '--shots 取 auto / none / all（缺省 auto）。');
  if (shots === null) return 1;
  const loaded = await readModel(fileArg);
  if (loaded === null) return 1;
  const params: SkeletonToolParams = {
    shots: shots as SkeletonToolParams['shots'],
    boneMap: flags['bone-map'] === undefined ? undefined : expandHome(flags['bone-map']),
    out: flags.out,
  };
  try {
    const result = await runSkeleton(loaded.data, path.basename(loaded.abs), params, {
      assetDir: path.dirname(loaded.abs),
      absPath: loaded.abs,
    });
    emit(result);
    return 0;
  } catch (error) {
    if (error instanceof KinemeshError) return fail(error.message, error.guidance, `识别 ${loaded.abs} 的骨架`);
    return fail(reasonOf(error), '确认模型能被 info 解析后重试。', `识别 ${loaded.abs} 的骨架`);
  }
}

export async function main(argv: string[]): Promise<number> {
  const { command, positional, flags } = parseArgv(argv);
  const wantsHelp = flags.help !== undefined || command === '--help' || command === '-h';
  if (wantsHelp) {
    process.stdout.write(USAGE);
    return 0;
  }
  // 0.9.4：--version 让第三方 Agent 能确认手上是哪一版（构建期注入 __KINEMESH_VERSION__）
  if (flags.version !== undefined || command === '--version' || command === '-v') {
    process.stdout.write(`kinemesh ${cliVersion()}\n`);
    return 0;
  }
  if (command === '') {
    process.stderr.write(USAGE);
    return 2;
  }
  if (command === 'info' || command === 'analyze' || command === 'skeleton' || command === 'render') {
    const known = KNOWN_FLAGS[command]!;
    const unknown = Object.keys(flags).filter((key) => !known.includes(key));
    if (unknown.length > 0) {
      return fail(
        `未认识的选项：${unknown.map((key) => `--${key}`).join('、')}（${command} 子命令）。`,
        '用 kinemesh --help 查看该子命令的全部选项；注意输出目录参数 analyze/skeleton 是 --out、render 是 --out-dir（已互为别名，两个名字都接受）。',
        '解析命令行参数',
      );
    }
    normalizeFlagAliases(command, flags);
  }
  if (command === 'info') return runInfo(positional[0]);
  if (command === 'analyze') return runAnalyzeCli(positional[0], flags);
  if (command === 'skeleton') return runSkeletonCli(positional[0], flags);
  if (command === 'render') return runRender(positional[0], flags);
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      what: `未知命令「${command}」。`,
      guidance: '可用命令：info <file> / analyze <file> [选项] / skeleton <file> [选项] / render <file> [选项]；--help 看全部。',
      step: '解析命令行',
    })}\n`,
  );
  return 2;
}

// 直接执行时才跑（测试 / MCP 里 import main 不触发）；ESM 源码态没有 __filename，落在 catch
const invokedDirectly = (() => {
  try {
    const self = path.resolve(__filename);
    const invoked = path.resolve(process.argv[1] ?? '');
    return invoked !== '' && invoked === self;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ ok: false, what: reasonOf(error), guidance: '未知错误，重试或缩小参数范围。', step: 'CLI 执行' })}\n`);
      process.exit(1);
    });
}
