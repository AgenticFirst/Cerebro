/**
 * Regression tests for the "approve from the chat, not the sidebar" fix.
 *
 * Background: chat-triggered approvals were only reachable from the sidebar
 * Approvals screen. The inline card already existed (InlineApprovals) but never
 * rendered, because the run record was persisted WITHOUT its conversation_id —
 * so every approval came back with conversation_id=null and this component's
 * filter dropped it.
 *
 * These tests pin the user-facing contract of the component itself: it shows
 * the approve/deny card for approvals belonging to the open conversation, and
 * ONLY those. A regression in the filter (e.g. dropping the conversation match,
 * or — as before — approvals arriving with a null conversation) is caught here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { ApprovalRequest } from '../../../types/approvals';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const approve = vi.fn().mockResolvedValue(undefined);
const deny = vi.fn().mockResolvedValue(undefined);
let pendingApprovals: ApprovalRequest[] = [];

vi.mock('../../../context/ApprovalContext', () => ({
  useApprovals: () => ({ pendingApprovals, approve, deny }),
}));

import InlineApprovals from '../InlineApprovals';

function makeApproval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'appr-1',
    run_id: 'run-1',
    conversation_id: 'conv-1',
    step_id: 'step-1',
    step_name: 'Create HubSpot ticket',
    summary: 'Create a ticket in the internal pipeline',
    payload_json: null,
    status: 'pending',
    decision_reason: null,
    requested_at: '2026-06-01T22:24:00Z',
    resolved_at: null,
    ...over,
  };
}

describe('InlineApprovals — surfaces chat approvals inline', () => {
  beforeEach(() => {
    approve.mockClear();
    deny.mockClear();
    pendingApprovals = [];
    cleanup();
  });

  it('renders the approve/deny card for an approval belonging to the open chat', () => {
    pendingApprovals = [makeApproval({ conversation_id: 'conv-1' })];
    render(<InlineApprovals conversationId="conv-1" />);

    expect(screen.getByText('approvals.inlineTitle')).toBeTruthy();
    expect(screen.getByText('Create HubSpot ticket')).toBeTruthy();
    // The pending card exposes both actions, so the user never leaves the chat.
    expect(screen.getByText('approvals.approve')).toBeTruthy();
    expect(screen.getByText('approvals.deny')).toBeTruthy();
  });

  it('renders nothing when there are no pending approvals', () => {
    pendingApprovals = [];
    const { container } = render(<InlineApprovals conversationId="conv-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('does NOT show approvals with a null conversation (routine-triggered)', () => {
    // This is the exact shape that previously leaked through (every chat
    // approval looked like this) and kept the card invisible.
    pendingApprovals = [makeApproval({ conversation_id: null })];
    const { container } = render(<InlineApprovals conversationId="conv-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('does NOT show an approval that belongs to a different conversation', () => {
    pendingApprovals = [makeApproval({ conversation_id: 'conv-OTHER' })];
    const { container } = render(<InlineApprovals conversationId="conv-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('shows only the approvals scoped to the open conversation when several are pending', () => {
    pendingApprovals = [
      makeApproval({ id: 'a-mine', conversation_id: 'conv-1', step_name: 'Mine A' }),
      makeApproval({ id: 'a-other', conversation_id: 'conv-2', step_name: 'Other' }),
      makeApproval({ id: 'a-routine', conversation_id: null, step_name: 'Routine' }),
      makeApproval({ id: 'a-mine-2', conversation_id: 'conv-1', step_name: 'Mine B' }),
    ];
    render(<InlineApprovals conversationId="conv-1" />);

    expect(screen.getByText('Mine A')).toBeTruthy();
    expect(screen.getByText('Mine B')).toBeTruthy();
    expect(screen.queryByText('Other')).toBeNull();
    expect(screen.queryByText('Routine')).toBeNull();
  });

  it('approves inline — clicking Approve calls approve(id) without navigating away', () => {
    pendingApprovals = [makeApproval({ id: 'appr-42', conversation_id: 'conv-1' })];
    render(<InlineApprovals conversationId="conv-1" />);

    fireEvent.click(screen.getByText('approvals.approve'));

    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith('appr-42');
    expect(deny).not.toHaveBeenCalled();
  });

  it('denies inline with a reason — Deny → type → Confirm calls deny(id, reason)', () => {
    pendingApprovals = [makeApproval({ id: 'appr-99', conversation_id: 'conv-1' })];
    const { container } = render(<InlineApprovals conversationId="conv-1" />);

    // Reveal the inline reason form, then confirm.
    fireEvent.click(screen.getByText('approvals.deny'));
    const input = within(container as HTMLElement).getByPlaceholderText(
      'approvals.reasonPlaceholder',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'not now' } });
    fireEvent.click(screen.getByText('approvals.confirm'));

    expect(deny).toHaveBeenCalledTimes(1);
    expect(deny).toHaveBeenCalledWith('appr-99', 'not now');
    expect(approve).not.toHaveBeenCalled();
  });
});
