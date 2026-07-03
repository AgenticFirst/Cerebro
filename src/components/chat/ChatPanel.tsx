/**
 * The main Cerebro chat surface, bound to the active conversation from
 * ChatContext: the live conversation when one is active, the welcome view
 * otherwise. AppLayout's chat branch renders this.
 */

import ChatView from './ChatView';
import WelcomeView from './WelcomeView';
import { useChat } from '../../context/ChatContext';

export default function ChatPanel() {
  const { activeConversation, sendMessage, isStreaming, isThinking } = useChat();

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
