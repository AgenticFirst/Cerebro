import { describe, it, expect, vi } from 'vitest';
import { summarizeAction } from '../actions/summarize';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

vi.mock('../actions/utils/llm-call', () => ({
  streamModelCall: vi.fn(),
  resolveModelForAction: vi.fn().mockResolvedValue({
    source: 'cloud',
    provider: 'anthropic',
    modelId: 'claude-sonnet',
    displayName: 'Claude Sonnet',
  }),
  buildLLMRequestBody: vi.fn().mockReturnValue({
    path: '/cloud/chat',
    body: { messages: [], stream: true },
  }),
}));

import { streamModelCall } from '../actions/utils/llm-call';

function makeContext(): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: 9999,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    resolveModel: vi.fn(),
  };
}

describe('summarizeAction', () => {
  it('summarizes text and returns lengths', async () => {
    vi.mocked(streamModelCall).mockResolvedValue('This is a summary.');

    const result = await summarizeAction.execute({
      params: {
        input_field: 'text',
        max_length: 'short',
      },
      wiredInputs: { text: 'A very long text that needs summarizing...' },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(result.data.summary).toBe('This is a summary.');
    expect(result.data.original_length).toBe(42);
    expect(result.summary).toContain('42 chars');
  });

  it('throws when input field is empty', async () => {
    await expect(
      summarizeAction.execute({
        params: { input_field: 'text', max_length: 'medium' },
        wiredInputs: { text: '' },
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('empty or not a string');
  });

  it('throws when input field does not exist', async () => {
    await expect(
      summarizeAction.execute({
        params: { input_field: 'missing', max_length: 'medium' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('empty or not a string');
  });
});
