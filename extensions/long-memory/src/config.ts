import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));
export const COMPOSE_PATH = fileURLToPath(new URL("../docker/compose.yml", import.meta.url));

export interface MemoryConfig {
  appUrl?: string;
  readerUrl?: string;
  googleKey?: string;
  minSimilarity: number;
  backup: boolean;
  backupKeep: number;
}

export function readConfig(path = ENV_PATH, env: NodeJS.ProcessEnv = process.env): MemoryConfig {
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
  const minSimilarity = Number(value("MEMORY_MIN_SIMILARITY") ?? "0.6");
  if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) throw new Error("MEMORY_MIN_SIMILARITY must be between 0 and 1");
  const backupKeep = Number(value("MEMORY_BACKUP_KEEP") ?? "7");
  if (!Number.isSafeInteger(backupKeep) || backupKeep < 1) throw new Error("MEMORY_BACKUP_KEEP must be a positive integer");
  return {
    appUrl: url("MEMORY_DATABASE_URL", "memory_app", value("MEMORY_APP_PASSWORD")),
    readerUrl: url("MEMORY_READER_DATABASE_URL", "memory_reader", value("MEMORY_READER_PASSWORD")),
    googleKey: value("GEMINI_API_KEY"),
    minSimilarity,
    backup: value("MEMORY_BACKUP") !== "off",
    backupKeep,
  };
}
