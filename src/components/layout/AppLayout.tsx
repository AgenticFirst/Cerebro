import { AlertTriangle } from 'lucide-react';
import { useChat } from '../../context/ChatContext';
import Sidebar from './Sidebar';
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
import PlaceholderScreen from '../screens/PlaceholderScreen';
import AlertModal from '../ui/AlertModal';

export default function AppLayout() {
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
    if (activeScreen === 'call') {
      return <CallScreen />;
    }
    return <PlaceholderScreen screen={activeScreen} />;
  };

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 flex flex-col min-h-0">
        <div className="app-drag-region h-11 flex-shrink-0" />
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
                  { label: 'Dismiss', onClick: dismissChatError },
                  {
                    label: 'Go to Integrations',
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
    </div>
  );
}
