// CanonicalScene → InfoReport（设计文档 §4.3）。
// FBX / OBJ 走这条路（three.js 已把结构统一成 Object3D + AnimationClip）；
// glTF 走 gltf-json.ts 的纯 JSON 快速路径，两边产出同一份 InfoReport。
import * as THREE from 'three';
import { matchedCategories } from './humanoid.js';
import { unitWarnings } from './units.js';
import type { BoundsInfo, CanonicalScene, ClipInfo, InfoReport, MeshInfo, TextureInfo } from '../types.js';

const POSITION_EPSILON = 1e-4;
const WEIGHT_EPSILON = 1e-6;
const TEXTURE_SLOTS = [
  'map',
  'alphaMap',
  'bumpMap',
  'normalMap',
  'specularMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'displacementMap',
  'envMap',
] as const;

export interface SceneInfoSource {
  fileName: string;
  fileSize: number;
  /** 格式声明支持动画（如 FBX）但没解析到 clip 时，给一条非致命提示 */
  expectsAnimation: boolean;
}

export function sceneToInfo(scene: CanonicalScene, source: SceneInfoSource): InfoReport {
  const bones: THREE.Bone[] = [];
  const meshes: THREE.Mesh[] = [];
  scene.object.traverse((child) => {
    if ((child as THREE.Bone).isBone) bones.push(child as THREE.Bone);
    if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
  });

  // ————— 骨骼 —————
  const rootBones = bones.filter((bone) => !isAncestorBone(bone.parent));
  let maxDepth: number | null = null;
  if (bones.length > 0) {
    const cache = new Map<THREE.Bone, number>();
    const depthOf = (bone: THREE.Bone): number => {
      const cached = cache.get(bone);
      if (cached !== undefined) return cached;
      const parent = bone.parent;
      const depth = (parent as THREE.Bone).isBone ? depthOf(parent as THREE.Bone) + 1 : 0;
      cache.set(bone, depth);
      return depth;
    };
    maxDepth = bones.reduce((max, bone) => Math.max(max, depthOf(bone)), 0);
  }
  const humanoidLike = matchedCategories(bones.map((bone) => bone.name)).length >= 4;

  // ————— 网格 —————
  const meshInfos: MeshInfo[] = meshes.map((mesh) => {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    const vertexCount = position?.count ?? 0;
    const index = geometry.getIndex();
    const triangles = index !== null ? Math.floor(index.count / 3) : Math.floor(vertexCount / 3);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    return {
      name: mesh.name || '(unnamed mesh)',
      triangles,
      vertices: vertexCount,
      skinnedRatio: skinnedRatioOf(mesh, vertexCount),
      materials: materials.length,
    };
  });

  // ————— 动画片段 —————
  const clips: ClipInfo[] = scene.animations.map((clip, index) => ({
    name: clip.name || `clip_${index}`,
    duration: clip.duration,
    fps: scene.meta.fps,
    channels: clip.tracks.length,
    rootMotion: hasRootMotion(clip, rootBones, sceneBoundsHeight(scene)),
  }));

  // ————— 贴图 —————
  const textures = collectTextures(meshes);

  // ————— 包围盒 —————
  const box = new THREE.Box3().setFromObject(scene.object, true);
  const bounds = box.isEmpty() ? null : boundsOf(box, scene.meta.upAxis ?? 'y');

  // ————— 体检提示 —————
  const warnings = [...unitWarnings(bounds?.heightMeters ?? null)];
  if (source.expectsAnimation && scene.animations.length === 0) {
    warnings.push('没有解析到动画片段：静态模型，或导出时没有烘焙/包含动画（FBX 导出记得勾「烘焙动画」）。');
  }
  if (meshes.length === 0) {
    warnings.push('没有网格数据：模型可能只有骨架/动画。');
  }

  return {
    format: scene.meta.format,
    fileName: source.fileName,
    fileSize: source.fileSize,
    clips,
    bones: { count: bones.length, maxDepth, humanoidLike },
    meshes: meshInfos,
    textures,
    bounds,
    warnings,
  };
}

function isAncestorBone(parent: THREE.Object3D | null): boolean {
  let current: THREE.Object3D | null = parent;
  while (current !== null) {
    if ((current as THREE.Bone).isBone) return true;
    current = current.parent;
  }
  return false;
}

/** 场景包围盒沿上轴高度（模型单位）；analyze 工具层用它做身高归一（M6d，rest 姿态下取值） */
export function sceneBoundsHeight(scene: CanonicalScene): number | null {
  const box = new THREE.Box3().setFromObject(scene.object, true);
  if (box.isEmpty()) return null;
  const up = scene.meta.upAxis ?? 'y';
  const size = box.getSize(new THREE.Vector3());
  return up === 'x' ? size.x : up === 'z' ? size.z : size.y;
}

/**
 * 根运动判断：根骨骼的 position 轨道「净位移」是否超出阈值（终态相对初态的位移）。
 * 设计文档说「位移通道非零」，这里取净位移更贴近「能不能在游戏里复用」的判断——
 * 原地动作的上下弹跳不算根运动。
 */
function hasRootMotion(clip: THREE.AnimationClip, rootBones: THREE.Bone[], sceneHeight: number | null): boolean {
  const threshold = Math.max(POSITION_EPSILON, (sceneHeight ?? 0) * 0.01);
  const trackMap = new Map<string, THREE.KeyframeTrack>();
  for (const track of clip.tracks) trackMap.set(track.name, track);
  for (const bone of rootBones) {
    for (const name of [`${bone.name}.position`, `${sanitizeNodeName(bone.name)}.position`]) {
      const track = trackMap.get(name);
      if (track === undefined) continue;
      const values = track.values;
      const stride = 3;
      if (values.length < stride * 2) continue;
      let moved = false;
      for (let offset = stride; offset + stride <= values.length; offset += stride) {
        const dx = (values[offset] ?? 0) - (values[0] ?? 0);
        const dy = (values[offset + 1] ?? 0) - (values[1] ?? 0);
        const dz = (values[offset + 2] ?? 0) - (values[2] ?? 0);
        if (Math.hypot(dx, dy, dz) > threshold) {
          moved = true;
          break;
        }
      }
      if (moved) return true;
    }
  }
  return false;
}

/** 与 PropertyBinding.sanitizeNodeName 的常用行为对齐（空格 → 下划线） */
function sanitizeNodeName(name: string): string {
  return name.replace(/\s/g, '_');
}

function skinnedRatioOf(mesh: THREE.Mesh, vertexCount: number): number | null {
  if (!(mesh as THREE.SkinnedMesh).isSkinnedMesh || vertexCount === 0) return 0;
  const weights = mesh.geometry.getAttribute('skinWeight');
  if (weights === undefined) return 0;
  let influenced = 0;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    let total = 0;
    for (let component = 0; component < weights.itemSize; component += 1) {
      total += weights.getComponent(vertex, component);
    }
    if (total > WEIGHT_EPSILON) influenced += 1;
  }
  return influenced / vertexCount;
}

function collectTextures(meshes: THREE.Mesh[]): TextureInfo[] {
  const byKey = new Map<string, TextureInfo>();
  for (const mesh of meshes) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const record = material as unknown as Record<string, unknown>;
      for (const slot of TEXTURE_SLOTS) {
        const texture = record[slot] as THREE.Texture | undefined;
        if (texture === undefined || texture === null || !texture.isTexture) continue;
        const image = texture.image as { width?: number; height?: number } | undefined;
        const size: [number, number] | null =
          image !== undefined && typeof image.width === 'number' && typeof image.height === 'number'
            ? [image.width, image.height]
            : null;
        const name = texture.name || `(${slot})`;
        const key = `${name}|${size === null ? '?' : `${size[0]}x${size[1]}`}`;
        const existing = byKey.get(key);
        if (existing === undefined) {
          byKey.set(key, {
            name,
            size,
            embedded: texture.userData.kinemeshUnresolved === true ? true : null,
          });
        }
      }
    }
  }
  return [...byKey.values()];
}

function boundsOf(box: THREE.Box3, up: 'x' | 'y' | 'z'): BoundsInfo {
  const min = box.min;
  const max = box.max;
  const height =
    up === 'x' ? max.x - min.x : up === 'z' ? max.z - min.z : max.y - min.y;
  return {
    min: [min.x, min.y, min.z],
    max: [max.x, max.y, max.z],
    heightMeters: height,
  };
}
