// 角色根节点的 XYZ 参考轴（0.9.1，用户需求）：在「角色根节点」的世界位置上画一小段 X/Y/Z 三轴
// （X 红 / Y 绿 / Z 蓝 + 字母标签），用来直观看到根节点在哪、朝向如何。
//
// 与 0.8.1 的左下角 HUD 指示器的分工：
// · HUD 指示器 = 全局朝向（固定在屏幕左下角，不跟随模型）；
// · 根节点轴 = 角色根节点的**世界位置 + 朝向**（跟着根节点走；开 root motion 时能直接看到
//   位移/转身轨迹，开启「锁定位移」后它就会定在原地）。
//
// 只在预览里默认开启（viewer 的 mount 选项 rootAxes）；截图管线不开，避免给 AI 读图添杂线。
// 线用 depthTest:false：根节点常在模型体内（骨盆/腰部），否则根本看不见。
import * as THREE from 'three';
import { AXIS_COLORS, AXIS_LABEL_COLORS } from './axes.js';

export interface RootAxes {
  /** 挂到场景里的容器（位置/朝向/缩放每帧由 update 更新） */
  group: THREE.Group;
  /**
   * 跟随根节点：位置 = 节点世界坐标，朝向 = 节点世界四元数，轴向长度 = worldLength。
   * node 为 null 时隐藏（无模型/无根节点）。
   */
  update(node: THREE.Object3D | null, worldLength: number): void;
}

/**
 * @param labelHeight 标签高度（相对轴长 1 的比例，最终随 worldLength 一起缩放）
 */
export function createRootAxes(labelHeight = 0.3): RootAxes {
  const group = new THREE.Group();
  group.renderOrder = 997;
  const axes: Array<{ to: [number, number, number]; color: number; text: string; textColor: string }> = [
    { to: [1, 0, 0], color: AXIS_COLORS.x, text: 'X', textColor: AXIS_LABEL_COLORS.x },
    { to: [0, 1, 0], color: AXIS_COLORS.y, text: 'Y', textColor: AXIS_LABEL_COLORS.y },
    { to: [0, 0, 1], color: AXIS_COLORS.z, text: 'Z', textColor: AXIS_LABEL_COLORS.z },
  ];
  for (const axis of axes) {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(...axis.to),
    ]);
    const material = new THREE.LineBasicMaterial({ color: axis.color, depthTest: false, transparent: true });
    const line = new THREE.Line(geometry, material);
    line.renderOrder = 997;
    group.add(line);
    const label = makeLabelSprite(axis.text, axis.textColor, labelHeight);
    if (label !== null) {
      label.position.set(axis.to[0] * 1.12, axis.to[1] * 1.12, axis.to[2] * 1.12);
      group.add(label);
    }
  }
  group.visible = false;

  const scratchPosition = new THREE.Vector3();
  const scratchQuaternion = new THREE.Quaternion();
  return {
    group,
    update(node, worldLength) {
      if (node === null) {
        group.visible = false;
        return;
      }
      node.getWorldPosition(scratchPosition);
      node.getWorldQuaternion(scratchQuaternion);
      group.position.copy(scratchPosition);
      group.quaternion.copy(scratchQuaternion);
      // 轴线按单位长度建模，缩放即世界长度；标签高度一起等比
      group.scale.setScalar(Math.max(worldLength, 1e-4));
      group.visible = true;
    },
  };
}

/** 轴端字母精灵（深色描边 + 主题外的高对比配色，压过模型与网格） */
function makeLabelSprite(text: string, color: string, labelHeight: number): THREE.Sprite | null {
  if (typeof document === 'undefined') return null;
  const px = 64;
  const canvas = document.createElement('canvas');
  const probe = canvas.getContext('2d');
  if (probe === null) return null;
  const font = `700 ${px - 18}px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`;
  probe.font = font;
  const textWidth = Math.ceil(probe.measureText(text).width);
  canvas.width = Math.max(textWidth + 14, px);
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(14, 16, 20, 0.9)';
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2 + 2);
  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set((labelHeight * canvas.width) / canvas.height, labelHeight, 1);
  sprite.renderOrder = 998;
  return sprite;
}
