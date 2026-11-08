export interface Notification {
  title: string;
  message: string;
  /** Opened when the notification is clicked. */
  url?: string;
}

export interface Notifier {
  notify(n: Notification): Promise<void>;
}
