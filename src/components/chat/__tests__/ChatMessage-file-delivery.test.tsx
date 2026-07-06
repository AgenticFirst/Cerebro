/**
 * Regression tests for chat file delivery — "the attachment chip shows a ?
 * and the file can't be opened".
 *
 * The model delivers files as `@/absolute/path` lines in its reply. Real
 * transcripts show it sometimes ends the line with sentence punctuation
 * (`@/…/report.docx.`) or drops the ref mid-message with prose after it.
 * Both must still render a working chip, and a ref whose file is gone must
 * say so visibly instead of graying out silently.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../../i18n';
import ChatMessage from '../ChatMessage';
import { ToastProvider } from '../../../context/ToastContext';
import type { Message } from '../../../types/chat';

vi.mock('../../../context/ChatContext', () => ({
  useChat: () => ({
    isStreaming: false,
    conversations: [],
    regenerateFromUserMessage: vi.fn(),
  }),
}));

vi.mock('../../../context/FilesContext', () => ({
  useFiles: () => ({ saveExternalToFiles: vi.fn() }),
}));

vi.mock('../../../context/ChatFilePreviewContext', () => ({
  useChatFilePreviewModal: () => ({ open: vi.fn() }),
}));

const statPath = vi.fn();
const managedAbsPath = vi.fn();

beforeEach(() => {
  statPath.mockReset();
  managedAbsPath.mockReset();
  (window as unknown as { cerebro: unknown }).cerebro = {
    shell: { statPath },
    files: { managedAbsPath },
  };
});

afterEach(() => cleanup());

function assistantMessage(content: string): Message {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content,
    createdAt: new Date(),
  };
}

describe('ChatMessage file delivery', () => {
  it('renders a working chip when the trailing ref has sentence punctuation stuck to it', async () => {
    statPath.mockResolvedValue({ exists: true, isDirectory: false, size: 2048 });
    render(
      <ToastProvider>
        <ChatMessage
          message={assistantMessage('Aquí está el documento.\n\n@/tmp/Solution_Design_ZEISS.docx.')}
        />
      </ToastProvider>,
    );

    // Chip shows the clean filename with the DO extension badge — not "?".
    expect(screen.getByText('Solution_Design_ZEISS.docx')).toBeInTheDocument();
    expect(screen.getByText('DO')).toBeInTheDocument();
    expect(screen.queryByText('?')).not.toBeInTheDocument();
    // And the stat went to the de-punctuated path that actually exists.
    await waitFor(() => expect(statPath).toHaveBeenCalledWith('/tmp/Solution_Design_ZEISS.docx'));
  });

  it('renders a chip for a standalone ref dropped mid-message', () => {
    statPath.mockResolvedValue({ exists: true, isDirectory: false, size: 1024 });
    const content = 'Te reenvío el archivo:\n\n@/tmp/report.docx\n\nSi otra vez falla, avísame.';
    render(
      <ToastProvider>
        <ChatMessage message={assistantMessage(content)} />
      </ToastProvider>,
    );

    expect(screen.getByText('report.docx')).toBeInTheDocument();
    // The raw @-line is stripped from the rendered prose.
    expect(screen.queryByText(/@\/tmp\/report\.docx/)).not.toBeInTheDocument();
    expect(screen.getByText(/Si otra vez falla/)).toBeInTheDocument();
  });

  it('says visibly that the file is gone instead of graying out silently', async () => {
    statPath.mockResolvedValue({ exists: false, isDirectory: false, size: 0 });
    render(
      <ToastProvider>
        <ChatMessage message={assistantMessage('Listo.\n\n@/tmp/deleted-file.docx')} />
      </ToastProvider>,
    );

    expect(await screen.findByText('File no longer exists at this path')).toBeInTheDocument();
    expect(screen.getByText('deleted-file.docx')).toBeInTheDocument();
  });

  it('falls back to the managed copy when the original path is gone but a delivered file exists', async () => {
    // Original path missing; managed copy present.
    statPath.mockImplementation(async (p: string) => ({
      exists: p === '/managed/files/bucket1/item1.docx',
      isDirectory: false,
      size: p === '/managed/files/bucket1/item1.docx' ? 512 : 0,
    }));
    managedAbsPath.mockResolvedValue('/managed/files/bucket1/item1.docx');

    const message = assistantMessage('Aquí está.\n\n@/tmp/original-gone.docx');
    message.deliveredFiles = {
      '/tmp/original-gone.docx': { fileItemId: 'item1', storagePath: 'bucket1/item1.docx' },
    };
    render(
      <ToastProvider>
        <ChatMessage message={message} />
      </ToastProvider>,
    );

    // The chip resolves via the managed copy: size appears, no missing state.
    expect(await screen.findByText('512 B')).toBeInTheDocument();
    expect(screen.queryByText('File no longer exists at this path')).not.toBeInTheDocument();
    expect(managedAbsPath).toHaveBeenCalledWith('bucket1/item1.docx');
  });
});
