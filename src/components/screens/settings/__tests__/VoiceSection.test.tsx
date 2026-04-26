/**
 * Acceptance tests for the Voice settings section.
 *
 * The user said: "this needs to be deterministic and should NEVER fail."
 * These tests cover the full state matrix the user sees:
 *
 *   - first install: both models show "Download" buttons
 *   - mid-download: progress bar + cancel
 *   - one installed, one not: enable-toggle stays disabled
 *   - both installed: enable-toggle becomes available
 *   - failure: error message + retry button
 *
 * The VoiceContext is mocked so this test never touches the backend.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import VoiceSection from '../VoiceSection';
import { VoiceContext, type VoiceCatalog, type VoiceCatalogModel } from '../../../../context/VoiceContext';

// VoiceContext is the only thing this section depends on; we provide a
// hand-rolled implementation so tests can drive every branch.
function makeModel(overrides: Partial<VoiceCatalogModel> = {}): VoiceCatalogModel {
  return {
    id: 'kokoro-82m',
    name: 'Kokoro 82M',
    type: 'tts',
    description: 'High-quality 24 kHz TTS',
    size_bytes: 340_000_000,
    available: false,
    download_state: 'not_installed',
    downloaded_bytes: 0,
    error: null,
    ...overrides,
  };
}

function renderWithCatalog(
  catalog: VoiceCatalog,
  overrides: Partial<{
    refreshCatalog: () => Promise<void>;
    startDownload: (id: string) => Promise<void>;
    cancelDownload: (id: string) => Promise<void>;
  }> = {},
) {
  const value = {
    // VoiceState
    sessionState: 'idle' as const,
    activeSession: null,
    currentTranscription: '',
    currentResponse: '',
    isSpeaking: false,
    subtitlesEnabled: true,
    callError: null,
    statusMessage: '',
    // ModelsState
    catalog,
    catalogLoading: false,
    // Actions
    startCall: vi.fn(),
    endCall: vi.fn(),
    startSpeaking: vi.fn(),
    stopSpeaking: vi.fn(),
    toggleSubtitles: vi.fn(),
    refreshCatalog: overrides.refreshCatalog ?? vi.fn().mockResolvedValue(undefined),
    startDownload: overrides.startDownload ?? vi.fn().mockResolvedValue(undefined),
    cancelDownload: overrides.cancelDownload ?? vi.fn().mockResolvedValue(undefined),
  };
  return {
    ...render(
      <VoiceContext.Provider value={value}>
        <VoiceSection />
      </VoiceContext.Provider>,
    ),
    value,
  };
}

afterEach(() => {
  cleanup();
});

const STT = makeModel({
  id: 'faster-whisper-base',
  name: 'Faster Whisper Base',
  type: 'stt',
  description: 'Sub-200ms STT',
  size_bytes: 145_000_000,
});
const TTS = makeModel({ id: 'kokoro-82m' });

const CATALOG_BOTH_MISSING: VoiceCatalog = {
  models: [STT, TTS],
  voice_models_dir: '/tmp/voice',
  all_installed: false,
};

// ── Initial state: nothing installed ───────────────────────────

describe('VoiceSection — fresh install', () => {
  it('shows a Download button for each model', () => {
    renderWithCatalog(CATALOG_BOTH_MISSING);
    const buttons = screen.getAllByRole('button', { name: /Download \d+ MB/i });
    expect(buttons).toHaveLength(2);
  });

  it('does NOT render an "Enable voice calls" toggle (master switch lives in Beta Features)', () => {
    renderWithCatalog(CATALOG_BOTH_MISSING);
    expect(screen.queryByText(/Enable voice calls/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/install both models above to enable/i)).not.toBeInTheDocument();
  });

  it('clicking Download triggers startDownload with the model id', () => {
    const { value } = renderWithCatalog(CATALOG_BOTH_MISSING);
    const buttons = screen.getAllByRole('button', { name: /Download \d+ MB/i });
    fireEvent.click(buttons[0]); // STT comes first
    expect(value.startDownload).toHaveBeenCalledWith('faster-whisper-base');
  });
});

// ── Mid-download ──────────────────────────────────────────────

describe('VoiceSection — downloading', () => {
  it('renders the progress bar and percentage while downloading', () => {
    renderWithCatalog({
      models: [
        STT,
        makeModel({
          download_state: 'downloading',
          downloaded_bytes: 100_000_000,
          size_bytes: 340_000_000,
        }),
      ],
      voice_models_dir: '/tmp/voice',
      all_installed: false,
    });
    // 100/340 = 29%
    expect(screen.getByText(/95 MB \/ 324 MB \(29%\)/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
  });

  it('Cancel button calls cancelDownload', () => {
    const { value } = renderWithCatalog({
      models: [
        STT,
        makeModel({
          download_state: 'downloading',
          downloaded_bytes: 1,
          size_bytes: 340_000_000,
        }),
      ],
      voice_models_dir: '/tmp/voice',
      all_installed: false,
    });
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(value.cancelDownload).toHaveBeenCalledWith('kokoro-82m');
  });
});

// ── Failure ───────────────────────────────────────────────────

describe('VoiceSection — failure', () => {
  it('shows the error message and a Retry button on failed download', () => {
    renderWithCatalog({
      models: [
        STT,
        makeModel({ download_state: 'failed', error: 'ConnectionError: refused' }),
      ],
      voice_models_dir: '/tmp/voice',
      all_installed: false,
    });
    expect(screen.getByText(/ConnectionError: refused/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });

  it('Retry calls startDownload again with the same model', () => {
    const { value } = renderWithCatalog({
      models: [
        STT,
        makeModel({ download_state: 'failed', error: 'boom' }),
      ],
      voice_models_dir: '/tmp/voice',
      all_installed: false,
    });
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(value.startDownload).toHaveBeenCalledWith('kokoro-82m');
  });
});

// ── Both installed ────────────────────────────────────────────

describe('VoiceSection — fully installed', () => {
  it('shows Installed status for each model when both are installed', () => {
    renderWithCatalog({
      models: [
        makeModel({ ...STT, download_state: 'installed', available: true }),
        makeModel({ download_state: 'installed', available: true }),
      ],
      voice_models_dir: '/tmp/voice',
      all_installed: true,
    });
    // Match the badge label exactly so the section header copy
    // (which mentions "installed" in passing) doesn't pad the count.
    const installedLabels = screen.getAllByText(/^Installed$/);
    expect(installedLabels).toHaveLength(2);
  });

  it('shows the "Voice is ready" affordance when all_installed is true', () => {
    renderWithCatalog({
      models: [
        makeModel({ ...STT, download_state: 'installed', available: true }),
        makeModel({ download_state: 'installed', available: true }),
      ],
      voice_models_dir: '/tmp/voice',
      all_installed: true,
    });
    expect(screen.getByText(/Voice is ready/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Open any expert profile and click the call button/i),
    ).toBeInTheDocument();
  });
});

// ── Mixed state (one installed, one not) ───────────────────────

describe('VoiceSection — partial install', () => {
  it('does not show the "Voice is ready" banner when only one model is installed', () => {
    renderWithCatalog({
      models: [
        makeModel({ ...STT, download_state: 'installed', available: true }),
        makeModel({ download_state: 'not_installed' }),
      ],
      voice_models_dir: '/tmp/voice',
      all_installed: false,
    });
    expect(screen.queryByText(/Voice is ready/i)).not.toBeInTheDocument();
  });
});
