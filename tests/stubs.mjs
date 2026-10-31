// Minimal stand-ins for Pi's packages: just enough to load task-memory/index.ts in tests.
import { Type } from "typebox";

export const StringEnum = (values) => Type.Union(values.map((v) => Type.Literal(v)));
export const estimateTokens = (message) => Math.ceil(JSON.stringify(message.content ?? message.summary ?? "").length / 4);
export const DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };

export function findCutPoint(_entries, startIndex) {
  return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
}

export class CustomEditor {
  render() { return this.lines ?? []; }
  isShowingAutocomplete() { return this.autocomplete ?? false; }
}

export class Text {
  constructor(text) { this.text = text; }
  render() { return [this.text]; }
  invalidate() {}
}

export const truncateToWidth = (s, width, _ellipsis, pad) => pad ? s.padEnd(width) : s;
export const visibleWidth = (s) => [...s].length;
export const matchesKey = (data, key) => data === key;
export const wrapTextWithAnsi = (s, width) => s.match(new RegExp(`.{1,${width}}`, "gu")) ?? [""];
export const Key = { ctrlAlt: (key) => `ctrl+alt+${key}` };
