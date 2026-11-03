import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNotes } from "../shared/panel.ts";

const run = promisify(execFile);
const CLAUDE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const CLAUDE_WINDOWS = [["five_hour", "Current session"], ["seven_day", "Current week (all models)"], ["seven_day_opus", "Current week (Opus)"], ["seven_day_sonnet", "Current week (Sonnet)"]] as const;
const HOUR = 3600;

type Row = { label: string; percent: number; resetsAt: number | null };
type ClaudeWindow = { utilization?: unknown; resets_at?: unknown } | null | undefined;
type CodexWindow = { used_percent?: unknown; limit_window_seconds?: unknown; reset_after_seconds?: unknown } | null | undefined;
type Provider = "claude" | "codex";

const MAX_BAR = 50;
const REFRESH_MS = 60000;
const SAFE = "\x1b[38;2;105;180;255m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[39m";

export function levelColor(percent: number): string {
	if (percent >= 90) return RED;
	if (percent >= 70) return YELLOW;
	return SAFE;
}

function bar(percent: number, width: number): string {
	const halves = Math.round(Math.min(100, Math.max(0, percent)) / 100 * width * 2);
	const filled = "█".repeat(Math.floor(halves / 2)) + (halves % 2 ? "▌" : "");
	return filled.padEnd(width, " ");
}

function resetText(at: number, now: number, timeZone: string): string {
	const date = new Date(Math.round(at / 60000) * 60000);
	const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(date).replace(" ", "").toLowerCase().replace(":00", "");
	const day = (value: Date) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(value);
	return `Resets ${day(date) === day(new Date(now)) ? clock : `${day(date)} at ${clock}`} (${timeZone})`;
}

function render(rows: Row[], now: number, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, barWidth = MAX_BAR): string {
	if (!rows.length) throw new Error("Usage response had no limit windows");
	return rows.map((row) => {
		const color = levelColor(row.percent);
		return [row.label, `${color}${bar(row.percent, barWidth)}${RESET} ${color}${row.percent.toFixed(0)}% used${RESET}`, row.resetsAt === null ? "" : resetText(row.resetsAt, now, timeZone)].filter(Boolean).join("\n");
	}).join("\n\n");
}

export function formatClaudeUsage(data: Record<string, ClaudeWindow>, now = Date.now(), timeZone?: string, barWidth?: number): string {
	return render(CLAUDE_WINDOWS.flatMap(([key, label]) => {
		const window = data[key];
		if (typeof window?.utilization !== "number") return [];
		const reset = typeof window.resets_at === "string" ? Date.parse(window.resets_at) : NaN;
		return [{ label, percent: window.utilization, resetsAt: Number.isNaN(reset) ? null : reset }];
	}), now, timeZone, barWidth);
}

function codexLabel(seconds: unknown, fallback: string): string {
	if (seconds === 5 * HOUR) return "Current session";
	if (seconds === 7 * 24 * HOUR) return "Current week";
	return typeof seconds === "number" ? `${Math.round(seconds / HOUR)}-hour limit` : fallback;
}

export function formatCodexUsage(data: { rate_limit?: { primary_window?: CodexWindow; secondary_window?: CodexWindow } | null }, now = Date.now(), timeZone?: string, barWidth?: number): string {
	return render(([["primary_window", "Primary limit"], ["secondary_window", "Secondary limit"]] as const).flatMap(([key, fallback]) => {
		const window = data.rate_limit?.[key];
		if (typeof window?.used_percent !== "number") return [];
		const resetAfter = typeof window.reset_after_seconds === "number" ? now + window.reset_after_seconds * 1000 : null;
		return [{ label: codexLabel(window.limit_window_seconds, fallback), percent: window.used_percent, resetsAt: resetAfter }];
	}), now, timeZone, barWidth);
}

export function providerFor(provider: string | undefined): Provider | undefined {
	if (provider === "anthropic" || provider === "claude-bridge") return "claude";
	if (provider === "openai" || provider === "openai-codex") return "codex";
	return undefined;
}

export function accountIdFromToken(token: string): string | undefined {
	try {
		const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, { chatgpt_account_id?: string } | undefined>;
		return claims["https://api.openai.com/auth"]?.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

async function claudeCodeToken(): Promise<string> {
	const raw = process.platform === "darwin"
		? (await run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"])).stdout
		: await readFile(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json"), "utf8");
	let oauth: { accessToken?: string; expiresAt?: number } | undefined;
	try {
		oauth = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } }).claudeAiOauth;
	} catch {
		throw new Error("Claude Code credentials are unreadable; run `claude` and log in again");
	}
	if (!oauth?.accessToken) throw new Error("Claude Code is not logged in; run `claude` and log in");
	if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now()) throw new Error("Claude Code token expired; open `claude` once to refresh it");
	return oauth.accessToken;
}

async function registryToken(ctx: ExtensionContext): Promise<string> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error("No OAuth token for this provider; run /login");
	return auth.apiKey;
}

async function getJson(url: string, headers: Record<string, string>, rejected: string): Promise<unknown> {
	const response = await fetch(url, { headers: { "User-Agent": "claude-code/2.1.0", ...headers }, signal: AbortSignal.timeout(15000) });
	if (response.status === 401 || response.status === 403) throw new Error(rejected);
	if (!response.ok) throw new Error(`Usage endpoint returned HTTP ${response.status}`);
	return response.json();
}

type Formatter = (barWidth: number) => string;

async function claudeUsage(ctx: ExtensionContext): Promise<Formatter> {
	const token = ctx.model?.provider === "claude-bridge" ? await claudeCodeToken() : await registryToken(ctx);
	const data = await getJson(CLAUDE_ENDPOINT, { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }, "Anthropic rejected the credentials (subscription limits need an OAuth login, not an API key)");
	return (barWidth) => formatClaudeUsage(data as Record<string, ClaudeWindow>, Date.now(), undefined, barWidth);
}

async function codexUsage(ctx: ExtensionContext): Promise<Formatter> {
	const token = await registryToken(ctx);
	const accountId = accountIdFromToken(token);
	const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}) };
	const data = await getJson(CODEX_ENDPOINT, headers, `ChatGPT rejected the credentials for provider "${ctx.model?.provider}" (the usage endpoint needs a ChatGPT/Codex login such as the openai-codex provider)`);
	return (barWidth) => formatCodexUsage(data as Parameters<typeof formatCodexUsage>[0], Date.now(), undefined, barWidth);
}

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

async function loadUsage(ctx: ExtensionContext): Promise<{ title: string; format: Formatter }> {
	const kind = providerFor(ctx.model?.provider);
	if (!kind) throw new Error(`No usage limits known for provider "${ctx.model?.provider ?? "none"}"; switch to a Claude or Codex model`);
	return kind === "claude" ? { title: "Claude usage", format: await claudeUsage(ctx) } : { title: "Codex usage", format: await codexUsage(ctx) };
}

export function registerUsageCommand(pi: ExtensionAPI): void {
	let panel: ReturnType<typeof createNotes> | undefined;
	let latest: ExtensionContext | undefined;
	let state: { provider: string | undefined; fetchedAt: number; loading: boolean; result?: { title: string; format: Formatter } | { error: string } } = { provider: undefined, fetchedAt: 0, loading: false };

	function load(ctx: ExtensionContext): void {
		const provider = ctx.model?.provider;
		if (state.loading || (state.provider === provider && Date.now() - state.fetchedAt < REFRESH_MS)) return;
		state = { ...state, provider, loading: true };
		loadUsage(ctx).then((result) => { state = { provider, fetchedAt: Date.now(), loading: false, result }; })
			.catch((error: unknown) => { state = { provider, fetchedAt: Date.now(), loading: false, result: { error: error instanceof Error ? error.message : String(error) } }; });
	}

	function readText(width: number): string {
		if (latest) load(latest);
		const result = state.result;
		if (!result) return "Loading usage…";
		if ("error" in result) return result.error;
		return `${result.title}${state.loading ? " (refreshing…)" : ""}\n\n${result.format(Math.max(10, Math.min(MAX_BAR, width - 12)))}`;
	}

	pi.events?.on("ui:panel:opening", (data) => { if ((data as { name: string }).name !== "usage") panel?.close(); });
	pi.on?.("session_start", (_event, ctx) => {
		panel?.close();
		panel = undefined;
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget("usage-overlay", (tui, theme) => {
			panel?.close();
			panel = createNotes(tui, theme, readText, (message) => ctx.ui.notify(message, "error"), "usage", () => pi.events?.emit("ui:panel:opening", { name: "usage" }));
			return { invalidate() {}, render: () => [] };
		});
	});
	pi.on?.("session_shutdown", () => { panel?.close(); panel = undefined; latest = undefined; });
	pi.registerCommand("usage", {
		description: "Show 5-hour and weekly subscription limit usage for the current model's provider (Claude or Codex)",
		handler: async (_args, ctx) => {
			latest = ctx;
			if (ctx.mode === "tui" && panel?.canShow()) {
				if (!panel.focus()) state = { ...state, fetchedAt: 0 };
				panel.toggle();
				return;
			}
			try {
				const { title, format } = await loadUsage(ctx);
				ctx.ui.notify(`${title}\n\n${strip(format(MAX_BAR))}`);
			} catch (error) {
				ctx.ui.notify(`Usage: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
