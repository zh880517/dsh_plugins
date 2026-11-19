// core 公共类型：与出口无关（DSH 工具 / CLI / MCP 三处共用）。
// 本目录不得 import 任何宿主 API；three.js 是构建期内联的渲染/解析依赖。
import type * as THREE from 'three';

/** 来源格式：FBX 二进制 / FBX ASCII / glTF JSON / GLB 容器 / OBJ */
export type SourceFormat = 'fbx-binary' | 'fbx-ascii' | 'gltf' | 'glb' | 'obj';

/** Loader 附带的来源线索（拿不到的项保持 null，不要编造） */
export interface SceneMeta {
  format: SourceFormat;
  /** FBX GlobalSettings 的 UnitScaleFactor（1 单位 = N 厘米）；three.js 解析层不暴露，v1 恒为 null */
  unitScaleFactor: number | null;
  upAxis: 'x' | 'y' | 'z' | null;
  /** 动画帧率线索；FBX/gLTF 的 JS 解析层都拿不到，v1 恒为 null */
  fps: number | null;
}

/** Loader 注册表的统一输出：挂 DOM 即可渲染，也是 scene-info 的输入 */
export interface CanonicalScene {
  object: THREE.Object3D;
  animations: THREE.AnimationClip[];
  meta: SceneMeta;
}

/** Loader 执行上下文（读旁车文件留给 viewer 阶段用；info 阶段不需要） */
export interface LoadContext {
  fileName: string;
  /** 读与模型同目录的旁车文件（如 OBJ 的 .mtl）；读不到返回 null */
  readSidecar?: (name: string) => Promise<ArrayBuffer | null>;
}

/**
 * 格式条目：新增格式 = 注册一个 entry，viewer / 工具层零改动。
 * detect 用 magic bytes 优先、扩展名兜底；meta.format 由 loader 自己精确判定
 * （FBX 家族共用 FBXLoader，binary/ascii 由它内部嗅探）。
 */
export interface FormatEntry {
  id: string;
  extensions: string[];
  hasAnimation: boolean;
  detect: (head: Uint8Array, fileName: string) => boolean;
  load: (data: ArrayBuffer, ctx: LoadContext) => Promise<CanonicalScene> | CanonicalScene;
  /** 纯结构快速路径（不构造场景，Node 端信息提取优先走它）；缺省走 load + scene-info */
  fastInfo?: (data: ArrayBuffer, fileName: string) => InfoReport;
}

// ———————— kinemesh_info 返回结构（设计文档 §4.3） ————————

export interface ClipInfo {
  name: string;
  /** 秒 */
  duration: number;
  fps: number | null;
  /** three.js：AnimationClip.tracks 数；glTF 快速路径：channels 数 */
  channels: number;
  /** 根骨骼位移通道是否非零（游戏复用动作的关键判断） */
  rootMotion: boolean;
}

export interface BonesInfo {
  count: number;
  /** 骨骼链最大深度（根=0）；没有骨骼时为 null */
  maxDepth: number | null;
  /** 骨骼命名/层级匹配常见 Humanoid 惯例（hips/spine/head…），提示可重定向 */
  humanoidLike: boolean;
  /** B.6：约定识别结果（mixamo/biped/ue/vrm/rigify/custom）；无骨骼为 null */
  convention: string | null;
  /** B.6：映射计数——资产旁有 kinemesh-bones.json 时取映射骨骼数，否则字典自动命中数 */
  mapped: number;
}

export interface MeshInfo {
  name: string;
  triangles: number;
  vertices: number;
  /** 顶点被蒙皮权重影响的比例；静态网格为 0，无法判断时为 null */
  skinnedRatio: number | null;
  materials: number;
}

export interface TextureInfo {
  name: string;
  /** 像素尺寸；纯 JSON 快速路径拿不到位图头，为 null */
  size: [number, number] | null;
  /** 内嵌在模型文件里（FBX 视频/ GLB bin）还是外部引用 */
  embedded: boolean | null;
}

export interface BoundsInfo {
  min: [number, number, number];
  max: [number, number, number];
  /** 沿上轴的高度，按「模型单位 ≈ 米」理解；厘米文件这里就是 180 那类数字，交给体检标记 */
  heightMeters: number;
}

export interface InfoReport {
  format: SourceFormat;
  fileName: string;
  fileSize: number;
  clips: ClipInfo[];
  bones: BonesInfo;
  meshes: MeshInfo[];
  textures: TextureInfo[];
  bounds: BoundsInfo | null;
  /** 单位体检、缺动画提示等非致命提示 */
  warnings: string[];
}
