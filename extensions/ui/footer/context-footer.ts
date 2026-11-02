import type { ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";

export function installContextFooter(ctx: ExtensionContext): () => ReadonlyFooterDataProvider | undefined {
	let capturedFooterData: ReadonlyFooterDataProvider | undefined;
	ctx.ui.setFooter((_tui, _theme, footerData) => {
		capturedFooterData = footerData;
		return {
			dispose() {},
			invalidate() {},
			render(): string[] { return []; },
		};
	});
	return () => capturedFooterData;
}
