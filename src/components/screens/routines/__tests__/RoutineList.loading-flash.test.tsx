/**
 * Regression test for issue #55 — the Routines list flashes the empty state
 * ("No routines yet") for one frame before the loading spinner on first open.
 *
 * Root cause: RoutineProvider initialised `isLoading` to `false`. On the very
 * first synchronous paint — before RoutineList's mount effect calls
 * loadRoutines() — the spinner gate (`isLoading && routines.length === 0`) was
 * false, so the component fell through to the empty placeholder. The fix makes
 * `isLoading` start `true`, because a load is always kicked off on mount, so
 * the first frame shows the spinner instead.
 *
 * Two layers of coverage:
 *   1. Provider unit test — the initial context value must report isLoading
 *      before any consumer has triggered a load (the root cause, deterministic).
 *   2. Component test — the first synchronous render of RoutineList must show
 *      the spinner, never the empty placeholder, by inspecting the DOM before
 *      passive effects flush (reproduces the user-visible flash).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../../../i18n';

// RoutineProvider only consumes useToast/useExperts in callbacks; stub them so
// the provider can mount without the full context tree or the IPC bridge.
vi.mock('../../../../context/ToastContext', () => ({
  useToast: () => ({ addToast: vi.fn(), toasts: [], dismissToast: vi.fn() }),
}));
vi.mock('../../../../context/ExpertContext', () => ({
  useExperts: () => ({ experts: [] }),
}));

import { RoutineProvider, useRoutines } from '../../../../context/RoutineContext';
import RoutineList from '../RoutineList';

function stubBridge() {
  // Keep the /routines load pending forever so isLoading stays in its
  // mount-time value for the duration of the assertions.
  (window as unknown as { cerebro: unknown }).cerebro = {
    invoke: vi.fn(() => new Promise(() => {})),
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RoutineList loading flash (issue #55)', () => {
  it('provider starts in the loading state before any consumer triggers a load', () => {
    stubBridge();

    let captured: ReturnType<typeof useRoutines> | null = null;
    function Probe() {
      captured = useRoutines();
      return null;
    }

    render(
      <RoutineProvider>
        <Probe />
      </RoutineProvider>,
    );

    expect(captured).not.toBeNull();
    // A load always fires on mount, so the very first state the UI sees must be
    // "loading" — otherwise the empty placeholder flashes first.
    expect(captured!.isLoading).toBe(true);
    expect(captured!.routines).toHaveLength(0);
  });

  it('shows the spinner on the first paint, never the empty placeholder', () => {
    stubBridge();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    // flushSync forces the initial commit synchronously while leaving passive
    // effects (RoutineList's mount-time loadRoutines) deferred. Inspecting the
    // DOM now captures exactly the first frame the user sees on open — before
    // any load has been kicked off. IS_REACT_ACT_ENVIRONMENT=false keeps React
    // from auto-flushing those effects.
    const prevActEnv = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      flushSync(() => {
        root.render(
          <RoutineProvider>
            <RoutineList />
          </RoutineProvider>,
        );
      });

      const html = container.innerHTML;
      expect(html).not.toContain('No routines yet');
      expect(container.querySelector('.animate-spin')).not.toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
      container.remove();
    }
  });
});
