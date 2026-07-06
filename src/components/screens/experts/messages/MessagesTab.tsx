import { useEffect, useMemo, useState } from 'react';
import { useChat } from '../../../../context/ChatContext';
import { useExperts } from '../../../../context/ExpertContext';
import ExpertListRail from './ExpertListRail';
import ExpertThreadView from './ExpertThreadView';
import ExpertProfileDrawer from './ExpertProfileDrawer';

export default function MessagesTab() {
  const { experts, loadExperts } = useExperts();
  const { pendingExpertNav, consumePendingExpertNav, setActiveConversation } = useChat();
  const [selectedExpertId, setSelectedExpertId] = useState<string | null>(null);
  const [profileExpertId, setProfileExpertId] = useState<string | null>(null);

  useEffect(() => {
    loadExperts();
  }, [loadExperts]);

  // Default selection priority: pinned team → pinned expert → first enabled
  // team → first enabled expert. Teams jump the queue when the user has
  // explicitly starred one because they're the highest-intent contact.
  useEffect(() => {
    if (selectedExpertId) return;
    // A pending search-navigation names the expert to select — don't compete.
    if (pendingExpertNav) return;
    const enabledTeams = experts.filter((e) => e.isEnabled && e.type === 'team');
    const enabledExperts = experts.filter((e) => e.isEnabled && e.type === 'expert');
    const pinnedTeam = enabledTeams.find((e) => e.isPinned);
    const pinnedExpert = enabledExperts.find((e) => e.isPinned);
    const first = pinnedTeam ?? pinnedExpert ?? enabledExperts[0] ?? enabledTeams[0];
    if (first) setSelectedExpertId(first.id);
  }, [experts, selectedExpertId, pendingExpertNav]);

  // Reactive flag-flip safety: if the currently selected contact is filtered
  // out (e.g. teams flag turned off while a team thread is open), reset so
  // the default-selection effect can route to a still-visible contact.
  useEffect(() => {
    if (!selectedExpertId) return;
    const stillVisible = experts.some((e) => e.id === selectedExpertId);
    if (!stillVisible) setSelectedExpertId(null);
  }, [experts, selectedExpertId]);

  // Global chat search hands off a specific expert thread to open (same
  // pattern as pendingActivityRunId → ActivityScreen). Select the expert and
  // conversation, then consume; ExpertThreadView's sync effect keeps the
  // selection because the conversation is in that expert's thread list.
  useEffect(() => {
    if (!pendingExpertNav) return;
    setSelectedExpertId(pendingExpertNav.expertId);
    setActiveConversation(pendingExpertNav.conversationId);
    consumePendingExpertNav();
  }, [pendingExpertNav, consumePendingExpertNav, setActiveConversation]);

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
      <ExpertThreadView expert={selectedExpert} onOpenProfile={(id) => setProfileExpertId(id)} />
      {profileExpert && (
        <ExpertProfileDrawer
          key={profileExpert.id}
          expert={profileExpert}
          onClose={() => setProfileExpertId(null)}
          onSelectMember={(id) => setProfileExpertId(id)}
        />
      )}
    </div>
  );
}
