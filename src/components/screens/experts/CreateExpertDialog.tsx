import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, User, Users, Check } from 'lucide-react';
import clsx from 'clsx';
import type { Expert, ExpertType, CreateExpertInput } from '../../../context/ExpertContext';
import AvatarPicker from './AvatarPicker';

const DOMAINS = ['', 'productivity', 'health', 'finance', 'creative', 'engineering', 'research'];

interface CreateExpertDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: CreateExpertInput) => Promise<void>;
  experts: Expert[];
}

export default function CreateExpertDialog({
  isOpen,
  onClose,
  onCreate,
  experts,
}: CreateExpertDialogProps) {
  const { t } = useTranslation();
  const [type, setType] = useState<ExpertType>('expert');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [domain, setDomain] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Available individual experts that can be added to a team
  const availableExperts = experts.filter((e) => e.type === 'expert');

  useEffect(() => {
    if (isOpen) {
      setType('expert');
      setName('');
      setDescription('');
      setDomain('');
      setAvatarUrl(null);
      setSelectedMembers([]);
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const canSubmit =
    name.trim() &&
    description.trim() &&
    !isSubmitting &&
    (type === 'expert' || selectedMembers.length > 0);

  const toggleMember = (id: string) => {
    setSelectedMembers((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      const input: CreateExpertInput = {
        name: name.trim(),
        description: description.trim(),
        domain: domain || undefined,
        type,
        avatarUrl,
      };
      if (type === 'team') {
        input.teamMembers = selectedMembers.map((id, i) => ({
          expertId: id,
          role: 'member',
          order: i,
        }));
      }
      await onCreate(input);
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-bg-elevated rounded-xl border border-border-subtle p-6 w-full max-w-md animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-medium text-text-primary">
            {type === 'team' ? t('createExpert.newTeam') : t('createExpert.newExpert')}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Type Toggle */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('createExpert.typeLabel')}
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setType('expert');
                  setSelectedMembers([]);
                }}
                className={clsx(
                  'flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors border',
                  type === 'expert'
                    ? 'bg-accent/10 border-accent/30 text-accent'
                    : 'bg-bg-surface border-border-subtle text-text-tertiary hover:text-text-secondary hover:border-border-default',
                )}
              >
                <User size={15} />
                {t('createExpert.typeExpert')}
              </button>
              <button
                type="button"
                onClick={() => setType('team')}
                className={clsx(
                  'flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors border',
                  type === 'team'
                    ? 'bg-accent/10 border-accent/30 text-accent'
                    : 'bg-bg-surface border-border-subtle text-text-tertiary hover:text-text-secondary hover:border-border-default',
                )}
              >
                <Users size={15} />
                {t('createExpert.typeTeam')}
              </button>
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('experts.name')}
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                type === 'team'
                  ? t('createExpert.namePlaceholderTeam')
                  : t('createExpert.namePlaceholderExpert')
              }
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40 transition-colors"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('experts.description')}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                type === 'team'
                  ? t('createExpert.descPlaceholderTeam')
                  : t('createExpert.descPlaceholderExpert')
              }
              rows={2}
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40 transition-colors resize-none"
            />
          </div>

          {/* Domain */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('experts.domain')}{' '}
              <span className="text-text-tertiary font-normal">{t('common.optional')}</span>
            </label>
            <select
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent/40 transition-colors"
            >
              <option value="">{t('common.none')}</option>
              {DOMAINS.filter(Boolean).map((d) => (
                <option key={d} value={d}>
                  {t(`domains.${d}`)}
                </option>
              ))}
            </select>
          </div>

          {/* Avatar */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('experts.avatar')}{' '}
              <span className="text-text-tertiary font-normal">{t('common.optional')}</span>
            </label>
            <AvatarPicker value={avatarUrl} onChange={setAvatarUrl} />
          </div>

          {/* Team Members (only for team type) */}
          {type === 'team' && (
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                {t('experts.teamMembers')}{' '}
                <span className="text-text-tertiary font-normal">
                  {t('createExpert.membersSelected', { count: selectedMembers.length })}
                </span>
              </label>
              {availableExperts.length === 0 ? (
                <p className="text-xs text-text-tertiary bg-bg-surface rounded-lg px-3 py-3 border border-border-subtle">
                  {t('createExpert.membersEmpty')}
                </p>
              ) : (
                <div className="max-h-40 overflow-y-auto scrollbar-thin bg-bg-surface rounded-lg border border-border-subtle divide-y divide-border-subtle">
                  {availableExperts.map((exp) => {
                    const isSelected = selectedMembers.includes(exp.id);
                    return (
                      <button
                        key={exp.id}
                        type="button"
                        onClick={() => toggleMember(exp.id)}
                        className={clsx(
                          'w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors',
                          isSelected ? 'bg-accent/5' : 'hover:bg-bg-hover',
                        )}
                      >
                        <div
                          className={clsx(
                            'w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors',
                            isSelected ? 'bg-accent border-accent' : 'border-border-default',
                          )}
                        >
                          {isSelected && <Check size={10} className="text-bg-base" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-text-primary truncate">{exp.name}</div>
                          {exp.domain && (
                            <div className="text-[10px] text-text-tertiary capitalize">
                              {exp.domain}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 text-sm text-text-secondary hover:text-text-primary rounded-lg hover:bg-bg-hover transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-3.5 py-1.5 text-sm font-medium text-bg-base bg-accent hover:bg-accent-hover rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isSubmitting
                ? t('common.creating')
                : type === 'team'
                  ? t('createExpert.createTeam')
                  : t('createExpert.createExpert')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
