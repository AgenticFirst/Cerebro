import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useExperts } from '../../../context/ExpertContext';
import { isCerebroExpert } from '../../../shared/agent-name';

interface AssigneeSelectProps {
  /** Current assignee id: '' (none), the Cerebro id, or a real expert/team id. */
  value: string;
  onChange: (value: string) => void;
  className?: string;
  /** Label for the empty / unassigned option. */
  noneLabel: string;
}

/**
 * Grouped assignee picker shared by task create + reassign. Offers:
 *   - None (unassigned)
 *   - Cerebro (the orchestrator; runs the main agent, which re-routes to the
 *     experts/teams it judges necessary). Backed by a real builtin expert row
 *     so it satisfies the task.expert_id foreign key.
 *   - Experts (individual)
 *   - Teams (only when the teams beta flag is on — `useExperts().experts`
 *     already hides teams otherwise, so this group is naturally empty)
 */
export default function AssigneeSelect({
  value,
  onChange,
  className,
  noneLabel,
}: AssigneeSelectProps) {
  const { t } = useTranslation();
  const { experts } = useExperts();

  const cerebro = useMemo(() => experts.find((e) => isCerebroExpert(e) && e.isEnabled), [experts]);
  const individualExperts = useMemo(
    () => experts.filter((e) => e.type === 'expert' && e.isEnabled && !isCerebroExpert(e)),
    [experts],
  );
  const teams = useMemo(() => experts.filter((e) => e.type === 'team' && e.isEnabled), [experts]);

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">{noneLabel}</option>
      {cerebro && <option value={cerebro.id}>{cerebro.name}</option>}
      {individualExperts.length > 0 && (
        <optgroup label={t('tasks.expertGroupExperts')}>
          {individualExperts.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </optgroup>
      )}
      {teams.length > 0 && (
        <optgroup label={t('tasks.expertGroupTeams')}>
          {teams.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
