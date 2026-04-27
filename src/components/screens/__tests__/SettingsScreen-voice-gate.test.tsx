/**
 * Acceptance test: the Voice section in Settings is gated on the
 * `voice-calls` beta feature flag.
 *
 * The user requirement: "Call icon and downloads should only be available
 * to those who turn beta features on." This test pins down the downloads
 * half (the Phone-button half is enforced by the existing flag check in
 * ExpertDetailPanel.tsx — covered by its own component test).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import SettingsScreen from '../SettingsScreen';

// Stub i18n so labels resolve to their keys (or the configured fallback).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) => {
      const map: Record<string, string> = {
        'settings.title': 'Settings',
        'settings.memory': 'Memory',
        'settings.sandbox': 'Sandbox',
        'settings.voice': 'Voice',
        'settings.appearance': 'Appearance',
        'settings.beta': 'Beta Features',
        'settings.about': 'About',
        'settings.aboutComingSoon': 'About Cerebro coming soon',
      };
      return map[k] ?? k;
    },
  }),
}));

// Stub heavy section components — we only care which ones the sidebar
// renders, not their content.
vi.mock('../settings/MemorySection', () => ({ default: () => <div>__memory_pane__</div> }));
vi.mock('../settings/SandboxSection', () => ({ default: () => <div>__sandbox_pane__</div> }));
vi.mock('../settings/AppearanceSection', () => ({ default: () => <div>__appearance_pane__</div> }));
vi.mock('../settings/BetaFeaturesSection', () => ({ default: () => <div>__beta_pane__</div> }));
vi.mock('../settings/VoiceSection', () => ({ default: () => <div>__voice_pane__</div> }));

let mockFlags: Record<string, boolean> = { teams: false, 'voice-calls': false };

vi.mock('../../../context/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: mockFlags, setFlag: vi.fn() }),
}));

// Stub OnboardingContext so SettingsScreen doesn't require the provider.
// The Voice gating tests don't exercise tour state at all.
vi.mock('../../../context/OnboardingContext', () => ({
  useOnboarding: () => ({
    isOpen: false,
    stepIndex: 0,
    step: { id: 'welcome', kind: 'welcome', titleKey: '', bodyKey: '' },
    hasCompletedBefore: true,
    forcedSettingsSection: null,
    language: 'en',
    start: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    setLanguageAndAdvance: vi.fn(),
    finish: vi.fn(),
  }),
  OnboardingProvider: ({ children }: { children: React.ReactNode }) => children,
}));

beforeEach(() => {
  mockFlags = { teams: false, 'voice-calls': false };
});

afterEach(() => {
  cleanup();
});

describe('SettingsScreen — Voice gating', () => {
  it('hides Voice from the sidebar when voice-calls flag is OFF', () => {
    render(<SettingsScreen />);
    // Memory / Sandbox / Appearance / Beta / About — but NOT Voice.
    expect(screen.getByText('Memory')).toBeInTheDocument();
    expect(screen.getByText('Sandbox')).toBeInTheDocument();
    expect(screen.getByText('Appearance')).toBeInTheDocument();
    expect(screen.getByText('Beta Features')).toBeInTheDocument();
    expect(screen.getByText('About')).toBeInTheDocument();
    expect(screen.queryByText('Voice')).not.toBeInTheDocument();
  });

  it('shows Voice in the sidebar when voice-calls flag is ON', () => {
    mockFlags = { teams: false, 'voice-calls': true };
    render(<SettingsScreen />);
    expect(screen.getByText('Voice')).toBeInTheDocument();
  });

  it('renders the voice pane when the flag is ON and a caller pre-selects voice', async () => {
    mockFlags = { teams: false, 'voice-calls': true };
    const { setPendingSettingsSection } = await import(
      '../settings/pending-section'
    );
    setPendingSettingsSection('voice');
    render(<SettingsScreen />);
    expect(screen.getByText('__voice_pane__')).toBeInTheDocument();
  });

  it('falls back to the Beta pane if a caller asks for voice while the flag is OFF', async () => {
    mockFlags = { teams: false, 'voice-calls': false };
    const { setPendingSettingsSection } = await import(
      '../settings/pending-section'
    );
    setPendingSettingsSection('voice');
    render(<SettingsScreen />);
    // Voice pane is NOT shown; the user lands on Beta where they can flip the flag.
    expect(screen.queryByText('__voice_pane__')).not.toBeInTheDocument();
    expect(screen.getByText('__beta_pane__')).toBeInTheDocument();
  });
});
