import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const WORDS = ["Stargazing", "Wandering", "Weaving", "Unfolding", "Navigating", "Gathering", "Illuminating", "Daydreaming"];
const STARS = ["·", "∙", "⋅", "∗", "✢", "✣", "✤", "✥", "✳", "✺", "❄", "✺", "✳", "✥", "✤", "✣", "✢", "∗", "⋅", "∙"];

export function blueWave(text: string, frame: number): string {
	return [...text].map((char, index) => {
		const wave = (Math.sin(frame * 0.12 - index * 0.45) + 1) / 2;
		const red = Math.round(45 + wave * 80);
		const green = Math.round(125 + wave * 75);
		return `\x1b[38;2;${red};${green};255m${char}`;
	}).join("") + "\x1b[39m";
}

export function workingFrame(frame: number): string {
	return blueWave(WORDS[Math.floor(frame / 25) % WORDS.length]!, frame);
}

export function installWorkingIndicator(ctx: ExtensionContext): void {
	ctx.ui.setWorkingIndicator({
		frames: Array.from({ length: STARS.length * 3 }, (_, frame) => `\x1b[38;2;90;175;255m${STARS[Math.floor(frame / 3)]!}\x1b[39m`),
		intervalMs: 120,
	});
}

export function startWorkingAnimation(ctx: ExtensionContext): () => void {
	let frame = 0;
	ctx.ui.setWorkingMessage(workingFrame(frame));
	const timer = setInterval(() => ctx.ui.setWorkingMessage(workingFrame(++frame)), 120);
	return () => { clearInterval(timer); ctx.ui.setWorkingMessage(); };
}
