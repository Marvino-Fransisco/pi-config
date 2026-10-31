import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PipeCursorEditor } from "./editor/pipe-cursor-editor.ts";
import { installContextFooter } from "./footer/context-footer.ts";
import { installTopbar } from "./widget/topbar.ts";
import { installWorkingIndicator, startWorkingAnimation } from "./widget/working.ts";

export default function (pi: ExtensionAPI) {
	let stopWorking: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") installWorkingIndicator(ctx);
		ctx.ui.setEditorComponent((tui, theme, kb) => new PipeCursorEditor(tui, theme, kb));
		const getFooterData = installContextFooter(ctx);
		installTopbar(ctx, getFooterData);
	});
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		stopWorking?.();
		stopWorking = startWorkingAnimation(ctx);
	});
	pi.on("agent_settled", () => { stopWorking?.(); stopWorking = undefined; });
	pi.on("session_shutdown", (_event, ctx) => {
		stopWorking?.();
		stopWorking = undefined;
		if (ctx.mode === "tui") ctx.ui.setWorkingIndicator();
	});
}
