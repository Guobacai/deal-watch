// Costco product URLs look like https://www.costco.com/p/-/<slug>/<itemNumber>

const PRODUCT_PATH = /^\/p\/[^/]+\/[^/]+\/(\d+)\/?$/;

/** `/p/-/<slug>/<itemNumber>` → itemNumber, or null if the URL isn't a product page. */
export function parseItemNumber(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(PRODUCT_PATH);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export class InvalidItemUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidItemUrlError";
  }
}

/**
 * Validate a Costco product URL and normalize it (https, no query string or hash).
 * Throws InvalidItemUrlError with a user-facing message.
 */
export function parseItemUrl(input: string): { itemNumber: string; url: string } {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new InvalidItemUrlError("That isn't a valid URL.");
  }
  if (u.hostname !== "www.costco.com" && u.hostname !== "costco.com") {
    throw new InvalidItemUrlError("Only costco.com product URLs are supported.");
  }
  const m = u.pathname.match(PRODUCT_PATH);
  if (!m) {
    throw new InvalidItemUrlError("That isn't a Costco product page (expected /p/-/<name>/<item number>).");
  }
  return { itemNumber: m[1], url: `https://www.costco.com${u.pathname.replace(/\/$/, "")}` };
}
