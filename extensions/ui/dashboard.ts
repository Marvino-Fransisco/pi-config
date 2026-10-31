import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type OverlayHandle, type OverlayOptions, type TUI } from "@earendil-works/pi-tui";

export interface DashboardSection {
	title: string;
	lines: string[];
}

interface Action {
	command: string;
	label: string;
}

interface Row {
	text: string;
	action?: Action;
}

const LOGO = [
	"██████╗ ██╗",
	"██╔══██╗██║",
	"██████╔╝██║",
	"██╔═══╝ ██║",
	"██║     ██║",
	"╚═╝     ╚═╝",
];
const ACTIONS: Action[] = [
	{ command: "task resume", label: "Resume active task" },
	{ command: "task", label: "Task notes" },
	{ command: "context", label: "Context usage" },
	{ command: "memory", label: "Long-term memory" },
];
const BOTTOM_ROWS = 6;
const FRAMES = 10;
const FRAME_MS = 30;

const rgb = (r: number, g: number, b: number) => (text: string) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
const BRIGHT = rgb(150, 210, 255);
const BLUE = rgb(90, 175, 255);
const MUTED = rgb(70, 125, 185);
const gradient = (row: number, text: string) => {
	const t = row / (LOGO.length - 1);
	return rgb(Math.round(60 + t * 60), Math.round(140 + t * 80), 255)(text);
};

export function registerDashboard(pi: ExtensionAPI, getFooterData: () => ReadonlyFooterDataProvider | undefined): void {
	let collapse: (() => void) | undefined;

	const available = () => {
		const names = new Set(pi.getCommands().map((c) => c.name));
		return ACTIONS.filter((a) => names.has(a.command.split(" ")[0]!));
	};
	const run = (ctx: ExtensionContext | undefined, action: Action) => {
		if (!available().includes(action)) {
			ctx?.ui.notify(`/${action.command} is not available.`, "warning");
			return;
		}
		pi.sendUserMessage(`/${action.command}`, { expandPromptTemplates: true });
	};

	pi.on("session_start", (event, ctx) => {
		collapse = undefined;
		if (ctx.mode !== "tui") return;
		const fresh = (event.reason === "startup" || event.reason === "new")
			&& !ctx.sessionManager.getBranch().some((e) => e.type === "message");
		if (!fresh) {
			ctx.ui.setHeader(undefined);
			return;
		}
		ctx.ui.setHeader((tui) => {
			const dashboard = showDashboard(tui, () => rows(pi, ctx, getFooterData, available()), (action) => run(ctx, action));
			collapse = dashboard.collapse;
			return { render: () => [], invalidate() {}, dispose: dashboard.hide };
		});
	});

	pi.on("input", () => {
		collapse?.();
		collapse = undefined;
	});
}

function rows(pi: ExtensionAPI, ctx: ExtensionContext, getFooterData: () => ReadonlyFooterDataProvider | undefined, actions: Action[]): Row[] {
	const out: Row[] = LOGO.map((line, i) => ({ text: gradient(i, line) }));
	out.push({ text: "" }, { text: `${BRIGHT("pi coding agent")}${MUTED(` v${VERSION}`)}` }, { text: "" });

	const home = process.env.HOME;
	let cwd = ctx.sessionManager.getCwd();
	if (home && cwd.startsWith(home)) cwd = `~${cwd.slice(home.length)}`;
	const branch = getFooterData()?.getGitBranch();
	let model = ctx.model?.id ?? "no model";
	if (ctx.model?.reasoning) model += ` • ${ctx.thinkingLevel || "off"}`;
	out.push({ text: `${BLUE(model)}${MUTED(`  ·  ${cwd}${branch ? ` (${branch})` : ""}`)}` });

	const sections: DashboardSection[] = [];
	pi.events?.emit("ui:dashboard:sections", sections);
	for (const section of sections) {
		out.push({ text: "" }, { text: BRIGHT(section.title) });
		for (const line of section.lines) out.push({ text: BLUE(line) });
	}

	if (actions.length) {
		const labelWidth = Math.max(...actions.map((a) => a.label.length));
		const commandWidth = Math.max(...actions.map((a) => a.command.length + 1));
		out.push({ text: "" }, { text: BRIGHT("Quick actions · click to run") });
		for (const action of actions) {
			out.push({ text: `${BRIGHT("›")} ${BLUE(action.label.padEnd(labelWidth))}  ${MUTED(`/${action.command}`.padEnd(commandWidth))}`, action });
		}
	}
	out.push({ text: "" }, { text: MUTED("Type a message to start") });
	return out;
}

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

function showDashboard(tui: TUI, getRows: () => Row[], run: (action: Action) => void) {
	let frame = 0;
	let collapsing = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let visible: Row[] = [];
	let handle: OverlayHandle | undefined;
	const options: OverlayOptions = { width: "100%", row: 0, nonCapturing: true };

	const hide = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		handle?.hide();
		handle = undefined;
	};

	handle = tui.showOverlay({
		invalidate() {},
		handleMouse(event) {
			if (event.type !== "click" || collapsing) return undefined;
			const action = visible[event.y]?.action;
			if (!action) return undefined;
			run(action);
			return { handled: true };
		},
		render(width: number): string[] {
			const content = getRows();
			const base = Math.max(0, Math.floor((tui.terminal.rows - BOTTOM_ROWS - content.length) / 2));
			const progress = Math.min(1, frame / FRAMES);
			const row = base - Math.round(progress * progress * (base + content.length));
			options.row = Math.max(0, row);
			visible = content.slice(Math.max(0, -row));
			const faded = collapsing && progress > 0.3;
			return visible.map((r) => {
				const text = truncateToWidth(faded ? MUTED(strip(r.text)) : r.text, width, "…");
				return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2))) + text;
			});
		},
	}, options);

	return {
		hide,
		collapse() {
			if (collapsing) return;
			collapsing = true;
			timer = setInterval(() => {
				frame++;
				if (frame >= FRAMES) hide();
				tui.requestRender();
			}, FRAME_MS);
			timer.unref?.();
		},
	};
}
