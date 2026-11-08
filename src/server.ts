// HTTP server: the extension posts prices here; the portal (Tasks 6–8) is served from here too.
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { InvalidItemUrlError } from "./costcoUrl";
import { checkTime, ObservationError, ObservationSchema, recordObservation, type ObservationDeps } from "./observations";
import { registerRunRoutes } from "./routes/runs";
import type { RunManager } from "./runs";
import { registerItemRoutes } from "./routes/items";
import { registerPortalRoutes } from "./routes/portal";
import { JsonFileError } from "./store/jsonFile";
import { DuplicateItemError, ItemNotFoundError } from "./store/items";

export interface ServerOptions extends ObservationDeps {
  port: number;
  logger?: boolean;
  /** Check runs. Without it, the run routes are off and captures aren't counted toward runs. */
  runs?: RunManager;
}

/**
 * Only this Mac's own pages and the Chrome extension may call the API.
 *  - Host must be 127.0.0.1/localhost on our port (blocks DNS-rebinding tricks).
 *  - If the browser sends an Origin, it must be the extension or the portal itself (blocks other websites).
 */
export function isAllowedRequest(port: number, host: string | undefined, origin: string | undefined): boolean {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!host || !hosts.includes(host)) return false;
  if (origin === undefined) return true; // curl, or same-origin GET navigation
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return true;
  return hosts.some((h) => origin === `http://${h}`);
}

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 16 * 1024 });
  // JSON only. A cross-site form or text/plain post (which browsers send without a CORS preflight) gets 415.
  app.removeContentTypeParser("text/plain");

  app.addHook("onRequest", async (req, reply) => {
    if (!isAllowedRequest(opts.port, req.headers.host, req.headers.origin)) {
      return reply.code(403).send({ error: "forbidden" });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      return reply.code(400).send({ error: `invalid ${issue?.path.join(".") || "body"}: ${issue?.message}` });
    }
    if (err instanceof InvalidItemUrlError || err instanceof ObservationError) {
      return reply.code(400).send({ error: err.message });
    }
    if (err instanceof DuplicateItemError) return reply.code(409).send({ error: err.message });
    if (err instanceof ItemNotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof JsonFileError) {
      req.log.error(err);
      return reply.code(500).send({ error: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.post("/api/observations", async (req, reply) => {
    const obs = ObservationSchema.parse(req.body);
    const at = checkTime(obs, (opts.now ?? (() => new Date()))());
    // The service decides which run a capture belongs to; whatever the client sent is ignored.
    delete obs.runId;
    const runId = await opts.runs?.runIdAt(at);
    if (runId) obs.runId = runId;
    const result = await recordObservation(opts, obs);
    if (result.watched && opts.runs) {
      await opts.runs.noteCapture(result.itemNumber, obs.price === null ? "failed" : "ok", obs.price, at);
    }
    const code = !result.watched ? 202 : result.saved ? 201 : 200;
    return reply.code(code).send(result);
  });

  registerItemRoutes(app, opts);
  if (opts.runs) registerRunRoutes(app, opts.runs);
  registerPortalRoutes(app);

  return app;
}
