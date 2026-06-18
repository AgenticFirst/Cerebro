/**
 * Regression tests for "no draft in chat": a half-typed message was lost when
 * the user navigated away from the chat screen and back, because ChatInput kept
 * the text in local state that died when the component unmounted.
 *
 * The fix makes ChatInput a controlled component when the parent passes
 * `onDraftChange` — the parent (ChatContext) owns the draft so it outlives the
 * unmount. These tests pin that contract: the textarea reflects `draftValue`,
 * edits flow out through `onDraftChange`, a remount restores the draft, and
 * sending clears it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('../../../context/ToastContext', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

// SpeedSelector pulls in QualityContext, irrelevant to draft behavior.
vi.mock('../SpeedSelector', () => ({ default: () => null }));

import ChatInput from '../ChatInput';

beforeEach(() => {
  cleanup();
});

// Mimics the parent (ChatContext) holding the draft, with a switch to unmount
// ChatInput the way leaving the chat screen does.
function Harness({ onSend }: { onSend: (c: string) => void }) {
  const [draft, setDraft] = useState('');
  const [mounted, setMounted] = useState(true);
  return (
    <div>
      <button onClick={() => setMounted((m) => !m)}>toggle</button>
      {mounted && <ChatInput onSend={onSend} draftValue={draft} onDraftChange={setDraft} />}
    </div>
  );
}

describe('ChatInput draft persistence', () => {
  it('renders the controlled draft value', () => {
    render(<ChatInput onSend={vi.fn()} draftValue="hola" onDraftChange={vi.fn()} />);
    expect(screen.getByRole('textbox')).toHaveValue('hola');
  });

  it('reports edits through onDraftChange', () => {
    const onDraftChange = vi.fn();
    render(<ChatInput onSend={vi.fn()} draftValue="" onDraftChange={onDraftChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'work in progress' } });
    expect(onDraftChange).toHaveBeenCalledWith('work in progress');
  });

  it('restores the draft after the input unmounts and remounts', () => {
    render(<Harness onSend={vi.fn()} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsent message' } });
    // Navigate away (unmount) then back (remount).
    fireEvent.click(screen.getByText('toggle'));
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByText('toggle'));

    expect(screen.getByRole('textbox')).toHaveValue('unsent message');
  });

  it('sends the draft and clears it', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'send me' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: false });

    expect(onSend).toHaveBeenCalledWith('send me');
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  // The change is additive: a caller that passes neither prop must keep its
  // original uncontrolled local-state behavior (no draft persistence wiring).
  it('falls back to uncontrolled local state when no draft props are given', () => {
    render(<ChatInput onSend={vi.fn()} />);
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'local only' } });
    expect(box).toHaveValue('local only');
  });
});
