import { useEffect, useMemo, useState } from 'react';
import { useExperts } from '../../../../context/ExpertContext';
import ExpertListRail from './ExpertListRail';
import ExpertThreadView from './ExpertThreadView';
import ExpertProfileDrawer from './ExpertProfileDrawer';

export default function MessagesTab() {
  const { experts, loadExperts } = useExperts();
  const [selectedExpertId, setSelectedExpertId] = useState<string | null>(null);
  const [profileExpertId, setProfileExpertId] = useState<string | null>(null);

  useEffect(() => {
    loadExperts();
  }, [loadExperts]);

  // Default selection: the first starred expert, else the first enabled expert.
  useEffect(() => {
    if (selectedExpertId) return;
    const enabled = experts.filter((e) => e.isEnabled && e.type === 'expert');
    const starred = enabled.find((e) => e.isPinned);
    const first = starred ?? enabled[0];
    if (first) setSelectedExpertId(first.id);
  }, [experts, selectedExpertId]);

  const selectedExpert = useMemo(
    () => experts.find((e) => e.id === selectedExpertId) ?? null,
    [experts, selectedExpertId],
  );

  const profileExpert = useMemo(
    () => experts.find((e) => e.id === profileExpertId) ?? null,
    [experts, profileExpertId],
  );

  return (
    <div className="flex-1 flex min-h-0 relative">
      <ExpertListRail
        experts={experts}
        selectedExpertId={selectedExpertId}
        onSelectExpert={setSelectedExpertId}
      />
      <ExpertThreadView
        expert={selectedExpert}
        onOpenProfile={(id) => setProfileExpertId(id)}
      />
      {profileExpert && (
        <ExpertProfileDrawer
          expert={profileExpert}
          onClose={() => setProfileExpertId(null)}
        />
      )}
    </div>
  );
}
