// Small JSON file store: zod-validated reads, atomic writes, a .bak copy, and
// writes serialized per file so concurrent callers in this process can't interleave.
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";

export class JsonFileError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "JsonFileError";
  }
}

const queues = new Map<string, Promise<unknown>>();

/** Run `fn` after any pending operation on the same path finishes. */
export function serialized<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(path) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(path, next.catch(() => undefined));
  return next;
}

/**
 * Read and validate a JSON file. A missing file returns `fallback`.
 * Unparseable or invalid content throws JsonFileError — the file is left untouched.
 */
export async function readJson<S extends z.ZodType>(path: string, schema: S, fallback: z.infer<S>): Promise<z.infer<S>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new JsonFileError(path, `not valid JSON (${(e as Error).message}). Fix or restore it from ${path}.bak.`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new JsonFileError(path, `invalid content at "${issue?.path.join(".") || "(root)"}": ${issue?.message}`);
  }
  return parsed.data;
}

/** Write JSON atomically: copy the current file to .bak, write a temp file, then rename over. */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await copyFile(path, `${path}.bak`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}
