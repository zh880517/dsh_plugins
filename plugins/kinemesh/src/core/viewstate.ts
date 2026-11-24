// ViewState 规范（设计文档 §4.2）：三出口通用的「画面坐标」。
// 球坐标（方位角/仰角/距离/注视点/fov）而非 position 数组——紧凑、AI 读写不易错、无 up-axis 歧义。
// 本模块是纯逻辑（无 three.js / DOM），校验与换算三处共用；三维换算的向量版在 viewer 里做。
import { KinemeshError } from './errors.js';

export type ViewMode = 'default' | 'solid' | 'wireframe' | 'skeleton' | 'bones-overlay';
export type ViewPreset = 'front' | 'side' | 'back' | 'three-quarter' | 'orbit8';

/**
 * 表面显示方式（0.7.2）：预览面板把它做成「互斥选择」，与「骨架叠加开关」解耦。
 * · default = 贴图 / solid = 素模 / wireframe = 线框 / none = 不画网格（纯骨架模式）
 * 对外契约仍是 `ViewMode`（AI 截图 / CLI / MCP 不感知这条解耦）。
 */
export type SurfaceMode = 'default' | 'solid' | 'wireframe' | 'none';

/** 表面互斥选项（客户端下拉用）：不含 `none`——「只画骨架」由叠加开关 + 无网格模型自然覆盖 */
export const SURFACE_MODES: Exclude<SurfaceMode, 'none'>[] = ['solid', 'default', 'wireframe'];

/** 旧 `ViewMode` → 表面方式（skeleton 不画网格，其余同名前四项） */
export function surfaceOfMode(mode: ViewMode): SurfaceMode {
  if (mode === 'skeleton') return 'none';
  if (mode === 'bones-overlay') return 'default';
  return mode;
}

/** 旧 `ViewMode` → 骨架线是否显示（skeleton / bones-overlay 两种模式才显示） */
export function bonesOfMode(mode: ViewMode): boolean {
  return mode === 'skeleton' || mode === 'bones-overlay';
}

/** 表面 + 骨架 → 旧 `ViewMode`（回写记忆 / 发给 AI 时保持单一模式口径；无 mesh 一律 skeleton） */
export function composeViewMode(surface: SurfaceMode, bones: boolean, hasMesh: boolean): ViewMode {
  if (!hasMesh) return 'skeleton';
  if (surface === 'none') return 'skeleton';
  if (!bones) return surface;
  return surface === 'default' ? 'bones-overlay' : surface;
}

export interface ViewStateCamera {
  /** 方位角（度，绕 Y 轴；0 = 从 +Z 看，即正面） */
  azimuth: number;
  /** 仰角（度，向上为正） */
  elevation: number;
  /** 与 target 的距离（模型单位） */
  distance: number;
  /** 注视点 */
  target: [number, number, number];
  /** 垂直视场角（度） */
  fov: number;
}

export interface ViewState {
  camera: ViewStateCamera;
  /** 动画片段名；null = 静态/第 0 帧 */
  clip: string | null;
  /** 帧号；换算 time = frame / RENDER_FPS（源 fps 拿不到时统一按 30fps 约定，见 design.md） */
  frame: number | null;
  mode: ViewMode;
}

/** 帧号 → 秒的换算约定：JS 解析层拿不到源 fps，统一按 30fps（可按 clip 覆盖，见 viewer） */
export const RENDER_FPS = 30;

export interface ViewPresetDefinition {
  azimuth: number;
  elevation: number;
}

export const VIEW_PRESETS: Record<Exclude<ViewPreset, 'orbit8'>, ViewPresetDefinition> = {
  front: { azimuth: 0, elevation: 0 },
  side: { azimuth: 90, elevation: 0 },
  back: { azimuth: 180, elevation: 0 },
  'three-quarter': { azimuth: 45, elevation: 20 },
};

/** orbit8 = 八方位连拍：每 45° 一个方位 */
export const ORBIT8_AZIMUTHS = [0, 45, 90, 135, 180, 225, 270, 315] as const;

export interface SceneFrame {
  /** 包围盒中心（模型单位）——target 的缺省值 */
  center: [number, number, number];
  /** 包围球半径——distance 的缺省值 = radius × DEFAULT_DISTANCE_FACTOR */
  radius: number;
  /** 场景里的动画片段名（用于校验 clip 参数） */
  clips: string[];
}

export const DEFAULT_DISTANCE_FACTOR = 2.2;
export const DEFAULT_FOV = 40;

export interface NormalizedViewInput {
  view?: unknown;
  viewPreset?: unknown;
  mode?: unknown;
  clip?: unknown;
  frame?: unknown;
}

export interface ViewResolution {
  view: ViewState;
  /** orbit8 展开出的额外方位角（逐帧 × 逐方位出图）；普通视图为 null */
  orbit8: boolean;
  warnings: string[];
}

/**
 * 把工具/CLI 入参（view 或 viewPreset 二选一 + mode/clip/frame）解析成规范 ViewState。
 * 场景信息（bounds/clips）由调用方提供，用于缺省 target/distance 与 clip 校验。
 * 参数不合法时抛 KinemeshError（自愈文案）。
 */
export function resolveView(input: NormalizedViewInput, scene: SceneFrame): ViewResolution {
  const warnings: string[] = [];
  const mode = parseMode(input.mode);
  const clip = parseClip(input.clip, scene.clips);
  const frame = parseFrame(input.frame, clip);

  let azimuth: number | null = null;
  let elevation: number | null = null;
  let orbit8 = false;

  const hasView = input.view !== undefined && input.view !== null;
  const hasPreset = input.viewPreset !== undefined && input.viewPreset !== null;
  if (hasView && hasPreset) {
    throw new KinemeshError('view 与 viewPreset 同时给出了，二选一。', '要么给完整 view 对象（azimuth/elevation/distance/target/fov），要么只给 viewPreset 名称。');
  }
  if (hasView) {
    const camera = parseViewCamera(input.view, scene);
    azimuth = camera.azimuth;
    elevation = camera.elevation;
    const view: ViewState = {
      camera: { ...camera, target: camera.target, fov: camera.fov },
      clip,
      frame,
      mode,
    };
    return { view: withDefaults(view, scene), orbit8: false, warnings };
  }
  if (hasPreset) {
    const preset = String(input.viewPreset);
    if (preset === 'orbit8') {
      orbit8 = true;
      elevation = 20;
    } else {
      const definition = VIEW_PRESETS[preset as Exclude<ViewPreset, 'orbit8'>];
      if (definition === undefined) {
        throw new KinemeshError(
          `未知 viewPreset「${preset}」。`,
          `可选值：${Object.keys(VIEW_PRESETS).join(' / ')} / orbit8（八方位连拍）。`,
        );
      }
      azimuth = definition.azimuth;
      elevation = definition.elevation;
    }
  }
  const view: ViewState = {
    camera: {
      azimuth: azimuth ?? VIEW_PRESETS['three-quarter'].azimuth,
      elevation: elevation ?? VIEW_PRESETS['three-quarter'].elevation,
      distance: scene.radius * DEFAULT_DISTANCE_FACTOR,
      target: [...scene.center] as [number, number, number],
      fov: DEFAULT_FOV,
    },
    clip,
    frame,
    mode,
  };
  if (input.viewPreset === undefined && input.view === undefined) {
    warnings.push('未指定视角，按 three-quarter 缺省视角渲染。');
  }
  if (frame !== null && clip === null) {
    warnings.push('指定了 frame 但没指定 clip：按静态姿态渲染，frame 被忽略。');
  }
  return { view: withDefaults(view, scene), orbit8, warnings };
}

function withDefaults(view: ViewState, scene: SceneFrame): ViewState {
  const camera = view.camera;
  return {
    camera: {
      azimuth: normalizeDegrees(camera.azimuth),
      elevation: clamp(camera.elevation, -89, 89),
      distance: camera.distance > 0 ? camera.distance : scene.radius * DEFAULT_DISTANCE_FACTOR,
      target: camera.target,
      fov: clamp(camera.fov, 5, 120),
    },
    clip: view.clip,
    frame: view.frame,
    mode: view.mode,
  };
}

/** orbit8 展开：返回逐方位的方位角表 */
export function orbit8Azimuths(): number[] {
  return [...ORBIT8_AZIMUTHS];
}

/** 球坐标 → 相机位置（Y 轴向上，azimuth 0 = 从 +Z 看） */
export function cameraPosition(camera: ViewStateCamera): [number, number, number] {
  const azimuthRad = (normalizeDegrees(camera.azimuth) * Math.PI) / 180;
  const elevationRad = (camera.elevation * Math.PI) / 180;
  const horizontal = camera.distance * Math.cos(elevationRad);
  return [
    camera.target[0] + horizontal * Math.sin(azimuthRad),
    camera.target[1] + camera.distance * Math.sin(elevationRad),
    camera.target[2] + horizontal * Math.cos(azimuthRad),
  ];
}

/** 相机位置 → 球坐标（viewer 回读用；与 cameraPosition 互逆） */
export function cameraFromPosition(
  position: [number, number, number],
  target: [number, number, number],
  fov: number,
): ViewStateCamera {
  const dx = position[0] - target[0];
  const dy = position[1] - target[1];
  const dz = position[2] - target[2];
  const distance = Math.hypot(dx, dy, dz);
  const elevation = distance === 0 ? 0 : (Math.asin(clamp(dy / distance, -1, 1)) * 180) / Math.PI;
  const azimuth = (Math.atan2(dx, dz) * 180) / Math.PI;
  return { azimuth: normalizeDegrees(azimuth), elevation, distance, target: [...target] as [number, number, number], fov };
}

export function normalizeDegrees(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function parseMode(input: unknown): ViewMode {
  if (input === undefined || input === null) return 'default';
  const value = String(input);
  if (value === 'default' || value === 'solid' || value === 'wireframe' || value === 'skeleton' || value === 'bones-overlay') {
    return value;
  }
  throw new KinemeshError(`未知渲染模式「${value}」。`, '可选值：default / solid / wireframe / skeleton / bones-overlay。');
}

function parseClip(input: unknown, clips: string[]): string | null {
  if (input === undefined || input === null || input === '') return null;
  const value = String(input);
  if (!clips.includes(value)) {
    throw new KinemeshError(
      `场景里没有动画片段「${value}」。`,
      clips.length === 0
        ? '这个模型没有动画片段，去掉 clip 参数按静态渲染。'
        : `可用片段：${clips.join(' / ')}（先调 kinemesh_info 确认）。`,
    );
  }
  return value;
}

function parseFrame(input: unknown, clip: string | null): number | null {
  if (input === undefined || input === null) return clip === null ? null : 0;
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new KinemeshError(`frame 必须是非负整数帧号，收到「${String(input)}」。`, 'frame 是帧号（整数），按 30fps 换算成秒：time = frame / 30。');
  }
  return value;
}

function parseViewCamera(input: unknown, scene: SceneFrame): ViewStateCamera {
  if (typeof input !== 'object' || input === null) {
    throw new KinemeshError('view 必须是对象（camera: {azimuth,elevation,distance,target,fov}）。', 'view 形如 {"camera":{"azimuth":45,"elevation":15,"distance":3.2,"target":[0,1,0],"fov":40}}；省略字段按场景包围盒缺省。');
  }
  const raw = input as Record<string, unknown>;
  const rawCamera = (typeof raw.camera === 'object' && raw.camera !== null ? raw.camera : raw) as Record<string, unknown>;
  const numberAt = (name: string, fallback?: number): number => {
    const value = rawCamera[name];
    if (value === undefined || value === null) {
      if (fallback !== undefined) return fallback;
      throw new KinemeshError(`view.camera.${name} 缺失。`, `补上 ${name}（数字）；或直接用 viewPreset 简化。`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new KinemeshError(`view.camera.${name} 不是数字：${String(value)}。`, `补上合法数字；或直接用 viewPreset 简化。`);
    return parsed;
  };
  const rawTarget = Array.isArray(rawCamera.target) ? rawCamera.target : scene.center;
  const target: [number, number, number] = [
    Number(rawTarget[0] ?? scene.center[0]),
    Number(rawTarget[1] ?? scene.center[1]),
    Number(rawTarget[2] ?? scene.center[2]),
  ];
  if (target.some((axis) => !Number.isFinite(axis))) {
    throw new KinemeshError('view.camera.target 必须是 [x, y, z] 数字数组。', '例如 "target": [0, 1, 0]。');
  }
  return {
    azimuth: numberAt('azimuth', 0),
    elevation: numberAt('elevation', 0),
    distance: numberAt('distance', scene.radius * DEFAULT_DISTANCE_FACTOR),
    target,
    fov: numberAt('fov', DEFAULT_FOV),
  };
}
