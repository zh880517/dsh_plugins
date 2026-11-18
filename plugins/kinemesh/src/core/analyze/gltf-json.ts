// glTF 快速路径（设计文档 §4.3）：animations[].samplers 的 accessor min/max、
// accessors 的 count/min/max、nodes/skins/children 全是纯 JSON，
// 不碰二进制 buffer 就能得出片段/骨骼/网格/包围盒 —— Node 端 info 的主路径。
import { KinemeshError, reasonOf } from '../errors.js';
import { isHumanoidLike } from './humanoid.js';
import { unitWarnings } from './units.js';
import type { BoundsInfo, ClipInfo, InfoReport, MeshInfo, SourceFormat, TextureInfo } from '../types.js';

// ———————— glTF JSON 子集（只声明要读的字段） ————————

interface GltfAccessor {
  count?: number;
  min?: number[];
  max?: number[];
}
interface GltfPrimitive {
  attributes?: Record<string, number | undefined>;
  indices?: number;
  mode?: number;
  material?: number;
}
interface GltfMesh {
  name?: string;
  primitives?: GltfPrimitive[];
}
interface GltfNode {
  name?: string;
  mesh?: number;
  skin?: number;
  children?: number[];
}
interface GltfSkin {
  name?: string;
  joints?: number[];
}
interface GltfSampler {
  input?: number;
  output?: number;
}
interface GltfChannel {
  sampler?: number;
  target?: { node?: number; path?: string };
}
interface GltfAnimation {
  name?: string;
  channels?: GltfChannel[];
  samplers?: GltfSampler[];
}
interface GltfImage {
  name?: string;
  uri?: string;
  mimeType?: string;
}
interface GltfJson {
  animations?: GltfAnimation[];
  meshes?: GltfMesh[];
  nodes?: GltfNode[];
  skins?: GltfSkin[];
  accessors?: GltfAccessor[];
  images?: GltfImage[];
  extensionsRequired?: string[];
}

const GLB_JSON_CHUNK = 0x4e4f534a; // 'JSON'
const ROOT_MOTION_EPSILON = 1e-4;

/** 分析 glTF / GLB（不构造场景，纯 JSON） */
export function gltfJsonInfo(data: ArrayBuffer, fileName: string): InfoReport {
  const json = readGltfJson(data);
  const format: SourceFormat = isGlbContainer(data) ? 'glb' : 'gltf';
  const accessors = json.accessors ?? [];
  const nodes = json.nodes ?? [];
  const meshesJson = json.meshes ?? [];

  const readAccessor = (index: number | undefined): GltfAccessor | undefined => {
    if (typeof index !== 'number' || index < 0) return undefined;
    return accessors[index];
  };

  // ————— 网格 —————
  const nodeInstances = new Map<number, number[]>();
  for (const [nodeIndex, node] of nodes.entries()) {
    if (typeof node.mesh !== 'number') continue;
    const list = nodeInstances.get(node.mesh);
    if (list === undefined) nodeInstances.set(node.mesh, [nodeIndex]);
    else list.push(nodeIndex);
  }
  const meshes: MeshInfo[] = [];
  let bounds: BoundsInfo | null = null;
  for (const [meshIndex, mesh] of meshesJson.entries()) {
    let triangles = 0;
    let vertices = 0;
    const materials = new Set<number>();
    for (const prim of mesh.primitives ?? []) {
      const position = readAccessor(prim.attributes?.POSITION);
      const vertexCount = position?.count ?? 0;
      const indices = readAccessor(prim.indices);
      if ((prim.mode ?? 4) === 4) {
        triangles += indices !== undefined ? Math.floor((indices.count ?? 0) / 3) : Math.floor(vertexCount / 3);
      }
      vertices += vertexCount;
      if (typeof prim.material === 'number') materials.add(prim.material);
      bounds = unionAccessorBounds(bounds, position);
    }
    const instances = nodeInstances.get(meshIndex) ?? [];
    const skinned = instances.filter((nodeIndex) => typeof nodes[nodeIndex]?.skin === 'number').length;
    meshes.push({
      name: mesh.name ?? `mesh_${meshIndex}`,
      triangles,
      vertices,
      skinnedRatio: instances.length > 0 ? skinned / instances.length : null,
      materials: materials.size,
    });
  }

  // ————— 骨骼（取关节最多的 skin 代表；多 skin 是同骨架多份绑定，很少见） —————
  const skins = (json.skins ?? []).slice().sort((left, right) => (right.joints?.length ?? 0) - (left.joints?.length ?? 0));
  const mainSkin = skins[0];
  const jointIndices = mainSkin?.joints ?? [];
  let maxDepth: number | null = null;
  let humanoidLike = false;
  if (jointIndices.length > 0) {
    const jointSet = new Set(jointIndices);
    const parentOf = new Map<number, number>();
    for (const nodeIndex of jointIndices) {
      for (const child of nodes[nodeIndex]?.children ?? []) {
        if (jointSet.has(child)) parentOf.set(child, nodeIndex);
      }
    }
    const depthCache = new Map<number, number>();
    const depthOf = (nodeIndex: number): number => {
      const cached = depthCache.get(nodeIndex);
      if (cached !== undefined) return cached;
      const parent = parentOf.get(nodeIndex);
      const depth = parent === undefined ? 0 : depthOf(parent) + 1;
      depthCache.set(nodeIndex, depth);
      return depth;
    };
    maxDepth = jointIndices.reduce((max, joint) => Math.max(max, depthOf(joint)), 0);
    humanoidLike = isHumanoidLike(jointIndices.map((joint) => nodes[joint]?.name ?? ''));
  }

  // ————— 动画 —————
  const childSet = new Set<number>();
  for (const node of nodes) {
    for (const child of node.children ?? []) childSet.add(child);
  }
  const clips: ClipInfo[] = [];
  for (const [animationIndex, animation] of (json.animations ?? []).entries()) {
    const samplers = animation.samplers ?? [];
    let duration = 0;
    let rootMotion = false;
    for (const channel of animation.channels ?? []) {
      const sampler = samplers[channel.sampler ?? -1];
      const input = readAccessor(sampler?.input);
      duration = Math.max(duration, input?.max?.[0] ?? 0);
      const target = channel.target;
      if (
        target?.path === 'translation' &&
        typeof target.node === 'number' &&
        !childSet.has(target.node)
      ) {
        const output = readAccessor(sampler?.output);
        rootMotion = rootMotion || accessorMoves(output);
      }
    }
    clips.push({
      name: animation.name ?? `clip_${animationIndex}`,
      duration,
      fps: null,
      channels: animation.channels?.length ?? 0,
      rootMotion,
    });
  }

  // ————— 贴图 —————
  const textures: TextureInfo[] = (json.images ?? []).map((image, index) => ({
    name: image.name || basename(image.uri ?? '') || image.mimeType || `image_${index}`,
    size: null,
    embedded: typeof image.uri === 'string' ? false : true,
  }));

  // ————— 包围盒与体检 —————
  const warnings = [...unitWarnings(bounds === null ? null : bounds.heightMeters)];
  if (json.animations === undefined || json.animations.length === 0) {
    warnings.push('没有解析到动画片段：静态模型，或导出时没有烘焙/包含动画。');
  }
  if (meshesJson.length === 0) {
    warnings.push('没有网格数据：模型可能只有骨架/动画。');
  }
  if (bounds === null) {
    warnings.push('POSITION accessor 缺少 min/max，算不出包围盒（非标准导出）。');
  }

  return {
    format,
    fileName,
    fileSize: data.byteLength,
    clips,
    bones: { count: jointIndices.length, maxDepth, humanoidLike },
    meshes,
    textures,
    bounds,
    warnings,
  };
}

// ———————— GLB 容器 ————————

export function isGlbContainer(data: ArrayBuffer): boolean {
  return data.byteLength >= 4 && new TextDecoder('latin1').decode(new Uint8Array(data, 0, 4)) === 'glTF';
}

/** GLB：12 字节头 + JSON chunk；.gltf：直接 JSON 文本 */
function readGltfJson(data: ArrayBuffer): GltfJson {
  let text: string;
  if (isGlbContainer(data)) {
    const view = new DataView(data);
    const version = view.getUint32(4, true);
    if (version !== 2) {
      throw new KinemeshError(`GLB 版本是 ${version}，本工具只支持 glTF 2.0。`, '用导出工具重新导出为 glTF 2.0 的 GLB。');
    }
    const chunkLength = view.getUint32(12, true);
    const chunkType = view.getUint32(16, true);
    if (chunkType !== GLB_JSON_CHUNK) {
      throw new KinemeshError('GLB 第一个 chunk 不是 JSON（结构异常）。', '用 glTF 校验器（gltf-validator）检查文件，或回导出工具重新导出。');
    }
    const start = 20;
    const end = Math.min(start + chunkLength, data.byteLength);
    text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(data, start, end - start));
  } else {
    text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(data));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new KinemeshError(`glTF JSON 解析失败：${reasonOf(error)}`, '文件不是合法 JSON：确认扩展名与内容一致（.glb 是二进制容器，.gltf 是 JSON 文本），损坏文件回导出工具重新导出。', { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new KinemeshError('glTF 内容不是 JSON 对象。', '确认文件是 glTF 2.0 资产（顶层要有 asset 字段）。');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.asset !== 'object' || record.asset === null) {
    throw new KinemeshError('JSON 里没有 asset 字段，不像 glTF。', '确认文件是 glTF 2.0 资产；其他 JSON 文件不要用 .gltf/.glb 扩展名。');
  }
  return parsed as GltfJson;
}

/** 输出 accessor（位移）是否非零：靠 min/max 判断；缺 min/max 时保守返回 false */
function accessorMoves(accessor: GltfAccessor | undefined): boolean {
  const min = accessor?.min;
  const max = accessor?.max;
  if (min === undefined || max === undefined) return false;
  const axes = Math.min(min.length, max.length, 3);
  for (let axis = 0; axis < axes; axis += 1) {
    const low = min[axis];
    const high = max[axis];
    if (low !== undefined && high !== undefined && Math.abs(high - low) > ROOT_MOTION_EPSILON) return true;
  }
  return false;
}

function unionAccessorBounds(current: BoundsInfo | null, accessor: GltfAccessor | undefined): BoundsInfo | null {
  const min = accessor?.min;
  const max = accessor?.max;
  if (min === undefined || max === undefined || min.length < 3 || max.length < 3) return current;
  const low: [number, number, number] = [min[0] ?? 0, min[1] ?? 0, min[2] ?? 0];
  const high: [number, number, number] = [max[0] ?? 0, max[1] ?? 0, max[2] ?? 0];
  if (current === null) return { min: low, max: high, heightMeters: high[1] - low[1] };
  return {
    min: [Math.min(current.min[0], low[0]), Math.min(current.min[1], low[1]), Math.min(current.min[2], low[2])],
    max: [Math.max(current.max[0], high[0]), Math.max(current.max[1], high[1]), Math.max(current.max[2], high[2])],
    heightMeters: Math.max(current.max[1], high[1]) - Math.min(current.min[1], low[1]),
  };
}

function basename(uri: string): string {
  const clean = uri.split(/[?#]/)[0] ?? uri;
  const last = clean.split(/[\\/]/).pop();
  return last === undefined || last === '' ? '' : decodeURIComponent(last);
}
