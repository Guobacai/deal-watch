// macOS notifications through node-notifier (it ships terminal-notifier). Clicking opens the given URL.
import notifier from "node-notifier";
import type { Notification, Notifier } from "./types";

export class MacNotifier implements Notifier {
  notify(n: Notification): Promise<void> {
    return new Promise((resolve, reject) => {
      notifier.notify(
        {
          title: n.title,
          message: n.message,
          sound: true,
          wait: false,
          ...(n.url ? { open: n.url } : {}),
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }
}
