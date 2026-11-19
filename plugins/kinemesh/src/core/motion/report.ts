// 中间文件落盘（design.md §6.4 / 附录 A.11–A.13）：JSON / CSV / SVG 序列化。
// M6a 先落 frames.csv（每采样帧一行）；summary / segments / keyframes / trajectory 随 M6b 扩展。
// 圆整口径（A.14）：长度/速度 3 位小数，角度 1 位；CSV 布尔用 true/false。
import type { FrameChannels } from './channels.js';

export const FRAMES_CSV_COLUMNS = [
  'frame',
  'time',
  'energy',
  'energyLevel',
  'root_x',
  'root_y',
  'root_z',
  'heading',
  'turnTotal',
  'moveDir',
  'moveDirBody',
  'moveSpeed',
  'contactL',
  'contactR',
  'airborne',
  'support',
  'topJoint',
  'topJointSpeed',
  'amplitude',
] as const;

/** 定长小数；把 "-0.000" 这类负零圆整结果归一成非负（避免 CSV 出现 "-0.0"） */
function fixed(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return text.startsWith('-') && Number(text) === 0 ? text.slice(1) : text;
}

/** 长度/速度：3 位小数（A.14） */
export function roundLength(value: number): string {
  return fixed(value, 3);
}

/** 角度：1 位小数（A.14） */
export function roundAngle(value: number): string {
  return fixed(value, 1);
}

/** 每采样帧一行的通道明细（§6.4 motion-frames.csv） */
export function framesCsv(channels: FrameChannels): string {
  const length = (values: number[], k: number): number => values[k] ?? 0;
  const word = (values: string[], k: number): string => values[k] ?? '';
  const flag = (values: boolean[], k: number): boolean => values[k] ?? false;
  const lines: string[] = [FRAMES_CSV_COLUMNS.join(',')];
  for (let k = 0; k < channels.frameCount; k += 1) {
    lines.push(
      [
        String(channels.frames[k] ?? k),
        roundLength(length(channels.times, k)),
        roundLength(length(channels.energy, k)),
        word(channels.energyLevel, k),
        roundLength(length(channels.rootX, k)),
        roundLength(length(channels.rootY, k)),
        roundLength(length(channels.rootZ, k)),
        roundAngle(length(channels.heading, k)),
        roundAngle(length(channels.turnTotal, k)),
        word(channels.moveDir, k),
        word(channels.moveDirBody, k),
        roundLength(length(channels.moveSpeed, k)),
        flag(channels.contactL, k) ? 'true' : 'false',
        flag(channels.contactR, k) ? 'true' : 'false',
        flag(channels.airborne, k) ? 'true' : 'false',
        word(channels.support, k),
        word(channels.topJoint, k),
        roundLength(length(channels.topJointSpeed, k)),
        roundLength(length(channels.amplitude, k)),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
