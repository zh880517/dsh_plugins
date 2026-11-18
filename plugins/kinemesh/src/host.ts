// Host 半入口：Agent 工具注册。
// M1 只有 kinemesh_info；M3 起追加 /kinemesh 前缀的 webServer 路由与
// 「发送给 AI 分析」链路（届时 inject 追加 'webServer'）。
import { registerTools } from './tools.js';

export const inject = ['tools'];

export function apply(ctx: any): void {
  ctx.effect(() => registerTools(ctx));
}
