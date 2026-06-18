import { useEffect, useMemo, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useChat } from '../../context/ChatContext';
import { useTasks } from '../../context/TaskContext';
import { useExperts } from '../../context/ExpertContext';
import { useFeatureFlags } from '../../context/FeatureFlagsContext';
import { useToast } from '../../context/ToastContext';
import { IS_MAC } from '../../lib/platform';
import { showOsNotification } from '../../lib/os-notification';
import Sidebar from './Sidebar';
import UpdateBanner from '../update/UpdateBanner';
import ChatView from '../chat/ChatView';
import WelcomeView from '../chat/WelcomeView';
import ExpertsScreen from '../screens/ExpertsScreen';
import RoutinesScreen from '../screens/RoutinesScreen';
import ActivityScreen from '../screens/ActivityScreen';
import ApprovalsScreen from '../screens/ApprovalsScreen';
import SettingsScreen from '../screens/SettingsScreen';
import CallScreen from '../screens/CallScreen';
import TasksScreen from '../screens/TasksScreen';
import FilesScreen from '../screens/FilesScreen';
import KnowledgeBaseScreen from '../screens/knowledge-base/KnowledgeBaseScreen';
import NewsScreen from '../screens/news/NewsScreen';
import CalendarScreen from '../screens/calendar/CalendarScreen';
import CommandPalette from '../command-palette/CommandPalette';
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
  const {
    pendingFailurePrompts,
    confirmFailurePrompt,
    dismissFailurePrompt,
    subscribeTaskCompletion,
  } = useTasks();
  const { flags } = useFeatureFlags();
  const { experts } = useExperts();
  const { addToast } = useToast();

  // Surface every new approval the moment it lands — the sidebar badge alone
  // is easy to miss. Two non-overlapping channels depending on focus:
  //   • window focused  → a clickable in-app toast that jumps to Approvals
  //   • window unfocused → a native OS notification (the common case when the
  //     chat is being driven from Slack/Telegram); clicking it refocuses
  //     Cerebro on the Approvals screen.
  // Keep activeScreen in a ref so the single onAnyEvent subscription always
  // reads the live screen without re-subscribing on every navigation.
  const activeScreenRef = useRef(activeScreen);
  activeScreenRef.current = activeScreen;
  useEffect(() => {
    const openApprovals = () => setActiveScreen('approvals');
    const unsubscribe = window.cerebro.engine.onAnyEvent((event) => {
      if (event.type !== 'approval_requested') return;

      if (!document.hasFocus()) {
        showOsNotification(
          t('approvals.newNotificationTitle'),
          t('approvals.newNotificationBody'),
          () => {
            window.cerebro.focusWindow();
            openApprovals();
          },
        );
        return;
      }

      if (activeScreenRef.current === 'approvals') return;
      addToast(t('approvals.newToast'), 'info', {
        label: t('approvals.newToastAction'),
        onClick: openApprovals,
      });
    });
    return unsubscribe;
  }, [addToast, setActiveScreen, t]);

  // Alert when a Kanban task run finishes (success or failure) so the user
  // hears about it even when they've walked away. Mirrors the approval flow:
  //   • window unfocused → native OS notification; click refocuses on Tasks
  //   • focused, another screen → clickable in-app toast that jumps to Tasks
  //   • focused, already on Tasks → no-op (the card visibly moves columns)
  useEffect(() => {
    const openTasks = () => setActiveScreen('tasks');
    return subscribeTaskCompletion(({ title, outcome }) => {
      const isError = outcome === 'error';
      const osTitle = t(isError ? 'tasks.failedNotificationTitle' : 'tasks.doneNotificationTitle');
      const osBody = t(isError ? 'tasks.failedNotificationBody' : 'tasks.doneNotificationBody', {
        title,
      });

      if (!document.hasFocus()) {
        showOsNotification(osTitle, osBody, () => {
          window.cerebro.focusWindow();
          openTasks();
        });
        return;
      }

      if (activeScreenRef.current === 'tasks') return;
      const toastMessage = t(isError ? 'tasks.failedToast' : 'tasks.doneToast', { title });
      addToast(toastMessage, isError ? 'error' : 'success', {
        label: t('tasks.viewToastAction'),
        onClick: openTasks,
      });
    });
  }, [addToast, setActiveScreen, subscribeTaskCompletion, t]);

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
    // Integrations and Skills (marketplace) now live inside Settings as
    // sub-sections. Existing deep-links to these screens land on the matching
    // Settings pane.
    if (activeScreen === 'integrations') {
      return <SettingsScreen initialSection="integrations" />;
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
      return <SettingsScreen initialSection="skills" />;
    }
    if (activeScreen === 'knowledge-base') {
      return <KnowledgeBaseScreen />;
    }
    if (activeScreen === 'news') {
      return <NewsScreen />;
    }
    if (activeScreen === 'calendar') {
      return <CalendarScreen />;
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
        {IS_MAC && activeScreen !== 'files' && activeScreen !== 'knowledge-base' && (
          <div className="app-drag-region h-11 flex-shrink-0" />
        )}
        <UpdateBanner />
        {renderContent()}
      </main>

      <CommandPalette />

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
              label: t('tasks.queueFailedSend', {
                expert: targetExpertName ?? t('tasks.drawerExpert'),
              }),
              primary: true,
              onClick: () => confirmFailurePrompt(activePrompt.taskId),
            },
          ]}
        />
      )}
    </div>
  );
}
