/**
 * MCP servers management UI (Integrations → Connected apps → MCP Servers).
 *
 * Two-tier model (CrewAI / Copilot Studio style): servers are CONNECTED here
 * once, then ATTACHED per-expert from the Expert panel's "MCP tools" section.
 * Each server row shows live status, discovered tool count, an "Available in
 * chat" toggle (main Cerebro agent), test-connection, and remove.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  RefreshCw,
  Trash2,
  AlertTriangle,
  Loader2,
  TerminalSquare,
  Globe,
} from 'lucide-react';
import clsx from 'clsx';
import { GoogleDriveIcon } from '../../icons/BrandIcons';
import type { McpServerInfo } from '../../../mcp/types';
import Toggle from '../../ui/Toggle';
import AlertModal from '../../ui/AlertModal';
import GoogleDriveConnectModal from './GoogleDriveConnectModal';
import AddCustomMcpModal from './AddCustomMcpModal';

function statusPill(server: McpServerInfo, t: (k: string) => string) {
  const map: Record<McpServerInfo['status'], { cls: string; label: string }> = {
    connected: {
      cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
      label: t('mcp.status.connected'),
    },
    discovering: {
      cls: 'border-sky-500/30 bg-sky-500/10 text-sky-400',
      label: t('mcp.status.discovering'),
    },
    auth_expired: {
      cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
      label: t('mcp.status.authExpired'),
    },
    error: {
      cls: 'border-red-500/30 bg-red-500/10 text-red-400',
      label: t('mcp.status.error'),
    },
  };
  const { cls, label } = map[server.status];
  return (
    <span
      className={clsx(
        'text-[10px] font-medium px-2 py-0.5 rounded-full border flex items-center gap-1',
        cls,
      )}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" /> {label}
    </span>
  );
}

function ServerRow({
  server,
  busy,
  onToggleChat,
  onRediscover,
  onRemove,
}: {
  server: McpServerInfo;
  busy: boolean;
  onToggleChat: () => void;
  onRediscover: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const isDrive = server.kind === 'gdrive';
  const transportSummary =
    server.transport === 'stdio' ? `stdio · ${server.command ?? ''}` : `http · ${server.url ?? ''}`;

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-surface/40 p-3">
      <div className="flex items-center gap-2.5">
        {isDrive ? (
          <GoogleDriveIcon size={18} className="text-text-primary" />
        ) : server.transport === 'stdio' ? (
          <TerminalSquare size={18} className="text-text-secondary" />
        ) : (
          <Globe size={18} className="text-text-secondary" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-text-primary truncate">
            {server.name}
            {server.accountLabel && (
              <span className="ml-1.5 text-[11px] font-normal text-text-tertiary">
                {server.accountLabel}
              </span>
            )}
          </div>
          <div className="text-[11px] text-text-tertiary truncate">
            {isDrive ? t('mcp.section.driveSummary') : transportSummary}
            {' · '}
            {t('mcp.section.toolCount').replace('{{count}}', String(server.tools.length))}
          </div>
        </div>
        {statusPill(server, t)}
      </div>

      {server.lastError && server.status !== 'connected' && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-400">
          <AlertTriangle size={12} className="shrink-0" />
          <span className="truncate">{server.lastError}</span>
        </div>
      )}

      {server.tools.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {server.tools.map((tool) => (
            <span
              key={tool.name}
              title={tool.description}
              className="text-[10px] px-1.5 py-0.5 rounded border border-border-subtle bg-bg-elevated text-text-secondary"
            >
              {tool.name}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        <span className="flex items-center gap-2 text-[11px] text-text-secondary">
          <Toggle checked={server.chatEnabled} onChange={onToggleChat} disabled={busy} />
          {t('mcp.section.availableInChat')}
        </span>
        <div className="flex-1" />
        <button
          onClick={onRediscover}
          disabled={busy}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-text-secondary hover:bg-bg-hover disabled:opacity-50"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}{' '}
          {t('mcp.section.testConnection')}
        </button>
        <button
          onClick={onRemove}
          disabled={busy}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-red-400 hover:bg-red-500/10 disabled:opacity-50"
        >
          <Trash2 size={11} /> {t('mcp.section.remove')}
        </button>
      </div>
    </div>
  );
}

export default function MCPServersSection() {
  const { t } = useTranslation();
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showDriveConnect, setShowDriveConnect] = useState(false);
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<McpServerInfo | null>(null);

  const refresh = useCallback(async () => {
    setServers(await window.cerebro.mcp.listServers());
  }, []);

  useEffect(() => {
    void refresh();
    const off = window.cerebro.mcp.onChanged(() => void refresh());
    return off;
  }, [refresh]);

  const toggleChat = async (server: McpServerInfo, enabled: boolean) => {
    setBusyId(server.id);
    await window.cerebro.mcp.setChatEnabled(server.id, enabled);
    setBusyId(null);
    void refresh();
  };

  const rediscover = async (server: McpServerInfo) => {
    setBusyId(server.id);
    await window.cerebro.mcp.rediscover(server.id);
    setBusyId(null);
    void refresh();
  };

  const remove = async (server: McpServerInfo) => {
    setPendingRemove(null);
    setBusyId(server.id);
    await window.cerebro.mcp.removeServer(server.id);
    setBusyId(null);
    void refresh();
  };

  const driveServer = servers.find((s) => s.kind === 'gdrive') ?? null;
  const customServers = servers.filter((s) => s.kind !== 'gdrive');

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-text-secondary">{t('mcp.section.description')}</p>

      {/* Featured: Google Drive */}
      {driveServer ? (
        <ServerRow
          server={driveServer}
          busy={busyId === driveServer.id}
          onToggleChat={() => void toggleChat(driveServer, !driveServer.chatEnabled)}
          onRediscover={() => void rediscover(driveServer)}
          onRemove={() => setPendingRemove(driveServer)}
        />
      ) : (
        <div className="rounded-lg border border-border-subtle bg-bg-surface/40 p-3 flex items-center gap-2.5">
          <GoogleDriveIcon size={18} className="text-text-primary" />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium text-text-primary">Google Drive</div>
            <div className="text-[11px] text-text-tertiary">{t('mcp.section.driveHint')}</div>
          </div>
          <button
            onClick={() => setShowDriveConnect(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] bg-accent/15 text-accent hover:bg-accent/25"
          >
            <Plus size={11} /> {t('mcp.section.connect')}
          </button>
        </div>
      )}

      {/* Custom servers */}
      {customServers.map((server) => (
        <ServerRow
          key={server.id}
          server={server}
          busy={busyId === server.id}
          onToggleChat={() => void toggleChat(server, !server.chatEnabled)}
          onRediscover={() => void rediscover(server)}
          onRemove={() => setPendingRemove(server)}
        />
      ))}

      <button
        onClick={() => setShowAddCustom(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] bg-accent/15 text-accent hover:bg-accent/25"
      >
        <Plus size={13} /> {t('mcp.section.addCustom')}
      </button>
      <p className="text-[11px] text-text-tertiary">{t('mcp.section.attachHint')}</p>

      {showDriveConnect && (
        <GoogleDriveConnectModal
          onClose={() => {
            setShowDriveConnect(false);
            void refresh();
          }}
          onPersisted={() => void refresh()}
        />
      )}

      {showAddCustom && (
        <AddCustomMcpModal
          onClose={() => {
            setShowAddCustom(false);
            void refresh();
          }}
          onPersisted={() => void refresh()}
        />
      )}

      {pendingRemove && (
        <AlertModal
          iconTone="danger"
          icon={<Trash2 size={16} className="text-red-400" />}
          title={t('mcp.section.remove')}
          message={t('mcp.section.removeConfirm').replace('{{name}}', pendingRemove.name)}
          onClose={() => setPendingRemove(null)}
          actions={[
            { label: t('mcp.section.cancel'), onClick: () => setPendingRemove(null) },
            {
              label: t('mcp.section.remove'),
              primary: true,
              variant: 'danger',
              onClick: () => void remove(pendingRemove),
            },
          ]}
        />
      )}
    </div>
  );
}
