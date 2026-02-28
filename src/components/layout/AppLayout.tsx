import { useChat } from '../../context/ChatContext';
import Sidebar from './Sidebar';
import ChatView from '../chat/ChatView';
import WelcomeView from '../chat/WelcomeView';
import PlaceholderScreen from '../screens/PlaceholderScreen';

export default function AppLayout() {
  const {
    activeConversation,
    isStreaming,
    isThinking,
    activeScreen,
    sendMessage,
  } = useChat();

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 flex flex-col min-h-0">
        {activeScreen === 'chat' ? (
          activeConversation ? (
            <ChatView
              conversation={activeConversation}
              onSend={sendMessage}
              isStreaming={isStreaming}
              isThinking={isThinking}
            />
          ) : (
            <WelcomeView onSend={sendMessage} />
          )
        ) : (
          <PlaceholderScreen screen={activeScreen} />
        )}
      </main>
    </div>
  );
}
