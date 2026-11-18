// 「发送给 AI 分析」的纯逻辑：请求解析 + 唤醒消息组装。
// Host 路由（POST /kinemesh/analyze）与测试共用；真正投递在 host.ts 的 followup。
import { RENDER_FPS, type ViewState } from './core/viewstate.js';

export interface AnalyzeRequest {
  /** 模型文件路径（Agent 端可见的同一路径） */
  path: string;
  /** 目标会话 id（界面传原始 id） */
  sessionId: string;
  clip: string | null;
  frame: number | null;
  /** 预览面板回读的完整 ViewState（球坐标），不合法时忽略并按缺省视角描述 */
  view: ViewState | null;
  /** 用户输入框附言 */
  note: string | null;
}

export type ParsedAnalyze =
  | { ok: true; request: AnalyzeRequest }
  | { ok: false; message: string };

export function parseAnalyzeRequest(body: unknown): ParsedAnalyze {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: '请求体必须是 JSON 对象。' };
  }
  const raw = body as Record<string, unknown>;
  const path = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (path === '') return { ok: false, message: '缺少 path（模型文件路径）。' };
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
  if (sessionId === '') return { ok: false, message: '缺少 sessionId（当前会话 id）。' };
  const clip = typeof raw.clip === 'string' && raw.clip.trim() !== '' ? raw.clip.trim() : null;
  const frameRaw = raw.frame;
  const frame =
    typeof frameRaw === 'number' && Number.isFinite(frameRaw) && frameRaw >= 0 && Number.isInteger(frameRaw)
      ? frameRaw
      : clip === null
        ? null
        : 0;
  const view = isViewStateLike(raw.view) ? (raw.view as ViewState) : null;
  const note = typeof raw.note === 'string' && raw.note.trim() !== '' ? raw.note.trim() : null;
  return { ok: true, request: { path, sessionId, clip, frame, view, note } };
}

function isViewStateLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const camera = (value as { camera?: unknown }).camera;
  return typeof camera === 'object' && camera !== null;
}

/** 组装投递给 Agent 的用户态消息（followup）：视角描述 + 明确的工具调用指令 */
export function composeAnalyzeMessage(request: AnalyzeRequest): string {
  const view = request.view;
  const viewText =
    view === null
      ? '缺省视角（three-quarter：azimuth 45° / elevation 20°，距离按模型包围球自适应）'
      : `azimuth ${round(view.camera.azimuth)}°，elevation ${round(view.camera.elevation)}°，distance ${round(view.camera.distance)}，` +
        `target [${view.camera.target.map((axis) => round(axis)).join(', ')}]，fov ${round(view.camera.fov)}，渲染模式 ${view.mode}`;
  const clipText = request.clip === null ? '（无动画/静态）' : `「${request.clip}」`;
  const frameText = request.frame === null ? '0' : String(request.frame);
  const lines = [
    '【动析 kinemesh】用户在 3D 预览面板里请求对模型做视觉分析。',
    `模型文件：${request.path}`,
    `动画片段：${clipText}；帧号：${frameText}（换算 time = frame / ${RENDER_FPS}）`,
    `视角：${viewText}`,
  ];
  if (request.note !== null) {
    lines.push('用户附言：', '"""', request.note, '"""');
  }
  lines.push(
    '请调用 kinemesh_render 渲染上面这个视角的截图（clip/frames/view 按上面取值；view 直接传完整对象），' +
      '然后用读图工具查看 PNG，给出视觉分析（结构、动作质量、穿模/悬空、比例等，按用户附言侧重）。',
  );
  return lines.join('\n');
}

function round(value: number): number {
  return Number.isInteger(value) ? value : Number(value.toFixed(2));
}
