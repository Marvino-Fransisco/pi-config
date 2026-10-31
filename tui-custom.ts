/**
 * tui-custom — custom footer, context bar, pipe cursor, yellow model/thinking text.
 *
 * - Footer: pwd (white), context bar [####------] NN% (color by usage), model+thinking (yellow)
 * - Removes the default token-stats line (↑/↓/R/W/CH/cost/etc.)
 * - Editor cursor: thin bar instead of default '█' reverse-video block
 * - ctrl+y already maps to tui.editor.yank (paste last deleted text) by default — no change needed
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Colors (raw ANSI, independent of active theme so they stay exact)
// ---------------------------------------------------------------------------

const WHITE = "\x1b[97m";
const YELLOW = "\x1b[33m";
const ORANGE = "\x1b[38;5;208m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const SHADOW = "\x1b[90m";
const RESET = "\x1b[0m";

function barStatus(percent: number): { color: string; label: string } {
	if (percent >= 100) return { color: RED, label: "✕ FULL" };
	if (percent >= 98) return { color: RED, label: "✕ LIMIT" };
	if (percent >= 90) return { color: RED, label: "⚠ CRITICAL" };
	if (percent >= 80) return { color: ORANGE, label: "▲ HIGH" };
	if (percent >= 25) return { color: YELLOW, label: "◐ WATCH" };
	return { color: GREEN, label: "● SAFE" };
}

// ---------------------------------------------------------------------------
// Custom editor: '|' cursor instead of reverse-video block
// ---------------------------------------------------------------------------

class PipeCursorEditor extends CustomEditor {
	constructor(...args: ConstructorParameters<typeof CustomEditor>) {
		super(...args);
	}

	render(width: number): string[] {
		let lines = super.render(width);

		// Move the @/"/" autocomplete suggestion list (files, skills, commands)
		// from below the input box to above it. The base Editor always appends
		// it after the bottom border, so detect the bottom-border line and split
		// there: everything after it is the autocomplete block.
		//
		// IMPORTANT: the border test must be strict. An earlier version allowed
		// [a-z0-9] in the pattern, which false-matched ordinary lowercase editor
		// content (e.g. typed text, skill/command names) as "the border" and
		// split at the wrong line — that was the reported bug. A real border is
		// only the '─' box-drawing char, optionally with a scroll indicator like
		// "─── ↓ 3 more ───" (arrow + digits + literal "more", still dash-framed).
		// Real content essentially never consists solely of '─'.
		if (this.isShowingAutocomplete()) {
			const STRIP_RE = /\x1b\[[0-9;]*m|\x1b_pi:c\x07/g;
			const BORDER_RE = /^(?=.*─)\s*─*\s*(?:[↑↓]\s*\d+\s*more\s*─*\s*)?$/i;
			let borderIndex = -1;
			for (let i = lines.length - 1; i >= 0; i--) {
				const stripped = lines[i]!.replace(STRIP_RE, "");
				if (BORDER_RE.test(stripped)) {
					borderIndex = i;
					break;
				}
			}
			if (borderIndex !== -1 && borderIndex < lines.length - 1) {
				const box = lines.slice(0, borderIndex + 1);
				const autocomplete = lines.slice(borderIndex + 1);
				lines = [...autocomplete, ...box];
			}
		}

		return lines;
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		// Pipe cursor
		ctx.ui.setEditorComponent((tui, theme, kb) => new PipeCursorEditor(tui, theme, kb));

		// Captured so the topbar widget (below) can reuse it — setWidget's
		// factory doesn't receive footerData directly.
		let capturedFooterData: import("@earendil-works/pi-coding-agent").ReadonlyFooterDataProvider | undefined;

		// Custom footer — context bar + model/thinking only. pwd/branch and
		// extension statuses (caveman, pi-lens/LSP, etc.) live in the topbar
		// widget above the editor instead (see below).
		ctx.ui.setFooter((_tui, _theme, footerData) => {
			capturedFooterData = footerData;
			return {
				dispose() {},
				invalidate() {},
				render(width: number): string[] {
					const usage = ctx.getContextUsage();
					const hasPercent = typeof usage?.percent === "number" && Number.isFinite(usage.percent);
					const percent = hasPercent ? Math.max(0, Math.min(100, usage.percent!)) : 0;
					const filled = Math.round(percent / 5);
					const status = hasPercent ? barStatus(Math.round(percent)) : { color: SHADOW, label: "○ UNKNOWN" };
					const suffix = hasPercent ? ` ${Math.round(percent)}%  ${status.label}` : ` ?%  ${status.label}`;
					const barText = `${"█".repeat(filled)}${"░".repeat(20 - filled)}${suffix}`;
					const barLine = `${status.color}${"█".repeat(filled)}${SHADOW}${"░".repeat(20 - filled)}${status.color}${suffix}${RESET}`;

					const modelName = ctx.model?.id || "no-model";
					let modelText = modelName;
					if (ctx.model?.reasoning) {
						const thinkingLevel = ctx.thinkingLevel || "off";
						modelText =
							thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
					}
					const maxModelWidth = Math.max(0, width - visibleWidth(barText) - 1);
					const modelLine = truncateToWidth(
						YELLOW + modelText + RESET,
						maxModelWidth,
						YELLOW + "..." + RESET,
					);
					const gap = " ".repeat(
						Math.max(1, width - visibleWidth(barText) - visibleWidth(modelLine)),
					);
					const contextLine = barLine + gap + modelLine;

					return [truncateToWidth(contextLine, width)];
				},
			};
		});

		// Topbar widget (above editor): pwd/branch + extension statuses
		// (caveman level, pi-lens/LSP status, etc.) — moved off the footer.
		ctx.ui.setWidget(
			"topbar",
			(_tui, _theme) => {
				const unsub = capturedFooterData?.onBranchChange(() => _tui.requestRender());
				return {
					dispose: unsub,
					invalidate() {},
					render(width: number): string[] {
						const home = process.env.HOME || process.env.USERPROFILE;
						let pwd = ctx.sessionManager.getCwd();
						if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
						const branch = capturedFooterData?.getGitBranch();
						if (branch) pwd = `${pwd} (${branch})`;
						const pwdLine = truncateToWidth(WHITE + pwd + RESET, width, WHITE + "..." + RESET);

						// Extension statuses (caveman level, pi-lens/LSP) intentionally dropped —
						// not shown anywhere in the UI per user request.
						return [pwdLine];
					},
				};
			},
			{ placement: "aboveEditor" },
		);
	});
}
