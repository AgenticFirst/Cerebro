import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Info, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import { useExperts } from '../../../context/ExpertContext';
import type { Expert } from '../../../context/ExpertContext';
import type {
  SlackExpertAccessConfig,
  SlackStatusResponse,
  SlackWorkspaceUser,
} from '../../../types/ipc';

interface Props {
  status: SlackStatusResponse | null;
}

const FULL_ACCESS = '*';
const PANEL_MAX_HEIGHT = 320;
const PANEL_OFFSET = 4;

type AccessMode = 'all' | 'custom';

interface ExceptionRow {
  userId: string;
  displayName: string;
  mode: AccessMode;
  /** Experts when mode === 'custom'. Empty when mode === 'all'. */
  expertIds: string[];
}

/**
 * Slack expert-access editor.
 *
 * Model: one **default** policy applied to the whole workspace, plus a list
 * of **exceptions** for individuals who need different access. Configuring a
 * 50-person company is therefore one default + a handful of overrides —
 * never one row per person.
 *
 * Storage: see {@link SlackExpertAccessConfig}. The sentinel `'*'` inside a
 * per-user `expertIds` array means "full access regardless of the default" —
 * used to grant admins everything when the workspace baseline is restrictive.
 *
 * Dropdowns (expert pickers, member picker) render through a portal pinned
 * to the viewport so they escape the Settings screen's scroll container.
 */
export default function UserExpertAccessEditor({ status }: Props) {
  const { t } = useTranslation();
  const { experts: allExperts } = useExperts();

  // ── Workspace default ───────────────────────────────────────
  const [defaultMode, setDefaultMode] = useState<AccessMode>('all');
  const [defaultExperts, setDefaultExperts] = useState<string[]>([]);

  // ── Per-person exceptions ───────────────────────────────────
  const [rows, setRows] = useState<ExceptionRow[]>([]);

  // ── Misc state ──────────────────────────────────────────────
  const [workspaceUsers, setWorkspaceUsers] = useState<SlackWorkspaceUser[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Floating panels — single instance at a time
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null);
  const [pickerQuery, setPickerQuery] = useState('');
  const [expertMenuAnchor, setExpertMenuAnchor] = useState<HTMLElement | null>(null);
  // Owner: 'default' for the workspace default's picker, otherwise userId for an exception row's picker.
  const [expertMenuOwner, setExpertMenuOwner] = useState<string | 'default' | null>(null);

  // ── Derived data ────────────────────────────────────────────
  const sortedExperts = useMemo<Expert[]>(
    () =>
      [...allExperts]
        .filter((e) => e.isEnabled)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [allExperts],
  );

  const expertById = useMemo(() => {
    const m = new Map<string, Expert>();
    for (const e of allExperts) m.set(e.id, e);
    return m;
  }, [allExperts]);

  // ── Load on mount ───────────────────────────────────────────
  const loadConfig = useCallback(async () => {
    setError(null);
    try {
      const res = await window.cerebro.slack.getExpertAccess();
      if (!res.ok || !res.config) {
        setError(res.error ?? 'Failed to load');
        return;
      }
      if (res.config.defaultExpertAccess === null) {
        setDefaultMode('all');
        setDefaultExperts([]);
      } else {
        setDefaultMode('custom');
        setDefaultExperts(res.config.defaultExpertAccess);
      }
      const next = res.config.exceptions.map((e) => {
        const isAll = e.expertIds.includes(FULL_ACCESS);
        return {
          userId: e.userId,
          displayName: e.displayName ?? e.userId,
          mode: (isAll ? 'all' : 'custom') as AccessMode,
          expertIds: isAll ? [] : [...e.expertIds],
        };
      });
      next.sort((a, b) => a.displayName.localeCompare(b.displayName));
      setRows(next);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  // Resolve display names from the directory once it loads.
  useEffect(() => {
    if (!workspaceUsers) return;
    setRows((prev) => {
      let changed = false;
      const idToName = new Map(workspaceUsers.map((u) => [u.id, u.name]));
      const next = prev.map((r) => {
        const fresh = idToName.get(r.userId);
        if (fresh && fresh !== r.displayName) {
          changed = true;
          return { ...r, displayName: fresh };
        }
        return r;
      });
      return changed ? next : prev;
    });
  }, [workspaceUsers]);

  // ── Persistence ─────────────────────────────────────────────
  const persist = useCallback(
    async (next: {
      defaultMode: AccessMode;
      defaultExperts: string[];
      rows: ExceptionRow[];
    }) => {
      const payload: SlackExpertAccessConfig = {
        defaultExpertAccess: next.defaultMode === 'all' ? null : next.defaultExperts,
        exceptions: next.rows.map((r) => ({
          userId: r.userId,
          displayName: r.displayName,
          expertIds: r.mode === 'all' ? [FULL_ACCESS] : r.expertIds,
        })),
      };
      const res = await window.cerebro.slack.setExpertAccess(payload);
      if (!res.ok) setError(res.error ?? 'Failed to save');
    },
    [],
  );

  const applyDefault = useCallback(
    (mode: AccessMode, experts: string[]) => {
      setDefaultMode(mode);
      setDefaultExperts(experts);
      void persist({ defaultMode: mode, defaultExperts: experts, rows });
    },
    [persist, rows],
  );

  const applyRows = useCallback(
    (next: ExceptionRow[]) => {
      setRows(next);
      void persist({ defaultMode, defaultExperts, rows: next });
    },
    [persist, defaultMode, defaultExperts],
  );

  // ── Workspace directory ─────────────────────────────────────
  const fetchWorkspaceUsers = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await window.cerebro.slack.listWorkspaceUsers();
      if (!res.ok) {
        setError(res.error ?? 'Failed to load workspace members');
        return;
      }
      setWorkspaceUsers(res.users ?? []);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const handleOpenPicker = useCallback(
    async (anchor: HTMLElement) => {
      setPickerAnchor((cur) => (cur === anchor ? null : anchor));
      setPickerQuery('');
      if (!workspaceUsers && status?.running) {
        await fetchWorkspaceUsers();
      }
    },
    [workspaceUsers, status?.running, fetchWorkspaceUsers],
  );

  const availableForPicker = useMemo<SlackWorkspaceUser[]>(() => {
    if (!workspaceUsers) return [];
    const taken = new Set(rows.map((r) => r.userId));
    const q = pickerQuery.trim().toLowerCase();
    return workspaceUsers
      .filter((u) => u.id !== status?.botUserId)
      .filter((u) => !taken.has(u.id))
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q))
      .slice(0, 25);
  }, [workspaceUsers, rows, pickerQuery, status?.botUserId]);

  const handleToggleExpertMenu = useCallback((owner: string | 'default', anchor: HTMLElement) => {
    setExpertMenuOwner((cur) => (cur === owner ? null : owner));
    setExpertMenuAnchor((cur) => (cur === anchor ? null : anchor));
  }, []);

  const closeExpertMenu = useCallback(() => {
    setExpertMenuOwner(null);
    setExpertMenuAnchor(null);
  }, []);

  const closePicker = useCallback(() => setPickerAnchor(null), []);

  const defaultRemainingExperts = sortedExperts.filter((e) => !defaultExperts.includes(e.id));

  // Compute the "remaining" experts for the currently open menu, so the
  // portal-rendered list can show them.
  const currentMenuExperts: Expert[] = (() => {
    if (!expertMenuOwner) return [];
    if (expertMenuOwner === 'default') return defaultRemainingExperts;
    const row = rows.find((r) => r.userId === expertMenuOwner);
    if (!row) return [];
    return sortedExperts.filter((e) => !row.expertIds.includes(e.id));
  })();

  const onPickExpert = (e: Expert) => {
    if (!expertMenuOwner) return;
    if (expertMenuOwner === 'default') {
      applyDefault('custom', [...defaultExperts, e.id]);
    } else {
      const userId = expertMenuOwner;
      applyRows(
        rows.map((r) =>
          r.userId === userId ? { ...r, expertIds: [...r.expertIds, e.id] } : r,
        ),
      );
    }
    closeExpertMenu();
  };

  return (
    <div className="mt-8">
      {/* Header + intro */}
      <div>
        <label className="text-sm font-medium text-text-primary">
          {t('slackSection.expertAccessTitle')}
        </label>
        <p className="mt-1.5 text-[12px] text-text-secondary leading-relaxed">
          {t('slackSection.expertAccessIntro')}
        </p>
        <div className="mt-2.5 flex items-start gap-2 px-2.5 py-2 rounded-md bg-bg-surface border border-border-subtle text-[11px] text-text-tertiary leading-relaxed">
          <Info size={12} className="mt-0.5 flex-shrink-0 text-accent/70" />
          <span>{t('slackSection.expertAccessExample')}</span>
        </div>
        {!status?.running && (
          <p className="mt-2 text-[11px] text-amber-400/80 leading-relaxed">
            {t('slackSection.userExpertAccessBridgeOffline')}
          </p>
        )}
      </div>

      {/* Default section */}
      <div className="mt-5">
        <div className="text-xs font-medium text-text-secondary">
          {t('slackSection.expertAccessDefaultTitle')}
        </div>
        <p className="mt-1 text-[11px] text-text-tertiary leading-relaxed">
          {t('slackSection.expertAccessDefaultHelp')}
        </p>

        <div className="mt-2 rounded-md border border-border-subtle bg-bg-surface">
          {loading ? (
            <div className="px-3 py-3 text-sm text-text-tertiary">
              {t('slackSection.userExpertAccessLoading')}
            </div>
          ) : (
            <div className="px-3 py-2.5 space-y-2">
              <RadioRow
                checked={defaultMode === 'all'}
                onChange={() => applyDefault('all', [])}
                label={t('slackSection.expertAccessDefaultAll')}
                hint={t('slackSection.expertAccessDefaultAllHint')}
              />
              <RadioRow
                checked={defaultMode === 'custom'}
                onChange={() => applyDefault('custom', defaultExperts)}
                label={t('slackSection.expertAccessDefaultCustom')}
                hint={t('slackSection.expertAccessDefaultCustomHint')}
              />

              {defaultMode === 'custom' && (
                <div className="ml-6 mt-1 flex flex-wrap items-center gap-1.5">
                  {defaultExperts.length === 0 ? (
                    <span className="text-[11px] text-amber-400/80">
                      {t('slackSection.expertAccessDefaultCustomEmpty')}
                    </span>
                  ) : (
                    defaultExperts
                      .map((id) => expertById.get(id))
                      .filter((e): e is Expert => Boolean(e))
                      .map((e) => (
                        <span
                          key={e.id}
                          className="inline-flex items-center gap-1 rounded-full bg-accent/15 text-accent text-[11px] px-2 py-0.5"
                        >
                          {e.name}
                          <button
                            type="button"
                            onClick={() =>
                              applyDefault('custom', defaultExperts.filter((id) => id !== e.id))
                            }
                            aria-label={t('slackSection.userExpertAccessRemoveExpert', { name: e.name }) ?? 'Remove'}
                            className="hover:text-text-primary"
                          >
                            <X size={11} />
                          </button>
                        </span>
                      ))
                  )}
                  {defaultRemainingExperts.length > 0 && (
                    <AddExpertsButton
                      onClick={(el) => handleToggleExpertMenu('default', el)}
                      label={t('slackSection.userExpertAccessAddExperts')}
                      expanded={expertMenuOwner === 'default'}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Exceptions section */}
      <div className="mt-5">
        <div className="text-xs font-medium text-text-secondary">
          {t('slackSection.expertAccessExceptionsTitle')}
        </div>
        <p className="mt-1 text-[11px] text-text-tertiary leading-relaxed">
          {t('slackSection.expertAccessExceptionsHelp')}
        </p>

        <div className="mt-2 rounded-md border border-border-subtle bg-bg-surface">
          {loading ? null : rows.length === 0 ? (
            <div className="px-3 py-3 text-sm text-text-tertiary">
              {t('slackSection.expertAccessNoExceptions')}
            </div>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {rows.map((row) => {
                const assigned = row.expertIds
                  .map((id) => expertById.get(id))
                  .filter((e): e is Expert => Boolean(e));
                return (
                  <li key={row.userId} className="px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-text-primary truncate">{row.displayName}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                          <ModeRadio
                            checked={row.mode === 'all'}
                            onChange={() =>
                              applyRows(
                                rows.map((r) =>
                                  r.userId === row.userId ? { ...r, mode: 'all', expertIds: [] } : r,
                                ),
                              )
                            }
                            label={t('slackSection.expertAccessModeAll')}
                          />
                          <ModeRadio
                            checked={row.mode === 'custom'}
                            onChange={() =>
                              applyRows(
                                rows.map((r) =>
                                  r.userId === row.userId ? { ...r, mode: 'custom' } : r,
                                ),
                              )
                            }
                            label={t('slackSection.expertAccessModeCustom')}
                          />
                        </div>

                        {row.mode === 'custom' && (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {assigned.length === 0 ? (
                              <span className="text-[11px] text-amber-400/80">
                                {t('slackSection.userExpertAccessNoneAssigned')}
                              </span>
                            ) : (
                              assigned.map((e) => (
                                <span
                                  key={e.id}
                                  className="inline-flex items-center gap-1 rounded-full bg-accent/15 text-accent text-[11px] px-2 py-0.5"
                                >
                                  {e.name}
                                  <button
                                    type="button"
                                    onClick={() =>
                                      applyRows(
                                        rows.map((r) =>
                                          r.userId === row.userId
                                            ? { ...r, expertIds: r.expertIds.filter((id) => id !== e.id) }
                                            : r,
                                        ),
                                      )
                                    }
                                    aria-label={t('slackSection.userExpertAccessRemoveExpert', { name: e.name }) ?? 'Remove'}
                                    className="hover:text-text-primary"
                                  >
                                    <X size={11} />
                                  </button>
                                </span>
                              ))
                            )}
                            {sortedExperts.filter((e) => !row.expertIds.includes(e.id)).length > 0 && (
                              <AddExpertsButton
                                onClick={(el) => handleToggleExpertMenu(row.userId, el)}
                                label={t('slackSection.userExpertAccessAddExperts')}
                                expanded={expertMenuOwner === row.userId}
                              />
                            )}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => applyRows(rows.filter((r) => r.userId !== row.userId))}
                        aria-label={t('slackSection.userExpertAccessRemovePerson') ?? 'Remove from list'}
                        className="flex-shrink-0 mt-0.5 text-text-tertiary hover:text-red-400"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="px-3 py-2.5 border-t border-border-subtle">
            <AddExceptionButton
              onClick={handleOpenPicker}
              disabled={!status?.running}
              label={t('slackSection.expertAccessAddException')}
              expanded={pickerAnchor !== null}
            />
          </div>
        </div>
      </div>

      {error && <p className="mt-2 text-[11px] text-red-400 break-all">{error}</p>}

      {/* ── Floating panels (portaled, escape settings overflow) ── */}
      {expertMenuAnchor && expertMenuOwner && currentMenuExperts.length > 0 && (
        <FloatingPanel anchor={expertMenuAnchor} onClose={closeExpertMenu} minWidth={260}>
          <ExpertMenuContent experts={currentMenuExperts} onPick={onPickExpert} />
        </FloatingPanel>
      )}

      {pickerAnchor && (
        <FloatingPanel anchor={pickerAnchor} onClose={closePicker} minWidth={300}>
          <PeoplePickerContent
            workspaceUsers={workspaceUsers}
            available={availableForPicker}
            query={pickerQuery}
            onQueryChange={setPickerQuery}
            onRefresh={fetchWorkspaceUsers}
            refreshing={refreshing}
            onPick={(u) => {
              closePicker();
              const newMode: AccessMode = defaultMode === 'all' ? 'custom' : 'all';
              applyRows(
                [
                  ...rows,
                  {
                    userId: u.id,
                    displayName: u.name,
                    mode: newMode,
                    expertIds: [],
                  },
                ].sort((a, b) => a.displayName.localeCompare(b.displayName)),
              );
            }}
            placeholderText={t('slackSection.userExpertAccessSearchPlaceholder') ?? 'Search…'}
            loadingText={t('slackSection.userExpertAccessLoadingPeople') ?? ''}
            tapRefreshText={t('slackSection.userExpertAccessTapRefresh') ?? ''}
            noMatchText={t('slackSection.userExpertAccessNoMatch') ?? ''}
            allAddedText={t('slackSection.userExpertAccessAllAdded') ?? ''}
            refreshLabel={t('slackSection.userExpertAccessRefresh') ?? 'Refresh'}
          />
        </FloatingPanel>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────

function RadioRow({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      className="w-full text-left flex items-start gap-2 px-1 py-1 rounded hover:bg-white/5"
    >
      <span
        className={clsx(
          'mt-1 w-3.5 h-3.5 rounded-full border flex-shrink-0 flex items-center justify-center',
          checked ? 'border-accent' : 'border-border-subtle',
        )}
      >
        {checked && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
      </span>
      <span className="flex-1">
        <span className="text-sm text-text-primary">{label}</span>
        {hint && <span className="block text-[11px] text-text-tertiary mt-0.5">{hint}</span>}
      </span>
    </button>
  );
}

function ModeRadio({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-white/5"
    >
      <span
        className={clsx(
          'w-3 h-3 rounded-full border flex-shrink-0 flex items-center justify-center',
          checked ? 'border-accent' : 'border-border-subtle',
        )}
      >
        {checked && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
      </span>
      <span className={checked ? 'text-text-primary' : 'text-text-secondary'}>{label}</span>
    </button>
  );
}

function AddExpertsButton({
  onClick,
  label,
  expanded,
}: {
  onClick: (anchor: HTMLElement) => void;
  label: string;
  expanded: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(ev) => onClick(ev.currentTarget)}
      aria-expanded={expanded}
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border border-dashed text-[11px] px-2 py-0.5',
        expanded
          ? 'border-accent text-accent'
          : 'border-border-subtle text-text-tertiary hover:text-text-secondary hover:border-text-tertiary',
      )}
    >
      <Plus size={10} />
      {label}
    </button>
  );
}

function AddExceptionButton({
  onClick,
  disabled,
  label,
  expanded,
}: {
  onClick: (anchor: HTMLElement) => void;
  disabled: boolean;
  label: string;
  expanded: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(ev) => onClick(ev.currentTarget)}
      disabled={disabled}
      aria-expanded={expanded}
      className={clsx(
        'inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-dashed',
        disabled
          ? 'opacity-50 cursor-not-allowed text-text-tertiary border-border-subtle'
          : expanded
            ? 'border-accent text-accent'
            : 'border-border-subtle text-text-secondary hover:text-text-primary hover:border-text-tertiary',
      )}
    >
      <Plus size={12} />
      {label}
    </button>
  );
}

function ExpertMenuContent({
  experts,
  onPick,
}: {
  experts: Expert[];
  onPick: (e: Expert) => void;
}) {
  return (
    <div className="max-h-[320px] overflow-y-auto p-1">
      {experts.map((e) => (
        <button
          key={e.id}
          type="button"
          onClick={() => onPick(e)}
          className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-white/5 text-text-primary"
        >
          <div className="truncate">{e.name}</div>
          {e.description && (
            <div className="text-[10px] text-text-tertiary truncate">{e.description}</div>
          )}
        </button>
      ))}
    </div>
  );
}

function PeoplePickerContent({
  workspaceUsers,
  available,
  query,
  onQueryChange,
  onRefresh,
  refreshing,
  onPick,
  placeholderText,
  loadingText,
  tapRefreshText,
  noMatchText,
  allAddedText,
  refreshLabel,
}: {
  workspaceUsers: SlackWorkspaceUser[] | null;
  available: SlackWorkspaceUser[];
  query: string;
  onQueryChange: (v: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  onPick: (u: SlackWorkspaceUser) => void;
  placeholderText: string;
  loadingText: string;
  tapRefreshText: string;
  noMatchText: string;
  allAddedText: string;
  refreshLabel: string;
}) {
  return (
    <div className="flex flex-col max-h-[320px]">
      <div className="p-2 border-b border-border-subtle flex items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={placeholderText}
          className="flex-1 bg-bg-surface border border-border-subtle rounded px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
          autoFocus
        />
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={refreshLabel}
          className="text-text-tertiary hover:text-text-secondary disabled:opacity-50"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-1">
        {workspaceUsers === null ? (
          <div className="px-2 py-3 text-xs text-text-tertiary">
            {refreshing ? loadingText : tapRefreshText}
          </div>
        ) : available.length === 0 ? (
          <div className="px-2 py-3 text-xs text-text-tertiary">
            {query ? noMatchText : allAddedText}
          </div>
        ) : (
          available.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => onPick(u)}
              className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/5"
            >
              {u.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={u.avatarUrl} alt="" className="w-6 h-6 rounded-full flex-shrink-0" />
              ) : (
                <div className="w-6 h-6 rounded-full bg-bg-surface text-[10px] text-text-tertiary flex items-center justify-center flex-shrink-0">
                  {u.name.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <div className="text-xs text-text-primary truncate">{u.name}</div>
                {u.email && (
                  <div className="text-[10px] text-text-tertiary truncate">{u.email}</div>
                )}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Floating panel rendered through a portal pinned to the viewport. Auto-flips
 * above the anchor when there isn't room below, clamps to the viewport edges
 * so it never gets clipped by an ancestor's `overflow: hidden`.
 */
function FloatingPanel({
  anchor,
  onClose,
  children,
  minWidth = 240,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  children: React.ReactNode;
  minWidth?: number;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);

  const recompute = useCallback(() => {
    const rect = anchor.getBoundingClientRect();
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;
    const desiredWidth = Math.max(minWidth, rect.width);
    const width = Math.min(desiredWidth, vpW - 16);

    // Horizontal: align left edge with anchor, clamp into viewport.
    let left = rect.left;
    if (left + width > vpW - 8) left = vpW - 8 - width;
    if (left < 8) left = 8;

    // Vertical: prefer below; flip above if there's no room.
    const spaceBelow = vpH - rect.bottom - PANEL_OFFSET;
    const spaceAbove = rect.top - PANEL_OFFSET;
    let top: number;
    if (spaceBelow >= PANEL_MAX_HEIGHT || spaceBelow >= spaceAbove) {
      top = rect.bottom + PANEL_OFFSET;
    } else {
      top = Math.max(8, rect.top - PANEL_OFFSET - PANEL_MAX_HEIGHT);
    }

    setCoords({ top, left, width });
  }, [anchor, minWidth]);

  useLayoutEffect(() => {
    recompute();
  }, [recompute]);

  useEffect(() => {
    const onResize = () => recompute();
    // Reposition on scroll instead of closing — scrolling INSIDE the
    // panel itself was previously dismissing it, which made long expert
    // lists unusable. We only need to skip the recompute when the scroll
    // event originates from the panel's own scroll container (the anchor
    // hasn't moved in that case).
    const onScroll = (ev: Event) => {
      const target = ev.target as Node | null;
      if (target && panelRef.current?.contains(target)) return;
      recompute();
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [recompute]);

  useEffect(() => {
    function onDown(ev: MouseEvent) {
      const target = ev.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (anchor.contains(target)) return; // clicking the trigger toggles it elsewhere
      onClose();
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  if (!coords) return null;

  return createPortal(
    <div
      ref={panelRef}
      style={{
        position: 'fixed',
        top: coords.top,
        left: coords.left,
        width: coords.width,
        maxHeight: PANEL_MAX_HEIGHT,
        zIndex: 1000,
      }}
      className="rounded-md border border-border-subtle bg-bg-elevated shadow-lg overflow-hidden"
    >
      {children}
    </div>,
    document.body,
  );
}
