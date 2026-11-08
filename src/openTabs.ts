// Open URLs as tabs in Google Chrome on this Mac. Uses execFile (no shell), so URLs can't inject commands.
import { execFile } from "node:child_process";

export function openInChrome(urls: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("open", ["-a", "Google Chrome", ...urls], { timeout: 15_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve();
    });
  });
}
