import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useChat } from '../../context/ChatContext';
import { useTasks } from '../../context/TaskContext';
import { useExperts } from '../../context/ExpertContext';
import { useFeatureFlags } from '../../context/FeatureFlagsContext';
import Sidebar from './Sidebar';
import UpdateBanner from '../update/UpdateBanner';
import ChatView from '../chat/ChatView';
import WelcomeView from '../chat/WelcomeView';
import ExpertsScreen from '../screens/ExpertsScreen';
import RoutinesScreen from '../screens/RoutinesScreen';
import IntegrationsScreen from '../screens/IntegrationsScreen';
import ActivityScreen from '../screens/ActivityScreen';
import ApprovalsScreen from '../screens/ApprovalsScreen';
import SettingsScreen from '../screens/SettingsScreen';
import SkillsLibraryScreen from '../screens/SkillsLibraryScreen';
import CallScreen from '../screens/CallScreen';
import TasksScreen from '../screens/TasksScreen';
import FilesScreen from '../screens/FilesScreen';
import PlaceholderScreen from '../screens/PlaceholderScreen';
import AlertModal from '../ui/AlertModal';

export default function AppLayout() {
  const { t } = useTranslation();
  const {
    activeConversation,
    isStreaming,
    isThinking,
    activeScreen,
    sendMessage,
    chatError,
    dismissChatError,
    setActiveScreen,
  } = useChat();
  const { pendingFailurePrompts, confirmFailurePrompt, dismissFailurePrompt } = useTasks();
  const { flags } = useFeatureFlags();
  const { experts } = useExperts();

  // Show one failure prompt at a time (FIFO).
  const activePrompt = pendingFailurePrompts[0] ?? null;
  const targetExpertName = useMemo(() => {
    if (!activePrompt?.targetExpertId) return null;
    return experts.find((e) => e.id === activePrompt.targetExpertId)?.name ?? null;
  }, [activePrompt, experts]);

  const renderContent = () => {
    if (activeScreen === 'chat') {
      return activeConversation ? (
        <ChatView
          conversation={activeConversation}
          onSend={sendMessage}
          isStreaming={isStreaming}
          isThinking={isThinking}
        />
      ) : (
        <WelcomeView onSend={sendMessage} />
      );
    }
    if (activeScreen === 'tasks') {
      return <TasksScreen />;
    }
    if (activeScreen === 'files') {
      return <FilesScreen />;
    }
    if (activeScreen === 'experts') {
      return <ExpertsScreen />;
    }
    if (activeScreen === 'routines') {
      return <RoutinesScreen />;
    }
    if (activeScreen === 'integrations') {
      return <IntegrationsScreen />;
    }
    if (activeScreen === 'activity') {
      return <ActivityScreen />;
    }
    if (activeScreen === 'approvals') {
      return <ApprovalsScreen />;
    }
    if (activeScreen === 'settings') {
      return <SettingsScreen />;
    }
    if (activeScreen === 'marketplace') {
      return <SkillsLibraryScreen />;
    }
    if (activeScreen === 'call' && flags['voice-calls']) {
      return <CallScreen />;
    }
    return <PlaceholderScreen screen={activeScreen} />;
  };

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 flex flex-col min-h-0">
        {activeScreen !== 'files' && <div className="app-drag-region h-11 flex-shrink-0" />}
        <UpdateBanner />
        {renderContent()}
      </main>

      {chatError && (
        <AlertModal
          icon={<AlertTriangle size={18} className="text-accent" />}
          title={chatError.title}
          message={chatError.message}
          onClose={dismissChatError}
          actions={
            chatError.navigateTo
              ? [
                  { label: t('common.dismiss'), onClick: dismissChatError },
                  {
                    label: t('nav.integrations'),
                    primary: true,
                    onClick: () => {
                      dismissChatError();
                      setActiveScreen(chatError.navigateTo!);
                    },
                  },
                ]
              : undefined
          }
        />
      )}

      {!chatError && activePrompt && (
        <AlertModal
          icon={<AlertTriangle size={18} className="text-accent" />}
          title={t('tasks.queueFailedPromptTitle')}
          message={t('tasks.queueFailedPromptMessage', {
            reason: activePrompt.failureReason,
            expert: targetExpertName ?? t('tasks.drawerExpert'),
          })}
          onClose={() => dismissFailurePrompt(activePrompt.taskId)}
          actions={[
            {
              label: t('tasks.queueFailedDiscard'),
              onClick: () => dismissFailurePrompt(activePrompt.taskId),
            },
            {
              label: t('tasks.queueFailedSend', { expert: targetExpertName ?? t('tasks.drawerExpert') }),
              primary: true,
              onClick: () => confirmFailurePrompt(activePrompt.taskId),
            },
          ]}
        />
      )}
    </div>
  );
}
