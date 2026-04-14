import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, Trash2, Plus } from 'lucide-react';
import clsx from 'clsx';
import type { NotifyChannel, Routine } from '../../../types/routines';
import { useRoutines } from '../../../context/RoutineContext';
import { loadSetting } from '../../../lib/settings';
import { TELEGRAM_SETTING_KEYS } from '../../../telegram/types';

interface Props {
  routine: Routine;
}

/**
 * Toolbar popover that lets the user pick who gets notified when the
 * routine completes (or fails). v1: Telegram only — recipients are
 * drawn from the bridge's allowlist so we can't dispatch to strangers.
 */
export default function NotifyChannelsPopover({ routine }: Props) {
  const { t } = useTranslation();
  const { updateRoutine } = useRoutines();
  const [open, setOpen] = useState(false);
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  const current = routine.notifyChannels ?? [];
  const hasAny = current.length > 0;

  // Load Telegram allowlist so the picker has concrete options.
  useEffect(() => {
    if (!open) return;
    (async () => {
      const list = await loadSetting<string[]>(TELEGRAM_SETTING_KEYS.allowlist);
      setAllowlist(Array.isArray(list) ? list : []);
    })();
  }, [open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const saveChannels = useCallback(
    (next: NotifyChannel[]) => {
      updateRoutine(routine.id, {
        notify_channels: next,
      } as Parameters<typeof updateRoutine>[1]);
    },
    [routine.id, updateRoutine],
  );

  const toggleRecipient = useCallback(
    (recipient: string) => {
      const hasIt = current.some((c) => c.channel === 'telegram' && c.recipient === recipient);
      const next = hasIt
        ? current.filter((c) => !(c.channel === 'telegram' && c.recipient === recipient))
        : [...current, { channel: 'telegram' as const, recipient }];
      saveChannels(next);
    },
    [current, saveChannels],
  );

  const removeAll = useCallback(() => saveChannels([]), [saveChannels]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors',
          hasAny
            ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
            : 'bg-bg-elevated text-text-secondary border border-border-subtle hover:border-border-default',
        )}
        title={t('routineEditor.notifyOnCompletion')}
      >
        <Bell size={11} />
        {hasAny
          ? t('routineEditor.notifyCount', { count: current.length })
          : `${t('routineEditor.notifyOnCompletion')} · ${t('routineEditor.notifyViaTelegram')}`}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg p-3 min-w-[260px] z-50">
          <div className="flex items-baseline justify-between mb-2">
            <div className="text-xs font-medium text-text-primary">
              {t('routineEditor.notifyOnCompletion')}
            </div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-sky-400">
              {t('routineEditor.notifyChannelTelegram')}
            </div>
          </div>

          {allowlist.length === 0 ? (
            <div className="text-[11px] text-text-tertiary leading-relaxed">
              {t('routineEditor.notifyNoAllowlist')}
            </div>
          ) : (
            <div className="space-y-1">
              {allowlist.map((id) => {
                const checked = current.some(
                  (c) => c.channel === 'telegram' && c.recipient === id,
                );
                return (
                  <label
                    key={id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-bg-hover cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRecipient(id)}
                      className="accent-sky-400"
                    />
                    <span className="text-[11px] font-mono text-text-secondary">Telegram · {id}</span>
                  </label>
                );
              })}
            </div>
          )}

          {hasAny && (
            <button
              type="button"
              onClick={removeAll}
              className="mt-3 flex items-center gap-1 text-[11px] text-text-tertiary hover:text-red-400 transition-colors"
            >
              <Trash2 size={11} />
              {t('routineEditor.notifyClear')}
            </button>
          )}
          {!hasAny && allowlist.length > 0 && (
            <div className="mt-3 text-[11px] text-text-tertiary flex items-center gap-1">
              <Plus size={11} />
              {t('routineEditor.notifyHint')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
