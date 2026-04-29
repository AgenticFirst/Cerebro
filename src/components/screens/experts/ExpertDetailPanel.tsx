import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Copy, Check, Trash2, UserPlus, XCircle, Users, Phone, BadgeCheck } from 'lucide-react';
import clsx from 'clsx';
import { useVoice } from '../../../context/VoiceContext';
import { useFeatureFlags } from '../../../context/FeatureFlagsContext';
import type { Expert } from '../../../context/ExpertContext';
import ExpertMemoryTab from '../../experts/ExpertMemoryTab';
import ExpertSkillsSection from './ExpertSkillsSection';
import ExpertContextFilesSection from './ExpertContextFilesSection';
import AvatarPicker from './AvatarPicker';

// ── Helpers ────────────────────────────────────────────────────

const DOMAINS = ['', 'productivity', 'health', 'finance', 'creative', 'engineering', 'research'];

function timeAgo(dateStr: string | null, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!dateStr) return t('timeAgo.never');
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('timeAgo.justNow');
  if (mins < 60) return t('timeAgo.minutesAgo', { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('timeAgo.hoursAgo', { count: hrs });
  const days = Math.floor(hrs / 24);
  return t('timeAgo.daysAgo', { count: days });
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-accent mb-2.5">
        {label}
      </h4>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={clsx(
        'relative w-8 h-[18px] rounded-full transition-colors duration-200',
        checked ? 'bg-accent' : 'bg-bg-elevated border border-border-default',
      )}
    >
      <div
        className={clsx(
          'absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform duration-200',
          checked ? 'translate-x-[15px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

// ── Component ──────────────────────────────────────────────────

interface ExpertDetailPanelProps {
  expert: Expert | null;
  isCerebro?: boolean;
  allExperts: Expert[];
  onClose: () => void;
  onUpdate: (id: string, fields: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onToggleEnabled: (expert: Expert) => void;
  onTogglePinned: (expert: Expert) => void;
  activeCount: number;
  pinnedCount: number;
}

export default function ExpertDetailPanel({
  expert,
  isCerebro,
  allExperts,
  onClose,
  onUpdate,
  onDelete,
  onToggleEnabled,
  onTogglePinned,
  activeCount,
  pinnedCount,
}: ExpertDetailPanelProps) {
  const { t } = useTranslation();
  const { startCall } = useVoice();
  const { flags } = useFeatureFlags();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [domain, setDomain] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [copied, setCopied] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);

  const capabilities = useMemo(() => [
    t('experts.capResponds'),
    t('experts.capRoutes'),
    t('experts.capRoutines'),
    t('experts.capDrafts'),
    t('experts.capMemory'),
  ], [t]);

  useEffect(() => {
    if (expert) {
      setName(expert.name);
      setDescription(expert.description);
      setDomain(expert.domain ?? '');
      setSystemPrompt(expert.systemPrompt ?? '');
      setShowAddMember(false);
    }
  }, [expert?.id, expert?.name, expert?.description, expert?.domain, expert?.systemPrompt]);

  const isLocked = !!expert?.isVerified;

  // Team member helpers
  const isTeam = expert?.type === 'team';
  const memberIds = new Set(expert?.teamMembers?.map((m) => m.expertId) ?? []);
  const currentMembers = allExperts.filter((e) => memberIds.has(e.id));
  const addableExperts = allExperts.filter(
    (e) => e.type === 'expert' && !memberIds.has(e.id) && e.id !== expert?.id,
  );

  const addMember = (memberId: string) => {
    if (!expert) return;
    const existing = expert.teamMembers ?? [];
    const updated = [
      ...existing.map((m) => ({ expert_id: m.expertId, role: m.role, order: m.order })),
      { expert_id: memberId, role: 'member', order: existing.length },
    ];
    onUpdate(expert.id, { team_members: updated });
    setShowAddMember(false);
  };

  const removeMember = (memberId: string) => {
    if (!expert) return;
    const updated = (expert.teamMembers ?? [])
      .filter((m) => m.expertId !== memberId)
      .map((m, i) => ({ expert_id: m.expertId, role: m.role, order: i }));
    onUpdate(expert.id, { team_members: updated });
  };

  const saveField = (snakeField: string, value: unknown) => {
    if (!expert) return;
    if (isLocked) return;
    onUpdate(expert.id, { [snakeField]: value });
  };

  const handleCopy = () => {
    const text = isCerebro ? 'cerebro' : expert?.slug ?? expert?.id ?? '';
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="absolute top-0 right-0 bottom-0 w-[380px] bg-bg-surface border-l border-border-subtle animate-slide-in-right z-10 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle flex-shrink-0">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-text-primary tracking-wide">
            {t('experts.configuration')}
          </h3>
          {flags['voice-calls'] && !isCerebro && expert?.type === 'expert' && expert.isEnabled && (
            <button
              onClick={() => expert && startCall(expert.id)}
              className="p-1.5 rounded-lg text-accent hover:bg-accent/10 transition-colors"
              title={t('experts.callExpert')}
            >
              <Phone size={14} />
            </button>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-5 py-5 space-y-6">
        {isCerebro ? (
          <>
            <Section label={t('experts.leadExpert')}>
              <div className="text-sm text-text-primary font-medium">Cerebro</div>
              <p className="text-xs text-text-secondary mt-1.5 leading-relaxed">
                {t('experts.alwaysAvailable')}
              </p>
            </Section>

            <Section label={t('experts.capabilities')}>
              <div className="space-y-2">
                {capabilities.map((cap) => (
                  <div key={cap} className="flex items-center gap-2.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                    <span className="text-xs text-text-secondary">{cap}</span>
                  </div>
                ))}
              </div>
            </Section>

            <Section label={t('experts.statusLabel')}>
              <div className="space-y-1.5">
                <div className="text-xs text-text-secondary">
                  {t('experts.expert', { count: activeCount })}
                </div>
                <div className="text-xs text-text-secondary">
                  {t('experts.pinned', { count: pinnedCount })}
                </div>
              </div>
            </Section>
          </>
        ) : expert ? (
          <>
            {isLocked && (
              <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-accent/5 border border-accent/20">
                <BadgeCheck size={14} className="text-accent mt-0.5 flex-shrink-0" strokeWidth={2.25} />
                <div className="text-[11px] text-text-secondary leading-relaxed">
                  <span className="text-accent font-medium">{t('experts.verified')}</span>
                  {' — '}
                  {t('experts.verifiedReadOnly')}
                </div>
              </div>
            )}

            {/* Expert ID */}
            <Section label={t('experts.nodeId')}>
              <div className="flex items-center gap-2">
                <code className="text-xs text-text-secondary font-mono">
                  #{expert.slug ?? expert.id.slice(0, 16)}
                </code>
                <button
                  onClick={handleCopy}
                  className="p-0.5 text-text-tertiary hover:text-text-secondary transition-colors"
                >
                  {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                </button>
              </div>
            </Section>

            {/* Name */}
            <Section label={t('experts.details')}>
              <div className="space-y-3">
                <div>
                  <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wide mb-1">
                    {t('experts.name')}
                  </label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => name !== expert.name && saveField('name', name)}
                    readOnly={isLocked}
                    disabled={isLocked}
                    className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wide mb-1">
                    {t('experts.domain')}
                  </label>
                  <select
                    value={domain}
                    onChange={(e) => {
                      setDomain(e.target.value);
                      saveField('domain', e.target.value || null);
                    }}
                    disabled={isLocked}
                    className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent/30 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    <option value="">{t('common.none')}</option>
                    {DOMAINS.filter(Boolean).map((d) => (
                      <option key={d} value={d}>
                        {t(`domains.${d}`)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wide mb-1">
                    {t('experts.description')}
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    onBlur={() =>
                      description !== expert.description &&
                      saveField('description', description)
                    }
                    rows={3}
                    readOnly={isLocked}
                    disabled={isLocked}
                    className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-secondary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors resize-none disabled:opacity-60 disabled:cursor-not-allowed"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wide mb-1">
                    {t('experts.avatar')}
                  </label>
                  <AvatarPicker
                    value={expert.avatarUrl}
                    onChange={(id) => saveField('avatar_url', id)}
                  />
                </div>
              </div>
            </Section>

            {/* Team Members (only for teams) */}
            {isTeam && (
              <Section label={t('experts.teamMembers')}>
                {currentMembers.length > 0 ? (
                  <div className="space-y-1.5">
                    {currentMembers.map((member) => (
                      <div
                        key={member.id}
                        className="flex items-center gap-2.5 bg-bg-base rounded-lg px-3 py-2 border border-border-subtle group"
                      >
                        <Users size={13} className="text-text-tertiary flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-text-primary truncate">
                            {member.name}
                          </div>
                          {member.domain && (
                            <div className="text-[10px] text-text-tertiary capitalize">
                              {member.domain}
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => removeMember(member.id)}
                          className="p-0.5 text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all"
                          title={t('experts.removeFromTeam')}
                        >
                          <XCircle size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-text-tertiary">{t('experts.noMembersYet')}</p>
                )}

                {/* Add member */}
                {showAddMember ? (
                  <div className="mt-2 bg-bg-base rounded-lg border border-border-subtle max-h-36 overflow-y-auto scrollbar-thin">
                    {addableExperts.length === 0 ? (
                      <p className="text-xs text-text-tertiary px-3 py-2.5">
                        {t('experts.noAvailableExperts')}
                      </p>
                    ) : (
                      addableExperts.map((exp) => (
                        <button
                          key={exp.id}
                          onClick={() => addMember(exp.id)}
                          className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-bg-hover transition-colors"
                        >
                          <UserPlus size={12} className="text-accent flex-shrink-0" />
                          <span className="text-xs text-text-secondary truncate">
                            {exp.name}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                ) : (
                  <button
                    onClick={() => setShowAddMember(true)}
                    className="mt-2 flex items-center gap-1.5 text-xs text-accent hover:text-accent-hover transition-colors"
                  >
                    <UserPlus size={13} />
                    {t('experts.addMember')}
                  </button>
                )}
              </Section>
            )}

            {/* Skills */}
            <Section label={t('experts.skills')}>
              <ExpertSkillsSection expertId={expert.id} />
            </Section>

            {/* System Prompt */}
            <Section label={t('experts.systemContext')}>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                onBlur={() =>
                  systemPrompt !== (expert.systemPrompt ?? '') &&
                  saveField('system_prompt', systemPrompt || null)
                }
                placeholder={t('experts.systemPromptPlaceholder')}
                rows={8}
                readOnly={isLocked}
                disabled={isLocked}
                className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-secondary font-mono leading-relaxed placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors resize-none disabled:opacity-60 disabled:cursor-not-allowed"
              />
            </Section>

            {/* Reference documents (per-expert context files) */}
            <Section label={t('experts.referenceDocs')}>
              <ExpertContextFilesSection expertId={expert.id} isLocked={isLocked} />
            </Section>

            {/* Settings */}
            <Section label={t('experts.settingsSection')}>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-secondary">{t('experts.enabled')}</span>
                  <Toggle
                    checked={expert.isEnabled}
                    onChange={() => onToggleEnabled(expert)}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-secondary">{t('experts.pinnedLabel')}</span>
                  <Toggle
                    checked={expert.isPinned}
                    onChange={() => onTogglePinned(expert)}
                  />
                </div>
              </div>
            </Section>

            {/* Expert Memory */}
            <Section label={t('experts.memorySection')}>
              <ExpertMemoryTab expert={expert} />
            </Section>

            {/* Info */}
            <Section label={t('experts.infoSection')}>
              <div className="space-y-1.5 text-xs text-text-tertiary">
                <div>
                  {t('experts.source')}:{' '}
                  <span className="text-text-secondary capitalize">{expert.source}</span>
                </div>
                <div>
                  {t('experts.type')}:{' '}
                  <span className="text-text-secondary capitalize">{expert.type}</span>
                </div>
                <div>
                  {t('experts.versionLabel')}: <span className="text-text-secondary">{expert.version}</span>
                </div>
                <div>
                  {t('experts.lastActive')}:{' '}
                  <span className="text-text-secondary">{timeAgo(expert.lastActiveAt, t)}</span>
                </div>
              </div>
            </Section>

            {/* Delete */}
            {expert.source !== 'builtin' && (
              <button
                onClick={() => onDelete(expert.id)}
                className="flex items-center gap-2 text-xs text-red-400/70 hover:text-red-400 transition-colors"
              >
                <Trash2 size={13} />
                {t('experts.deleteExpert')}
              </button>
            )}
          </>
        ) : null}
      </div>

      {/* Footer status bar */}
      <div className="flex items-center gap-2 px-5 py-3 border-t border-border-subtle flex-shrink-0">
        <div
          className={clsx(
            'w-2 h-2 rounded-full',
            isCerebro || expert?.isEnabled ? 'bg-green-500' : 'bg-text-tertiary',
          )}
          style={{
            boxShadow:
              isCerebro || expert?.isEnabled
                ? '0 0 6px rgba(34, 197, 94, 0.5)'
                : 'none',
          }}
        />
        <span className="text-xs text-text-secondary">
          {isCerebro ? t('experts.alwaysActive') : expert?.isEnabled ? t('experts.connected') : t('status.disabled')}
        </span>
      </div>
    </div>
  );
}
