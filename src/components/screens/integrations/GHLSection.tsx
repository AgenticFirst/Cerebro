import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, Loader2, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

interface GHLConfig {
  api_key_set: boolean;
  location_id: string;
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'err'; error: string };

export default function GHLSection() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<GHLConfig | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [locationId, setLocationId] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [editing, setEditing] = useState(false);
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });
  const [savedFlash, setSavedFlash] = useState(false);
  const flashRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadConfig = useCallback(async () => {
    const res = await window.cerebro.invoke<GHLConfig>({
      method: 'GET',
      path: '/integrations/ghl/config',
    });
    if (res.ok) {
      setConfig(res.data);
      setLocationId(res.data.location_id ?? '');
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => () => {
    if (flashRef.current) clearTimeout(flashRef.current);
  }, []);

  const handleSave = useCallback(async () => {
    if (!apiKey.trim() || !locationId.trim()) return;
    const res = await window.cerebro.invoke<GHLConfig>({
      method: 'PUT',
      path: '/integrations/ghl/config',
      body: { api_key: apiKey.trim(), location_id: locationId.trim() },
    });
    if (res.ok) {
      setConfig(res.data);
      setApiKey('');
      setEditing(false);
      setShowKey(false);
      setTestState({ kind: 'idle' });
      setSavedFlash(true);
      if (flashRef.current) clearTimeout(flashRef.current);
      flashRef.current = setTimeout(() => setSavedFlash(false), 1_500);
    }
  }, [apiKey, locationId]);

  const handleTest = useCallback(async () => {
    setTestState({ kind: 'testing' });
    const res = await window.cerebro.invoke<{ ok: boolean; error?: string }>({
      method: 'POST',
      path: '/integrations/ghl/test',
    });
    if (res.data?.ok) {
      setTestState({ kind: 'ok' });
    } else {
      setTestState({ kind: 'err', error: res.data?.error ?? t('ghlSection.testFailed') });
    }
  }, [t]);

  const handleDisconnect = useCallback(async () => {
    await window.cerebro.invoke({
      method: 'PUT',
      path: '/integrations/ghl/config',
      body: { api_key: '', location_id: '' },
    });
    setConfig(null);
    setApiKey('');
    setLocationId('');
    setEditing(false);
    setTestState({ kind: 'idle' });
  }, []);

  const configured = Boolean(config?.api_key_set);
  const showForm = !configured || editing;

  return (
    <div className="space-y-4">
      {/* API Key */}
      <div>
        <label className="text-xs font-medium text-text-secondary">{t('ghlSection.apiKeyLabel')}</label>
        <p className="text-[11px] text-text-tertiary mt-1 leading-relaxed">
          {t('ghlSection.apiKeyHelp')}
        </p>

        {showForm ? (
          <div className="mt-2 flex items-center gap-2">
            <div className="relative flex-1">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('ghlSection.apiKeyPlaceholder')}
                className="w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 pr-10 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? t('ghlSection.hideKey') : t('ghlSection.showKey')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            {configured && (
              <button
                type="button"
                onClick={() => { setEditing(false); setApiKey(''); }}
                className="px-3 py-2 text-sm rounded-md font-medium text-text-tertiary hover:text-text-secondary"
              >
                {t('common.cancel')}
              </button>
            )}
          </div>
        ) : (
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-md bg-bg-surface border border-border-subtle text-sm">
              <span className="text-text-secondary font-mono">••••••••••••••••</span>
            </div>
            <button
              type="button"
              onClick={() => { setEditing(true); setTestState({ kind: 'idle' }); }}
              className="px-3 py-2 text-sm rounded-md font-medium bg-accent/15 text-accent hover:bg-accent/25"
            >
              {t('ghlSection.replaceKey')}
            </button>
          </div>
        )}
      </div>

      {/* Location ID */}
      <div>
        <label className="text-xs font-medium text-text-secondary">{t('ghlSection.locationIdLabel')}</label>
        <p className="text-[11px] text-text-tertiary mt-1 leading-relaxed">
          {t('ghlSection.locationIdHelp')}
        </p>
        <input
          type="text"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          placeholder={t('ghlSection.locationIdPlaceholder')}
          disabled={configured && !editing}
          className="mt-2 w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 disabled:opacity-60 disabled:cursor-not-allowed"
          spellCheck={false}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-2">
          {configured && !editing && (
            <>
              <button
                type="button"
                onClick={handleTest}
                disabled={testState.kind === 'testing'}
                className={clsx(
                  'px-3 py-1.5 text-xs rounded-md font-medium transition-colors',
                  'bg-accent/15 text-accent hover:bg-accent/25',
                  'disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5',
                )}
              >
                {testState.kind === 'testing' && <Loader2 size={11} className="animate-spin" />}
                {t('ghlSection.testConnection')}
              </button>
              <button
                type="button"
                onClick={handleDisconnect}
                className="px-3 py-1.5 text-xs rounded-md font-medium text-text-tertiary hover:text-red-400 transition-colors"
              >
                {t('ghlSection.disconnect')}
              </button>
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          {savedFlash && (
            <span className="text-xs text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 size={12} /> {t('ghlSection.saved')}
            </span>
          )}
          {showForm && (
            <button
              type="button"
              onClick={handleSave}
              disabled={!apiKey.trim() || !locationId.trim()}
              className="px-3 py-1.5 text-xs rounded-md font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('common.save')}
            </button>
          )}
        </div>
      </div>

      {/* Test result */}
      {testState.kind === 'ok' && (
        <div className="flex items-center gap-1.5 text-xs text-emerald-400">
          <CheckCircle2 size={13} />
          <span>{t('ghlSection.testSuccess')}</span>
        </div>
      )}
      {testState.kind === 'err' && (
        <div className="flex items-center gap-1.5 text-xs text-red-400">
          <XCircle size={13} />
          <span>{testState.error}</span>
        </div>
      )}
    </div>
  );
}
