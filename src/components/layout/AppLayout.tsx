import { AlertTriangle } from 'lucide-react';
import { useChat } from '../../context/ChatContext';
import Sidebar from './Sidebar';
import ChatView from '../chat/ChatView';
import WelcomeView from '../chat/WelcomeView';
import ExpertsScreen from '../screens/ExpertsScreen';
import IntegrationsScreen from '../screens/IntegrationsScreen';
import SettingsScreen from '../screens/SettingsScreen';
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
    if (activeScreen === 'integrations') {
      return <IntegrationsScreen />;
    }
    if (activeScreen === 'settings') {
      return <SettingsScreen />;
    }
    return <PlaceholderScreen screen={activeScreen} />;
  };

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 flex flex-col min-h-0">{renderContent()}</main>

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
