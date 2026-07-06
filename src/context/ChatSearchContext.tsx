import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

// Open/close state for the global conversation search overlay. Lives in a tiny
// context (rather than local AppLayout state) so the Sidebar button, the
// command palette, and the Cmd/Ctrl+Shift+F listener can all toggle it.
interface ChatSearchContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

const ChatSearchContext = createContext<ChatSearchContextValue | null>(null);

export function ChatSearchProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const value = useMemo(() => ({ isOpen, open, close }), [isOpen, open, close]);
  return <ChatSearchContext.Provider value={value}>{children}</ChatSearchContext.Provider>;
}

export function useChatSearch(): ChatSearchContextValue {
  const ctx = useContext(ChatSearchContext);
  if (!ctx) throw new Error('useChatSearch must be used within ChatSearchProvider');
  return ctx;
}
