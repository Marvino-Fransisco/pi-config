import type { ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

export function installContextFooter(ctx: ExtensionContext): () => ReadonlyFooterDataProvider | undefined {
	let capturedFooterData: ReadonlyFooterDataProvider | undefined;
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
	return () => capturedFooterData;
}
