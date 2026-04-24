import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, Loader2, Lock, ShieldAlert, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { HubSpotIcon } from '../../icons/BrandIcons';
import type { HubSpotPipelineSummary, HubSpotStatusResponse } from '../../../types/ipc';

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  | { kind: 'ok'; portalId: string | null }
  | { kind: 'err'; error: string };

interface HubSpotSectionProps {
  showHeader?: boolean;
}

export default function HubSpotSection({ showHeader = false }: HubSpotSectionProps = {}) {
  const [tokenDraft, setTokenDraft] = useState('');
  const [editingToken, setEditingToken] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const [status, setStatus] = useState<HubSpotStatusResponse | null>(null);
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' });

  const [pipelines, setPipelines] = useState<HubSpotPipelineSummary[]>([]);
  const [selectedPipeline, setSelectedPipeline] = useState<string>('');
  const [selectedStage, setSelectedStage] = useState<string>('');
  const [pipelinesLoading, setPipelinesLoading] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetTokenEditor = useCallback(() => {
    setTokenDraft('');
    setEditingToken(false);
    setShowToken(false);
    setVerify({ kind: 'idle' });
  }, []);

  const refreshStatus = useCallback(async () => {
    const s = await window.cerebro.hubspot.status();
    setStatus(s);
    if (s.defaultPipeline) setSelectedPipeline(s.defaultPipeline);
    if (s.defaultStage) setSelectedStage(s.defaultStage);
  }, []);

  const loadPipelines = useCallback(async () => {
    setPipelinesLoading(true);
    const res = await window.cerebro.hubspot.listPipelines();
    setPipelinesLoading(false);
    if (res.ok && res.pipelines) setPipelines(res.pipelines);
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (status?.hasToken) {
      void loadPipelines();
    } else {
      setPipelines([]);
      setSelectedPipeline('');
      setSelectedStage('');
    }
  }, [status?.hasToken, loadPipelines]);

  const handleVerify = useCallback(async () => {
    if (!tokenDraft.trim()) return;
    setVerify({ kind: 'verifying' });
    const res = await window.cerebro.hubspot.verify(tokenDraft.trim());
    if (res.ok) setVerify({ kind: 'ok', portalId: res.portalId ?? null });
    else setVerify({ kind: 'err', error: res.error ?? 'Unknown error' });
  }, [tokenDraft]);

  const handleSaveToken = useCallback(async () => {
    if (!tokenDraft.trim()) return;
    const res = await window.cerebro.hubspot.setToken(tokenDraft.trim());
    if (res.ok) {
      resetTokenEditor();
      await refreshStatus();
      await loadPipelines();
    } else {
      setVerify({ kind: 'err', error: res.error ?? 'Save failed' });
    }
  }, [tokenDraft, refreshStatus, loadPipelines, resetTokenEditor]);

  const handleClearToken = useCallback(async () => {
    await window.cerebro.hubspot.clearToken();
    resetTokenEditor();
    setPipelines([]);
    setSelectedPipeline('');
    setSelectedStage('');
    await refreshStatus();
  }, [refreshStatus, resetTokenEditor]);

  const handleSaveDefaults = useCallback(async () => {
    await window.cerebro.hubspot.setDefaults({
      pipeline: selectedPipeline || null,
      stage: selectedStage || null,
    });
    await refreshStatus();
    setSavedFlash(true);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setSavedFlash(false), 1_500);
  }, [selectedPipeline, selectedStage, refreshStatus]);

  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  const tokenConfigured = Boolean(status?.hasToken);
  const showTokenInput = !tokenConfigured || editingToken;
  const usingKeychain = status?.tokenBackend === 'os-keychain';
  const stagesForSelected = pipelines.find((p) => p.id === selectedPipeline)?.stages ?? [];

  return (
    <div>
      {showHeader && (
        <>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-orange-500/15 text-orange-400">
              <HubSpotIcon size={18} />
            </div>
            <h2 className="text-lg font-medium text-text-primary">HubSpot CRM</h2>
          </div>
          <p className="text-sm text-text-secondary mt-3 leading-relaxed">
            Open and update tickets, contacts, and deals in HubSpot from a routine.
          </p>
        </>
      )}

      {/* Storage backend banner */}
      {status && (
        usingKeychain ? (
          <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">
            <Lock size={14} className="mt-0.5 flex-shrink-0" />
            <span className="leading-relaxed">Access token is encrypted in your OS keychain.</span>
          </div>
        ) : (
          <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-warning/30 bg-warning/10 text-xs text-warning-text">
            <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
            <span className="leading-relaxed">No OS keychain available — token stored with fallback encoding.</span>
          </div>
        )
      )}

      {/* Token row */}
      <div className="mt-6">
        <label className="text-xs font-medium text-text-secondary">Private App access token</label>
        <p className="text-[11px] text-text-tertiary mt-1 leading-relaxed">
          Create a Private App in HubSpot Settings → Integrations → Private Apps, with the
          <code className="mx-1 px-1 py-0.5 rounded bg-bg-elevated text-[10px]">crm.objects.tickets.write</code>
          and
          <code className="mx-1 px-1 py-0.5 rounded bg-bg-elevated text-[10px]">crm.objects.contacts.write</code>
          scopes, then paste the generated token below.
        </p>

        {showTokenInput ? (
          <>
            <div className="mt-2 flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={tokenDraft}
                  onChange={(e) => { setTokenDraft(e.target.value); setVerify({ kind: 'idle' }); }}
                  placeholder="pat-na1-..."
                  className="w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 pr-10 text-sm font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
                >
                  {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <button
                type="button"
                onClick={handleVerify}
                disabled={!tokenDraft.trim() || verify.kind === 'verifying'}
                className={clsx(
                  'px-3 py-2 text-sm rounded-md font-medium transition-colors',
                  'bg-accent/15 text-accent hover:bg-accent/25',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                {verify.kind === 'verifying' ? 'Verifying…' : 'Verify'}
              </button>
              {verify.kind === 'ok' && (
                <button
                  type="button"
                  onClick={handleSaveToken}
                  className="px-3 py-2 text-sm rounded-md font-medium bg-accent text-white hover:bg-accent-hover"
                >
                  Save
                </button>
              )}
              {tokenConfigured && (
                <button
                  type="button"
                  onClick={resetTokenEditor}
                  className="px-3 py-2 text-sm rounded-md font-medium text-text-tertiary hover:text-text-secondary"
                >
                  Cancel
                </button>
              )}
            </div>
            {verify.kind === 'ok' && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-400">
                <CheckCircle2 size={13} />
                <span>Portal id: {verify.portalId ?? '(hidden)'}</span>
              </div>
            )}
            {verify.kind === 'err' && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-red-400">
                <XCircle size={13} />
                <span>{verify.error}</span>
              </div>
            )}
          </>
        ) : (
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-md bg-bg-surface border border-border-subtle text-sm">
              <Lock size={13} className="text-emerald-400/80 flex-shrink-0" />
              <span className="text-text-secondary">Connected to portal <span className="font-mono">{status?.portalId ?? '(unknown)'}</span></span>
            </div>
            <button
              type="button"
              onClick={() => { setEditingToken(true); setVerify({ kind: 'idle' }); }}
              className="px-3 py-2 text-sm rounded-md font-medium bg-accent/15 text-accent hover:bg-accent/25"
            >
              Replace token
            </button>
            <button
              type="button"
              onClick={handleClearToken}
              className="px-3 py-2 text-sm rounded-md font-medium text-text-tertiary hover:text-red-400"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>

      {/* Default ticket pipeline + stage */}
      {tokenConfigured && (
        <div className="mt-6">
          <label className="text-xs font-medium text-text-secondary">Default ticket pipeline + stage</label>
          <p className="text-[11px] text-text-tertiary mt-1 leading-relaxed">
            New tickets created by routines land here unless a step overrides them.
          </p>
          {pipelinesLoading ? (
            <div className="mt-3 flex items-center gap-2 text-xs text-text-tertiary">
              <Loader2 size={12} className="animate-spin" /> Loading pipelines…
            </div>
          ) : (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <select
                value={selectedPipeline}
                onChange={(e) => { setSelectedPipeline(e.target.value); setSelectedStage(''); }}
                className="w-full h-9 px-3 text-sm bg-bg-surface border border-border-subtle rounded-md text-text-primary focus:outline-none focus:border-accent/50"
              >
                <option value="">— Pipeline —</option>
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              <select
                value={selectedStage}
                onChange={(e) => setSelectedStage(e.target.value)}
                disabled={!selectedPipeline}
                className="w-full h-9 px-3 text-sm bg-bg-surface border border-border-subtle rounded-md text-text-primary focus:outline-none focus:border-accent/50 disabled:opacity-50"
              >
                <option value="">— Stage —</option>
                {stagesForSelected.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </div>
          )}
          <div className="mt-3 flex items-center justify-end gap-3">
            {savedFlash && (
              <span className="text-xs text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 size={12} /> Saved
              </span>
            )}
            <button
              type="button"
              onClick={handleSaveDefaults}
              disabled={!selectedPipeline || !selectedStage}
              className="px-3 py-1.5 text-xs rounded-md font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Save defaults
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
