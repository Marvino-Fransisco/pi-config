import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PipeCursorEditor } from "./editor/pipe-cursor-editor.ts";
import { installContextFooter } from "./footer/context-footer.ts";
import { installTopbar } from "./widget/topbar.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, kb) => new PipeCursorEditor(tui, theme, kb));
		const getFooterData = installContextFooter(ctx);
		installTopbar(ctx, getFooterData);
	});
}
