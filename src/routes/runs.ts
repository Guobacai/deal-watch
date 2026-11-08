// Starting a check run and following its progress.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { AlreadyRunningError, BadTokenError, NothingToCheckError, OpenTabsError, type RunManager } from "../runs";

const TokenQuery = z.object({ token: z.string().max(200).default("") });

function page(reply: FastifyReply, status: number, title: string, message: string) {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return reply
    .code(status)
    .header("content-type", "text/html; charset=utf-8")
    .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
    .send(
      `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>` +
        `<body style="font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px">` +
        `<h1 style="font-size:20px">${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">Open the portal</a></p></body>`,
    );
}

export function registerRunRoutes(app: FastifyInstance, runs: RunManager) {
  // The portal's "Check all" button.
  app.post("/api/runs", async (_req, reply) => {
    try {
      return reply.code(201).send(await runs.start("portal"));
    } catch (e) {
      if (e instanceof AlreadyRunningError) return reply.code(409).send({ error: e.message, run: e.run });
      if (e instanceof NothingToCheckError) return reply.code(400).send({ error: e.message });
      if (e instanceof OpenTabsError) return reply.code(500).send({ error: e.message });
      throw e;
    }
  });

  app.get("/api/runs/current", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    return runs.current();
  });

  // The link in the daily reminder notification. Needs today's one-time token,
  // so another website can't start a run by linking here.
  app.get("/run/start", async (req, reply) => {
    const { token } = TokenQuery.parse(req.query);
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    try {
      await runs.startWithToken(token);
      return reply.redirect("/", 303);
    } catch (e) {
      if (e instanceof BadTokenError) {
        return page(reply, 403, "Link expired", `${e.message} Use the Check all button in the portal instead.`);
      }
      if (e instanceof AlreadyRunningError || e instanceof NothingToCheckError) return reply.redirect("/", 303);
      if (e instanceof OpenTabsError) return page(reply, 500, "Couldn't open Chrome", e.message);
      throw e;
    }
  });
}
