import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PipeCursorEditor } from "./editor/pipe-cursor-editor.ts";
import { installContextFooter } from "./footer/context-footer.ts";
import { installTopbar } from "./widget/topbar.ts";
import { installWorkingIndicator, startWorkingAnimation } from "./widget/working.ts";
import { registerContextCommand } from "./context.ts";

export default function (pi: ExtensionAPI) {
	registerContextCommand(pi);
	let stopWorking: (() => void) | undefined;
	let footerActive = false;
	pi.events?.on("ui:footer:available", (data) => { if (footerActive) (data as { available: boolean }).available = true; });
	pi.on("session_start", (_event, ctx) => {
		footerActive = ctx.mode === "tui";
		if (ctx.mode === "tui") installWorkingIndicator(ctx);
		ctx.ui.setEditorComponent((tui, theme, kb) => new PipeCursorEditor(tui, theme, kb));
		const getFooterData = installContextFooter(ctx, () => {
			const request = { available: false };
			pi.events?.emit("task-memory:footer:available", request);
			return request.available;
		});
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
		footerActive = false;
		if (ctx.mode === "tui") ctx.ui.setWorkingIndicator();
	});
}
