import type { ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

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
					const pwdLine = truncateToWidth(WHITE + pwd + RESET, width, WHITE + "..." + RESET);

					// Extension statuses (caveman level, pi-lens/LSP) intentionally dropped —
					// not shown anywhere in the UI per user request.
					return [pwdLine];
				},
			};
		},
		{ placement: "belowEditor" },
	);
}
