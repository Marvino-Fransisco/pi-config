import type { ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const BLUE = "\x1b[38;2;90;175;255m";
const RESET = "\x1b[0m";

export function installContextFooter(ctx: ExtensionContext, hasTaskFooter: () => boolean = () => false): () => ReadonlyFooterDataProvider | undefined {
	let capturedFooterData: ReadonlyFooterDataProvider | undefined;
	ctx.ui.setFooter((_tui, _theme, footerData) => {
		capturedFooterData = footerData;
		return {
			dispose() {},
			invalidate() {},
			render(width: number): string[] {
				if (hasTaskFooter()) return [];
				let modelText = ctx.model?.id || "no-model";
				if (ctx.model?.reasoning) {
					const thinkingLevel = ctx.thinkingLevel || "off";
					modelText += thinkingLevel === "off" ? " • thinking off" : ` • ${thinkingLevel}`;
				}
				const modelLine = truncateToWidth(BLUE + modelText + RESET, width, BLUE + "..." + RESET);
				return [" ".repeat(Math.max(0, width - visibleWidth(modelLine))) + modelLine];
			},
		};
	});
	return () => capturedFooterData;
}
