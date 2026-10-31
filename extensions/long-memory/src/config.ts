import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));

export function readConfig(path = ENV_PATH, env: NodeJS.ProcessEnv = process.env): { ownerUrl?: string; readerUrl?: string; googleKey?: string } {
  let file: Record<string, string | undefined> = {};
  try {
    file = parseEnv(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const value = (name: string) => env[name] ?? file[name];
  const port = value("MEMORY_DB_PORT") || "55432";
  const url = (name: string, user: string, password: string | undefined) => {
    const explicit = value(name);
    if (explicit !== undefined) return explicit;
    if (!password) return undefined;
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("MEMORY_DB_PORT must be a valid TCP port");
    return `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/pi_memory`;
  };
  return {
    ownerUrl: url("MEMORY_DATABASE_URL", "memory_owner", value("MEMORY_DB_PASSWORD")),
    readerUrl: url("MEMORY_READER_DATABASE_URL", "memory_reader", value("MEMORY_READER_PASSWORD")),
    googleKey: value("GEMINI_API_KEY"),
  };
}
