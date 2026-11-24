// 全局 XYZ 轴参考（0.8.1）：常规 3D 工具的取向习惯——X 红、Y 绿、Z 蓝，轴末端带字母标签。
//
// 为什么要有：地面网格只画了 X/Z 两条线（0.6.6），没有 Y 轴、也没有字母，用户在预览里只能靠
// 轴线颜色猜朝向。这里一次性补齐三根轴线 + 末端 X/Y/Z 文字标签（Sprite，始终朝向相机；
// depthTest:false 所以永远压在模型/网格之上，就像 DCC 的轴端标记）。
//
// 纯对象操作（three 几何 + canvas 贴图），Node 端可建线（无 document 时不出标签）。
import * as THREE from 'three';

/** 全局轴配色：与 0.6.6 的网格轴线一致（X 偏红 / Z 偏蓝），补齐 Y 偏绿 */
export const AXIS_COLORS = {
  x: 0xb4554f,
  y: 0x57a85f,
  z: 0x4f74b4,
} as const;

/** 轴标签文字颜色（比轴线亮一点，深色舞台下更清楚） */
export const AXIS_LABEL_COLORS = {
  x: '#e5837c',
  y: '#79d68a',
  z: '#84a7f0',
} as const;

export interface AxisGuides {
  /** 三根轴线（X/Y/Z，从原点指到正方向 length） */
  lines: THREE.Line[];
  /** 轴末端文字标签；非浏览器环境（无 document）为空数组 */
  labels: THREE.Sprite[];
}

/** 地面网格上的 X/Z 轴长线（从 -length 到 +length；Y 轴留给左下角指示器） */export function createGroundAxisLines(length: number): THREE.Line[] {
  const makeLine = (from: [number, number, number], to: [number, number, number], color: number): THREE.Line => {
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...from), new THREE.Vector3(...to)]);
    return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color }));
  };
  return [
    makeLine([-length, 0, 0], [length, 0, 0], AXIS_COLORS.x),
    makeLine([0, 0, -length], [0, 0, length], AXIS_COLORS.z),
  ];
}

/**
 * 建全局轴参考：三根轴线 + 三枚轴端字母标签。
 * @param length    轴线长度（场景单位；viewer 里用网格的 5 单位，随网格一起缩放）
 * @param labelHeight 标签世界高度（同样会被网格缩放，0.7 换算到身高 186 的模型约 35px）
 */
export function createAxisGuides(length: number, labelHeight = 0.7): AxisGuides {
  const lines: THREE.Line[] = [];
  const labels: THREE.Sprite[] = [];

  const makeLine = (to: [number, number, number], color: number): THREE.Line => {
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(...to)]);
    return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color }));
  };

  const axes: Array<{ key: 'x' | 'y' | 'z'; to: [number, number, number] }> = [
    { key: 'x', to: [length, 0, 0] },
    { key: 'y', to: [0, length, 0] },
    { key: 'z', to: [0, 0, length] },
  ];
  for (const axis of axes) {
    lines.push(makeLine(axis.to, AXIS_COLORS[axis.key]));
    const label = makeAxisLabel(axis.key.toUpperCase(), AXIS_LABEL_COLORS[axis.key], labelHeight);
    if (label !== null) {
      // 标签放在轴线末端稍外一点，避免和轴线/模型重叠
      label.position.set(axis.to[0] * 1.08, axis.to[1] * 1.08, axis.to[2] * 1.08);
      labels.push(label);
    }
  }
  return { lines, labels };
}

/** 轴端字母精灵：canvas 2D 画字 + 深色描边保证在亮/暗背景都读得清 */
function makeAxisLabel(text: string, color: string, worldHeight: number): THREE.Sprite | null {
  if (typeof document === 'undefined') return null;
  const px = 64;
  const canvas = document.createElement('canvas');
  const probe = canvas.getContext('2d');
  if (probe === null) return null;
  const font = `700 ${px - 16}px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`;
  probe.font = font;
  const textWidth = Math.ceil(probe.measureText(text).width);
  canvas.width = Math.max(textWidth + 16, px);
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  // canvas 尺寸赋值会重置 context，字体要重设
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
  sprite.scale.set((worldHeight * canvas.width) / canvas.height, worldHeight, 1);
  // 压过模型与网格，任何渲染模式下都能读到朝向
  sprite.renderOrder = 998;
  return sprite;
}
