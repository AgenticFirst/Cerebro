/**
 * Add a custom MCP server (stdio command or HTTP endpoint). On save, the
 * main process runs a bounded connection test + tool discovery and only
 * persists servers that respond — errors show inline so the user can fix
 * the config and retry without losing their input.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Loader2, Plus, Trash2, X, XCircle } from 'lucide-react';
import clsx from 'clsx';
import type { DiscoveredTool, McpTransport } from '../../../mcp/types';

interface Props {
  onClose: () => void;
  onPersisted?: () => void;
}

interface KeyValueRow {
  key: string;
  value: string;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'ok'; tools: DiscoveredTool[] }
  | { kind: 'err'; error: string };

function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}) {
  return (
    <div className="space-y-1.5">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            value={row.key}
            onChange={(e) =>
              onChange(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
            }
            placeholder={keyPlaceholder}
            className="w-[38%] bg-bg-surface border border-border-subtle rounded-md px-2 py-1 text-[12px] text-text-primary outline-none focus:border-accent font-mono"
          />
          <input
            value={row.value}
            onChange={(e) =>
              onChange(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
            }
            placeholder={valuePlaceholder}
            type="password"
            className="flex-1 bg-bg-surface border border-border-subtle rounded-md px-2 py-1 text-[12px] text-text-primary outline-none focus:border-accent font-mono"
          />
          <button
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            className="text-text-tertiary hover:text-red-400"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <button
        onClick={() => onChange([...rows, { key: '', value: '' }])}
        className="flex items-center gap-1 text-[11px] text-accent hover:underline"
      >
        <Plus size={11} /> {addLabel}
      </button>
    </div>
  );
}

export default function AddCustomMcpModal({ onClose, onPersisted }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<McpTransport>('stdio');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [url, setUrl] = useState('');
  const [envRows, setEnvRows] = useState<KeyValueRow[]>([]);
  const [headerRows, setHeaderRows] = useState<KeyValueRow[]>([]);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });

  const canSave =
    Boolean(name.trim()) &&
    (transport === 'stdio' ? Boolean(command.trim()) : /^https?:\/\//.test(url.trim()));

  const toRecord = (rows: KeyValueRow[]): Record<string, string> =>
    Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));

  const submit = async () => {
    setSave({ kind: 'saving' });
    try {
      const res = await window.cerebro.mcp.addCustomServer({
        name: name.trim(),
        transport,
        ...(transport === 'stdio'
          ? {
              command: command.trim(),
              args: argsText.trim() ? argsText.trim().split(/\s+/) : [],
              env: toRecord(envRows),
            }
          : {
              url: url.trim(),
              headers: toRecord(headerRows),
            }),
      });
      if (res.ok && res.server) {
        setSave({ kind: 'ok', tools: res.server.tools });
        onPersisted?.();
      } else {
        setSave({ kind: 'err', error: res.error ?? 'Unknown error' });
      }
    } catch (err) {
      setSave({ kind: 'err', error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[480px] max-w-[92vw] rounded-xl border border-border-subtle bg-bg-base shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <h2 className="flex-1 text-[15px] font-semibold text-text-primary">
            {t('mcp.custom.title')}
          </h2>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-secondary">
            <X size={16} />
          </button>
        </div>

        {save.kind === 'ok' ? (
          <div className="px-4 py-6 flex flex-col items-center text-center">
            <CheckCircle2 size={28} className="text-emerald-400" />
            <p className="text-[13px] text-text-secondary mt-2">
              {t('mcp.custom.success').replace('{{count}}', String(save.tools.length))}
            </p>
            <div className="mt-2 flex flex-wrap gap-1 justify-center max-w-sm">
              {save.tools.map((tool) => (
                <span
                  key={tool.name}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-border-subtle bg-bg-elevated text-text-secondary"
                >
                  {tool.name}
                </span>
              ))}
            </div>
            <button
              onClick={onClose}
              className="mt-4 px-3 py-1 rounded-md text-[12px] bg-accent text-black font-medium"
            >
              {t('mcp.custom.done')}
            </button>
          </div>
        ) : (
          <>
            <div className="px-4 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
              <div>
                <label className="block text-[11px] uppercase tracking-wide text-text-tertiary mb-1">
                  {t('mcp.custom.fields.name')}
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('mcp.custom.hints.name')}
                  className="w-full bg-bg-surface border border-border-subtle rounded-md px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent"
                />
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wide text-text-tertiary mb-1">
                  {t('mcp.custom.fields.transport')}
                </label>
                <div className="flex gap-1.5">
                  {(['stdio', 'http'] as const).map((tr) => (
                    <button
                      key={tr}
                      onClick={() => setTransport(tr)}
                      className={clsx(
                        'px-3 py-1 rounded-md text-[12px] border',
                        transport === tr
                          ? 'border-accent/50 bg-accent/10 text-accent'
                          : 'border-border-subtle bg-bg-surface text-text-secondary hover:bg-bg-hover',
                      )}
                    >
                      {tr === 'stdio'
                        ? t('mcp.custom.transportStdio')
                        : t('mcp.custom.transportHttp')}
                    </button>
                  ))}
                </div>
              </div>

              {transport === 'stdio' ? (
                <>
                  <div>
                    <label className="block text-[11px] uppercase tracking-wide text-text-tertiary mb-1">
                      {t('mcp.custom.fields.command')}
                    </label>
                    <input
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      placeholder="npx"
                      className="w-full bg-bg-surface border border-border-subtle rounded-md px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] uppercase tracking-wide text-text-tertiary mb-1">
                      {t('mcp.custom.fields.args')}
                    </label>
                    <input
                      value={argsText}
                      onChange={(e) => setArgsText(e.target.value)}
                      placeholder="-y some-mcp-server"
                      className="w-full bg-bg-surface border border-border-subtle rounded-md px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] uppercase tracking-wide text-text-tertiary mb-1">
                      {t('mcp.custom.fields.env')}
                    </label>
                    <KeyValueEditor
                      rows={envRows}
                      onChange={setEnvRows}
                      keyPlaceholder="API_KEY"
                      valuePlaceholder={t('mcp.custom.hints.secretValue')}
                      addLabel={t('mcp.custom.addEnv')}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-[11px] uppercase tracking-wide text-text-tertiary mb-1">
                      {t('mcp.custom.fields.url')}
                    </label>
                    <input
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://example.com/mcp"
                      className="w-full bg-bg-surface border border-border-subtle rounded-md px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] uppercase tracking-wide text-text-tertiary mb-1">
                      {t('mcp.custom.fields.headers')}
                    </label>
                    <KeyValueEditor
                      rows={headerRows}
                      onChange={setHeaderRows}
                      keyPlaceholder="Authorization"
                      valuePlaceholder={t('mcp.custom.hints.secretValue')}
                      addLabel={t('mcp.custom.addHeader')}
                    />
                  </div>
                </>
              )}

              <p className="text-[11px] text-text-tertiary">{t('mcp.custom.secretsHint')}</p>

              {save.kind === 'err' && (
                <div className="flex items-start gap-1.5 text-[12px] text-red-400">
                  <XCircle size={13} className="shrink-0 mt-0.5" />
                  <span>{t('mcp.custom.error').replace('{{error}}', save.error)}</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-border-subtle px-4 py-2.5">
              <button
                onClick={onClose}
                disabled={save.kind === 'saving'}
                className="px-2.5 py-1 rounded-md text-[12px] text-text-tertiary hover:text-text-secondary disabled:opacity-50"
              >
                {t('mcp.custom.cancel')}
              </button>
              <button
                onClick={submit}
                disabled={!canSave || save.kind === 'saving'}
                className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] bg-accent text-black font-medium hover:brightness-110 disabled:opacity-40"
              >
                {save.kind === 'saving' ? (
                  <>
                    <Loader2 size={12} className="animate-spin" /> {t('mcp.custom.testing')}
                  </>
                ) : (
                  t('mcp.custom.addAndTest')
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
