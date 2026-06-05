/**
 * Regression test for issue #62 — the Routine editor shows "Saved" and silently
 * drops the user's edits when the autosave PATCH fails.
 *
 * Root cause: RoutineContext.updateRoutine swallows every failure (network
 * rejection or a non-ok HTTP response) and resolves normally. The autosave
 * effect in useRoutineCanvas treated that resolution as success — it always ran
 * setIsDirty(false) + setSaveStatus('saved'). So a failed save flipped the
 * canvas to a clean "Saved" state even though nothing reached the backend, and
 * because isDirty was cleared the edits were never retried and were lost on the
 * next reload.
 *
 * The fix makes updateRoutine report success/failure (Promise<boolean>) and has
 * the autosave / manual-save paths keep the canvas dirty and surface an "error"
 * status when the write fails.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Routine } from '../../../../types/routines';

const updateRoutineMock = vi.fn();

// The hook only needs updateRoutine from the routine context; stub the rest so
// it can run without the full provider tree or the IPC bridge.
vi.mock('../../../../context/RoutineContext', () => ({
  useRoutines: () => ({ updateRoutine: updateRoutineMock }),
}));

import { useRoutineCanvas } from '../../../../hooks/useRoutineCanvas';

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'r-1',
    name: 'Test',
    description: '',
    plainEnglishSteps: null,
    dagJson: null,
    triggerType: 'manual',
    cronExpression: null,
    defaultRunnerId: null,
    isEnabled: true,
    approvalGates: null,
    requiredConnections: null,
    notifyChannels: null,
    source: 'user',
    sourceConversationId: null,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 0,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  updateRoutineMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRoutineCanvas autosave failure (issue #62)', () => {
  it('keeps the canvas dirty and shows an error when the autosave PATCH fails', async () => {
    // A failing PATCH: updateRoutine resolves false (its failure contract).
    updateRoutineMock.mockResolvedValue(false);

    const { result } = renderHook(() => useRoutineCanvas(makeRoutine()));

    // Make an edit so the canvas is dirty and autosave is scheduled.
    act(() => {
      result.current.addNode('signal', { x: 10, y: 10 });
    });
    expect(result.current.isDirty).toBe(true);

    // Let the 1s autosave debounce fire and the async save settle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    expect(updateRoutineMock).toHaveBeenCalledTimes(1);
    // The save failed: the editor must NOT claim "Saved" and must NOT drop the
    // edit by clearing the dirty flag.
    expect(result.current.saveStatus).toBe('error');
    expect(result.current.isDirty).toBe(true);
  });

  it('reports "saved" and clears the dirty flag when the autosave PATCH succeeds', async () => {
    updateRoutineMock.mockResolvedValue(true);

    const { result } = renderHook(() => useRoutineCanvas(makeRoutine()));

    act(() => {
      result.current.addNode('signal', { x: 10, y: 10 });
    });
    expect(result.current.isDirty).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    expect(updateRoutineMock).toHaveBeenCalledTimes(1);
    expect(result.current.saveStatus).toBe('saved');
    expect(result.current.isDirty).toBe(false);
  });
});
