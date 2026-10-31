// Minimal stand-ins for Pi's packages: just enough to load task-memory/index.ts in tests.
import { Type } from "typebox";

export const StringEnum = (values) => Type.Union(values.map((v) => Type.Literal(v)));

export function findCutPoint(_entries, startIndex) {
  return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
}

export class Text {
  constructor(text) { this.text = text; }
  render() { return [this.text]; }
  invalidate() {}
}

export const truncateToWidth = (s) => s;
export const visibleWidth = (s) => [...s].length;
export const matchesKey = () => false;
