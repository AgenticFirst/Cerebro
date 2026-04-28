/**
 * GenericConnectModal — manifest-driven setup modal used by integrations
 * that don't ship a custom modal. Renders three steps from the manifest:
 *   1. Setup steps prose (BotFather-style walkthrough text).
 *   2. Credential fields with masked input + Verify button.
 *   3. Success / Done.
 *
 * Future integrations get this for free — drop a manifest into
 * src/integrations/manifests/, fill in `setupStepKeys` + `fields`, and
 * the IntegrationSetupCard will render this modal automatically.
 */

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, ArrowLeft, CheckCircle2, ExternalLink, Eye, EyeOff, Loader2, X, XCircle } from 'lucide-react';
import clsx from 'clsx';
import type { IntegrationManifest } from '../../../types/integrations';

interface GenericConnectModalProps {
  manifest: IntegrationManifest;
  onClose: () => void;
  onPersisted?: () => void;
}

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  | { kind: 'ok'; data?: Record<string, unknown> }
  | { kind: 'err'; error: string };

const STEP_COUNT = 3;

export default function GenericConnectModal({
  manifest,
  onClose,
  onPersisted,
}: GenericConnectModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [showSensitive, setShowSensitive] = useState<Record<string, boolean>>({});
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const integrationName = t(manifest.nameKey);

  const updateField = useCallback((key: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
    setVerify({ kind: 'idle' });
    setSaveError(null);
  }, []);

  const handleVerify = useCallback(async () => {
    if (!manifest.ipc.verify) return;
    setVerify({ kind: 'verifying' });
    try {
      const r = await manifest.ipc.verify(fieldValues);
      if (r.ok) {
        setVerify({ kind: 'ok', data: r.data });
      } else {
        setVerify({ kind: 'err', error: r.error ?? 'Verification failed.' });
      }
    } catch (err) {
      setVerify({ kind: 'err', error: err instanceof Error ? err.message : 'Verification failed.' });
    }
  }, [manifest, fieldValues]);

  const handleSave = useCallback(async () => {
    if (!manifest.ipc.saveCredentials) return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await manifest.ipc.saveCredentials(fieldValues);
      if (r.ok) {
        onPersisted?.();
        setStep(3);
      } else {
        setSaveError(r.error ?? 'Could not save credentials.');
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save credentials.');
    } finally {
      setSaving(false);
    }
  }, [manifest, fieldValues, onPersisted]);

  const allFieldsFilled = manifest.fields.every((f) => f.optional || (fieldValues[f.key] ?? '').length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-[600px] max-w-[92vw] max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-tertiary">
              {t('integrations.generic.stepLabel', { current: step, total: STEP_COUNT })}
            </span>
            <span className="text-text-tertiary">·</span>
            <span className="text-sm font-medium text-text-primary">{integrationName}</span>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {step === 1 && (
            <div className="space-y-4">
              <h2 className="text-base font-semibold text-text-primary">
                {t('integrations.generic.stepsTitle')}
              </h2>
              <p className="text-sm text-text-secondary">{t(manifest.descriptionKey)}</p>
              <ol className="space-y-3 list-decimal list-inside">
                {manifest.setupStepKeys.map((key) => (
                  <li key={key} className="text-sm text-text-secondary leading-relaxed">
                    {t(key)}
                  </li>
                ))}
              </ol>
              {manifest.docsUrl && (
                <a
                  href={manifest.docsUrl}
                  onClick={(e) => {
                    e.preventDefault();
                    window.cerebro.shell.openExternal(manifest.docsUrl!);
                  }}
                  className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
                >
                  <ExternalLink size={12} />
                  {t('integrations.generic.docsLink')}
                </a>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <h2 className="text-base font-semibold text-text-primary">
                {t('integrations.generic.fieldsTitle')}
              </h2>
              {manifest.fields.map((field) => {
                const isPwd = field.type === 'password';
                const reveal = showSensitive[field.key] ?? false;
                return (
                  <div key={field.key} className="space-y-1">
                    <label className="block text-xs font-medium text-text-secondary">
                      {t(field.labelKey)}
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type={isPwd && !reveal ? 'password' : 'text'}
                        value={fieldValues[field.key] ?? ''}
                        onChange={(e) => updateField(field.key, e.target.value)}
                        placeholder={field.hintKey ? t(field.hintKey) : undefined}
                        className="flex-1 px-3 py-2 rounded-md text-sm bg-bg-canvas border border-border-subtle text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
                      />
                      {isPwd && (
                        <button
                          onClick={() => setShowSensitive((prev) => ({ ...prev, [field.key]: !reveal }))}
                          className="text-text-tertiary hover:text-text-primary p-2"
                          aria-label="Toggle visibility"
                        >
                          {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Verify state */}
              {manifest.ipc.verify && (
                <div className="flex items-center gap-2 pt-2">
                  <button
                    onClick={handleVerify}
                    disabled={!allFieldsFilled || verify.kind === 'verifying'}
                    className="px-3 py-1.5 rounded-md text-xs font-medium bg-bg-hover/50 text-text-secondary hover:bg-bg-hover disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {verify.kind === 'verifying'
                      ? t('integrations.generic.verifying')
                      : t('integrations.generic.verify')}
                  </button>
                  {verify.kind === 'verifying' && <Loader2 size={14} className="text-text-tertiary animate-spin" />}
                  {verify.kind === 'ok' && (
                    <span className="flex items-center gap-1 text-xs text-green-400">
                      <CheckCircle2 size={12} />
                      {t('integrations.generic.verified')}
                    </span>
                  )}
                  {verify.kind === 'err' && (
                    <span className="flex items-center gap-1 text-xs text-red-400">
                      <XCircle size={12} />
                      {verify.error}
                    </span>
                  )}
                </div>
              )}

              {saveError && (
                <div className="flex items-center gap-1.5 text-xs text-red-400">
                  <XCircle size={12} />
                  {saveError}
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="text-center py-8 space-y-3">
              <CheckCircle2 size={40} className="text-green-400 mx-auto" />
              <h2 className="text-base font-semibold text-text-primary">
                {t('integrations.card.connectedSubtitle')}
              </h2>
              <p className="text-sm text-text-secondary">{integrationName}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border-subtle">
          <button
            onClick={() => (step > 1 ? setStep(step - 1) : onClose())}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 cursor-pointer"
          >
            {step > 1 ? <ArrowLeft size={12} /> : null}
            {step > 1 ? t('integrations.generic.back') : t('integrations.generic.cancel')}
          </button>

          {step === 1 && (
            <button
              onClick={() => setStep(2)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-accent/15 text-accent hover:bg-accent/25 cursor-pointer"
            >
              {t('integrations.generic.next')}
              <ArrowRight size={12} />
            </button>
          )}
          {step === 2 && (
            <button
              onClick={handleSave}
              disabled={
                !allFieldsFilled ||
                saving ||
                (manifest.ipc.verify ? verify.kind !== 'ok' : false)
              }
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer',
                'bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
              {saving ? t('integrations.generic.saving') : t('integrations.generic.save')}
            </button>
          )}
          {step === 3 && (
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent/15 text-accent hover:bg-accent/25 cursor-pointer"
            >
              {t('integrations.generic.done')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
