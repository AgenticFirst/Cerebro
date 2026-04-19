/**
 * MarkdownDocumentContext — single global mount point for the Notion-style
 * markdown overlay. Any component anywhere in the tree can call
 * `useMarkdownDocument().open(props)` to push a document onto the screen,
 * and the host component (mounted once in AppLayout) renders it.
 *
 * Keeping it global means callers don't have to thread modal state through
 * every screen — same approach we'd use for a toaster.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import MarkdownDocument, { type MarkdownDocumentProps } from '../components/ui/MarkdownDocument';

type OpenProps = Omit<MarkdownDocumentProps, 'onClose'> & {
  /** Optional close hook for callers that need to react after dismissal. */
  onClose?: () => void;
};

interface MarkdownDocumentContextValue {
  open: (props: OpenProps) => void;
  close: () => void;
}

const MarkdownDocumentContext = createContext<MarkdownDocumentContextValue | null>(null);

export function MarkdownDocumentProvider({ children }: { children: ReactNode }) {
  const [doc, setDoc] = useState<OpenProps | null>(null);

  const open = useCallback((props: OpenProps) => setDoc(props), []);
  const close = useCallback(() => setDoc(null), []);

  const value = useMemo<MarkdownDocumentContextValue>(() => ({ open, close }), [open, close]);

  const handleClose = useCallback(() => {
    doc?.onClose?.();
    setDoc(null);
  }, [doc]);

  return (
    <MarkdownDocumentContext.Provider value={value}>
      {children}
      {doc && <MarkdownDocument {...doc} onClose={handleClose} />}
    </MarkdownDocumentContext.Provider>
  );
}

export function useMarkdownDocument(): MarkdownDocumentContextValue {
  const ctx = useContext(MarkdownDocumentContext);
  if (!ctx) {
    throw new Error('useMarkdownDocument must be used inside MarkdownDocumentProvider');
  }
  return ctx;
}
