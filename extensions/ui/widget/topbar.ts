import type { ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const BLUE = "\x1b[38;2;90;175;255m";
const WHITE = "\x1b[97m";
const RESET = "\x1b[0m";

export function installTopbar(ctx: ExtensionContext, getFooterData: () => ReadonlyFooterDataProvider | undefined): void {
	ctx.ui.setWidget(
		"topbar",
		(_tui, _theme) => {
			const unsub = getFooterData()?.onBranchChange(() => _tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const home = process.env.HOME || process.env.USERPROFILE;
					let pwd = ctx.sessionManager.getCwd();
					if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
					const branch = getFooterData()?.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					let model = ctx.model?.id || "no-model";
					if (ctx.model?.reasoning) {
						const level = ctx.thinkingLevel || "off";
						model += level === "off" ? " • thinking off" : ` • ${level}`;
					}
					const right = truncateToWidth(BLUE + model + RESET, Math.max(0, width - 1), BLUE + "..." + RESET);
					const pwdLine = truncateToWidth(WHITE + pwd + RESET, Math.max(0, width - visibleWidth(right) - 1), WHITE + "..." + RESET);
					const line = pwdLine + " ".repeat(Math.max(0, width - visibleWidth(pwdLine) - visibleWidth(right))) + right;

					// Extension statuses (caveman level, pi-lens/LSP) intentionally dropped —
					// not shown anywhere in the UI per user request.
					return [line];
				},
			};
		},
		{ placement: "belowEditor" },
	);
}
