/**
 * Show a native OS notification. Electron renders the web Notification API as a
 * real OS notification. Best-effort: if notifications aren't permitted we
 * silently skip (callers keep a badge/toast fallback so the UI stays correct).
 *
 * Shared by approval alerts and task-completion alerts — keep this the single
 * implementation so both surfaces behave identically.
 */
export function showOsNotification(title: string, body: string, onClick: () => void): void {
  if (typeof Notification === 'undefined') return;
  const show = () => {
    try {
      const n = new Notification(title, { body });
      n.onclick = onClick;
    } catch {
      /* notifications unavailable — badge/toast still cover it */
    }
  };
  if (Notification.permission === 'granted') {
    show();
  } else if (Notification.permission !== 'denied') {
    void Notification.requestPermission().then((perm) => {
      if (perm === 'granted') show();
    });
  }
}
