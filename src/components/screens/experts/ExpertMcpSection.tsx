/**
 * Per-expert MCP tool grants (Expert panel → "MCP tools").
 *
 * Second tier of the two-tier model: servers are CONNECTED in Settings →
 * Integrations → MCP Servers; here the user attaches a connected server to
 * this expert with either all of its tools or a per-tool selection. Every
 * mutation re-materializes the expert's agent file (syncExpert) so the
 * granted tools take effect on the next turn — invisible plumbing, the
 * section itself always shows what the expert can currently do.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, ChevronRight, Settings2 } from 'lucide-react';
import clsx from 'clsx';
import type { McpServerInfo } from '../../../mcp/types';
import Toggle from '../../ui/Toggle';

interface ApiGrant {
  id: string;
  expert_id: string;
  mcp_server_id: string;
  all_tools: boolean;
  selected_tools: string[];
}

interface Props {
  expertId: string;
  isLocked?: boolean;
  /** Navigate to Integrations (used by the "Fix in Integrations" link). */
  onOpenIntegrations?: () => void;
}

export default function ExpertMcpSection({
  expertId,
  isLocked = false,
  onOpenIntegrations,
}: Props) {
  const { t } = useTranslation();
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [grants, setGrants] = useState<ApiGrant[]>([]);
  const [busyServerId, setBusyServerId] = useState<string | null>(null);
  const [expandedServerId, setExpandedServerId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [serverList, grantsRes] = await Promise.all([
      window.cerebro.mcp.listServers(),
      window.cerebro.invoke({ method: 'GET', path: `/experts/${expertId}/mcp-grants` }),
    ]);
    setServers(serverList);
    if (grantsRes.ok) setGrants(grantsRes.data as ApiGrant[]);
  }, [expertId]);

  useEffect(() => {
    void refresh();
    const off = window.cerebro.mcp.onChanged(() => void refresh());
    return off;
  }, [refresh]);

  const syncExpert = useCallback(async () => {
    await window.cerebro.installer.syncExpert(expertId).catch(() => {
      /* best-effort */
    });
  }, [expertId]);

  const grantFor = (serverId: string) => grants.find((g) => g.mcp_server_id === serverId) ?? null;

  const attach = async (server: McpServerInfo) => {
    setBusyServerId(server.id);
    try {
      await window.cerebro.invoke({
        method: 'POST',
        path: `/experts/${expertId}/mcp-grants`,
        body: { mcp_server_id: server.id, all_tools: true },
      });
      await syncExpert();
      await refresh();
    } finally {
      setBusyServerId(null);
    }
  };

  const detach = async (grant: ApiGrant) => {
    setBusyServerId(grant.mcp_server_id);
    try {
      await window.cerebro.invoke({
        method: 'DELETE',
        path: `/experts/${expertId}/mcp-grants/${grant.id}`,
      });
      await syncExpert();
      await refresh();
    } finally {
      setBusyServerId(null);
    }
  };

  const patchGrant = async (
    grant: ApiGrant,
    body: { all_tools?: boolean; selected_tools?: string[] },
  ) => {
    setBusyServerId(grant.mcp_server_id);
    try {
      await window.cerebro.invoke({
        method: 'PATCH',
        path: `/experts/${expertId}/mcp-grants/${grant.id}`,
        body,
      });
      await syncExpert();
      await refresh();
    } finally {
      setBusyServerId(null);
    }
  };

  const toggleAllTools = (grant: ApiGrant, server: McpServerInfo, allTools: boolean) => {
    // Switching to per-tool selection pre-checks the read-only tools so the
    // safe default matches the approvals convention (writes are opt-in).
    const body = allTools
      ? { all_tools: true }
      : {
          all_tools: false,
          selected_tools:
            grant.selected_tools.length > 0
              ? grant.selected_tools
              : server.tools.filter((tool) => tool.readOnly).map((tool) => tool.name),
        };
    void patchGrant(grant, body);
    if (!allTools) setExpandedServerId(server.id);
  };

  const toggleTool = (grant: ApiGrant, toolName: string, checked: boolean) => {
    const next = checked
      ? [...new Set([...grant.selected_tools, toolName])]
      : grant.selected_tools.filter((n) => n !== toolName);
    void patchGrant(grant, { selected_tools: next });
  };

  if (servers.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-[11px] text-text-tertiary leading-snug">{t('experts.mcpToolsHelp')}</p>
        <div className="text-xs text-text-tertiary italic px-2 py-3">
          {t('experts.mcpNoServers')}{' '}
          {onOpenIntegrations && (
            <button onClick={onOpenIntegrations} className="text-accent hover:underline not-italic">
              {t('experts.mcpOpenIntegrations')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-text-tertiary leading-snug">{t('experts.mcpToolsHelp')}</p>

      <ul className="space-y-1.5">
        {servers.map((server) => {
          const grant = grantFor(server.id);
          const attached = grant !== null;
          const busy = busyServerId === server.id;
          const expanded = expandedServerId === server.id;
          const unhealthy = server.status !== 'connected';
          const grantedCount = !grant
            ? 0
            : grant.all_tools
              ? server.tools.length
              : grant.selected_tools.filter((n) => server.tools.some((tool) => tool.name === n))
                  .length;

          return (
            <li
              key={server.id}
              className="px-2.5 py-2 rounded-md bg-bg-elevated border border-border-subtle"
            >
              <div className="flex items-center gap-2">
                <Settings2 size={14} className="text-text-secondary shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-text-primary truncate">
                    {server.name}
                    {server.accountLabel && (
                      <span className="ml-1 text-[10px] text-text-tertiary">
                        {server.accountLabel}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-text-tertiary">
                    {attached
                      ? t('experts.mcpGrantedCount')
                          .replace('{{granted}}', String(grantedCount))
                          .replace('{{total}}', String(server.tools.length))
                      : t('experts.mcpNotAttached')}
                  </div>
                </div>
                <Toggle
                  checked={attached}
                  disabled={isLocked || busy}
                  onChange={() => {
                    if (!attached) void attach(server);
                    else if (grant) void detach(grant);
                  }}
                />
              </div>

              {attached && unhealthy && (
                <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-amber-400">
                  <AlertTriangle size={11} className="shrink-0" />
                  <span className="truncate">
                    {server.status === 'auth_expired'
                      ? t('experts.mcpAuthExpired')
                      : t('experts.mcpServerError')}
                  </span>
                  {onOpenIntegrations && (
                    <button
                      onClick={onOpenIntegrations}
                      className="text-accent hover:underline shrink-0"
                    >
                      {t('experts.mcpFixInIntegrations')}
                    </button>
                  )}
                </div>
              )}

              {attached && grant && (
                <div className="mt-2 pl-6">
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1.5 text-[10px] text-text-secondary">
                      <Toggle
                        checked={grant.all_tools}
                        disabled={isLocked || busy}
                        onChange={() => toggleAllTools(grant, server, !grant.all_tools)}
                      />
                      {t('experts.mcpAllTools')}
                    </span>
                    {!grant.all_tools && (
                      <button
                        onClick={() => setExpandedServerId(expanded ? null : server.id)}
                        className="flex items-center gap-0.5 text-[10px] text-accent hover:underline"
                      >
                        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        {t('experts.mcpChooseTools')}
                      </button>
                    )}
                  </div>

                  {!grant.all_tools && expanded && (
                    <ul className="mt-1.5 space-y-1">
                      {server.tools.map((tool) => (
                        <li key={tool.name} className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={grant.selected_tools.includes(tool.name)}
                            disabled={isLocked || busy}
                            onChange={(e) => toggleTool(grant, tool.name, e.target.checked)}
                            className="mt-0.5 accent-[var(--color-accent,#06B6D4)]"
                          />
                          <div className="min-w-0">
                            <span
                              className={clsx(
                                'text-[10px] font-mono',
                                grant.selected_tools.includes(tool.name)
                                  ? 'text-text-primary'
                                  : 'text-text-secondary',
                              )}
                            >
                              {tool.name}
                            </span>
                            {!tool.readOnly && (
                              <span className="ml-1.5 text-[9px] px-1 py-px rounded border border-amber-500/30 bg-amber-500/10 text-amber-400">
                                {t('experts.mcpWriteTool')}
                              </span>
                            )}
                            {tool.description && (
                              <div className="text-[10px] text-text-tertiary truncate">
                                {tool.description}
                              </div>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
