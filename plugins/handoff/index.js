import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
//#region
/** 默认交接备份目录：`~/.dsh/handoff`。 */
function handoffHome() {
	const override = process.env["HANDOFF_HOME"];
	if (override !== void 0 && override.trim() !== "") return path.resolve(override.trim());
	return path.join(os.homedir(), ".dsh", "handoff");
}
/** 把会话 id 收敛成安全文件名：只保留字母、数字与 `._-`。 */
function safeSessionId(sessionId) {
	const cleaned = sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
	return cleaned === "" ? "session" : cleaned;
}
/** `yyyyMMdd-HHmmss`（本地时区）。 */
function timestamp(date) {
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
/**
* 交接单备份文件名：`<sessionId>-<yyyyMMdd-HHmmss>.md`。
*
* @param sessionId - DSH 会话 id。
* @param now - 时间戳来源。
* @returns 文件名（不含目录）。
*/
function handoffBackupFileName(sessionId, now) {
	return `${safeSessionId(sessionId)}-${timestamp(now)}.md`;
}
/**
* 把交接单写到备份目录，返回写入的绝对路径。
*
* 目录不存在时自建（`recursive: true`）；正文末尾补一个换行（已有则不重复补）。
* 任何失败都抛错，调用方必须据此放弃交接。
*
* @param request - 会话 id、正文与可选的时间/目录覆盖。
* @returns 备份文件的绝对路径。
*/
async function writeBackup(request) {
	const home = request.home !== void 0 && request.home.trim() !== "" ? path.resolve(request.home.trim()) : handoffHome();
	const file = path.resolve(path.join(home, handoffBackupFileName(request.sessionId, request.now ?? /* @__PURE__ */ new Date())));
	const body = request.doc.endsWith("\n") ? request.doc : `${request.doc}\n`;
	try {
		await mkdir(home, { recursive: true });
		await writeFile(file, body, "utf8");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`handoff backup failed: ${reason}`, { cause: error });
	}
	return file;
}
//#endregion
//#region
/**
* 前导注入节点（会被保留下来的那些）：工作区指令基线、developer 消息、追加的 system 消息。
*
* `dsh-agent-instructions` 注入的基线是一条 `user/message`，`source.kind` 为
* `agent-instructions`（见该插件源码）。DSH 目前没有在 replace 后自动重注工作区指令的
* 保证（design.md §9 V1 待真机验证），所以 P1 保守地把它们留在前面。
*/
function isLeadingInjection(node) {
	if (node.type === "system/message" || node.type === "developer/message") return true;
	return node.type === "user/message" && node.sourceKind === "agent-instructions";
}
/**
* 计算要保留的**前导节点数**：至少保住 system 头（surface 头确实是 `system/message` 时
* 保留 1 个），再把紧跟其后的前导注入节点一起留下。
*
* 只跳过**开头连续**的注入节点：中途出现的注入（例如后续的指令更新）仍属于会话后缀，
* 会被交接遮蔽。
*
* @param nodes - `session.surface.nodes` 对应的节点视图，按 surface 顺序。
* @returns 前导保留数量，范围 `0..nodes.length`；空 surface 返回 0。
*/
function pinnedNodeCount(nodes) {
	const head = nodes[0];
	if (head === void 0) return 0;
	let pinned = head.type === "system/message" ? 1 : 0;
	while (pinned < nodes.length) {
		const node = nodes[pinned];
		if (node === void 0 || !isLeadingInjection(node)) break;
		pinned += 1;
	}
	return pinned;
}
/**
* 从 `surface.nodes` 算出被遮蔽的**后缀**：保留前 `pinnedCount` 个节点，其余全部遮蔽。
*
* 后缀性质保证所有 tool call / result 对都完整落在区间内，不会切断配对（design.md §4.3）。
*
* @param nodes - `session.surface.nodes`（seq 数组），按 surface 顺序。
* @param pinnedCount - `pinnedNodeCount` 的结果；越界会被收敛到 `0..nodes.length`。
* @returns 遮蔽区间；没有可遮蔽历史时返回 `null`。
*/
function shadowedRange(nodes, pinnedCount) {
	const pinned = Math.min(Number.isSafeInteger(pinnedCount) && pinnedCount > 0 ? pinnedCount : 0, nodes.length);
	const seqs = nodes.slice(pinned);
	const startSeq = seqs[0];
	const endSeq = seqs[seqs.length - 1];
	if (startSeq === void 0 || endSeq === void 0) return null;
	return {
		startSeq,
		endSeq,
		seqs
	};
}
/**
* 最新一条 `session/end-seed` 在事件视图里的下标；没有就返回 `-1`。
*
* fork 出来的会话以 `session/end-seed` 收尾：`dsh-session` 的 `buildForkSeed`
* 只闭合 turn（补 `turn/end`），**不闭合** `compaction/start`。压缩后端自己承认这个
* 例外：未配对的 `compaction/start` 如果早于最新的 `session/end-seed`，就不算活跃
* （`dsh-compaction-basic` 的 `assertCompactionInactive`）。所以这里也只能看
* "最新 seed 之后"的事件。
*/
function latestEndSeedIndex(events) {
	for (let index = events.length - 1; index >= 0; index -= 1) if (events[index]?.type === "session/end-seed") return index;
	return -1;
}
/**
* 判断会话当前能否交接：只看**最新 `session/end-seed` 之后**的事件，从末尾往旧扫，
* 遇到未闭合的标记就停。
*
* - `turn/start` 没有配对的 `turn/end` → 有轮次在跑：`open-turn`
* - `compaction/start` 没有配对的 `compaction/end` → 压缩正在进行：`open-compaction`
* - 两者都已闭合（或从未出现）→ `idle`
*
* seed 之前的事件属于上一段会话生命周期（fork 时被冻结的父会话）：`buildForkSeed`
* 不闭合 compaction，若把它们算进来，从"压缩进行中"的会话 fork 出来的新会话会永久
* 返回 `open-compaction`、永远无法交接。
*
* 两个标记都未闭合时，返回**离末尾最近**的那一个，因为它是当前正在发生的事。
* 两种忙碌在结果文案上不区分（都提示"轮次运行或压缩进行中"）。
*
* @param events - 整段事件日志的只读视图，必须按 seq 升序（允许包含种子/继承事件）。
* @returns 忙碌原因；`idle` 表示可以进入摘要流程。
*/
function inspectBusy(events) {
	let turnSettled = false;
	let compactionSettled = false;
	const boundary = latestEndSeedIndex(events);
	for (let index = events.length - 1; index > boundary; index -= 1) {
		const event = events[index];
		if (event === void 0) continue;
		if (!turnSettled) {
			if (event.type === "turn/start") return "open-turn";
			if (event.type === "turn/end") turnSettled = true;
		}
		if (!compactionSettled) {
			if (event.type === "compaction/start") return "open-compaction";
			if (event.type === "compaction/end") compactionSettled = true;
		}
		if (turnSettled && compactionSettled) break;
	}
	return "idle";
}
//#endregion
//#region
/**
* 交接单指令：design.md §4.2 的原文，一字不改。
*
* 改动它等于改交接单的结构（§6），需要先改设计文档。
*/
var HANDOFF_INSTRUCTION = `You are a handoff engine. Condense the conversation ABOVE into a handoff document
that lets another model resume the work, and that a human can review later.
Output EXACTLY this Markdown structure, keeping every section (write "(none)" when empty):

# 交接：<阶段名>
## 目标
## 不变式
## 当前状态
## 关键决策
## 死路
## 下一步
## 指针

Preserve exact file paths, commands, error strings, identifiers and numbers.
Do not mention this summary request. Output only the document; do not call tools.`;
/**
* 从请求头读输出上限：只在是正整数时才算数（DSH 对 `maxTokens` 的约束同款）。
* 读不到就返回 `undefined`，调用方据此**省略** `maxTokens` key。
*/
function readMaxTokens(config) {
	const value = config?.maxTokens;
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
/** 解析目标模型：先上次请求的 header，再 `agent.options`；`maxTokens` 只来自 header。 */
function resolveTarget(agent) {
	const config = agent.session.requestHeader()?.config;
	const maxTokens = readMaxTokens(config);
	if (config !== void 0 && typeof config.provider === "string" && config.provider.length > 0 && typeof config.model === "string" && config.model.length > 0) return {
		provider: config.provider,
		model: config.model,
		...maxTokens === void 0 ? {} : { maxTokens }
	};
	const provider = agent.options.provider;
	const model = agent.options.model;
	if (typeof provider === "string" && provider.length > 0 && typeof model === "string" && model.length > 0) return {
		provider,
		model,
		...maxTokens === void 0 ? {} : { maxTokens }
	};
	throw new Error("no provider/model available for the handoff summary: the session has no routed request header and no agent options");
}
/** 把 chunk 流拼成文本：优先 text-delta，缺失时退回 block-end 的完整块。 */
async function collectText(stream) {
	const texts = /* @__PURE__ */ new Map();
	let finish;
	for await (const chunk of stream) switch (chunk.type) {
		case "text-delta":
			texts.set(chunk.index, (texts.get(chunk.index) ?? "") + chunk.text);
			break;
		case "block-end":
			if (chunk.block.type === "text" && (texts.get(chunk.index) ?? "").trim() === "") texts.set(chunk.index, chunk.block.text ?? "");
			break;
		case "finish": finish = chunk.reason;
	}
	return {
		text: [...texts.entries()].sort((left, right) => left[0] - right[0]).map(([, value]) => value).join("\n\n").trim(),
		finish
	};
}
/** 把终止原因翻译成 fail-closed 的错误；只有正常结束（stop / 无 finish）返回 null。 */
function finishFailure(finish) {
	if (finish === void 0) return null;
	switch (finish.kind) {
		case "stop": return null;
		case "max-tokens": return /* @__PURE__ */ new Error("handoff summary truncated at the token cap (incomplete handoff document)");
		case "tool-calls": return /* @__PURE__ */ new Error("handoff summary ended in a tool call instead of a handoff document");
		case "error":
		case "aborted": {
			const message = finish.failure?.message;
			return new Error(typeof message === "string" && message.length > 0 ? message : `handoff summary stream finished with "${finish.kind}"`);
		}
		default: return /* @__PURE__ */ new Error(`handoff summary stream finished with an unknown reason "${finish.kind}"`);
	}
}
/**
* 生成交接单：回放前缀 + 最后一条 user 指令 → `ctx.llm.stream` → 文本。
*
* 空文本、异常终止、被取消都抛错（fail closed）：调用方据此不写备份、不 append。
*
* @param ctx - 提供 `llm.stream` 的宿主上下文。
* @param input - 回放前缀 messages（可含 tools）。
* @param agent - 提供目标模型、session id 与 tool history 的 agent。
* @param signal - 可选取消信号；取消同样以抛错表现。
* @returns 交接单正文与实际使用的 provider/model。
*/
async function summarizeForHandoff(ctx, input, agent, signal) {
	const target = resolveTarget(agent);
	const instruction = {
		role: "user",
		content: [{
			type: "text",
			text: HANDOFF_INSTRUCTION
		}]
	};
	const messages = [...input.messages, instruction];
	const toolHistory = agent.session.toolHistory?.();
	const options = {
		provider: target.provider,
		model: target.model,
		messages,
		...toolHistory === void 0 ? {} : { toolHistory },
		...input.tools === void 0 ? {} : { tools: [...input.tools] },
		...target.maxTokens === void 0 ? {} : { maxTokens: target.maxTokens },
		sessionId: agent.session.id,
		purpose: "compaction",
		...signal === void 0 ? {} : { signal }
	};
	const { text, finish } = await collectText(ctx.llm.stream(options));
	const failure = finishFailure(finish);
	if (failure !== null) throw failure;
	if (text.length === 0) throw new Error("handoff summary produced no text content");
	return {
		text,
		provider: target.provider,
		model: target.model
	};
}
//#endregion
//#region
/**
* surface 节点的视图（design.md §4.3 / core.ts 的输入）。
*
* `session.surface.nodes` 是**数字 seq 数组**，不是节点对象；这里逐个 `eventAt(seq)`
* 映射成 `SurfaceNode`。映射写错（例如把 `user/message` 的 `source` 取到
* `data.message.source`）会让工作区指令基线认不出来，`pinnedNodeCount` 变小甚至归 0，
* 替换区间就会从 surface 节点 0 开始，`Session.append` 的 `assertSystemHeadRewrite`
* 会抛 "node 0 holds the system prompt"。
*
* 因此它是 `export` 的：`tests/handoff/command.test.ts` 直接喂真实形状的事件。
*
* `sourceKind` 只对 `user/message` 有意义：`agent-instructions` 基线要靠它识别成
* "前导注入节点"被保留下来（core.ts 的 `pinnedNodeCount`）。
*/
function surfaceViews(session) {
	const views = [];
	for (const seq of session.surface.nodes) {
		const event = session.eventAt(seq);
		if (event === void 0) throw new Error(`surface 节点 seq ${seq} 没有对应的事件`);
		const sourceKind = event.type === "user/message" ? event.data?.source?.kind : void 0;
		views.push(sourceKind === void 0 ? {
			seq,
			type: event.type
		} : {
			seq,
			type: event.type,
			sourceKind
		});
	}
	return views;
}
/**
* 整段事件日志的只读视图（design.md §4.4 的忙闲守卫输入）。
*
* 包含种子/继承事件：`inspectBusy` 从尾部往前扫，以最新 `session/end-seed` 为界，
* 只关心其后的未闭合 `turn/start` / `compaction/start`，所以从头扫一遍是安全的。
*/
function eventViews(session) {
	const views = [];
	const end = session.seq;
	for (let seq = 0; seq < end; seq += 1) {
		const event = session.eventAt(seq);
		if (event === void 0) continue;
		views.push({
			seq,
			type: event.type
		});
	}
	return views;
}
/**
* 取消信号是否已触发。
*
* 刻意包一层函数：`signal.aborted` 一旦在某个分支里被 `if (… === true) return` 收窄成
* `false`，TypeScript 不会因为中间有 `await` 就重置收窄，后续检查会被判成"永假"。
*/
function isAborted(signal) {
	return signal?.aborted === true;
}
/** 失败原因收敛成一行，供兜底文案使用。 */
function reasonOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* design.md §4.5 的固定文案。
*
* 两个入口共用：draft 只用到 `busy` / `noHistory` / `summaryFailed` / `cancelled`；
* `changed` 与 `backupFailed` 是 `/handoff` 独有的阶段（draft 不做选区稳定检查、不写备份）。
*/
var HANDOFF_TEXTS = {
	busy: "当前有轮次正在运行或压缩正在进行，交接暂不可用。",
	noHistory: "没有可交接的历史。",
	changed: "交接期间会话发生了变化，未执行。请重试。",
	summaryFailed: "交接单生成失败（模型未返回有效内容），未执行。",
	backupFailed: "备份写入失败，未执行交接。",
	cancelled: "交接已取消。"
};
/**
* 交接单文档（design.md §6）：头部注释 + 摘要正文。
*
* 备份文件、替换消息的 `<handoff>` 段与 draft 响应里的 `doc` 共用这一个拼法，
* 三处不会出现"头部格式略有不同"。头部时间与备份文件名用同一个 `now`。
*
* @param input.sessionId - 源会话 id。
* @param input.range - 被遮蔽区间（只取两端 seq 写进头部）。
* @param input.text - 摘要正文。
* @param input.now - 头部时间；`/handoff` 同时用它命名备份文件。
* @returns 完整交接单（含头部注释）。
*/
function buildHandoffDoc(input) {
	return `<!-- handoff: ${randomUUID()} at ${input.now.toISOString()} from session ${input.sessionId} (seq ${input.range.startSeq}..${input.range.endSeq}) -->\n\n${input.text}`;
}
/**
* 守卫 + 摘要：两个入口共用的一段（design.md §2）。
*
* 顺序与 `/handoff` 一致：取消 → 忙 → 有历史 → 摘要。**不**在这里做"选区稳定"检查：
* 那是 `/handoff` 替换前的要求（拿到 doc 之后 surface 又变了，replace 区间就可能遮蔽错
* 东西）；draft 不需要它，理由写在 draft.ts 里。所以这里只把快照交出去，由调用方决定。
*
* 失败原因都收敛成 stage 的 `kind`，不抛异常；只有 surface / 事件读取自相矛盾这类宿主
* 接线错误会逃出去，由调用方兜底（`/handoff` 折成 `交接未执行：<原因>。`）。
*
* @param ctx - 宿主上下文（只需 `llm.stream`）。
* @param session - 只读会话视图。
* @param agent - 提供目标模型、session id 与 tool history 的真实 Agent。
* @param signal - 可选取消信号。
* @returns 阶段结果；`ready` 才表示拿到了交接单。
*/
async function prepareHandoff(ctx, session, agent, signal) {
	if (isAborted(signal)) return { kind: "cancelled" };
	if (inspectBusy(eventViews(session)) !== "idle") return { kind: "busy" };
	const pinned = pinnedNodeCount(surfaceViews(session));
	const range = shadowedRange(session.surface.nodes, pinned);
	if (range === null) return { kind: "no-history" };
	const surface = [...session.surface.nodes];
	const messages = session.deriveMessages();
	let text;
	try {
		text = (await summarizeForHandoff(ctx, { messages }, agent, signal)).text;
	} catch {
		if (isAborted(signal)) return { kind: "cancelled" };
		return { kind: "summary-failed" };
	}
	const now = /* @__PURE__ */ new Date();
	return {
		kind: "ready",
		doc: buildHandoffDoc({
			sessionId: session.id,
			range,
			text,
			now
		}),
		shadowable: range.seqs.length,
		range,
		now,
		surface
	};
}
//#endregion
//#region
/**
* 替换消息的引导语：告诉读这条消息的模型"此前对话已被这份交接单取代"。
*
* 与压缩的 checkpoint 引导语同一个用途（design.md §4.3）；`<handoff>` 包裹段由本模块
* 拼接，备份文件里**不带**这层包裹（备份只有交接单原文）。
*/
var PREAMBLE = `This conversation was handed off: everything before this message has been replaced by the handoff document below.
Treat it as established background, including its "下一步" (next steps), and continue the work from there.
Do not ask the user to restate anything the document already records.`;
/** 调用的 Agent 里取出 session；形状不对属于宿主接线错误，交给外层兜底。 */
function sessionOf(agent) {
	const candidate = agent !== null && typeof agent === "object" ? agent.session : void 0;
	if (candidate === null || typeof candidate !== "object") throw new TypeError("调用现场没有关联的会话");
	return candidate;
}
/** surface 快照比较：守卫 C 用（design.md §4.4）。 */
function sameNodes(left, right) {
	if (left.length !== right.length) return false;
	return left.every((seq, index) => seq === right[index]);
}
/**
* 执行一次 `/handoff`：守卫 → 摘要 → 备份 → 替换（design.md §4.3）。
*
* 任何失败都收敛成 `{ kind: 'error', text }`，**不向宿主抛异常**（design.md §4.5）。
*
* @param ctx - 宿主上下文（只需 `llm.stream`）。
* @param invocation - 调用现场（agent / signal）。
* @returns 结果行；成功时带 append 后的事件 seq。
*/
async function runHandoff(ctx, invocation) {
	try {
		return await executeHandoff(ctx, invocation);
	} catch (error) {
		return {
			kind: "error",
			text: `交接未执行：${reasonOf(error)}。`
		};
	}
}
/** `runHandoff` 的主体；错误按 §4.5 的文案在各阶段收敛。 */
async function executeHandoff(ctx, invocation) {
	const session = sessionOf(invocation.agent);
	const signal = invocation.signal;
	const stage = await prepareHandoff(ctx, session, invocation.agent, signal);
	switch (stage.kind) {
		case "busy": return {
			kind: "error",
			text: HANDOFF_TEXTS.busy
		};
		case "no-history": return {
			kind: "success",
			text: HANDOFF_TEXTS.noHistory
		};
		case "cancelled": return {
			kind: "error",
			text: HANDOFF_TEXTS.cancelled
		};
		case "summary-failed": return {
			kind: "error",
			text: HANDOFF_TEXTS.summaryFailed
		};
	}
	if (!sameNodes(session.surface.nodes, stage.surface)) return {
		kind: "error",
		text: HANDOFF_TEXTS.changed
	};
	if (isAborted(signal)) return {
		kind: "error",
		text: HANDOFF_TEXTS.cancelled
	};
	let backupPath;
	try {
		backupPath = await writeBackup({
			sessionId: session.id,
			doc: stage.doc,
			now: stage.now
		});
	} catch {
		return {
			kind: "error",
			text: HANDOFF_TEXTS.backupFailed
		};
	}
	if (isAborted(signal)) return {
		kind: "error",
		text: `${HANDOFF_TEXTS.cancelled}（交接单已备份到 ${backupPath}，会话未修改）`
	};
	try {
		const event = session.append("user/message", {
			id: randomUUID(),
			role: "user",
			source: { kind: "user" },
			content: [{
				type: "text",
				text: `${PREAMBLE}\n\n<handoff>\n${stage.doc}\n</handoff>`
			}]
		}, {
			surfaceOp: {
				op: "replace",
				startSeq: stage.range.startSeq,
				endSeq: stage.range.endSeq
			},
			sourceEventSeqs: [...stage.range.seqs]
		});
		return {
			kind: "success",
			text: `已交接：遮蔽 ${stage.range.seqs.length} 条，备份 ${backupPath}`,
			sourceEventSeq: event.seq
		};
	} catch (error) {
		return {
			kind: "error",
			text: `交接单写入会话失败（${reasonOf(error)}），会话未修改；备份见 ${backupPath}`
		};
	}
}
//#endregion
//#region
/** 失败结果的小工厂。 */
function failure(status, code, message) {
	return {
		status,
		body: {
			ok: false,
			error: {
				code,
				message
			}
		}
	};
}
function asRecord(value) {
	return value !== null && typeof value === "object" ? value : void 0;
}
/** 结构检查：只认 `HandoffSessionView` 需要的那几个成员，形状不对就当没有。 */
function isSessionView(value) {
	const record = asRecord(value);
	if (record === void 0) return false;
	return typeof record["id"] === "string" && typeof record["seq"] === "number" && asRecord(record["surface"]) !== void 0 && typeof record["eventAt"] === "function" && typeof record["deriveMessages"] === "function";
}
/**
* 按 id 找活跃 Agent：`ctx.get('agents')` 是 `dsh-agent` 的 `AgentRegistry`，`get(id)`
* 返回 live `Agent`（Agent 上带 `session` 与 `options`，正是摘要需要的两样）。
*
* 拿不到 agents 服务、服务里没有这个会话、或形状不对时返回 `undefined`，不抛。
*/
function findAgent(ctx, sessionId) {
	try {
		const agents = asRecord(ctx.get?.("agents"));
		const get = agents?.["get"];
		if (typeof get !== "function") return void 0;
		const agent = get.call(agents, sessionId);
		const record = asRecord(agent);
		if (record === void 0 || !isSessionView(record["session"])) return void 0;
		return agent;
	} catch {
		return;
	}
}
/** 按 id 找 live Session：`ctx.sessions` 是 `dsh-session` 的 `SessionStore`。 */
function findSession(ctx, sessionId) {
	try {
		const session = ctx.sessions.get(sessionId);
		return isSessionView(session) ? session : void 0;
	} catch {
		return;
	}
}
/**
* 生成一份新会话交接草稿：只读，**不写会话、不建 session、不写备份**（design.md §3.2）。
*
* @param ctx - 宿主上下文（`llm` / `sessions` / `get('agents')`）。
* @param sessionId - 源会话 id（URL 的 `?session=`，原始 DSH 会话 id）。
* @param signal - 可选取消信号（HTTP 层在客户端断开时 abort）。
* @returns 状态码 + JSON 体；不会抛异常（兜底折成 500 `internal`）。
*/
async function runHandoffDraft(ctx, sessionId, signal) {
	const id = sessionId.trim();
	if (id === "") return failure(400, "bad-request", "需要 session 参数（会话 id）。");
	if (isAborted(signal)) return failure(499, "cancelled", HANDOFF_TEXTS.cancelled);
	const agent = findAgent(ctx, id);
	const session = agent?.session ?? findSession(ctx, id);
	if (session === void 0) return failure(404, "session-not-found", `找不到活跃会话 ${id}。`);
	if (agent === void 0) return failure(409, "agent-not-live", `会话 ${id} 没有活跃的 Agent（摘要需要它的模型路由），无法生成交接单。`);
	let stage;
	try {
		stage = await prepareHandoff(ctx, session, agent, signal);
	} catch (error) {
		return failure(500, "internal", `交接单生成失败：${reasonOf(error)}。`);
	}
	switch (stage.kind) {
		case "busy": return failure(409, "busy", HANDOFF_TEXTS.busy);
		case "no-history": return {
			status: 200,
			body: {
				ok: true,
				doc: null,
				shadowable: 0
			}
		};
		case "cancelled": return failure(499, "cancelled", HANDOFF_TEXTS.cancelled);
		case "summary-failed": return failure(502, "summary-failed", HANDOFF_TEXTS.summaryFailed);
		case "ready": return {
			status: 200,
			body: {
				ok: true,
				doc: stage.doc,
				shadowable: stage.shadowable
			}
		};
	}
}
//#endregion
//#region
/**
* 注入的服务。
*
* `webServer` 是 P2 追加的（design.md §4.1）：没有 Web 服务的组合里本插件不激活，
* 也就没有 `/handoff` 命令 —— 这是设计上接受的取舍（P2 的按钮只存在于 Web/桌面壳）。
* `sessions` 用来按 id 找 live 会话；`agents` 不做 inject，走 `ctx.get('agents')`
* （aiworkflow 同款），缺它时命令照常、draft 返回 409。
*/
var inject = [
	"commands",
	"sessions",
	"llm",
	"webServer"
];
/** 路由前缀：不以 `/` 结尾（宿主按 `path === prefix || path.startsWith(prefix + '/')` 匹配）。 */
var ROUTE_PREFIX = "/handoff/draft";
/**
* 注册 `/handoff` 与 `/handoff/draft`，并在卸载时等待进行中的交接结算。
* @param ctx - 宿主上下文（`commands` / `sessions` / `llm` / `webServer` 已注入）。
*/
function apply(ctx) {
	const active = /* @__PURE__ */ new Set();
	/** 在飞的取消控制器（draft 等）：卸载时先 abort 再 drain，别让不响应 signal 的适配器拖住退出。 */
	const controllers = /* @__PURE__ */ new Set();
	/**
	* 记入 `active`，让插件卸载时等这次交接结算（命令与草稿共用）。
	* @param operation - 进行中的交接。
	* @returns 原样的 promise。
	*/
	const track = (operation) => {
		active.add(operation);
		const retire = () => {
			active.delete(operation);
		};
		operation.then(retire, retire);
		return operation;
	};
	const handler = (invocation) => track(runHandoff(ctx, invocation));
	ctx.effect(function* () {
		yield async () => {
			for (const controller of controllers) controller.abort();
			controllers.clear();
			await Promise.allSettled(active);
		};
		yield ctx.commands.register({
			definitionId: "@handoff/dsh-plugin",
			name: "handoff",
			description: "Replace this conversation with a handoff document",
			handler
		});
	}, "handoff lifecycle");
	ctx.effect(() => {
		const disposeRoute = ctx.webServer.register({
			kind: "prefix",
			path: ROUTE_PREFIX,
			handler: (req, res) => handleDraftRequest(ctx, req, res, track, controllers)
		});
		return () => {
			disposeRoute();
		};
	}, "handoff draft route");
}
/**
* `GET /handoff/draft?session=<sessionId>`：只读草稿。
*
* HTTP 细节（CORS / 状态码 / JSON 形状 / 客户端断开）都在这里，业务在 draft.ts，
* 这样单测可以直接喂假 ctx / 假 req / 假 res。
*/
async function handleDraftRequest(ctx, req, res, track, controllers) {
	try {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const method = req.method ?? "GET";
		if (method === "OPTIONS") {
			res.statusCode = 204;
			setCorsHeaders(req, res);
			res.end();
			return;
		}
		if (url.pathname !== ROUTE_PREFIX && url.pathname !== `${ROUTE_PREFIX}/`) {
			sendNotFound(req, res, url.pathname);
			return;
		}
		if (method !== "GET") {
			sendJson(req, res, 405, {
				ok: false,
				error: {
					code: "method-not-allowed",
					message: "method not allowed"
				}
			});
			return;
		}
		const controller = new AbortController();
		controllers.add(controller);
		const onClose = () => {
			if (!res.writableEnded) controller.abort();
		};
		if (typeof res.on === "function") res.on("close", onClose);
		let result;
		try {
			result = await track(runHandoffDraft(ctx, url.searchParams.get("session") ?? "", controller.signal));
		} finally {
			controllers.delete(controller);
			if (typeof res.off === "function") res.off("close", onClose);
		}
		if (controller.signal.aborted && res.destroyed) return;
		sendJson(req, res, result.status, result.body);
	} catch (error) {
		sendJson(req, res, 500, {
			ok: false,
			error: {
				code: "internal",
				message: reasonOf(error)
			}
		});
	}
}
function sendJson(req, res, status, body) {
	const text = JSON.stringify(body);
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	setCorsHeaders(req, res);
	res.end(text);
}
function sendNotFound(req, res, pathname) {
	sendJson(req, res, 404, {
		ok: false,
		error: {
			code: "not-found",
			message: `unknown route ${pathname}`
		}
	});
}
/**
* 只读本地数据的跨源放行，按 `Origin` 分层（不按 remoteAddress 白名单，那会打断局域网用法）：
*
* - 没有 `Origin`（同源请求 / 非浏览器）→ 不设 ACAO（同源本来不受 CORS 限制）；
* - `Origin: null`（桌面壳 `file://` 渲染器）→ `ACAO: null`；
* - `Origin` 的 host 与 `req.headers.host` 相同 → 回显该 origin；
* - 其它（陌生网页）→ 不设 ACAO，浏览器读不到响应体。
*
* 这条 GET 会返回会话摘要正文并触发一次付费 LLM 调用，所以不能再 `*`。
*/
function setCorsHeaders(req, res) {
	const origin = typeof req.headers.origin === "string" ? req.headers.origin : void 0;
	if (origin === void 0 || origin === "") return;
	let allow;
	if (origin === "null") allow = "null";
	else {
		let originHost;
		try {
			originHost = new URL(origin).host;
		} catch {
			originHost = void 0;
		}
		const requestHost = req.headers.host;
		if (originHost !== void 0 && typeof requestHost === "string" && originHost === requestHost) allow = origin;
	}
	if (allow === void 0) return;
	res.setHeader("access-control-allow-origin", allow);
	res.setHeader("access-control-allow-methods", "GET, OPTIONS");
	res.setHeader("access-control-allow-headers", "accept, content-type");
	res.setHeader("access-control-max-age", "600");
}
//#endregion
export { apply, inject };
