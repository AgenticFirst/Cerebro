import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../context/ToastContext';

/**
 * One-shot detector for "the app just came back from a backup restore".
 *
 * The Electron main process writes `.backup-restore-flag.json` into userData
 * when it applies a staged restore on boot. This component consumes that
 * flag on first mount and shows a toast so the user knows the swap worked,
 * then deletes the flag so it doesn't fire again.
 *
 * The undo affordance lives in Settings -> Backup; we don't try to surface
 * it inside the toast itself to keep the toast component model simple.
 */
export default function RestoreCompletionWatcher() {
  const { addToast } = useToast();
  const { t } = useTranslation();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const flag = await window.cerebro.backup.consumeCompletionFlag();
        if (cancelled || !flag) return;
        const message = flag.is_undo
          ? t('backup.toasts.undoComplete')
          : t('backup.toasts.restoreComplete');
        addToast(message, 'success');
      } catch {
        /* preload not ready yet; nothing to recover */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addToast, t]);

  return null;
}
