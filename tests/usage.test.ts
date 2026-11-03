import assert from "node:assert/strict";
import test from "node:test";
import { accountIdFromToken, formatClaudeUsage, formatCodexUsage, levelColor, providerFor } from "../extensions/ui/usage.ts";

test("claude usage renders bar, percent used, absolute reset and level colors", () => {
	const now = Date.parse("2026-11-03T00:00:00Z");
	const text = formatClaudeUsage({ five_hour: { utilization: 15, resets_at: "2026-11-03T05:29:59.7Z" }, seven_day: { utilization: 75, resets_at: "2026-11-07T20:59:59Z" }, seven_day_sonnet: { utilization: 95, resets_at: null }, seven_day_opus: null }, now, "Asia/Jakarta");
	assert.match(text, /^Current session\n\x1b\[38;2;105;180;255m█{7}▌ {42}\x1b\[39m \x1b\[38;2;105;180;255m15% used/);
	assert.match(text, /Resets 12:30pm \(Asia\/Jakarta\)/);
	assert.match(text, /Current week \(all models\)\n\x1b\[33m.*75% used.*\nResets Nov 8 at 4am \(Asia\/Jakarta\)/);
	assert.match(text, /\x1b\[31m.*95% used\x1b\[39m$/);
	assert.doesNotMatch(text, /Opus/);
});

test("level color thresholds", () => {
	assert.equal(levelColor(69.9), "\x1b[38;2;105;180;255m");
	assert.equal(levelColor(70), "\x1b[33m");
	assert.equal(levelColor(90), "\x1b[31m");
});

test("codex usage labels windows by length", () => {
	const now = Date.parse("2026-11-03T00:00:00Z");
	const text = formatCodexUsage({ rate_limit: { primary_window: { used_percent: 85, limit_window_seconds: 18000, reset_after_seconds: 3600 }, secondary_window: { used_percent: 9, limit_window_seconds: 604800, reset_after_seconds: 90000 } } }, now, "UTC");
	assert.match(text, /Current session\n.*85% used.*\nResets 1am \(UTC\)/);
	assert.match(text, /Current week\n.*9% used.*\nResets Nov 4 at 1am \(UTC\)/);
});

test("usage rejects a response without windows", () => {
	assert.throws(() => formatClaudeUsage({}), /no limit windows/);
	assert.throws(() => formatCodexUsage({ rate_limit: null }), /no limit windows/);
});

test("provider detection and account id extraction", () => {
	assert.equal(providerFor("claude-bridge"), "claude");
	assert.equal(providerFor("anthropic"), "claude");
	assert.equal(providerFor("openai-codex"), "codex");
	assert.equal(providerFor("google"), undefined);
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } })).toString("base64url");
	assert.equal(accountIdFromToken(`h.${payload}.s`), "acc-1");
	assert.equal(accountIdFromToken("garbage"), undefined);
});
