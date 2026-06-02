import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ExternalLink, Eye, EyeOff, Lock, ShieldAlert, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { SlackIcon } from '../../icons/BrandIcons';
import { loadSetting, saveSetting } from '../../../lib/settings';
import { SLACK_SETTING_KEYS } from '../../../slack/types';
import type { SlackStatusResponse } from '../../../types/ipc';
import UserExpertAccessEditor from './UserExpertAccessEditor';

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  | { kind: 'ok'; teamName: string }
  | { kind: 'err'; error: string };

interface SlackSectionProps {
  showHeader?: boolean;
}

export default function SlackSection({ showHeader = false }: SlackSectionProps = {}) {
  const { t } = useTranslation();

  const [botDraft, setBotDraft] = useState('');
  const [appDraft, setAppDraft] = useState('');
  const [editingTokens, setEditingTokens] = useState(false);
  const [showBot, setShowBot] = useState(false);
  const [showApp, setShowApp] = useState(false);

  const [allowChans, setAllowChans] = useState('');
  const [allowUsers, setAllowUsers] = useState('');
  const [operatorUserId, setOperatorUserId] = useState('');
  const [enabled, setEnabled] = useState(false);

  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' });
  const [status, setStatus] = useState<SlackStatusResponse | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveWarn, setSaveWarn] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);

  useEffect(() => {
    (async () => {
      const [chans, users, en, operator] = await Promise.all([
        loadSetting<string[]>(SLACK_SETTING_KEYS.allowlistChannels),
        loadSetting<string[]>(SLACK_SETTING_KEYS.allowlistUsers),
        loadSetting<boolean>(SLACK_SETTING_KEYS.enabled),
        loadSetting<string>(SLACK_SETTING_KEYS.operatorUserId),
      ]);
      if (Array.isArray(chans)) setAllowChans(chans.join(', '));
      if (Array.isArray(users)) setAllowUsers(users.join(', '));
      if (typeof en === 'boolean') setEnabled(en);
      if (typeof operator === 'string') setOperatorUserId(operator);
    })();
  }, []);

  const refreshStatus = useCallback(async () => {
    const s = await window.cerebro.slack.status();
    setStatus((prev) => {
      if (
        prev
        && prev.running === s.running
        && prev.lastEventAt === s.lastEventAt
        && prev.lastError === s.lastError
        && prev.teamName === s.teamName
        && prev.hasBotToken === s.hasBotToken
        && prev.hasAppToken === s.hasAppToken
        && prev.tokenBackend === s.tokenBackend
      ) {
        return prev;
      }
      return s;
    });
  }, []);

  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, 5_000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  const parseList = useCallback((raw: string, prefixes: string[]): string[] => {
    return raw
      .split(/[,\s]+/)
      .map((s) => s.trim().replace(/^<[#@]([A-Z0-9]+)(?:\|[^>]*)?>$/, '$1'))
      .filter((s) => s === '*' || prefixes.some((p) => s.startsWith(p) && s.length >= 7));
  }, []);

  const handleVerify = useCallback(async () => {
    if (!botDraft.trim() || !appDraft.trim()) return;
    setVerify({ kind: 'verifying' });
    const res = await window.cerebro.slack.verify(botDraft.trim(), appDraft.trim());
    if (res.ok && res.teamName) {
      setVerify({ kind: 'ok', teamName: res.teamName });
    } else {
      setVerify({ kind: 'err', error: res.error ?? 'Unknown error' });
    }
  }, [botDraft, appDraft]);

  const persistTokensIfDraft = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!botDraft.trim() || !appDraft.trim()) return { ok: true };
    const res = await window.cerebro.slack.setTokens({
      botToken: botDraft.trim(),
      appToken: appDraft.trim(),
    });
    if (res.ok) {
      setBotDraft('');
      setAppDraft('');
      setEditingTokens(false);
      setShowBot(false);
      setShowApp(false);
      setVerify({ kind: 'idle' });
    }
    return res;
  }, [botDraft, appDraft]);

  const handleSave = useCallback(async () => {
    const channels = parseList(allowChans, ['C', 'G', 'D']);
    const users = parseList(allowUsers, ['U', 'W']);
    setSaveWarn(null);
    const tokenRes = await persistTokensIfDraft();
    if (!tokenRes.ok) {
      // Replacing tokens on a live bridge is persisted but not hot-applied;
      // surface the re-enable warning instead of silently doing nothing.
      setSaveWarn(tokenRes.error ?? 'Could not save tokens.');
      await refreshStatus();
      return;
    }
    await Promise.all([
      saveSetting(SLACK_SETTING_KEYS.allowlistChannels, channels),
      saveSetting(SLACK_SETTING_KEYS.allowlistUsers, users),
    ]);
    await window.cerebro.slack.setAllowlist({ channels, users });
    const trimmedOperator = operatorUserId.trim() || null;
    await window.cerebro.slack.setOperatorUserId(trimmedOperator);
    if (enabled && status?.running) {
      await window.cerebro.slack.reload();
    }
    await refreshStatus();
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1_500);
  }, [allowChans, allowUsers, operatorUserId, parseList, persistTokensIfDraft, enabled, status?.running, refreshStatus]);

  const handleClearTokens = useCallback(async () => {
    await window.cerebro.slack.clearTokens();
    setBotDraft('');
    setAppDraft('');
    setEditingTokens(false);
    setShowBot(false);
    setShowApp(false);
    setVerify({ kind: 'idle' });
    await refreshStatus();
  }, [refreshStatus]);

  const tokensConfigured = Boolean(status?.hasBotToken && status?.hasAppToken);
  const draftReady = botDraft.trim().length > 0 && appDraft.trim().length > 0;
  const canEnable =
    (enabled && status?.running)
    || (tokensConfigured && !editingTokens)
    || (draftReady && verify.kind === 'ok');

  const handleToggleEnable = useCallback(async () => {
    setEnabling(true);
    try {
      const tokenRes = await persistTokensIfDraft();
      if (!tokenRes.ok) return;

      const next = !enabled;
      await saveSetting(SLACK_SETTING_KEYS.enabled, next);
      setEnabled(next);
      if (next) {
        const res = await window.cerebro.slack.enable();
        if (!res.ok) {
          await saveSetting(SLACK_SETTING_KEYS.enabled, false);
          setEnabled(false);
        }
      } else {
        await window.cerebro.slack.disable();
      }
      await refreshStatus();
    } finally {
      setEnabling(false);
    }
  }, [enabled, persistTokensIfDraft, refreshStatus]);

  const lastEventLabel = status?.lastEventAt
    ? new Date(status.lastEventAt).toLocaleTimeString()
    : '—';

  const showTokenInputs = !tokensConfigured || editingTokens;
  const usingKeychain = status?.tokenBackend === 'os-keychain';

  return (
    <div>
      {showHeader && (
        <>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-purple-500/15 text-purple-400">
              <SlackIcon size={18} />
            </div>
            <h2 className="text-lg font-medium text-text-primary">{t('slackSection.title')}</h2>
          </div>
          <p className="text-sm text-text-secondary mt-3 leading-relaxed">
            {t('slackSection.description')}
          </p>
        </>
      )}

      {/* Storage status banner */}
      {status && (
        usingKeychain ? (
          <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">
            <Lock size={14} className="mt-0.5 flex-shrink-0" />
            <span className="leading-relaxed">{t('telegramSection.storageEncrypted')}</span>
          </div>
        ) : (
          <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-warning/30 bg-warning/10 text-xs text-warning-text">
            <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
            <span className="leading-relaxed">{t('telegramSection.storagePlaintextFallback')}</span>
          </div>
        )
      )}

      {/* Tokens */}
      <div className="mt-6 space-y-3">
        {showTokenInputs ? (
          <>
            <div>
              <label className="text-xs font-medium text-text-secondary">{t('slackSection.botTokenLabel')}</label>
              <div className="mt-1.5 relative">
                <input
                  type={showBot ? 'text' : 'password'}
                  value={botDraft}
                  onChange={(e) => { setBotDraft(e.target.value); setVerify({ kind: 'idle' }); }}
                  placeholder={t('slackSection.botTokenPlaceholder')}
                  className="w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 pr-10 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setShowBot((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
                  aria-label={showBot ? 'Hide bot token' : 'Show bot token'}
                >
                  {showBot ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-text-secondary">{t('slackSection.appTokenLabel')}</label>
              <div className="mt-1.5 relative">
                <input
                  type={showApp ? 'text' : 'password'}
                  value={appDraft}
                  onChange={(e) => { setAppDraft(e.target.value); setVerify({ kind: 'idle' }); }}
                  placeholder={t('slackSection.appTokenPlaceholder')}
                  className="w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 pr-10 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setShowApp((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
                  aria-label={showApp ? 'Hide app token' : 'Show app token'}
                >
                  {showApp ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleVerify}
                disabled={!draftReady || verify.kind === 'verifying'}
                className={clsx(
                  'px-3 py-2 text-sm rounded-md font-medium transition-colors',
                  'bg-accent/15 text-accent hover:bg-accent/25',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                {verify.kind === 'verifying' ? t('slackSection.verifying') : t('slackSection.verify')}
              </button>
              {tokensConfigured && (
                <button
                  type="button"
                  onClick={() => { setBotDraft(''); setAppDraft(''); setEditingTokens(false); setShowBot(false); setShowApp(false); setVerify({ kind: 'idle' }); }}
                  className="px-3 py-2 text-sm rounded-md font-medium text-text-tertiary hover:text-text-secondary"
                >
                  {t('telegramSection.cancel')}
                </button>
              )}
              {verify.kind === 'ok' && (
                <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                  <CheckCircle2 size={13} />
                  {t('slackConnect.verifiedAs', { teamName: verify.teamName })}
                </span>
              )}
              {verify.kind === 'err' && (
                <span className="flex items-center gap-1.5 text-xs text-red-400">
                  <XCircle size={13} />
                  {verify.error}
                </span>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-md bg-bg-surface border border-border-subtle text-sm">
              <Lock size={13} className="text-emerald-400/80 flex-shrink-0" />
              <span className="text-text-secondary">{t('slackSection.tokensVerified')}</span>
            </div>
            <button
              type="button"
              onClick={() => { setEditingTokens(true); setVerify({ kind: 'idle' }); }}
              className="px-3 py-2 text-sm rounded-md font-medium bg-accent/15 text-accent hover:bg-accent/25"
            >
              {t('telegramSection.replaceToken')}
            </button>
            <button
              type="button"
              onClick={handleClearTokens}
              className="px-3 py-2 text-sm rounded-md font-medium text-text-tertiary hover:text-red-400"
            >
              {t('slackSection.clear')}
            </button>
          </div>
        )}
      </div>

      {/* Allowlist - channels */}
      <div className="mt-6">
        <label className="text-xs font-medium text-text-secondary">{t('slackSection.allowlistChannelsLabel')}</label>
        <input
          type="text"
          value={allowChans}
          onChange={(e) => setAllowChans(e.target.value)}
          placeholder="C01ABCDE, G01ABCDE, *"
          className="mt-1.5 w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
          spellCheck={false}
        />
        <p className="mt-1.5 text-[11px] text-text-tertiary leading-relaxed">
          {t('slackSection.allowlistChannelsHelp')}
        </p>
      </div>

      {/* Allowlist - users */}
      <div className="mt-6">
        <label className="text-xs font-medium text-text-secondary">{t('slackSection.allowlistUsersLabel')}</label>
        <input
          type="text"
          value={allowUsers}
          onChange={(e) => setAllowUsers(e.target.value)}
          placeholder="U01ABCDE, W01ABCDE, *"
          className="mt-1.5 w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
          spellCheck={false}
        />
        <p className="mt-1.5 text-[11px] text-text-tertiary leading-relaxed">
          {t('slackSection.allowlistUsersHelp')}
        </p>
      </div>

      {/* Operator user id — receives Claude re-auth DMs */}
      <div className="mt-6">
        <label className="text-xs font-medium text-text-secondary">{t('slackSection.operatorUserIdLabel')}</label>
        <input
          type="text"
          value={operatorUserId}
          onChange={(e) => setOperatorUserId(e.target.value)}
          placeholder="U01ABCDE"
          className="mt-1.5 w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
          spellCheck={false}
        />
        <p className="mt-1.5 text-[11px] text-text-tertiary leading-relaxed">
          {t('slackSection.operatorUserIdHelp')}
        </p>
      </div>

      {/* Per-person expert access */}
      <UserExpertAccessEditor status={status} />

      {/* Save */}
      {saveWarn && (
        <div className="mt-4 flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-warning/30 bg-warning/10 text-xs text-warning-text">
          <ShieldAlert size={14} className="shrink-0 mt-px" />
          <span>{saveWarn}</span>
        </div>
      )}

      <div className="mt-5 flex items-center justify-end gap-3">
        {savedFlash && (
          <span className="text-sm text-emerald-400 flex items-center gap-1.5">
            <CheckCircle2 size={14} />
            {t('telegramSection.saved')}
          </span>
        )}
        <button
          type="button"
          onClick={handleSave}
          className="px-4 py-2 text-sm rounded-md font-medium bg-accent text-white hover:bg-accent-hover transition-colors flex items-center gap-1.5 shadow-sm"
        >
          <CheckCircle2 size={14} />
          {t('slackSection.save')}
        </button>
      </div>

      {/* Enable bridge */}
      <div className="mt-6 bg-bg-surface border border-border-subtle rounded-lg p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-sm text-text-primary font-medium">{t('slackSection.enableLabel')}</div>
            <div className="mt-2 flex items-center gap-2 text-xs">
              {enabling ? (
                <ExternalLink size={13} className="text-amber-400 animate-spin" />
              ) : status?.running ? (
                <CheckCircle2 size={13} className="text-emerald-400" />
              ) : (
                <XCircle size={13} className="text-text-tertiary" />
              )}
              <span className={status?.running ? 'text-emerald-400' : 'text-text-tertiary'}>
                {status?.running
                  ? t('slackSection.statusRunning', { at: lastEventLabel })
                  : t('slackSection.statusOffline')}
              </span>
            </div>
            {status?.teamName && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-text-tertiary">
                <SlackIcon size={11} className="text-purple-400/70" />
                <span>
                  {t('slackSection.workspaceLabel')}:{' '}
                  <span className="font-mono text-text-secondary">{status.teamName}</span>
                </span>
              </div>
            )}
            {status?.botUserId && (
              <div className="mt-1 text-[11px] text-text-tertiary">
                {t('slackSection.botUserLabel')}:{' '}
                <span className="font-mono text-text-secondary">{status.botUserId}</span>
              </div>
            )}
            {status?.lastError && (
              <div className="mt-2 text-[11px] text-red-400 break-all">
                {t('slackSection.statusError', { message: status.lastError })}
              </div>
            )}
            <p className="mt-3 text-[11px] text-text-tertiary leading-relaxed">
              {t('slackSection.helpHint')}
            </p>
          </div>
          <ToggleSwitch
            checked={enabled}
            disabled={!canEnable && !enabled}
            onChange={handleToggleEnable}
          />
        </div>
      </div>
    </div>
  );
}

interface ToggleProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}

function ToggleSwitch({ checked, disabled, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0',
        checked ? 'bg-accent' : 'bg-white/10',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <span
        className={clsx(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  );
}
