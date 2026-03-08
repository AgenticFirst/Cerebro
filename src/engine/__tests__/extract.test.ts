import { describe, it, expect, vi } from 'vitest';
import { extractAction } from '../actions/extract';
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

describe('extractAction', () => {
  it('parses extracted fields from JSON response', async () => {
    vi.mocked(streamModelCall).mockResolvedValue(
      '{"name": "John Doe", "email": "john@example.com", "age": 30}'
    );

    const result = await extractAction.execute({
      params: {
        prompt: 'Name: John Doe, Email: john@example.com, Age: 30',
        schema: [
          { name: 'name', type: 'string', description: 'Full name' },
          { name: 'email', type: 'string', description: 'Email address' },
          { name: 'age', type: 'number', description: 'Age in years' },
        ],
      },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(result.data.name).toBe('John Doe');
    expect(result.data.email).toBe('john@example.com');
    expect(result.data.age).toBe(30);
    expect(result.summary).toMatch(/3\/3 fields/);
  });

  it('throws when schema is empty', async () => {
    await expect(
      extractAction.execute({
        params: { prompt: 'test', schema: [] },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('at least one field');
  });

  it('throws on invalid JSON response', async () => {
    vi.mocked(streamModelCall).mockResolvedValue('This is not JSON at all');

    await expect(
      extractAction.execute({
        params: {
          prompt: 'test',
          schema: [{ name: 'field', type: 'string', description: 'A field' }],
        },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('Failed to parse');
  });
});
