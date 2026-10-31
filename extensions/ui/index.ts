import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PipeCursorEditor } from "./editor/pipe-cursor-editor.ts";
import { installContextFooter } from "./footer/context-footer.ts";
import { installTopbar } from "./widget/topbar.ts";
import { registerContextCommand } from "./context.ts";
import { registerDashboard } from "./dashboard.ts";

export default function (pi: ExtensionAPI) {
	registerContextCommand(pi);
	let getFooterData: ReturnType<typeof installContextFooter> | undefined;
	registerDashboard(pi, () => getFooterData?.());
	let footerActive = false;
	pi.events?.on("ui:footer:available", (data) => { if (footerActive) (data as { available: boolean }).available = true; });
	pi.on("session_start", (_event, ctx) => {
		footerActive = ctx.mode === "tui";
		ctx.ui.setEditorComponent((tui, theme, kb) => new PipeCursorEditor(tui, theme, kb));
		getFooterData = installContextFooter(ctx, () => {
			const request = { available: false };
			pi.events?.emit("task-memory:footer:available", request);
			return request.available;
		});
		installTopbar(ctx, getFooterData);
	});
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const request = { available: false };
		pi.events?.emit("task-memory:footer:available", request);
		ctx.ui.setWorkingVisible(!request.available);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		footerActive = false;
		if (ctx.mode === "tui") ctx.ui.setWorkingVisible(true);
	});
}
