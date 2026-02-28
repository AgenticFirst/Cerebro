import { useCallback } from 'react';
import { useChat } from '../../context/ChatContext';
import Sidebar from './Sidebar';
import ChatView from '../chat/ChatView';
import WelcomeView from '../chat/WelcomeView';

export default function AppLayout() {
  const {
    activeConversation,
    activeConversationId,
    isStreaming,
    createConversation,
    addMessage,
  } = useChat();

  const handleSend = useCallback(
    (content: string) => {
      let convId = activeConversationId;
      if (!convId) {
        convId = createConversation(content);
      }
      addMessage(convId, 'user', content);
    },
    [activeConversationId, createConversation, addMessage],
  );

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 flex flex-col min-h-0">
        {activeConversation ? (
          <ChatView
            conversation={activeConversation}
            onSend={handleSend}
            isStreaming={isStreaming}
          />
        ) : (
          <WelcomeView onSend={handleSend} />
        )}
      </main>
    </div>
  );
}
