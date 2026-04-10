import { useState, useEffect } from 'react';
import { X, Copy, Check, Trash2, UserPlus, XCircle, Users } from 'lucide-react';
import clsx from 'clsx';
import type { Expert } from '../../../context/ExpertContext';
import ExpertMemoryTab from '../../experts/ExpertMemoryTab';
import ExpertSkillsSection from './ExpertSkillsSection';

// ── Helpers ────────────────────────────────────────────────────

const DOMAINS = ['', 'productivity', 'health', 'finance', 'creative', 'engineering', 'research'];

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
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
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [domain, setDomain] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [copied, setCopied] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);

  useEffect(() => {
    if (expert) {
      setName(expert.name);
      setDescription(expert.description);
      setDomain(expert.domain ?? '');
      setSystemPrompt(expert.systemPrompt ?? '');
      setShowAddMember(false);
    }
  }, [expert?.id, expert?.name, expert?.description, expert?.domain, expert?.systemPrompt]);

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
    if (expert) onUpdate(expert.id, { [snakeField]: value });
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
        <h3 className="text-sm font-semibold text-text-primary tracking-wide">
          Configuration
        </h3>
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
            <Section label="LEAD EXPERT">
              <div className="text-sm text-text-primary font-medium">Cerebro</div>
              <p className="text-xs text-text-secondary mt-1.5 leading-relaxed">
                Always available. Plans, delegates, learns, and gets things done.
              </p>
            </Section>

            <Section label="CAPABILITIES">
              <div className="space-y-2">
                {[
                  'Responds directly',
                  'Routes to experts',
                  'Proposes routines',
                  'Drafts specialists',
                  'Manages memory',
                ].map((cap) => (
                  <div key={cap} className="flex items-center gap-2.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                    <span className="text-xs text-text-secondary">{cap}</span>
                  </div>
                ))}
              </div>
            </Section>

            <Section label="STATUS">
              <div className="space-y-1.5">
                <div className="text-xs text-text-secondary">
                  {activeCount} expert{activeCount !== 1 ? 's' : ''} active
                </div>
                <div className="text-xs text-text-secondary">
                  {pinnedCount} pinned
                </div>
              </div>
            </Section>
          </>
        ) : expert ? (
          <>
            {/* Expert ID */}
            <Section label="NODE ID">
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
            <Section label="DETAILS">
              <div className="space-y-3">
                <div>
                  <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wide mb-1">
                    Name
                  </label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => name !== expert.name && saveField('name', name)}
                    className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wide mb-1">
                    Domain
                  </label>
                  <select
                    value={domain}
                    onChange={(e) => {
                      setDomain(e.target.value);
                      saveField('domain', e.target.value || null);
                    }}
                    className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent/30 transition-colors"
                  >
                    <option value="">None</option>
                    {DOMAINS.filter(Boolean).map((d) => (
                      <option key={d} value={d}>
                        {d.charAt(0).toUpperCase() + d.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-text-secondary uppercase tracking-wide mb-1">
                    Description
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    onBlur={() =>
                      description !== expert.description &&
                      saveField('description', description)
                    }
                    rows={3}
                    className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-secondary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors resize-none"
                  />
                </div>
              </div>
            </Section>

            {/* Team Members (only for teams) */}
            {isTeam && (
              <Section label="TEAM MEMBERS">
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
                          title="Remove from team"
                        >
                          <XCircle size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-text-tertiary">No members yet.</p>
                )}

                {/* Add member */}
                {showAddMember ? (
                  <div className="mt-2 bg-bg-base rounded-lg border border-border-subtle max-h-36 overflow-y-auto scrollbar-thin">
                    {addableExperts.length === 0 ? (
                      <p className="text-xs text-text-tertiary px-3 py-2.5">
                        No available experts to add.
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
                    Add Member
                  </button>
                )}
              </Section>
            )}

            {/* Skills */}
            <Section label="SKILLS">
              <ExpertSkillsSection expertId={expert.id} />
            </Section>

            {/* System Prompt */}
            <Section label="SYSTEM CONTEXT">
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                onBlur={() =>
                  systemPrompt !== (expert.systemPrompt ?? '') &&
                  saveField('system_prompt', systemPrompt || null)
                }
                placeholder="Define this expert's behavior and personality..."
                rows={8}
                className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-secondary font-mono leading-relaxed placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors resize-none"
              />
            </Section>

            {/* Settings */}
            <Section label="SETTINGS">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-secondary">Enabled</span>
                  <Toggle
                    checked={expert.isEnabled}
                    onChange={() => onToggleEnabled(expert)}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-secondary">Pinned</span>
                  <Toggle
                    checked={expert.isPinned}
                    onChange={() => onTogglePinned(expert)}
                  />
                </div>
              </div>
            </Section>

            {/* Expert Memory */}
            <Section label="MEMORY">
              <ExpertMemoryTab expert={expert} />
            </Section>

            {/* Info */}
            <Section label="INFO">
              <div className="space-y-1.5 text-xs text-text-tertiary">
                <div>
                  Source:{' '}
                  <span className="text-text-secondary capitalize">{expert.source}</span>
                </div>
                <div>
                  Type:{' '}
                  <span className="text-text-secondary capitalize">{expert.type}</span>
                </div>
                <div>
                  Version: <span className="text-text-secondary">{expert.version}</span>
                </div>
                <div>
                  Last active:{' '}
                  <span className="text-text-secondary">{timeAgo(expert.lastActiveAt)}</span>
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
                Delete Expert
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
          {isCerebro ? 'Always Active' : expert?.isEnabled ? 'Connected' : 'Disabled'}
        </span>
      </div>
    </div>
  );
}
