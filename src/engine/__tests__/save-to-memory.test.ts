import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { saveToMemoryAction } from '../actions/save-to-memory';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

vi.mock('../../claude-code/single-shot', () => ({
  singleShotClaudeCode: vi.fn(),
}));

vi.mock('../actions/utils/backend-fetch', () => ({
  backendFetch: vi.fn(),
}));

import { singleShotClaudeCode } from '../../claude-code/single-shot';
import { backendFetch } from '../actions/utils/backend-fetch';

const mockSingleShot = vi.mocked(singleShotClaudeCode);
const mockBackendFetch = vi.mocked(backendFetch);

function makeContext(): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: 55555,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    resolveModel: vi.fn(),
  } as ActionContext;
}

async function run(
  params: Record<string, unknown>,
  context: ActionContext = makeContext(),
) {
  return saveToMemoryAction.execute({
    params,
    wiredInputs: {},
    scratchpad: new RunScratchpad(),
    context,
  });
}

/** Capture the body argument of the PUT call. */
function getPutCall() {
  const put = mockBackendFetch.mock.calls.find((c) => c[1] === 'PUT');
  expect(put).toBeDefined();
  return put!;
}

/**
 * Default backendFetch mock: any GET returns 404 ("file not found"),
 * PUT resolves to the stored content echo. Tests override per-case.
 */
function defaultBackendFetch() {
  mockBackendFetch.mockImplementation(async (_port, method, _path, body) => {
    if (method === 'GET') {
      const err = new Error('Backend error (404): not found') as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    if (method === 'PUT') {
      return {
        path: 'routines/2026-04-21.md',
        content: (body as { content: string }).content,
        last_modified: '2026-04-21T14:32:00',
      };
    }
    return {};
  });
}

describe('saveToMemoryAction', () => {
  beforeEach(() => {
    mockSingleShot.mockReset();
    mockBackendFetch.mockReset();
    // Freeze time so filename/header are deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T14:32:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('STM-U1: writes verbatim content in write mode under routines/<YYYY-MM-DD>.md', async () => {
    defaultBackendFetch();
    const result = await run({ content: 'Keep this fact verbatim.' });

    const put = getPutCall();
    expect(put[1]).toBe('PUT');
    expect(put[2]).toBe('/agent-memory/cerebro/files/routines/2026-04-21.md');
    const body = put[3] as { content: string };
    expect(body.content).toContain('Keep this fact verbatim.');
    // Does NOT call Claude when mode is write.
    expect(mockSingleShot).not.toHaveBeenCalled();
    expect(result.data.saved).toBe(true);
    expect(result.data.item_id).toBe('cerebro:routines/2026-04-21.md');
  });

  it('STM-U2: uses extract-mode distilled body instead of raw content when mode=extract', async () => {
    defaultBackendFetch();
    mockSingleShot.mockResolvedValueOnce('- fact one\n- fact two');
    await run({ content: 'Long ramble with two facts.', mode: 'extract' });

    const body = (getPutCall()[3] as { content: string }).content;
    expect(body).toContain('- fact one');
    expect(body).toContain('- fact two');
    expect(body).not.toContain('Long ramble with two facts.');
    expect(mockSingleShot).toHaveBeenCalledOnce();
  });

  it('STM-U3: falls back to raw content when extract returns only whitespace', async () => {
    defaultBackendFetch();
    mockSingleShot.mockResolvedValueOnce('   \n  ');
    await run({ content: 'Original body.', mode: 'extract' });
    const body = (getPutCall()[3] as { content: string }).content;
    expect(body).toContain('Original body.');
  });

  it('STM-U4: stamps the entry with a ## <timestamp> header', async () => {
    defaultBackendFetch();
    await run({ content: 'Hello.' });
    const body = (getPutCall()[3] as { content: string }).content;
    expect(body).toMatch(/## 2026-04-21 14:32(?:\n|\s)/);
  });

  it('STM-U5: includes the topic in the header when provided', async () => {
    defaultBackendFetch();
    await run({ content: 'Hello.', topic: 'Daily standup' });
    const body = (getPutCall()[3] as { content: string }).content;
    expect(body).toContain('## 2026-04-21 14:32 — Daily standup');
  });

  it('STM-U6: targets the cerebro agent by default', async () => {
    defaultBackendFetch();
    await run({ content: 'Hello.' });
    const put = getPutCall();
    expect(put[2]).toBe('/agent-memory/cerebro/files/routines/2026-04-21.md');
  });

  it('STM-U7: honors an expert agent slug when provided', async () => {
    defaultBackendFetch();
    await run({ content: 'Hello.', agent: 'fitness-coach-ab12' });
    const put = getPutCall();
    expect(put[2]).toBe('/agent-memory/fitness-coach-ab12/files/routines/2026-04-21.md');
    const result = await run({ content: 'Again.', agent: 'fitness-coach-ab12' });
    expect(result.data.item_id).toBe('fitness-coach-ab12:routines/2026-04-21.md');
  });

  it('STM-U8: appends new entries to existing day file instead of overwriting', async () => {
    const existing =
      '# Routine notes — 2026-04-21\n\n## 2026-04-21 09:00\n\nEarlier entry.\n';
    mockBackendFetch.mockImplementation(async (_port, method, _path, body) => {
      if (method === 'GET') {
        return {
          path: 'routines/2026-04-21.md',
          content: existing,
          last_modified: '2026-04-21T09:00:00',
        };
      }
      if (method === 'PUT') {
        return { path: 'routines/2026-04-21.md', content: (body as { content: string }).content };
      }
      return {};
    });

    await run({ content: 'Later entry.' });
    const body = (getPutCall()[3] as { content: string }).content;
    expect(body).toContain('Earlier entry.');
    expect(body).toContain('Later entry.');
    expect(body.indexOf('Earlier entry.')).toBeLessThan(body.indexOf('Later entry.'));
  });

  it("STM-U9: creates a fresh file with an H1 header when the day's file doesn't exist yet", async () => {
    defaultBackendFetch();
    await run({ content: 'Fresh start.' });
    const body = (getPutCall()[3] as { content: string }).content;
    expect(body.startsWith('# Routine notes — 2026-04-21')).toBe(true);
  });

  it('STM-U10: throws and performs no write when content is empty or whitespace', async () => {
    defaultBackendFetch();
    await expect(run({ content: '' })).rejects.toThrow(/requires content/);
    await expect(run({ content: '   \n  ' })).rejects.toThrow(/requires content/);
    expect(mockBackendFetch).not.toHaveBeenCalled();
    expect(mockSingleShot).not.toHaveBeenCalled();
  });

  it('STM-U11: passes the extract model override through to singleShotClaudeCode', async () => {
    defaultBackendFetch();
    mockSingleShot.mockResolvedValueOnce('- distilled');
    await run({ content: 'text', mode: 'extract', model: 'claude-sonnet-4-6' });
    expect(mockSingleShot).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6' }),
    );
  });

  it('STM-U12: defaults to write mode when mode is unspecified or unknown', async () => {
    defaultBackendFetch();
    await run({ content: 'A' });
    await run({ content: 'B', mode: 'nonsense' as unknown as string });
    // Neither should invoke Claude (both are write-mode).
    expect(mockSingleShot).not.toHaveBeenCalled();
    const puts = mockBackendFetch.mock.calls.filter((c) => c[1] === 'PUT');
    expect(puts).toHaveLength(2);
  });

  it('STM-U13: propagates non-404 GET failures instead of clobbering the existing file', async () => {
    mockBackendFetch.mockImplementation(async (_port, method) => {
      if (method === 'GET') {
        const err = new Error('Backend error (500): boom') as Error & { status?: number };
        err.status = 500;
        throw err;
      }
      return {};
    });
    await expect(run({ content: 'text' })).rejects.toThrow(/500/);
    // Never attempt a PUT — a 500 on GET is ambiguous about file existence,
    // so we must not overwrite whatever was there.
    const puts = mockBackendFetch.mock.calls.filter((c) => c[1] === 'PUT');
    expect(puts).toHaveLength(0);
  });
});
