import { CustomEditor } from "@earendil-works/pi-coding-agent";

export class PipeCursorEditor extends CustomEditor {
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

