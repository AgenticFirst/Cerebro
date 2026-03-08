import { describe, it, expect, vi } from 'vitest';
import { classifyAction } from '../actions/classify';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

// Mock the llm-call module
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

function makeContext(overrides?: Partial<ActionContext>): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: 9999,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    resolveModel: vi.fn(),
    ...overrides,
  };
}

describe('classifyAction', () => {
  it('parses a valid JSON response', async () => {
    vi.mocked(streamModelCall).mockResolvedValue(
      '{"category": "bug", "confidence": "high", "reasoning": "Describes a defect"}'
    );

    const result = await classifyAction.execute({
      params: {
        prompt: 'The login button is broken',
        categories: [
          { label: 'bug', description: 'Software defect' },
          { label: 'feature', description: 'Feature request' },
        ],
      },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(result.data.category).toBe('bug');
    expect(result.data.confidence).toBe('high');
    expect(result.data.reasoning).toBe('Describes a defect');
  });

  it('falls back to text matching on invalid JSON', async () => {
    vi.mocked(streamModelCall).mockResolvedValue(
      'Based on the input, this is clearly a bug report.'
    );

    const result = await classifyAction.execute({
      params: {
        prompt: 'The app crashes on startup',
        categories: [
          { label: 'bug', description: 'Software defect' },
          { label: 'feature', description: 'Feature request' },
        ],
      },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(result.data.category).toBe('bug');
    expect(result.data.confidence).toBe('low');
  });

  it('throws when no categories provided', async () => {
    await expect(
      classifyAction.execute({
        params: { prompt: 'test', categories: [] },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('at least one category');
  });
});
