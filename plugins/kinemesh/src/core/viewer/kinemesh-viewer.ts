// viewer 模块（设计文档 §4.4）：框架无关，挂 DOM 即用。
// DSH Client 预览面板（M3）与 Playwright 截图页（M2）加载同一份模块，保证
// 「预览里看到的构图 = AI 截图分析拿到的画面」。
// 只能在浏览器里用（WebGL / OrbitControls）；Node 端不要 import 本文件。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  cameraFromPosition,
  cameraPosition,
  DEFAULT_DISTANCE_FACTOR,
  DEFAULT_FOV,
  RENDER_FPS,
  type ViewState,
  type ViewMode,
} from '../viewstate.js';
import { isVertexColorAllDark, normalizePreviewMaterial } from './material.js';
import type { CanonicalScene } from '../types.js';

/** B.4 标签像素基准：14px 文字（+上下衬底整高 24px）、Y 偏移 −6px，按 720p 画幅换算世界尺寸 */
const LABEL_BASE_HEIGHT_PX = 720;
const LABEL_FONT_PX = 14;
const LABEL_OFFSET_PX = 6;

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
  /**
   * B.4 骨骼名标注：给这些骨骼名建文字精灵（画在关节世界位置旁，随动画逐帧跟随）；
   * null / 空数组 = 清除。返回实际建标签数（名字未命中骨架的不计）。
   */
  setBoneLabels(bones: string[] | null): number;
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

  // ———————— 预览光照（0.6.4）———————
  // 原配置（hemi 1.1 + 单方向光 1.6）在深色舞台上看 Unity/Max 导出资产几乎是黑剪影。
  // 改为「环境光 + 半球光 + 主光 + 两侧补光」的四向布光：正面/侧面都有光，避免背光面全黑。
  const ambient = new THREE.AmbientLight(0xffffff, 2.2);
  const hemi = new THREE.HemisphereLight(0xf2f6ff, 0x2a2f38, 2.4);
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
  keyLight.position.set(4, 8, 6);
  const fillLight = new THREE.DirectionalLight(0xdce6ff, 1.2);
  fillLight.position.set(-6, 3, -4);
  const rimLight = new THREE.DirectionalLight(0xffffff, 0.9);
  rimLight.position.set(0, -4, -6);
  scene.add(ambient, hemi, keyLight, fillLight, rimLight);

  let grid = new THREE.GridHelper(10, 10, 0x555a63, 0x3a3e45);
  scene.add(grid);

  /** solid 素模模式共享材质（0.6.5）：中性灰 + 受光照，保证任何资产都能看清轮廓 */
  const solidMaterial = new THREE.MeshLambertMaterial({ color: 0xcfd6e0 });
  /** 贴图异步复查定时器（换模型/卸载时清理） */
  let textureCheckTimer: number | null = null;

  let model: THREE.Object3D | null = null;
  let modelRawClips: THREE.AnimationClip[] = [];
  let mixer: THREE.AnimationMixer | null = null;
  let actions = new Map<string, THREE.AnimationAction>();
  let activeAction: THREE.AnimationAction | null = null;
  let skeletons: THREE.SkeletonHelper[] = [];
  let bounds = { center: [0, 0, 0] as [number, number, number], radius: 1, clips: [] as string[], durationSeconds: 0 };
  // B.4 骨骼名标注：文字精灵清单（target = 命名的骨架对象；世界位置每帧回贴）
  let labelSprites: Array<{ sprite: THREE.Sprite; target: THREE.Object3D; offsetY: number }> = [];
  let namedObjects = new Map<string, THREE.Object3D>();

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
    positionBoneLabels();
    renderer.render(scene, camera);
    if (firstFrameResolve !== null) {
      firstFrameResolve();
      firstFrameResolve = null;
    }
    while (seekResolvers.length > 0) seekResolvers.pop()?.();
  };
  renderer.setAnimationLoop(renderLoop);

  function clearModel(): void {
    clearBoneLabels();
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
      // solid 素模（0.6.5）：用共享中性灰材质替换原材质，一键看清几何/动作，不受贴图与材质问题影响
      const stored = (mesh.userData as Record<string, unknown>).kinemeshOriginalMaterial as THREE.Material | THREE.Material[] | undefined;
      if (mode === 'solid') {
        if (stored !== undefined && (mesh.userData as Record<string, unknown>).kinemeshOriginalMaterial !== null) {
          mesh.material = solidMaterial;
        }
      } else if (stored !== undefined) {
        mesh.material = stored;
      }
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const wireframeFlag = material as THREE.MeshBasicMaterial;
        if (wireframeFlag.wireframe !== undefined) {
          wireframeFlag.wireframe = mode === 'wireframe';
        }
      }
    });
    grid.visible = mode === 'default' || mode === 'solid';
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
      // 材质兜底（0.6.4/0.6.5）：Unity/Max 导出资产在预览里常呈黑剪影，逐层修——
      // ① metalness 过高且无环境贴图 → 黑；② 贴图失败 + 深色 → 黑；③ 顶点色全黑 → color×0 恒黑。
      // 贴图是异步加载的：先同步归一一次，再在纹理解码结束后复查（TGA 等不受支持格式会保持空 image）。
      model.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        // 记录原始材质，供 solid 素模模式替换 / 其它模式还原
        (mesh.userData as Record<string, unknown>).kinemeshOriginalMaterial = mesh.material;
        const colorAttribute = mesh.geometry.getAttribute('color');
        if (isVertexColorAllDark(colorAttribute)) {
          // 顶点色全零：关掉材质顶点色开关（几何数据不动，截图管线同样受益）
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const material of materials) {
            if (material !== undefined && material !== null) {
              (material as THREE.MeshStandardMaterial).vertexColors = false;
              material.needsUpdate = true;
            }
          }
        }
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          if (material !== undefined && material !== null) normalizePreviewMaterial(material);
        }
      });
      // 贴图异步复查：解码失败（image 仍为空）就把 map 摘掉换成中性灰，避免黑贴图盖住颜色
      if (textureCheckTimer !== null) window.clearTimeout(textureCheckTimer);
      textureCheckTimer = window.setTimeout(() => {
        textureCheckTimer = null;
        model?.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh) return;
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const material of materials) {
            if (material === undefined || material === null) continue;
            normalizePreviewMaterial(material);
          }
        });
        renderer.render(scene, camera);
      }, 1200);
      scene.add(model);
      // B.4 标注的目标索引：名字 → 对象（重名取首个命中；换模型即作废重建）
      namedObjects = new Map<string, THREE.Object3D>();
      model.traverse((child) => {
        if (child.name !== '' && !namedObjects.has(child.name)) namedObjects.set(child.name, child);
      });
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
      if (mixer === null) {
        frame = Math.max(0, requested);
        return Promise.resolve();
      }
      // 兜底：还没激活 action 但已选过 clip 时（例如只 setClip 未 applyView），先激活再 scrub——
      // 否则拖时间轴画面不动（0.6.2 修复）
      let action = activeAction;
      if (action === null && clipName !== null) {
        const candidate = actions.get(clipName);
        if (candidate !== undefined) {
          for (const other of actions.values()) other.stop();
          candidate.reset().play();
          activeAction = candidate;
          action = candidate;
        }
      }
      if (action === null) {
        frame = Math.max(0, requested);
        return Promise.resolve();
      }
      const duration = action.getClip().duration;
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

    setBoneLabels(bones) {
      clearBoneLabels();
      if (model === null || bones === null || bones.length === 0) return 0;
      // B.4 像素基准的世界换算：按缺省构图（distance = radius × 2.2、fov 40）在 720p 画幅下
      // 让标签文字回到 14px 基准；之后随相机距离透视缩放（Sprite 默认 sizeAttenuation）
      const worldPerPx = (2 * DEFAULT_DISTANCE_FACTOR * Math.tan(((DEFAULT_FOV / 2) * Math.PI) / 180) * bounds.radius) / LABEL_BASE_HEIGHT_PX;
      let shown = 0;
      for (const name of bones) {
        const target = namedObjects.get(name);
        if (target === undefined) continue;
        const sprite = makeBoneLabelSprite(name, worldPerPx);
        if (sprite === null) continue;
        scene.add(sprite);
        labelSprites.push({ sprite, target, offsetY: -worldPerPx * LABEL_OFFSET_PX });
        shown += 1;
      }
      positionBoneLabels();
      // 立即出一帧：截图管线在 applyView / setBoneLabels 后立即截图，不等下一个 rAF
      renderer.render(scene, camera);
      return shown;
    },

    resize(nextWidth, nextHeight) {
      observedWidth = nextWidth;
      observedHeight = nextHeight;
      renderer.setSize(nextWidth, nextHeight);
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
    },

    ready() {
      return firstFrame;
    },

    dispose() {
      if (textureCheckTimer !== null) {
        window.clearTimeout(textureCheckTimer);
        textureCheckTimer = null;
      }
      if (resizeObserver !== null) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      renderer.setAnimationLoop(null);
      clearModel();
      controls.dispose();
      scene.remove(grid);
      grid.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };

  // ———————— 容器自适应（0.6.0：独立预览页全宽/页签/浮层共用同一卡片） ————————
  // 显式给了 width/height 就固定（截图管线用固定画幅）；否则跟随容器尺寸变化。
  let observedWidth = width;
  let observedHeight = height;
  let resizeObserver: ResizeObserver | null =
    options.width !== undefined || options.height !== undefined || typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          const nextWidth = container.clientWidth;
          const nextHeight = container.clientHeight;
          if (nextWidth <= 0 || nextHeight <= 0) return;
          if (nextWidth === observedWidth && nextHeight === observedHeight) return;
          observedWidth = nextWidth;
          observedHeight = nextHeight;
          renderer.setSize(nextWidth, nextHeight);
          camera.aspect = nextWidth / nextHeight;
          camera.updateProjectionMatrix();
          renderer.render(scene, camera);
        });
  if (resizeObserver !== null) resizeObserver.observe(container);

  function setModeInternal(next: ViewMode): void {
    mode = next;
    applyMode();
    // 立即出一张帧：截图管线在 applyView 后立即截图，不等下一个 rAF
    renderer.render(scene, camera);
  }

  // ———————— B.4 骨骼名文字精灵：canvas 2D 纹理 + three Sprite（无新依赖） ————————

  function clearBoneLabels(): void {
    for (const entry of labelSprites) {
      scene.remove(entry.sprite);
      entry.sprite.material.map?.dispose();
      entry.sprite.material.dispose();
    }
    labelSprites = [];
  }

  /** 每帧把标签回贴到关节世界位置（Y 偏移 −6px 基准），动画 seek 后依然钉在关节旁 */
  const labelScratch = new THREE.Vector3();
  function positionBoneLabels(): void {
    if (labelSprites.length === 0) return;
    for (const entry of labelSprites) {
      entry.target.getWorldPosition(labelScratch);
      entry.sprite.position.set(labelScratch.x, labelScratch.y + entry.offsetY, labelScratch.z);
    }
  }

  /** 标签贴图：14px 基准文字（2× 超采样保清晰）+ 半透明底衬；主题前景色保证深浅背景下可读 */
  function makeBoneLabelSprite(text: string, worldPerPx: number): THREE.Sprite | null {
    const font = `600 ${LABEL_FONT_PX * 2}px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`;
    const pad = 5 * 2;
    const canvas = document.createElement('canvas');
    const probe = canvas.getContext('2d');
    if (probe === null) return null;
    probe.font = font;
    const textWidth = Math.ceil(probe.measureText(text).width);
    canvas.width = textWidth + pad * 2;
    canvas.height = LABEL_FONT_PX * 2 + pad * 2;
    // canvas 尺寸赋值会重置 context 状态，字体要重设一次
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    ctx.font = font;
    ctx.fillStyle = 'rgba(26, 29, 35, 0.72)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e9ecf2';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, pad, canvas.height / 2 + 1);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(material);
    // 世界尺寸 = 像素基准 × worldPerPx（画布按 2× 超采样画，尺寸按 1× 换算）
    const worldHeight = worldPerPx * (canvas.height / 2);
    sprite.scale.set(worldHeight * (canvas.width / canvas.height), worldHeight, 1);
    // 标注层永远可读：压过骨骼线与网格（skeleton 模式下本来也无遮挡）
    sprite.renderOrder = 999;
    return sprite;
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
