// Serves the portal's static files from public/. A fixed list, so no path from the URL ever reaches the disk.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));

const FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/format.js": { file: "format.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

// Scripts and styles only from this service; images from Costco aren't used. No framing by other sites.
const CSP = "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export function registerPortalRoutes(app: FastifyInstance, publicDir = PUBLIC_DIR) {
  for (const [route, { file, type }] of Object.entries(FILES)) {
    app.get(route, async (_req, reply) => {
      const body = await readFile(publicDir + file);
      return reply
        .header("content-type", type)
        .header("content-security-policy", CSP)
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "no-cache")
        .send(body);
    });
  }
}
