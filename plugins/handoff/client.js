// 由 scripts/build-plugin.mjs 生成，勿手改。源码见 src/。
window.__ModuleLoader__.load({
  id: "@handoff/dsh-plugin",
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    (function (module, exports, require) {
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
//#endregion
let react = require("react");
react = __toESM(react, 1);
//#region
function resolveEndpoint(relativePath) {
	const protocol = globalThis.location?.protocol;
	if (protocol === "http:" || protocol === "https:") return new URL(relativePath, document.baseURI);
	const raw = globalThis.__DSH_TRANSPORT__?.streamBaseUrl;
	if (typeof raw === "string" && raw !== "") try {
		const base = new URL(raw);
		if (base.protocol === "ws:") base.protocol = "http:";
		else if (base.protocol === "wss:") base.protocol = "https:";
		if (base.protocol === "http:" || base.protocol === "https:") return new URL(relativePath, base);
	} catch {}
	return new URL(relativePath, document.baseURI);
}
//#endregion
//#region
function asRecord(value) {
	return value !== null && typeof value === "object" ? value : void 0;
}
/** 取一个非空字符串字段；类型不对 / 空串都算没有。 */
function stringField(record, key) {
	if (record === void 0) return null;
	const value = record[key];
	return typeof value === "string" && value !== "" ? value : null;
}
/**
* 归一化 draft 响应（契约见 `src/draft.ts` 的 `HandoffDraftBody`）。
*
* - 2xx + `{ ok: true, doc, shadowable }`：有历史 → `doc`；`doc === null` / 空串 /
*   `shadowable <= 0` → `empty`（**绝不能**拿空文本去建新会话）。
* - 非 2xx：`{ ok: false, error: { message } }` → 透传中文 message。
* - 200 但体不是契约形状（例如路由未落地时被 SPA fallback 成 HTML）：按失败处理。
*/
function classifyDraft(status, body) {
	const record = asRecord(body);
	if (status < 200 || status >= 300) return {
		kind: "error",
		text: stringField(asRecord(record?.["error"]), "message")
	};
	if (record === void 0 || record["ok"] !== true) return {
		kind: "error",
		text: stringField(asRecord(record?.["error"]), "message")
	};
	const doc = record["doc"];
	const shadowable = typeof record["shadowable"] === "number" ? record["shadowable"] : 0;
	if (typeof doc !== "string" || doc.trim() === "" || shadowable <= 0) return { kind: "empty" };
	return {
		kind: "doc",
		doc,
		shadowable
	};
}
/**
* 归一化 `commands.execute` 的结果。
*
* 真实形状：`{ ok: true, value: { commandId, result: { kind, text? } } } |
* { ok: false, error: { message } }`；`value === undefined` 表示未知命令（本插件理论上
* 不会发生，但宿主契约允许）。任何不认识的形状都收敛成“失败 + 无文案”。
*/
function classifyCommand(result) {
	const record = asRecord(result);
	if (record === void 0) return {
		kind: "error",
		text: null,
		reason: "transport"
	};
	if (record["ok"] === false) return {
		kind: "error",
		text: stringField(asRecord(record["error"]), "message"),
		reason: "command"
	};
	if (record["ok"] !== true) return {
		kind: "error",
		text: null,
		reason: "transport"
	};
	const value = record["value"];
	if (value === void 0) return {
		kind: "error",
		text: null,
		reason: "unknown-command"
	};
	const outcome = asRecord(asRecord(value)?.["result"]);
	if (outcome === void 0) return {
		kind: "error",
		text: null,
		reason: "transport"
	};
	const text = stringField(outcome, "text");
	return outcome["kind"] === "success" ? {
		kind: "success",
		text
	} : {
		kind: "error",
		text,
		reason: "command"
	};
}
/** 进行中那一行文案对应的 i18n key。 */
function pendingTextKey(action) {
	return action === "inplace" ? "status.pending.inplace" : "status.pending.new";
}
/**
* 从宿主 `useWorkspaces` 的状态里找某个会话所属的工作区。
*
* 真实形状（`dsh-client-ui-workspace` 的 workspaces 列表快照）：
* `{ items: [{ workspaceId, title, path, sessionIds }] }`。会话可能不在任何工作区
* （Ungrouped），这时返回 `undefined`，调用方退回 cwd。
*
* @param state - `useWorkspaces((s) => s)` 拿到的整份状态（形状不对按没有处理）。
* @param sessionId - 当前会话 id。
* @returns 所属工作区的 `workspaceId`；没有就 `undefined`。
*/
function workspaceIdOf(state, sessionId) {
	if (sessionId === "") return void 0;
	const items = state?.items;
	if (!Array.isArray(items)) return void 0;
	for (const item of items) {
		const record = asRecord(item);
		const members = record?.["sessionIds"];
		if (!Array.isArray(members) || !members.includes(sessionId)) continue;
		const workspaceId = record?.["workspaceId"];
		return typeof workspaceId === "string" && workspaceId !== "" ? workspaceId : void 0;
	}
}
//#endregion
//#region
/** `using` 里“还没发 prompt 就已被取消”的内部哨兵，不能与 `prompt()` 的任何返回值混淆。 */
var ABORTED = Symbol("handoff-aborted");
/** 三种运行时的建会话 API 都不存在时的明确失败文案（Host 文案是中文，保持一致）。 */
var UNSUPPORTED_TEXT = "当前 DSH 版本不支持自动创建会话，请手动新建会话后粘贴交接单。";
/** Error 的 message；其它一律没有。 */
function detailOf(cause) {
	return cause instanceof Error && cause.message !== "" ? cause.message : null;
}
/** 取会话句柄的 `prompt`；没有就 undefined（只探测形状，不猜版本号）。 */
function promptOf(session) {
	return session !== void 0 && typeof session.prompt === "function" ? session.prompt : void 0;
}
/** `prompt()` 结果的归一：成功返回 undefined，失败返回 Host 文案（或 `null`）。 */
function promptFailureOf(result) {
	const shaped = result;
	if (shaped !== null && typeof shaped === "object" && shaped.ok === true) return void 0;
	return { text: typeof shaped?.error?.message === "string" ? shaped.error.message : null };
}
/**
* 就地交接：走和斜杠菜单同一条 `commands.execute` 通道（不写 composer、不 submit）。
*
* 成功时 `text` 可能是 Host 的中文确认文案；失败时（busy / 无历史 / 会话变化）也是
* Host 的中文原因，原样交给 UI。
*/
async function handoffInPlace(deps, sessionId) {
	if (sessionId === "") return {
		kind: "error",
		text: null,
		reason: "transport"
	};
	try {
		return classifyCommand(await deps.commands.execute(sessionId, "/handoff", []));
	} catch {
		return {
			kind: "error",
			text: null,
			reason: "transport"
		};
	}
}
/**
* 新会话交接：draft → create → 首条 prompt → openSession。
*
* `ctx.sessions.create` **不接受** prompt（只有 workspaceId / cwd / sessionId / agentPreset），
* 所以首条消息必须另发。按运行时实际拥有的 API 依次尝试：
*
* 1. `using`（0.2.x）：借一个已 retain 的会话引用，`reference.binding.session.prompt`；
* 2. `retain`（0.2.x，`using` 缺席时）：create → retain → `reference.ready` →
*    `reference.binding.session.prompt` → `reference.release()`；
* 3. `binding(id)`（0.1.5）：create 返回 id，`binding(id).session.prompt`；
* 4. `create()` 直接返回带 `prompt` 的 session 对象（更保守的形状）。
*
* 四者都没有时返回 `stage: 'unsupported'` 并带上 `doc`，让上层提示手动新建会话。
* 结构探测只认 `typeof x === 'function'`，不看版本号字符串。全程不碰旧会话。
*
* 取消语义（面板关掉时 abort）：
* - draft 期间、create 之后 / prompt 之前：停在原地，不 prompt、不切会话；
* - prompt 一旦发出去就收不回：照常 `openSession`，让用户看见那个真在跑的会话，
*   而不是假装取消、留一个后台跑 turn 的不可见会话。
*
* @param target - 新会话落点：`workspaceId`（宿主会 attach 到工作区）优先，否则 `cwd`。
* @param signal - 取消信号；会一并传给 `using` / `retain`（两者都响应它）。
*/
async function handoffToNewSession(deps, sessionId, target, signal) {
	if (sessionId === "") return {
		kind: "error",
		stage: "draft",
		text: null
	};
	const workspaceId = target.workspaceId;
	const cwd = target.cwd;
	const hasWorkspace = workspaceId !== void 0 && workspaceId !== "";
	if (!hasWorkspace && (cwd === void 0 || cwd === "")) return {
		kind: "error",
		stage: "cwd",
		text: null
	};
	let response;
	try {
		response = await deps.readDraft(sessionId, signal);
	} catch {
		return {
			kind: "error",
			stage: "draft",
			text: null
		};
	}
	const draft = classifyDraft(response.status, response.body);
	if (draft.kind === "empty") return { kind: "empty" };
	if (draft.kind === "error") return {
		kind: "error",
		stage: "draft",
		text: draft.text,
		status: response.status
	};
	if (signal.aborted) return { kind: "cancelled" };
	const sessions = deps.sessions;
	if (typeof sessions.create !== "function") return {
		kind: "error",
		stage: "unsupported",
		text: UNSUPPORTED_TEXT,
		doc: draft.doc
	};
	let created;
	try {
		created = hasWorkspace ? await sessions.create({ workspaceId }) : await sessions.create({ cwd });
	} catch (cause) {
		return {
			kind: "error",
			stage: "create",
			text: detailOf(cause)
		};
	}
	if (typeof created === "string" && created === "") return {
		kind: "error",
		stage: "create",
		text: null
	};
	if (typeof created !== "string" && (created === null || typeof created !== "object")) return {
		kind: "error",
		stage: "create",
		text: null
	};
	if (signal.aborted) return { kind: "cancelled" };
	const createdId = typeof created === "string" ? created : void 0;
	const using = sessions.using;
	const retain = sessions.retain;
	const binding = sessions.binding;
	/** 本次实际打开的会话 id；`undefined` 表示 create 返回的对象没带 id。 */
	let openedId;
	let promptResult;
	if (createdId !== void 0 && typeof using === "function") {
		openedId = createdId;
		try {
			promptResult = await using.call(sessions, createdId, {
				source: "handoff",
				signal
			}, async (reference) => {
				if (signal.aborted) return ABORTED;
				const session = reference?.binding?.session;
				const prompt = promptOf(session);
				if (session === void 0 || prompt === void 0) throw new Error("session reference has no prompt()");
				return prompt.call(session, [{
					type: "text",
					text: draft.doc
				}], "queue");
			});
		} catch (cause) {
			if (signal.aborted) return { kind: "cancelled" };
			return {
				kind: "error",
				stage: "prompt",
				text: detailOf(cause)
			};
		}
	} else if (createdId !== void 0 && typeof retain === "function") {
		openedId = createdId;
		let reference;
		try {
			reference = retain.call(sessions, createdId, {
				source: "handoff",
				signal
			});
			await reference?.ready;
			if (signal.aborted) promptResult = ABORTED;
			else {
				const session = reference?.binding?.session;
				const prompt = promptOf(session);
				if (session === void 0 || prompt === void 0) throw new Error("session reference has no prompt()");
				promptResult = await prompt.call(session, [{
					type: "text",
					text: draft.doc
				}], "queue");
			}
		} catch (cause) {
			if (signal.aborted) return { kind: "cancelled" };
			return {
				kind: "error",
				stage: "prompt",
				text: detailOf(cause)
			};
		} finally {
			try {
				reference?.release?.();
			} catch {}
		}
	} else {
		const direct = typeof created === "object" && created !== null ? created : void 0;
		openedId = direct !== void 0 && typeof direct.sessionId === "string" && direct.sessionId !== "" ? direct.sessionId : void 0;
		try {
			let session = direct;
			let prompt = promptOf(session);
			if (prompt === void 0 && createdId !== void 0 && typeof binding === "function") {
				session = binding.call(sessions, createdId)?.session;
				prompt = promptOf(session);
				if (prompt !== void 0) openedId = createdId;
			}
			if (session === void 0 || prompt === void 0) return {
				kind: "error",
				stage: "unsupported",
				text: UNSUPPORTED_TEXT,
				doc: draft.doc
			};
			if (signal.aborted) return { kind: "cancelled" };
			promptResult = await prompt.call(session, [{
				type: "text",
				text: draft.doc
			}], "queue");
		} catch (cause) {
			if (signal.aborted) return { kind: "cancelled" };
			return {
				kind: "error",
				stage: "prompt",
				text: detailOf(cause)
			};
		}
	}
	if (promptResult === ABORTED) return { kind: "cancelled" };
	const failure = promptFailureOf(promptResult);
	if (failure !== void 0) return {
		kind: "error",
		stage: "prompt",
		text: failure.text
	};
	if (openedId !== void 0 && openedId !== "") deps.uiWorkspace.openSession(openedId);
	return {
		kind: "moved",
		sessionId: openedId ?? ""
	};
}
//#endregion
//#region
var NS = "handoff";
var ZH = {
	"button.label": "交接",
	"button.tooltip": "交接",
	"panel.title": "会话交接",
	"panel.subtitle": "把这段对话压成一份交接单，再决定交给谁",
	"panel.close": "关闭",
	"option.inplace.title": "在当前会话交接",
	"option.inplace.desc": "用交接单替换整个会话后缀，不可撤销（会先落盘备份）",
	"option.new.title": "开启新会话交接",
	"option.new.desc": "把交接单带到新会话继续，旧会话原样保留",
	"status.pending.inplace": "正在生成交接单并替换当前会话…",
	"status.pending.new": "正在生成交接单并开启新会话…",
	"status.done": "交接完成。",
	"status.noHistory": "没有可交接的历史。先在这个会话里聊几轮再试。",
	"error.draft": "读取交接单失败。",
	"error.network": "无法连接 Host 读取交接单。",
	"error.noCwd": "找不到当前会话的工作目录，无法创建新会话。",
	"error.prompt": "新会话已创建，但发送交接单失败。",
	"error.unknownCommand": "交接命令不可用，请确认插件已启用。",
	"error.unknown": "未知错误。",
	"error.emptyDoc": "交接单为空，未创建新会话。"
};
var EN = {
	"button.label": "Handoff",
	"button.tooltip": "Hand off",
	"panel.title": "Hand off",
	"panel.subtitle": "Condense this conversation into a handoff document",
	"panel.close": "Close",
	"option.inplace.title": "Hand off in this conversation",
	"option.inplace.desc": "Replace the entire conversation suffix with the document. Not reversible; a backup is written first.",
	"option.new.title": "Hand off to a new conversation",
	"option.new.desc": "Carry the document into a new conversation; this one stays untouched.",
	"status.pending.inplace": "Generating the handoff document and replacing this conversation…",
	"status.pending.new": "Generating the handoff document and opening a new conversation…",
	"status.done": "Handoff complete.",
	"status.noHistory": "Nothing to hand off yet. Talk a few more turns in this conversation first.",
	"error.draft": "Could not read the handoff document.",
	"error.network": "Could not reach the Host for the handoff document.",
	"error.noCwd": "The current conversation has no working directory, so a new conversation cannot be created.",
	"error.prompt": "The new conversation was created, but sending the handoff document failed.",
	"error.unknownCommand": "The handoff command is unavailable. Check that the plugin is enabled.",
	"error.unknown": "Unknown error.",
	"error.emptyDoc": "The handoff document is empty; no new conversation was created."
};
/** 注册到客户端 locale 服务；返回释放函数（重复注册的标签直接跳过）。 */
function registerTexts(ctx) {
	const disposers = [];
	const packs = [
		["en", EN],
		["zh", ZH],
		["zh-CN", ZH],
		["zh-Hans", ZH]
	];
	for (const [locale, dict] of packs) try {
		const dispose = ctx.locale.register(NS, locale, dict);
		if (typeof dispose === "function") disposers.push(dispose);
	} catch {}
	return () => {
		for (const dispose of disposers) try {
			dispose();
		} catch {}
	};
}
//#endregion
//#region
var css = `
/* 输入框工具行左侧的入口：与同行的「＋」同规格（28×28 圆形、图标 14） */
.hpf-btn{width:28px;height:28px;display:inline-grid;place-items:center;flex:none;padding:0;
  border:none;border-radius:50%;background:var(--dsw-specific-selector);
  color:var(--dsw-alias-label-secondary);font-family:inherit;cursor:pointer;
  transition:background .12s ease,color .12s ease}
.hpf-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.hpf-btn:disabled{opacity:.5;cursor:default}
.hpf-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.hpf-btn svg{display:block}

/* 面板：贴着输入框上方居中；backdrop 透明，只负责接“点外部关闭” */
.hpf-backdrop{position:fixed;inset:0;z-index:80;background:transparent;pointer-events:auto}
.hpf-panel{position:fixed;left:50%;bottom:92px;transform:translateX(-50%);z-index:81;
  width:min(380px,calc(100vw - 24px));max-height:min(72vh,560px);overflow-y:auto;
  display:flex;flex-direction:column;gap:10px;padding:14px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-panel);font-family:inherit;
  font-size:13px;line-height:1.5;pointer-events:auto;
  box-shadow:var(--dsw-elevation-prominent)}
.hpf-panel::-webkit-scrollbar{width:8px}
.hpf-panel::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:8px}

.hpf-head{display:flex;align-items:flex-start;gap:8px}
.hpf-head-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.hpf-title{font-weight:600;font-size:13.5px;letter-spacing:.01em;word-break:break-word}
.hpf-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.hpf-close{width:24px;height:24px;display:grid;place-items:center;flex:none;padding:0;
  border:1px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:1;cursor:pointer}
.hpf-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.hpf-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

.hpf-options{display:flex;flex-direction:column;gap:6px}
.hpf-option{display:flex;align-items:flex-start;gap:10px;width:100%;padding:10px 11px;
  text-align:left;font:inherit;color:inherit;cursor:pointer;
  background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  transition:background .12s ease,border-color .12s ease}
.hpf-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-brand-primary)}
.hpf-option:disabled{opacity:.55;cursor:default}
.hpf-option:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.hpf-option-icon{display:grid;place-items:center;width:18px;height:18px;flex:none;margin-top:1px;
  color:var(--dsw-alias-label-secondary)}
.hpf-option:hover:not(:disabled) .hpf-option-icon{color:var(--dsw-alias-brand-primary)}
.hpf-option-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.hpf-option-title{font-size:13px;font-weight:600;word-break:break-word}
.hpf-option-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.45;word-break:break-word}

.hpf-status{display:flex;align-items:flex-start;gap:8px;padding-top:10px;
  border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:1.5;
  color:var(--dsw-alias-label-secondary);word-break:break-word}
.hpf-status[data-kind="success"]{color:var(--dsw-alias-state-success-primary)}
.hpf-status[data-kind="error"]{color:var(--dsw-alias-state-error-primary)}
.hpf-status-text{min-width:0;white-space:pre-wrap}
.hpf-spinner{width:13px;height:13px;flex:none;margin-top:2px;border-radius:50%;
  border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);
  animation:hpf-spin .8s linear infinite}
@keyframes hpf-spin{to{transform:rotate(360deg)}}
`;
function Styles() {
	return /* @__PURE__ */ react.createElement("style", null, css);
}
//#endregion
//#region
var INPLACE_ICON = /* @__PURE__ */ react.createElement("svg", {
	width: "17",
	height: "17",
	viewBox: "0 0 24 24",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: "1.7",
	strokeLinecap: "round",
	strokeLinejoin: "round",
	"aria-hidden": "true"
}, /* @__PURE__ */ react.createElement("path", { d: "M3.5 8h11m0 0-3-3m3 3-3 3" }), /* @__PURE__ */ react.createElement("path", { d: "M20.5 16h-11m0 0 3-3m-3 3 3 3" }));
var NEWSESSION_ICON = /* @__PURE__ */ react.createElement("svg", {
	width: "17",
	height: "17",
	viewBox: "0 0 24 24",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: "1.7",
	strokeLinecap: "round",
	strokeLinejoin: "round",
	"aria-hidden": "true"
}, /* @__PURE__ */ react.createElement("path", { d: "M4.5 5.2h7.2l3 3v9.6H4.5z" }), /* @__PURE__ */ react.createElement("path", { d: "M11.7 5.2v3.2h3" }), /* @__PURE__ */ react.createElement("path", { d: "M16.6 12.1h4.3m0 0-1.9-1.9m1.9 1.9-1.9 1.9" }));
/** 面板正文：标题、两个选项、状态行。 */
function HandoffPanelView({ t, status, onInPlace, onNewSession, onClose }) {
	const busy = status.kind === "pending";
	const locked = busy || status.kind === "success";
	return /* @__PURE__ */ react.createElement(react.Fragment, null, /* @__PURE__ */ react.createElement(Styles, null), /* @__PURE__ */ react.createElement("div", {
		className: "hpf-backdrop",
		role: "presentation",
		onClick: onClose
	}), /* @__PURE__ */ react.createElement("div", {
		className: "hpf-panel",
		role: "dialog",
		"aria-modal": "false",
		"aria-label": t("panel.title"),
		"aria-busy": busy
	}, /* @__PURE__ */ react.createElement("header", { className: "hpf-head" }, /* @__PURE__ */ react.createElement("span", { className: "hpf-head-main" }, /* @__PURE__ */ react.createElement("span", { className: "hpf-title" }, t("panel.title")), /* @__PURE__ */ react.createElement("span", { className: "hpf-sub" }, t("panel.subtitle"))), /* @__PURE__ */ react.createElement("button", {
		type: "button",
		className: "hpf-close",
		title: t("panel.close"),
		"aria-label": t("panel.close"),
		onClick: onClose
	}, "✕")), /* @__PURE__ */ react.createElement("div", { className: "hpf-options" }, /* @__PURE__ */ react.createElement("button", {
		type: "button",
		className: "hpf-option",
		"data-action": "inplace",
		disabled: locked,
		onClick: onInPlace
	}, /* @__PURE__ */ react.createElement("span", {
		className: "hpf-option-icon",
		"aria-hidden": "true"
	}, INPLACE_ICON), /* @__PURE__ */ react.createElement("span", { className: "hpf-option-main" }, /* @__PURE__ */ react.createElement("span", { className: "hpf-option-title" }, t("option.inplace.title")), /* @__PURE__ */ react.createElement("span", { className: "hpf-option-desc" }, t("option.inplace.desc")))), /* @__PURE__ */ react.createElement("button", {
		type: "button",
		className: "hpf-option",
		"data-action": "newsession",
		disabled: locked,
		onClick: onNewSession
	}, /* @__PURE__ */ react.createElement("span", {
		className: "hpf-option-icon",
		"aria-hidden": "true"
	}, NEWSESSION_ICON), /* @__PURE__ */ react.createElement("span", { className: "hpf-option-main" }, /* @__PURE__ */ react.createElement("span", { className: "hpf-option-title" }, t("option.new.title")), /* @__PURE__ */ react.createElement("span", { className: "hpf-option-desc" }, t("option.new.desc"))))), /* @__PURE__ */ react.createElement(StatusLine, {
		status,
		t
	})));
}
/** 状态行：idle 不占位；pending 带转圈；结果用 success/error 着色。 */
function StatusLine({ status, t }) {
	if (status.kind === "idle") return null;
	if (status.kind === "pending") return /* @__PURE__ */ react.createElement("div", {
		className: "hpf-status",
		"data-kind": "pending",
		role: "status",
		"aria-live": "polite"
	}, /* @__PURE__ */ react.createElement("span", {
		className: "hpf-spinner",
		"aria-hidden": "true"
	}), /* @__PURE__ */ react.createElement("span", { className: "hpf-status-text" }, t(pendingTextKey(status.action))));
	return /* @__PURE__ */ react.createElement("div", {
		className: "hpf-status",
		"data-kind": status.kind,
		role: "status",
		"aria-live": "polite"
	}, /* @__PURE__ */ react.createElement("span", { className: "hpf-status-text" }, status.text));
}
//#endregion
//#region
var inject = [
	"slots",
	"locale",
	"remote",
	"remote.commands",
	"sessions",
	"uiWorkspace"
];
var INPUT_LEFT_SLOT = "conversation.input.left";
var OVERLAY_SLOT = "shell.overlay";
var ENTRY_ID = "handoff";
var PANEL_ID = "handoff-panel";
var CLOSED = Object.freeze({
	open: false,
	sessionId: "",
	cwd: void 0,
	workspaceId: void 0
});
var snapshot = CLOSED;
var listeners = /* @__PURE__ */ new Set();
function emit() {
	for (const listener of listeners) listener();
}
var panelTarget = {
	subscribe(listener) {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	},
	getSnapshot() {
		return snapshot;
	},
	open(sessionId, cwd, workspaceId) {
		if (snapshot.open && snapshot.sessionId === sessionId) return;
		snapshot = Object.freeze({
			open: true,
			sessionId,
			cwd,
			workspaceId
		});
		emit();
	},
	close() {
		if (!snapshot.open) return;
		snapshot = CLOSED;
		emit();
	}
};
function HandoffIcon() {
	return /* @__PURE__ */ react.createElement("svg", {
		width: "14",
		height: "14",
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: "1.7",
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": "true"
	}, /* @__PURE__ */ react.createElement("path", {
		d: "M4.6 6.3V4.5c0-.6.5-1.1 1.1-1.1h6.5c.6 0 1.1.5 1.1 1.1v8.9",
		opacity: ".55"
	}), /* @__PURE__ */ react.createElement("rect", {
		x: "6.6",
		y: "6.6",
		width: "8",
		height: "11",
		rx: "1.5"
	}), /* @__PURE__ */ react.createElement("path", { d: "M16.6 12.1h4.3m0 0-1.9-1.9m1.9 1.9-1.9 1.9" }));
}
/**
* 输入框左侧的图标按钮（`conversation.input.left`）。
*
* 新会话必须落在**当前会话所属的工作区**里：宿主 `session.create` 只有在收到
* `workspaceId` 时才 `attachSession`，只给 cwd 建出来的会话不属于任何工作区，
* 侧栏会把它丢进 Ungrouped（重启也不会自愈，成员关系是持久化的）。
*
* `t` 来自槽位下发（注册时声明了 `locale: NS`），这样面板开着切语言会跟着重渲染。
*/
function HandoffButton(props) {
	const t = typeof props["t"] === "function" ? props["t"] : (key) => key;
	const sessionId = typeof props["sessionId"] === "string" ? props["sessionId"] : "";
	const cwd = typeof props["useSessions"] === "function" ? props["useSessions"]((state) => {
		if (sessionId === "") return void 0;
		const value = state?.byId?.[sessionId]?.cwd;
		return typeof value === "string" ? value : void 0;
	}) : void 0;
	const workspaceId = typeof props["useWorkspaces"] === "function" ? props["useWorkspaces"]((state) => workspaceIdOf(state, sessionId)) : void 0;
	const onClick = () => {
		panelTarget.open(sessionId, typeof cwd === "string" ? cwd : void 0, typeof workspaceId === "string" ? workspaceId : void 0);
	};
	return /* @__PURE__ */ react.createElement(react.Fragment, null, /* @__PURE__ */ react.createElement(Styles, null), /* @__PURE__ */ react.createElement("button", {
		type: "button",
		className: "hpf-btn",
		title: t("button.tooltip"),
		"aria-label": t("button.label"),
		"aria-haspopup": "dialog",
		onClick
	}, /* @__PURE__ */ react.createElement(HandoffIcon, null)));
}
/** 错误详情：只有 Error 的 message 值得展示；其它一律留空给兜底文案。 */
function abortDetail(cause) {
	return cause instanceof Error ? cause.message : "";
}
/** 读取 draft：JSON 解析失败当成“没有 body”，由 classifyDraft 按失败处理。 */
async function readDraft(sessionId, signal) {
	const response = await fetch(resolveEndpoint(`handoff/draft?session=${encodeURIComponent(sessionId)}`), {
		headers: { accept: "application/json" },
		cache: "no-store",
		signal
	});
	let body;
	try {
		body = await response.json();
	} catch {
		body = void 0;
	}
	return {
		status: response.status,
		body
	};
}
/** 面板容器：订阅开关、发请求、维护 pending / 结果状态。 */
function HandoffPanel({ ctx, t }) {
	const target = react.useSyncExternalStore(panelTarget.subscribe, panelTarget.getSnapshot, panelTarget.getSnapshot);
	const [status, setStatus] = react.useState({ kind: "idle" });
	const alive = react.useRef(true);
	const inFlight = react.useRef(false);
	const abort = react.useRef(null);
	const closeTimer = react.useRef(void 0);
	react.useEffect(() => () => {
		alive.current = false;
		abort.current?.abort();
		abort.current = null;
		if (closeTimer.current !== void 0) {
			window.clearTimeout(closeTimer.current);
			closeTimer.current = void 0;
		}
	}, []);
	react.useEffect(() => {
		if (target.open && !inFlight.current) setStatus({ kind: "idle" });
		return () => {
			if (closeTimer.current !== void 0) {
				window.clearTimeout(closeTimer.current);
				closeTimer.current = void 0;
			}
		};
	}, [target.open]);
	react.useEffect(() => {
		if (!target.open) {
			abort.current?.abort();
			abort.current = null;
		}
	}, [target.open]);
	react.useEffect(() => {
		if (!target.open) return void 0;
		const onKey = (event) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			panelTarget.close();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [target.open]);
	const close = () => {
		panelTarget.close();
	};
	/** 就地交接：走和斜杠菜单同一条 Host 命令通道，把结果文案放回面板。 */
	const runInPlace = async () => {
		if (inFlight.current || !target.open) return;
		const sessionId = target.sessionId;
		if (sessionId === "") {
			setStatus({
				kind: "error",
				text: t("error.unknown")
			});
			return;
		}
		inFlight.current = true;
		setStatus({
			kind: "pending",
			action: "inplace"
		});
		try {
			const outcome = await handoffInPlace({ commands: ctx.remote.commands }, sessionId);
			if (!alive.current) return;
			if (outcome.kind === "success") {
				setStatus({
					kind: "success",
					text: outcome.text ?? t("status.done")
				});
				closeTimer.current = window.setTimeout(() => {
					closeTimer.current = void 0;
					if (alive.current) panelTarget.close();
				}, 1600);
				return;
			}
			setStatus({
				kind: "error",
				text: outcome.text ?? (outcome.reason === "unknown-command" ? t("error.unknownCommand") : t("error.unknown"))
			});
		} finally {
			inFlight.current = false;
		}
	};
	/** 新会话交接：draft → create → prompt → openSession。旧会话不动。 */
	const runNewSession = async () => {
		if (inFlight.current || !target.open) return;
		const { sessionId, cwd, workspaceId } = target;
		if (sessionId === "") {
			setStatus({
				kind: "error",
				text: t("error.unknown")
			});
			return;
		}
		if ((workspaceId === void 0 || workspaceId === "") && (cwd === void 0 || cwd === "")) {
			setStatus({
				kind: "error",
				text: t("error.noCwd")
			});
			return;
		}
		inFlight.current = true;
		setStatus({
			kind: "pending",
			action: "newsession"
		});
		const controller = new AbortController();
		abort.current = controller;
		try {
			const outcome = await handoffToNewSession({
				sessions: ctx.sessions,
				uiWorkspace: ctx.uiWorkspace,
				readDraft
			}, sessionId, {
				cwd,
				workspaceId
			}, controller.signal);
			if (!alive.current) return;
			if (outcome.kind === "empty") {
				setStatus({
					kind: "info",
					text: t("status.noHistory")
				});
				return;
			}
			if (outcome.kind === "cancelled") {
				setStatus({ kind: "idle" });
				return;
			}
			if (outcome.kind === "moved") {
				panelTarget.close();
				return;
			}
			switch (outcome.stage) {
				case "cwd":
					setStatus({
						kind: "error",
						text: t("error.noCwd")
					});
					return;
				case "draft":
					setStatus({
						kind: "error",
						text: outcome.status === void 0 ? t("error.network") : outcome.text ?? `${t("error.draft")} HTTP ${outcome.status}`
					});
					return;
				case "prompt":
					setStatus({
						kind: "error",
						text: outcome.text ?? t("error.prompt")
					});
					return;
				default:
					setStatus({
						kind: "error",
						text: outcome.text ?? t("error.unknown")
					});
					return;
			}
		} catch (cause) {
			if (!alive.current) return;
			const detail = abortDetail(cause);
			setStatus({
				kind: "error",
				text: detail === "" ? t("error.unknown") : `${t("error.unknown")} ${detail}`
			});
		} finally {
			if (abort.current === controller) abort.current = null;
			inFlight.current = false;
		}
	};
	if (!target.open) return null;
	return /* @__PURE__ */ react.createElement(HandoffPanelView, {
		t,
		status,
		onInPlace: () => void runInPlace(),
		onNewSession: () => void runNewSession(),
		onClose: close
	});
}
function apply(ctx) {
	const disposeTexts = registerTexts(ctx);
	ctx.effect(() => disposeTexts);
	ctx.effect(() => () => panelTarget.close());
	ctx.effect(() => ctx.slots.inject(INPUT_LEFT_SLOT, () => ctx.slots.register({
		name: INPUT_LEFT_SLOT,
		id: ENTRY_ID,
		order: 30,
		locale: NS
	}, (props) => /* @__PURE__ */ react.createElement(HandoffButton, props))));
	ctx.effect(() => ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
		name: OVERLAY_SLOT,
		id: PANEL_ID,
		order: 80,
		locale: NS
	}, (props) => /* @__PURE__ */ react.createElement(HandoffPanel, {
		ctx,
		t: typeof props["t"] === "function" ? props["t"] : (key) => key
	}))));
}
//#endregion
exports.apply = apply;
exports.inject = inject;
    })(module, module.exports, require);
    return module.exports;
  },
});
