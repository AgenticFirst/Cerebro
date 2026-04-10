import { useState, useEffect, useCallback } from 'react';
import { Plus, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { useSkills } from '../../../context/SkillContext';
import type { ExpertSkillAssignment } from '../../../types/skills';
import SkillIcon from '../../ui/SkillIcon';
import Toggle from '../../ui/Toggle';

interface ExpertSkillsSectionProps {
  expertId: string;
}

export default function ExpertSkillsSection({ expertId }: ExpertSkillsSectionProps) {
  const { skills, loadSkills, getExpertSkills, assignSkill, unassignSkill, toggleSkillActive } =
    useSkills();

  const [assignments, setAssignments] = useState<ExpertSkillAssignment[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    const result = await getExpertSkills(expertId);
    setAssignments(result);
    setIsLoading(false);
  }, [expertId, getExpertSkills]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (skills.length === 0) loadSkills();
  }, [skills.length, loadSkills]);

  const assignedIds = new Set(assignments.map((a) => a.skillId));
  const availableSkills = skills.filter((s) => !assignedIds.has(s.id) && s.isEnabled);

  const handleAssign = async (skillId: string) => {
    await assignSkill(expertId, skillId);
    await refresh();
    setShowAdd(false);
  };

  const handleUnassign = async (skillId: string) => {
    await unassignSkill(expertId, skillId);
    await refresh();
  };

  const handleToggle = async (skillId: string, currentActive: boolean) => {
    await toggleSkillActive(expertId, skillId, !currentActive);
    await refresh();
  };

  if (isLoading && assignments.length === 0) {
    return <p className="text-xs text-text-tertiary">Loading skills...</p>;
  }

  return (
    <div className="space-y-2">
      {/* Assigned skills list */}
      {assignments.length > 0 ? (
        <div className="space-y-1">
          {assignments.map((a) => (
            <div
              key={a.id}
              className="group flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-bg-base border border-border-subtle"
            >
              <SkillIcon
                name={a.skill.icon}
                size={12}
                className={clsx(
                  'flex-shrink-0',
                  a.isActive ? 'text-accent' : 'text-text-tertiary',
                )}
              />
              <span
                className={clsx(
                  'text-[11px] flex-1 truncate',
                  a.isActive ? 'text-text-secondary' : 'text-text-tertiary',
                )}
              >
                {a.skill.name}
              </span>
              {a.skill.isDefault && (
                <span className="text-[9px] text-text-tertiary bg-bg-elevated px-1.5 py-0.5 rounded">
                  default
                </span>
              )}
              <Toggle
                checked={a.isActive}
                onChange={() => handleToggle(a.skillId, a.isActive)}
              />
              <button
                onClick={() => handleUnassign(a.skillId)}
                className="p-0.5 text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all"
                title="Remove skill"
              >
                <XCircle size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-text-tertiary">No skills assigned.</p>
      )}

      {/* Add skill */}
      {showAdd ? (
        <div className="mt-2 bg-bg-base rounded-lg border border-border-subtle max-h-36 overflow-y-auto scrollbar-thin">
          {availableSkills.length === 0 ? (
            <p className="text-xs text-text-tertiary px-3 py-2.5">
              No available skills to add.
            </p>
          ) : (
            availableSkills.map((skill) => (
              <button
                key={skill.id}
                onClick={() => handleAssign(skill.id)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-bg-hover transition-colors"
              >
                <SkillIcon name={skill.icon} size={12} className="text-accent flex-shrink-0" />
                <span className="text-xs text-text-secondary truncate">
                  {skill.name}
                </span>
              </button>
            ))
          )}
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="mt-2 flex items-center gap-1.5 text-xs text-accent hover:text-accent-hover transition-colors"
        >
          <Plus size={13} />
          Add Skill
        </button>
      )}
    </div>
  );
}
