// viewer 模块（设计文档 §4.4）：框架无关，挂 DOM 即用。
// DSH Client 预览面板（M3）与 Playwright 截图页（M2）加载同一份模块，保证
// 「预览里看到的构图 = AI 截图分析拿到的画面」。
// 只能在浏览器里用（WebGL / OrbitControls）；Node 端不要 import 本文件。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { cameraFromPosition, cameraPosition, RENDER_FPS, type ViewState, type ViewMode } from '../viewstate.js';
import type { CanonicalScene } from '../types.js';

export interface ViewerFrameInfo {
  clip: string | null;
  /** 当前帧号（按 RENDER_FPS 换算） */
  frame: number;
  /** 片段总时长（秒） */
  durationSeconds: number;
}

export interface ViewerHandle {
  /** 载入场景（替换上一个）；同时按包围盒适配相机 */
  loadScene(scene: CanonicalScene): void;
  /** 应用视角（球坐标） */
  applyView(view: ViewState): void;
  /** 拖转/滚轮之后的实时回读：相机位置反解为球坐标 */
  getViewState(): ViewState;
  setMode(mode: ViewMode): void;
  play(clipName?: string): void;
  pause(): void;
  /** 跳帧：渲染完一帧后才 resolve（截图管线靠它保证确定性） */
  seekFrame(frame: number): Promise<void>;
  frameInfo(): ViewerFrameInfo | null;
  /** 当前场景全部动画轨道名（诊断绑定问题用） */
  trackNames(): string[];
  /** 场景级信息（截图管线解析 ViewState 缺省值时用） */
  sceneBounds(): { center: [number, number, number]; radius: number; clips: string[]; durationSeconds: number };
  resize(width: number, height: number): void;
  /** 首帧渲染完成 */
  ready(): Promise<void>;
  dispose(): void;
}

export interface MountOptions {
  width?: number;
  height?: number;
  background?: number;
}

export function mountViewer(container: HTMLElement, options: MountOptions = {}): ViewerHandle {
  const width = options.width ?? (container.clientWidth || 1280);
  const height = options.height ?? (container.clientHeight || 720);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(1);
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(options.background ?? 0x23262b);

  const camera = new THREE.PerspectiveCamera(40, width / height, 0.001, 1_000_000);
  camera.position.set(2, 2, 2);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444455, 1.1);
  const dir = new THREE.DirectionalLight(0xffffff, 1.6);
  dir.position.set(3, 6, 4);
  scene.add(hemi, dir);

  let grid = new THREE.GridHelper(10, 10, 0x555a63, 0x3a3e45);
  scene.add(grid);

  let model: THREE.Object3D | null = null;
  let modelRawClips: THREE.AnimationClip[] = [];
  let mixer: THREE.AnimationMixer | null = null;
  let actions = new Map<string, THREE.AnimationAction>();
  let activeAction: THREE.AnimationAction | null = null;
  let skeletons: THREE.SkeletonHelper[] = [];
  let bounds = { center: [0, 0, 0] as [number, number, number], radius: 1, clips: [] as string[], durationSeconds: 0 };

  let clipName: string | null = null;
  let frame = 0;
  let playing = false;
  let mode: ViewMode = 'default';
  let currentView: ViewState | null = null;

  const clock = new THREE.Clock();
  const seekResolvers: Array<() => void> = [];
  let firstFrameResolve: (() => void) | null = null;
  const firstFrame = new Promise<void>((resolve) => {
    firstFrameResolve = resolve;
  });

  const renderLoop = (): void => {
    const delta = clock.getDelta();
    if (mixer !== null && activeAction !== null && (playing || seekResolvers.length > 0)) {
      const duration = activeAction.getClip().duration;
      if (playing) {
        frame = (frame + delta * RENDER_FPS) % Math.max(duration * RENDER_FPS, 1 / RENDER_FPS);
      }
      mixer.setTime(frame / RENDER_FPS);
    }
    controls.update();
    renderer.render(scene, camera);
    if (firstFrameResolve !== null) {
      firstFrameResolve();
      firstFrameResolve = null;
    }
    while (seekResolvers.length > 0) seekResolvers.pop()?.();
  };
  renderer.setAnimationLoop(renderLoop);

  function clearModel(): void {
    if (model === null) return;
    scene.remove(model);
    model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) material?.dispose();
      }
    });
    model = null;
    modelRawClips = [];
    mixer = null;
    actions = new Map();
    activeAction = null;
    skeletons = [];
  }

  function applyMode(): void {
    if (model === null) return;
    for (const helper of skeletons) helper.visible = mode === 'skeleton' || mode === 'bones-overlay';
    model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.visible = mode !== 'skeleton';
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const wireframeFlag = material as THREE.MeshBasicMaterial;
        if (wireframeFlag.wireframe !== undefined) {
          wireframeFlag.wireframe = mode === 'wireframe';
        }
      }
    });
    grid.visible = mode === 'default';
  }

  const handle: ViewerHandle = {
    loadScene(target) {
      clearModel();
      model = target.object;
      modelRawClips = target.animations;
      // 部分导出器不给 LayerElementNormal（如最小 FBX）：没有法线的 Phong/Standard 材质会渲染成纯黑
      model.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry.getAttribute('normal') === undefined) {
          mesh.geometry.computeVertexNormals();
        }
      });
      scene.add(model);
      mixer = new THREE.AnimationMixer(model);
      actions = new Map();
      const clips = target.animations;
      for (const clip of clips) {
        const action = mixer.clipAction(clip);
        actions.set(clip.name || `clip_${actions.size}`, action);
      }
      skeletons = [new THREE.SkeletonHelper(model)];
      for (const helper of skeletons) {
        helper.visible = false;
        scene.add(helper);
      }
      const box = new THREE.Box3().setFromObject(model, true);
      const size = box.isEmpty() ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3());
      const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
      bounds = {
        center: [center.x, center.y, center.z],
        radius: Math.max(size.length() / 2, 0.001),
        clips: clips.map((clip, index) => clip.name || `clip_${index}`),
        durationSeconds: clips.reduce((max, clip) => Math.max(max, clip.duration), 0),
      };
      const scale = bounds.radius;
      grid.scale.setScalar(Math.max(scale / 5, 0.01));
      clipName = null;
      frame = 0;
      playing = false;
      applyMode();
    },

    applyView(view) {
      currentView = view;
      const position = cameraPosition(view.camera);
      camera.position.set(position[0], position[1], position[2]);
      camera.fov = view.camera.fov;
      camera.updateProjectionMatrix();
      controls.target.set(view.camera.target[0], view.camera.target[1], view.camera.target[2]);
      controls.update();
      setModeInternal(view.mode);
      const targetClip = view.clip;
      if (targetClip === null) {
        pauseInternal();
        clipName = null;
        frame = 0;
        if (mixer !== null) mixer.setTime(0);
      } else {
        const action = actions.get(targetClip);
        if (action !== undefined && mixer !== null) {
          for (const other of actions.values()) other.stop();
          // 注意不能 paused=true：paused 会把 effectiveTimeScale 归零，mixer.setTime 的 scrub 无效
          action.reset().play();
          activeAction = action;
          clipName = targetClip;
          const requested = view.frame ?? 0;
          frame = clampFrame(requested, action.getClip().duration);
          mixer.setTime(frame / RENDER_FPS);
        } else {
          pauseInternal();
          clipName = null;
          if (mixer !== null) mixer.setTime(frame / RENDER_FPS);
        }
      }
    },

    getViewState() {
      const target = controls.target;
      const cameraData = cameraFromPosition(
        [camera.position.x, camera.position.y, camera.position.z],
        [target.x, target.y, target.z],
        camera.fov,
      );
      return {
        camera: cameraData,
        clip: clipName,
        frame,
        mode,
      };
    },

    setMode(next) {
      setModeInternal(next);
    },

    play(clip) {
      const name = clip ?? clipName ?? bounds.clips[0] ?? null;
      if (name === null) return;
      const action = actions.get(name);
      if (action === undefined) return;
      for (const other of actions.values()) other.stop();
      action.reset().play();
      activeAction = action;
      clipName = name;
      playing = true;
    },

    pause() {
      pauseInternal();
    },

    seekFrame(requested) {
      if (activeAction === null || mixer === null) {
        frame = Math.max(0, requested);
        return Promise.resolve();
      }
      const duration = activeAction.getClip().duration;
      frame = clampFrame(requested, duration);
      playing = false;
      mixer.setTime(frame / RENDER_FPS);
      return new Promise<void>((resolve) => {
        seekResolvers.push(resolve);
      });
    },

    frameInfo() {
      if (activeAction === null) return null;
      return { clip: clipName, frame, durationSeconds: activeAction.getClip().duration };
    },

    trackNames() {
      return modelRawClips.flatMap((clip) => clip.tracks.map((track) => track.name));
    },

    sceneBounds() {
      return bounds;
    },

    resize(nextWidth, nextHeight) {
      renderer.setSize(nextWidth, nextHeight);
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
    },

    ready() {
      return firstFrame;
    },

    dispose() {
      renderer.setAnimationLoop(null);
      clearModel();
      controls.dispose();
      scene.remove(grid);
      grid.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };

  function setModeInternal(next: ViewMode): void {
    mode = next;
    applyMode();
    // 立即出一张帧：截图管线在 applyView 后立即截图，不等下一个 rAF
    renderer.render(scene, camera);
  }

  function pauseInternal(): void {
    playing = false;
    if (activeAction !== null) activeAction.paused = true;
  }

  function clampFrame(requested: number, durationSeconds: number): number {
    const maxFrame = Math.max(0, Math.floor(durationSeconds * RENDER_FPS));
    return Math.min(Math.max(0, Math.floor(requested)), maxFrame);
  }

  return handle;
}
