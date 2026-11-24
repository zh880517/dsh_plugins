// viewer 模块（设计文档 §4.4）：框架无关，挂 DOM 即用。
// DSH Client 预览面板（M3）与 Playwright 截图页（M2）加载同一份模块，保证
// 「预览里看到的构图 = AI 截图分析拿到的画面」。
// 只能在浏览器里用（WebGL / OrbitControls）；Node 端不要 import 本文件。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  bonesOfMode,
  cameraFromPosition,
  cameraPosition,
  clampPlaybackRate,
  composeViewMode,
  DEFAULT_DISTANCE_FACTOR,
  DEFAULT_FOV,
  RENDER_FPS,
  surfaceOfMode,
  type SurfaceMode,
  type ViewState,
  type ViewMode,
} from '../viewstate.js';
import { collectAuxiliaryObjects } from './auxiliary.js';
import { createAxisGuides, createGroundAxisLines } from './axes.js';
import { suggestViewMode, collectSceneModeFacts, type ModeSuggestion } from './auto-mode.js';
import { computeClipPlanes } from './clip-planes.js';
import { lightRigFor, SOLID_MATERIAL_COLOR, TEXTURED_LIGHT_RIG } from './lighting.js';
import { isVertexColorAllDark, normalizePreviewMaterial } from './material.js';
import { currentPoseBounds, currentPoseBoundsInfo } from './scene-bounds.js';
import {
  applyRootMotionLock,
  captureRootPose,
  findRootMotionNodes,
  ROOT_MOTION_UNLOCKED,
  type RootMotionLock,
  type RootPoseEntry,
} from './root-motion.js';
import { attachSkeletonHelpers, createSkeletonHelpers, detachSkeletonHelpers } from './skeleton-helpers.js';
import type { CanonicalScene } from '../types.js';

/** B.4 标签像素基准：14px 文字（+上下衬底整高 24px）、Y 偏移 −6px，按 720p 画幅换算世界尺寸 */
const LABEL_BASE_HEIGHT_PX = 720;
const LABEL_FONT_PX = 14;
const LABEL_OFFSET_PX = 6;
/** 逐帧取景的留白系数（0.8.0）：精确透视取景后再放大 8%，避免边缘像素贴边 */
const SUBJECT_FIT_MARGIN = 1.08;

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
  /**
   * 表面方式（互斥）+ 骨架叠加开关（0.7.2 面板 UI 用）：与 `setMode` 的单一模式是同一套状态，
   * 只是拆成两个控件分别设置；`getViewState().mode` 仍会合成回 `ViewMode`（AI 契约不变）。
   */
  setDisplay(display: { surface: SurfaceMode; bones: boolean }): void;
  play(clipName?: string): void;
  pause(): void;
  /** 播放速度倍率（0.7.4）：1 = 原速；范围 0.05～4，越界自动夹紧 */
  setPlaybackRate(rate: number): void;
  /**
   * root motion 开关（0.9.0）：锁定位移 / 锁定旋转，让带位移的动作原地播放。
   * 只还原「最上层被动画节点」的 position/quaternion，肢体动画不受影响。
   */
  setRootMotionLock(lock: RootMotionLock): void;
  /** 当前模型是否有可锁的 root motion 载体（无动画/纯静态时 false，面板据此禁用开关） */
  rootMotionAvailable(): boolean;
  /** 跳帧：渲染完一帧后才 resolve（截图管线靠它保证确定性） */
  seekFrame(frame: number): Promise<void>;
  frameInfo(): ViewerFrameInfo | null;
  /** 当前场景全部动画轨道名（诊断绑定问题用） */
  trackNames(): string[];
  /** 场景级信息（截图管线解析 ViewState 缺省值时用） */
  sceneBounds(): { center: [number, number, number]; radius: number; clips: string[]; durationSeconds: number };
  /**
   * 载入后推荐的渲染模式（0.7.1）：无 mesh → skeleton；有 mesh 无可用贴图 → solid；
   * 有可用贴图 → default。reason 给面板一句人话（`no-mesh` / `no-texture` / `textured`）。
   */
  modeSuggestion(): ModeSuggestion;
  /**
   * 当前帧的「实际身体包围盒」（0.8.0，含蒙皮/位移）：root motion 动作截图取景用——
   * 载入时的包围盒是静止姿态，位移动作会跑出画面（近则只剩半截、远则只剩地面）。
   */
  subjectBounds(): { center: [number, number, number]; radius: number } | null;
  /**
   * 把相机对准当前帧身体包围盒（0.8.0）：只改 target 与距离（保持方位角/仰角/fov），
   * 用精确透视取景（包围盒 8 角投影反推距离）。返回取景所用的包围盒（无可见网格时 null）。
   */
  fitCameraToSubject(): { center: [number, number, number]; radius: number } | null;
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
  scene.background = new THREE.Color(options.background ?? 0x32373f);

  const camera = new THREE.PerspectiveCamera(40, width / height, 0.001, 1_000_000);
  camera.position.set(2, 2, 2);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;

  // ———————— 预览光照（0.6.4 贴图布光 / 0.6.7 素模布光）———————
  // 强度表与理由见 viewer/lighting.ts：同一组灯对象，按模式只改 intensity（不重编材质）。
  // solid 素模若沿用贴图布光（合计 8.4），Lambert 出射亮度会整块截断成纯白（0.6.6 实测 69% 像素 ≥250）。
  const ambient = new THREE.AmbientLight(0xffffff, TEXTURED_LIGHT_RIG.ambient);
  const hemi = new THREE.HemisphereLight(0xf4f7ff, 0x323842, TEXTURED_LIGHT_RIG.hemi);
  const keyLight = new THREE.DirectionalLight(0xffffff, TEXTURED_LIGHT_RIG.key);
  keyLight.position.set(4, 8, 6);
  const fillLight = new THREE.DirectionalLight(0xe4ecff, TEXTURED_LIGHT_RIG.fill);
  fillLight.position.set(-6, 3, -4);
  const rimLight = new THREE.DirectionalLight(0xffffff, TEXTURED_LIGHT_RIG.rim);
  rimLight.position.set(0, -4, -6);
  scene.add(ambient, hemi, keyLight, fillLight, rimLight);

  /** 套光照强度（0.7.2：只看表面方式——素模用自己的 studio 布光，其余沿用 0.6.4 贴图布光） */
  function applyLightRig(solidSurface: boolean): void {
    const rig = lightRigFor(solidSurface ? 'solid' : 'default');
    ambient.intensity = rig.ambient;
    hemi.intensity = rig.hemi;
    keyLight.intensity = rig.key;
    fillLight.intensity = rig.fill;
    rimLight.intensity = rig.rim;
  }

  /**
   * 裁剪面跟随观察距离（0.6.8）：修「播放/拖动视角时模型表面碎成斑点」。
   * 原 near/far = 0.001 / 1e6（跨 9 个数量级）。透视深度缓冲的精度几乎全被 near 决定：
   * 24 位深度在 z≈100 处的可分辨厚度 ≈ z²/(near·2^24) ≈ 0.6 单位。而这类厘米级游戏资产里
   * 「皮肤 vs 短裤/护膝」两层表面只差 0.1～0.3 单位 → 互抢深度，表面碎成明暗斑点（z-fighting）。
   * 按观察距离重设 near = distance×0.02、far = distance×20（跨 3 个数量级）后，
   * 同一位置的可分辨厚度降到 ≈0.0003 单位，多层表面能正常分层。
   */
  function updateClipPlanes(): void {
    const { near, far } = computeClipPlanes(camera.position.distanceTo(controls.target), bounds.radius);
    if (Math.abs(camera.near - near) > near * 1e-3 || Math.abs(camera.far - far) > far * 1e-3) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
  }
  // 拖动 / 滚轮缩放后距离变了，裁剪面跟着走（否则拉近看细节时又退回低精度）
  controls.addEventListener('change', updateClipPlanes);

  let grid = new THREE.GridHelper(10, 20, 0x565d68, 0x454b54);
  // 地面上的 X/Z 轴长线（随网格一起缩放，指示正方向）
  const axisLength = 5;
  const groundAxes = createGroundAxisLines(axisLength);
  grid.add(...groundAxes);
  scene.add(grid);

  // 0.8.1：左下角全局 XYZ 轴指示器（HUD gizmo）——X 红 / Y 绿 / Z 蓝 + 字母标签，
  // 每帧跟随主相机朝向、独立正交相机渲染在固定像素框里（常规 3D 工具的做法）：
  // 不会跟模型抢画面、不被遮挡，AI 截图里也能读到朝向。
  const axisScene = new THREE.Scene();
  const axisGizmo = createAxisGuides(1, 0.5);
  axisScene.add(...axisGizmo.lines, ...axisGizmo.labels);
  const axisCamera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.01, 20);

  /** 主场景渲染 + 左下角轴指示器（所有立即出帧路径都走这里，保证截图/预览一致） */
  function renderFrame(): void {
    renderer.autoClear = true;
    renderer.setViewport(0, 0, renderer.domElement.width / renderer.getPixelRatio(), renderer.domElement.height / renderer.getPixelRatio());
    renderer.setScissorTest(false);
    renderer.render(scene, camera);
    // 轴指示器：固定像素框（随画幅短边缩放），叠在左下角
    const size = renderer.getSize(new THREE.Vector2());
    const box = Math.max(64, Math.round(Math.min(size.x, size.y) * 0.18));
    const margin = Math.max(8, Math.round(Math.min(size.x, size.y) * 0.02));
    const offset = camera.position.clone().sub(controls.target);
    if (offset.lengthSq() > 0) {
      axisCamera.position.copy(offset.normalize().multiplyScalar(4));
      axisCamera.up.copy(camera.up);
      axisCamera.lookAt(0, 0, 0);
      axisCamera.updateMatrixWorld();
      renderer.autoClear = false;
      renderer.setViewport(margin, margin, box, box);
      renderer.setScissor(margin, margin, box, box);
      renderer.setScissorTest(true);
      renderer.clearDepth();
      renderer.render(axisScene, axisCamera);
      renderer.setScissorTest(false);
      renderer.autoClear = true;
    }
  }

  /** solid 素模模式共享材质：中性灰 + 受光照，常规 3D 工具的 solid shading。
   *  DoubleSide：游戏资产常为单面，头发/裙摆从背面看会破洞。 */
  const solidMaterial = new THREE.MeshLambertMaterial({ color: SOLID_MATERIAL_COLOR, side: THREE.DoubleSide });
  /** 贴图异步复查定时器（换模型/卸载时清理） */
  let textureCheckTimer: number | null = null;
  /** FBX 自带辅助对象（Dummy/locator/线框 gizmo 等），载入时隐藏（常规 3D 工具同样不显示） */
  let suppressedAux: THREE.Object3D[] = [];

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
  /** 播放速度倍率（0.7.4）：只有播放推进受它影响，seek 与截图永远按真实帧号 */
  let playbackRate = 1;
  /** root motion 开关（0.9.0）：锁定位移 / 锁定旋转，让带位移的动作原地播放 */
  let rootMotionLock: RootMotionLock = { ...ROOT_MOTION_UNLOCKED };
  /** root motion 载体 + 载入静止姿态的参考值（每帧按开关写回） */
  let rootPose: RootPoseEntry[] = [];
  // 0.7.2：表面显示方式（互斥）与骨架叠加开关解耦——面板上素模/贴图/线框三选一，骨架单独勾选
  let surface: SurfaceMode = 'default';
  let bonesVisible = false;
  /** 当前模型是否有网格（无网格时模式口径一律按 skeleton，AI 侧不会误判） */
  let modelHasMesh = false;
  let currentView: ViewState | null = null;

  const clock = new THREE.Clock();
  const seekResolvers: Array<() => void> = [];
  let firstFrameResolve: (() => void) | null = null;
  const firstFrame = new Promise<void>((resolve) => {
    firstFrameResolve = resolve;
  });

  /** 渲染循环异常只记一次：不让单次异常掐断整条 rAF 链（three 的 setAnimationLoop 在回调抛错后
   *  不会排下一帧，循环一死画面就永久静止——「点轨道/播放条跳转不刷新显示」就是这个症状） */
  let renderErrorLogged = false;
  const renderLoop = (): void => {
    try {
      const delta = clock.getDelta();
      if (mixer !== null && activeAction !== null && (playing || seekResolvers.length > 0)) {
        const duration = activeAction.getClip().duration;
        if (playing) {
          frame = (frame + delta * RENDER_FPS * playbackRate) % Math.max(duration * RENDER_FPS, 1 / RENDER_FPS);
        }
        mixer.setTime(frame / RENDER_FPS);
        applyRootMotionLock(rootPose, rootMotionLock);
      }
      controls.update();
      positionBoneLabels();
      renderFrame();
      if (firstFrameResolve !== null) {
        firstFrameResolve();
        firstFrameResolve = null;
      }
      while (seekResolvers.length > 0) seekResolvers.pop()?.();
    } catch (error) {
      if (!renderErrorLogged) {
        renderErrorLogged = true;
        console.error('[kinemesh] 渲染循环异常（已忽略，循环继续）：', error);
      }
    }
  };
  /** 重新挂上动画循环：任何一次用户交互都顺手确保循环活着（上下文丢失/异常后能自愈） */
  function ensureRenderLoop(): void {
    renderer.setAnimationLoop(renderLoop);
  }
  renderer.setAnimationLoop(renderLoop);

  // WebGL 上下文丢失/恢复：DSH 里同时存在多个预览画布时 Chromium 会回收上下文，
  // 不处理的话画布会永久停在最后一帧（交互区还在动，但 3D 画面不刷新）
  let contextLost = false;
  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    contextLost = true;
    console.warn('[kinemesh] WebGL 上下文丢失，等待恢复');
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    contextLost = false;
    ensureRenderLoop();
    renderFrame();
  });

  function clearModel(): void {
    clearBoneLabels();
    if (model === null) return;
    scene.remove(model);
    model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        // solid 模式下 mesh.material 是共享的 solidMaterial：不能 dispose（下一个模型还要用它），
        // 要释放的是被替换下来的原始材质（0.6.8 顺带修正：原实现既漏释放原始材质，又会把共享材质销毁）
        const stored = (mesh.userData as Record<string, unknown>).kinemeshOriginalMaterial as
          | THREE.Material
          | THREE.Material[]
          | null
          | undefined;
        const originals: THREE.Material[] =
          stored === undefined || stored === null
            ? Array.isArray(mesh.material)
              ? mesh.material
              : [mesh.material]
            : Array.isArray(stored)
              ? stored
              : [stored];
        for (const material of originals) {
          if (material !== undefined && material !== null && material !== solidMaterial) material.dispose();
        }
      }
    });
    model = null;
    modelRawClips = [];
    mixer = null;
    actions = new Map();
    activeAction = null;
    // 骨架线必须显式从 scene 摘掉（它不在 model 层级里），否则旧骨架残留在下一个模型上
    detachSkeletonHelpers(scene, skeletons);
    skeletons = [];
    suppressedAux = [];
  }

  function applyMode(): void {
    // 光照先于几何：素模与贴图模式要用的布光强度不同（模型未载入时也先把灯设好，
    // 避免「先设 solid 再载模型」前几帧用错布光）
    applyLightRig(surface === 'solid');
    if (model === null) return;
    for (const helper of skeletons) helper.visible = bonesVisible;
    model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.visible = surface !== 'none';
      // solid 素模（0.6.5）：用共享中性灰材质替换原材质，一键看清几何/动作，不受贴图与材质问题影响
      const stored = (mesh.userData as Record<string, unknown>).kinemeshOriginalMaterial as THREE.Material | THREE.Material[] | undefined;
      if (surface === 'solid') {
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
          wireframeFlag.wireframe = surface === 'wireframe';
        }
      }
    });
    // 地面网格在每个渲染模式都显示（0.6.10）：线框/骨架/骨骼叠加模式下同样需要地面与轴向参照。
    // 注意 grid 不参与模型包围盒计算（见 loadScene 的 Box3 只算 model），所以显示它不会影响机位适配。
    grid.visible = true;
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
        renderFrame();
      }, 1200);
      // 辅助对象过滤：Unity/Max 导出的 FBX 常带 Dummy、IK 目标、locator、线框 gizmo，
      // 预览里会变成虚线/尖刺/红绿轴等杂线（常规 3D 工具默认不显示）。只隐藏、不删除；
      // 骨骼（Bone）永不触碰——蒙皮依赖骨骼层级。
      suppressedAux = collectAuxiliaryObjects(model);
      for (const aux of suppressedAux) aux.visible = false;
      // 0.7.2：记录「有没有网格」——无网格模型的模式口径一律按 skeleton（与自动选模式同源）
      modelHasMesh = collectSceneModeFacts(model).meshCount > 0;
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
      // 0.9.0：记录 root motion 载体（最上层被动画节点）的载入静止姿态，供「锁定位移/旋转」用
      rootPose = captureRootPose(findRootMotionNodes(model, clips));
      // 骨架线挂在 scene 上（生命周期见 viewer/skeleton-helpers.ts）：换模型时由 clearModel 摘除
      skeletons = createSkeletonHelpers(model);
      attachSkeletonHelpers(scene, skeletons);
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
      updateClipPlanes();
    },

    applyView(view) {
      currentView = view;
      const position = cameraPosition(view.camera);
      camera.position.set(position[0], position[1], position[2]);
      camera.fov = view.camera.fov;
      camera.updateProjectionMatrix();
      controls.target.set(view.camera.target[0], view.camera.target[1], view.camera.target[2]);
      controls.update();
      updateClipPlanes();
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
      // 0.9.0：root motion 开关是「观看方式」，每次应用视角后都重新套一遍并立即出帧
      applyRootMotionLock(rootPose, rootMotionLock);
      renderFrame();
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
        mode: composeViewMode(surface, bonesVisible, modelHasMesh),
      };
    },

    setMode(next) {
      setModeInternal(next);
    },

    setDisplay(next) {
      surface = next.surface;
      bonesVisible = next.bones;
      applyMode();
      renderFrame();
      ensureRenderLoop();
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
      ensureRenderLoop();
    },

    pause() {
      pauseInternal();
    },

    setPlaybackRate(rate) {
      playbackRate = clampPlaybackRate(rate);
    },

    setRootMotionLock(lock) {
      rootMotionLock = { translation: lock.translation === true, rotation: lock.rotation === true };
      applyRootMotionLock(rootPose, rootMotionLock);
      renderFrame();
    },

    rootMotionAvailable() {
      return rootPose.length > 0;
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
      // 0.7.5：paused 的 action 吃不动 mixer.setTime（会永远停在第 0 帧），scrub 前先解开
      if (action.paused) action.paused = false;
      mixer.setTime(frame / RENDER_FPS);
      applyRootMotionLock(rootPose, rootMotionLock);
      // 立即出帧：跳转必须马上可见，不能等渲染循环（循环若停过就永远等不到）
      renderFrame();
      ensureRenderLoop();
      return new Promise<void>((resolve) => {
        seekResolvers.push(resolve);
        // 兜底：渲染循环真停了（上下文丢失等）也不能让 seek 挂死——250ms 后自己补一帧并 resolve
        window.setTimeout(() => {
          const index = seekResolvers.indexOf(resolve);
          if (index < 0) return;
          seekResolvers.splice(index, 1);
          renderFrame();
          resolve();
        }, 250);
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

    modeSuggestion() {
      // 实时按当前模型现算：贴图是异步解码的，载入瞬间可能还没 image，
      // 客户端会在贴图复查后再问一次（0.7.1）
      if (model === null) return { mode: 'solid', reason: 'no-texture' };
      return suggestViewMode(model);
    },

    subjectBounds() {
      if (model === null) return null;
      return currentPoseBoundsInfo(model);
    },

    fitCameraToSubject() {
      if (model === null) return null;
      const box = currentPoseBounds(model);
      if (box === null) return null;
      const center = box.getCenter(new THREE.Vector3());
      const cameraData = cameraFromPosition(
        [camera.position.x, camera.position.y, camera.position.z],
        [controls.target.x, controls.target.y, controls.target.z],
        camera.fov,
      );
      // 精确透视取景：把包围盒 8 个角投到「相机朝向坐标系」，逐角算「该角刚好进画」所需距离，
      // 取最大值。比「包围球半径 × 2.2」这类经验值可靠——大姿态（举拳、前倾、伸腿）不会切边。
      const forward = new THREE.Vector3().subVectors(center, camera.position).normalize();
      const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3().crossVectors(right, forward).normalize();
      const tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
      const aspect = camera.aspect > 0 ? camera.aspect : 16 / 9;
      const corner = new THREE.Vector3();
      let distance = 0;
      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            corner.set(x, y, z).sub(center);
            const depth = corner.dot(forward);
            const needVertical = depth + Math.abs(corner.dot(up)) / tanHalfFov;
            const needHorizontal = depth + Math.abs(corner.dot(right)) / (tanHalfFov * aspect);
            distance = Math.max(distance, needVertical, needHorizontal);
          }
        }
      }
      distance = Math.max(distance * SUBJECT_FIT_MARGIN, (box.getSize(new THREE.Vector3()).length() / 2) * 1.05);
      const position = cameraPosition({ ...cameraData, distance, target: [center.x, center.y, center.z] });
      camera.position.set(position[0], position[1], position[2]);
      controls.target.set(center.x, center.y, center.z);
      controls.update();
      updateClipPlanes();
      renderFrame();
      const size = box.getSize(new THREE.Vector3());
      return {
        center: [center.x, center.y, center.z],
        radius: Math.max(size.length() / 2, 0.001),
      };
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
      renderFrame();
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
          renderFrame();
        });
  if (resizeObserver !== null) resizeObserver.observe(container);

  /** 旧 `ViewMode` 入口（AI 截图 / CLI / MCP / 内存回写）：拆成「表面 + 骨架」两个开关 */
  function setModeInternal(next: ViewMode): void {
    surface = surfaceOfMode(next);
    bonesVisible = bonesOfMode(next);
    applyMode();
    // 立即出一张帧：截图管线在 applyView 后立即截图，不等下一个 rAF
    renderFrame();
    ensureRenderLoop();
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
    // 标注层永远可读：压过骨骼线与地面网格（depthTest:false，任何模式下都不被遮挡）
    sprite.renderOrder = 999;
    return sprite;
  }

  /**
   * 暂停（0.7.5 修正）：**只清 playing 标志，绝不设 `action.paused = true`**。
   *
   * 踩过的坑：three 的 `AnimationAction.paused` 会把 `_effectiveTimeScale` 归零，于是
   * `mixer.setTime(t)` 里的 `deltaTime *= _updateTimeScale()` 变成 0——action 的时间停在
   * `setTime` 刚重置的 0 上，姿势永远回到**第 0 帧**。表现就是「暂停之后点轨道/播放条跳转，
   * 帧号和播放头在动、3D 画面不动（其实是永远停在第 0 帧）」，而再次播放又正常。
   * 我们的渲染循环本来就用 `playing` 门控是否推进，不需要 paused 这个开关。
   */
  function pauseInternal(): void {
    playing = false;
  }

  function clampFrame(requested: number, durationSeconds: number): number {
    const maxFrame = Math.max(0, Math.floor(durationSeconds * RENDER_FPS));
    return Math.min(Math.max(0, Math.floor(requested)), maxFrame);
  }

  return handle;
}
