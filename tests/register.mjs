// Lets `node --test` load task-memory/index.ts outside Pi:
// Pi's packages are replaced by tests/stubs.mjs; typebox is the real one from the installed Pi release.
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const install = `${homedir()}/.pi/agent/install`;
const version = readFileSync(`${install}/current-version`, "utf8").trim();
const anchor = pathToFileURL(`${install}/releases/${version}/_anchor.js`).href;
const stubs = new URL("./stubs.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@earendil-works/")) return { url: stubs, shortCircuit: true };
    if (specifier === "typebox" || specifier.startsWith("typebox/")) return next(specifier, { ...context, parentURL: anchor });
    return next(specifier, context);
  },
});
