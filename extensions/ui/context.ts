import { DEFAULT_COMPACTION_SETTINGS, estimateTokens, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createNotes } from "../shared/panel.ts";

const COLORS = ["\x1b[38;2;105;180;255m", "\x1b[38;2;95;225;220m", "\x1b[38;2;180;150;255m", "\x1b[38;2;255;185;110m", "\x1b[38;2;145;215;150m", "\x1b[38;2;255;145;175m", "\x1b[38;2;225;210;125m", "\x1b[38;2;150;165;185m"];
const RESET = "\x1b[39m";

export function contextReport(ctx: ExtensionContext, width = 100, reserve?: number | null): string[] {
	const usage = ctx.getContextUsage();
	const model = ctx.model?.id || "unknown";
	const modelName = ctx.model?.name || model;
	const window = usage?.contextWindow ?? ctx.model?.contextWindow;
	const total = usage?.tokens == null ? "unknown" : usage.tokens.toLocaleString();
	const percent = usage?.percent == null ? "unknown" : `${usage.percent.toFixed(1)}%`;
	const groups = new Map<string, number>();
	const tools = new Map<string, { tokens: number; calls: number }>();
	for (const entry of ctx.sessionManager.buildSessionProjection().entries) {
		for (const message of entry.messages) {
			const tokens = estimateTokens(message);
			let category = "Other messages";
			if (message.role === "toolResult") category = "Tool results";
			else if (message.role === "user") category = "User messages";
			else if (message.role === "assistant") category = "Assistant messages, thinking and tool calls";
			else if (message.role === "compactionSummary" || message.role === "branchSummary") category = "Summaries";
			else if (message.role === "system") category = "System messages and changes";
			groups.set(category, (groups.get(category) ?? 0) + tokens);
			if (message.role === "toolResult") {
				const name = [...message.toolName].filter((char) => { const code = char.codePointAt(0)!; return code >= 32 && (code < 127 || code > 159); }).join("");
				const previous = tools.get(name) ?? { tokens: 0, calls: 0 };
				previous.tokens += tokens;
				previous.calls++;
				tools.set(name, previous);
			}
		}
	}
	const systemTokens = Math.ceil(ctx.getSystemPrompt().length / 4);
	const categories = [["System prompt snapshot", systemTokens] as const, ...[...groups.entries()].sort((a, b) => b[1] - a[1])];
	const chart: string[] = [];
	if (window && window > 0 && usage?.tokens != null) {
		const active = categories.map(([, value], index) => ({ value, index })).filter(({ value }) => value > 0);
		const used = Math.min(200, Math.max(active.length, Math.ceil(usage.tokens / window * 200)));
		const cells: string[] = [];
		active.forEach(({ value, index }, position) => {
			const available = used - cells.length - (active.length - position - 1);
			const count = Math.min(available, Math.max(1, Math.round(value / window * 200)));
			for (let i = 0; i < count; i++) cells.push(`${COLORS[index % COLORS.length]}${index % 2 ? "⛁" : "⛀"}${RESET}`);
		});
		while (cells.length < used) cells.push("\x1b[90m⛀\x1b[39m");
		const reserved = reserve == null ? 0 : Math.min(200 - used, Math.ceil(Math.max(0, reserve) / window * 200));
		while (cells.length < 200 - reserved) cells.push("\x1b[90m⛶\x1b[39m");
		while (cells.length < 200) cells.push("\x1b[38;2;255;185;110m⛝\x1b[39m");
		for (let row = 0; row < 10; row++) chart.push(cells.slice(row * 20, row * 20 + 20).join(" "));
	} else chart.push("Context grid unavailable until usage is known.");
	const ratio = (value: number) => window && window > 0 ? ` (${(value / window * 100).toFixed(1)}%)` : "";
	const details = [
		modelName,
		model,
		`${total} / ${window?.toLocaleString() ?? "unknown"} tokens (${percent})`,
		"",
		"Estimated usage by category",
		...categories.map(([name, value], index) => `${COLORS[index % COLORS.length]}${index % 2 ? "⛁" : "⛀"}${RESET} ${name}: ~${value.toLocaleString()}${ratio(value)}`),
		"\x1b[90m⛀\x1b[39m Unattributed",
		usage?.tokens != null && window ? `\x1b[90m⛶\x1b[39m Free space: ~${Math.max(0, window - usage.tokens - (reserve ?? 0)).toLocaleString()}${ratio(Math.max(0, window - usage.tokens - (reserve ?? 0)))}` : "\x1b[90m⛶\x1b[39m Free space: unknown",
		reserve === null ? "Auto-compaction reserve: disabled" : reserve === undefined ? "Auto-compaction reserve: unavailable" : `\x1b[38;2;255;185;110m⛝\x1b[39m Configured Pi reserve: ${reserve.toLocaleString()}${ratio(reserve)}`,
	];
	const side = width >= 86 && chart.length === 10;
	const detailRows = side ? details.flatMap((line) => line ? wrapTextWithAnsi(line, width - 41) : [""]) : details;
	const summary = side
		? Array.from({ length: Math.max(chart.length, detailRows.length) }, (_, index) => `${chart[index] ?? " ".repeat(39)}  ${detailRows[index] ?? ""}`)
		: [...chart, "", ...details];
	const lines = [
		...summary,
		"",
		`${COLORS[1]}⛁${RESET} Tool result sizes in active context (estimated)`,
		...(tools.size ? [...tools.entries()].sort((a, b) => b[1].tokens - a[1].tokens).map(([name, value], index) =>
			`  ${COLORS[index % COLORS.length]}◆${RESET} ${name}: ~${value.tokens.toLocaleString()} tokens (${value.calls} results)`) : ["  No tool results in active context."]),
	];
	return lines;
}

function configuredReserve(pi: ExtensionAPI, ctx: ExtensionContext): number | null {
	const settings = pi.getSettings?.().compaction;
	if (settings?.enabled === false) return null;
	const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
	return settings?.modelOverrides?.[modelKey]?.reserveTokens ?? settings?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
}

export function registerContextCommand(pi: ExtensionAPI): void {
	let panel: ReturnType<typeof createNotes> | undefined;
	pi.events?.on("ui:panel:close", () => panel?.close());
	pi.events?.on("ui:panel:opening", (data) => { if ((data as { name: string }).name !== "context") panel?.close(); });
	pi.on?.("session_start", (_event, ctx) => {
		panel?.close();
		panel = undefined;
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget("context-overlay", (tui, theme) => {
			panel?.close();
			panel = createNotes(tui, theme, (width) => contextReport(ctx, width, configuredReserve(pi, ctx)).join("\n"), (message) => ctx.ui.notify(message, "error"), "context", () => pi.events?.emit("ui:panel:opening", { name: "context" }));
			return { invalidate() {}, render: () => [] };
		});
	});
	pi.on?.("session_shutdown", () => { panel?.close(); panel = undefined; });
	pi.events?.on("ui:context:read", (data) => {
		const request = data as { ctx: ExtensionContext; width?: number; lines?: string[] };
		request.lines = contextReport(request.ctx, request.width, configuredReserve(pi, request.ctx));
	});
	pi.registerCommand("context", {
		description: "Show estimated context usage and largest retained tool results",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				let text = contextReport(ctx, 100, configuredReserve(pi, ctx)).join("\n");
				for (const color of [...COLORS, RESET, "\x1b[90m"]) text = text.replaceAll(color, "");
				ctx.ui.notify(text);
				return;
			}
			if (panel?.canShow()) { panel.toggle(); return; }
			pi.events?.emit("ui:panel:opening", { name: "context" });
			await ctx.ui.custom<void>((tui, theme, _keys, done) => {
				let offset = 0;
				let lines: string[] = [];
				let lastWidth = -1;
				return {
					invalidate() {},
					render(width: number): string[] {
						if (width !== lastWidth) { lines = contextReport(ctx, width, configuredReserve(pi, ctx)); lastWidth = width; }
						const height = Math.max(1, tui.terminal.rows - 5);
						const wrapped = lines.flatMap((line) => line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]);
						offset = Math.min(offset, Math.max(0, wrapped.length - height));
						return [...wrapped.slice(offset, offset + height), truncateToWidth(theme.fg("dim", "↑/↓ scroll · Esc close"), width)];
					},
					handleInput(data: string): void {
						if (matchesKey(data, "escape") || data === "q") { done(); return; }
						if (matchesKey(data, "up") || data === "k") offset = Math.max(0, offset - 1);
						else if (matchesKey(data, "down") || data === "j") offset++;
						else return;
						tui.requestRender();
					},
				};
			});
		},
	});
}
