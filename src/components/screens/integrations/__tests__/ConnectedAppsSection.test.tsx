/**
 * Regression test for issue #30 — Slack is misclassified as a Connected App.
 *
 * Slack is a fully-implemented Channel integration (it lives in
 * ChannelsSection with a working SlackConnectModal and manifest setup
 * flow). It must NOT also be advertised on the Connected Apps surface as a
 * dead "Coming Soon" row, which leaves users with no way to start setup
 * from there.
 *
 * window.cerebro.hubspot.status is mocked so the section renders without
 * touching the main process. The HubSpot/GitHub/GHL/Supabase cards start
 * collapsed, so their inner sections never mount during the test.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../../../i18n';
import ConnectedAppsSection from '../ConnectedAppsSection';
import type { HubSpotStatusResponse } from '../../../../types/ipc';

const HUBSPOT_DISCONNECTED: HubSpotStatusResponse = {
  hasToken: false,
  portalId: null,
  defaultPipeline: null,
  defaultStage: null,
  tokenBackend: 'os-keychain',
};

function stubBridge() {
  (window as unknown as { cerebro: unknown }).cerebro = {
    hubspot: {
      status: vi.fn().mockResolvedValue(HUBSPOT_DISCONNECTED),
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ConnectedAppsSection — Slack classification (issue #30)', () => {
  it('does NOT advertise Slack as a Coming Soon connected app', () => {
    stubBridge();
    render(<ConnectedAppsSection />);

    // Slack belongs to Channels, not Connected Apps. Its connected-app
    // copy ("Team messaging and notifications") must not render here.
    expect(screen.queryByText('Team messaging and notifications')).not.toBeInTheDocument();
    expect(screen.queryByText('Slack')).not.toBeInTheDocument();
  });

  it('still lists the genuinely unimplemented coming-soon services', () => {
    stubBridge();
    render(<ConnectedAppsSection />);

    // Sanity check: the coming-soon section itself still renders.
    expect(screen.getByText('Notion')).toBeInTheDocument();
    expect(screen.getByText('Google Calendar')).toBeInTheDocument();
    expect(screen.getByText('Gmail')).toBeInTheDocument();
  });
});
