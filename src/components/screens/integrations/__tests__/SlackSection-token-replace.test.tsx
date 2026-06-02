/**
 * Regression test for issue #31 — replacing Slack tokens while the bridge is
 * running must NOT silently hot-restart it. The save handler surfaces the
 * "disable and re-enable Slack" warning returned by setTokens and never calls
 * reload (which would otherwise quietly bounce the live bridge).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../../../i18n';
import SlackSection from '../SlackSection';
import type { SlackStatusResponse } from '../../../../types/ipc';

// UserExpertAccessEditor pulls in ExpertContext, which is irrelevant to this
// test and would otherwise require a provider wrapper.
vi.mock('../UserExpertAccessEditor', () => ({ default: () => null }));

const RUNNING_STATUS: SlackStatusResponse = {
  running: true,
  lastEventAt: null,
  lastError: null,
  teamName: 'Acme',
  botUserId: 'U0BOT',
  hasBotToken: true,
  hasAppToken: true,
  tokenBackend: 'os-keychain',
  enabled: true,
  allowlistChannels: [],
  allowlistUsers: [],
  operatorUserId: null,
};

function stubBridge() {
  const setTokens = vi.fn().mockResolvedValue({
    ok: false,
    error: 'Tokens changed — disable and re-enable Slack to apply.',
  });
  const reload = vi.fn().mockResolvedValue({ ok: true });
  (window as unknown as { cerebro: unknown }).cerebro = {
    invoke: vi.fn().mockResolvedValue({ ok: false }),
    slack: {
      status: vi.fn().mockResolvedValue(RUNNING_STATUS),
      verify: vi.fn(),
      setTokens,
      clearTokens: vi.fn().mockResolvedValue({ ok: true }),
      setAllowlist: vi.fn().mockResolvedValue({ ok: true }),
      setOperatorUserId: vi.fn().mockResolvedValue({ ok: true }),
      reload,
      enable: vi.fn().mockResolvedValue({ ok: true }),
      disable: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
  return { setTokens, reload };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SlackSection — token replacement while running (issue #31)', () => {
  it('shows the re-enable warning and does not reload the live bridge', async () => {
    const { setTokens, reload } = stubBridge();
    render(<SlackSection />);

    // Wait for the running status (with configured tokens) to load.
    const replaceBtn = await screen.findByRole('button', { name: 'Replace' });
    fireEvent.click(replaceBtn);

    fireEvent.change(screen.getByPlaceholderText('xoxb-…'), {
      target: { value: 'xoxb-new-bot-token' },
    });
    fireEvent.change(screen.getByPlaceholderText('xapp-…'), {
      target: { value: 'xapp-new-app-token' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // The bridge-supplied warning must be surfaced to the operator.
    await waitFor(() =>
      expect(screen.getByText(/disable and re-enable Slack/i)).toBeInTheDocument(),
    );

    expect(setTokens).toHaveBeenCalledWith({
      botToken: 'xoxb-new-bot-token',
      appToken: 'xapp-new-app-token',
    });
    // reload() would bounce the live bridge — it must NOT be called.
    expect(reload).not.toHaveBeenCalled();
  });
});
