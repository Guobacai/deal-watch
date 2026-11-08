// Settings from environment variables, with defaults.
import { resolve } from "node:path";
import { parseReminderTime } from "./reminder";

export interface Config {
  dataDir: string;
  itemsPath: string;
  historyPath: string;
  statePath: string;
  port: number;
  /** A check run gives up on items that haven't reported after this long. */
  runTimeoutMs: number;
  /** Daily reminder time, as minutes after midnight (local time). */
  reminderMinutes: number;
  /** Set NOTIFICATIONS=off to turn Mac notifications off. */
  notifications: boolean;
  /** Repeat captures of the same item and result within this window are collapsed. */
  dedupeWindowMs: number;
}

function number(env: NodeJS.ProcessEnv, key: string, fallback: number, what = "a number ≥ 0"): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be ${what} (got "${raw}")`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.DATA_DIR || "data");
  const port = number(env, "PORT", 4000, "a port number");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT must be 1–65535 (got "${env.PORT}")`);
  return {
    dataDir,
    itemsPath: resolve(dataDir, "items.json"),
    historyPath: resolve(dataDir, "history.json"),
    statePath: resolve(dataDir, "state.json"),
    port,
    runTimeoutMs: number(env, "RUN_TIMEOUT_MINUTES", 10) * 60_000,
    reminderMinutes: parseReminderTime(env.REMINDER_TIME || "09:00"),
    notifications: env.NOTIFICATIONS !== "off",
    dedupeWindowMs: number(env, "DEDUPE_MINUTES", 10) * 60_000,
  };
}
