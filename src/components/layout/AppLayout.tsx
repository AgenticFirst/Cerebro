import { useChat } from '../../context/ChatContext';
import Sidebar from './Sidebar';
import ChatView from '../chat/ChatView';
import WelcomeView from '../chat/WelcomeView';
import IntegrationsScreen from '../screens/IntegrationsScreen';
import PlaceholderScreen from '../screens/PlaceholderScreen';

export default function AppLayout() {
  const {
    activeConversation,
    isStreaming,
    isThinking,
    activeScreen,
    sendMessage,
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
    if (activeScreen === 'integrations') {
      return <IntegrationsScreen />;
    }
    return <PlaceholderScreen screen={activeScreen} />;
  };

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 flex flex-col min-h-0">
        {renderContent()}
      </main>
    </div>
  );
}
