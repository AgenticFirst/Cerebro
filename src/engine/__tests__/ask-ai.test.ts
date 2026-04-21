import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

// ── Mock Claude Code one-shot ──────────────────────────────────
//
// The Ask AI action shells out to the Claude Code CLI via
// singleShotClaudeCode. We replace that with a recording stub so
// tests can assert on the final prompt/agent without spawning a
// real subprocess.

const claudeSpy = vi.fn<
  (opts: { agent: string; prompt: string; signal?: AbortSignal; maxTurns?: number }) => Promise<string>
>();

vi.mock('../../claude-code/single-shot', () => ({
  singleShotClaudeCode: (opts: Parameters<typeof claudeSpy>[0]) => claudeSpy(opts),
}));

// Import after the mock so the action binds to the stub.
const { askAiAction, modelCallAction } = await import('../actions/model-call');

// ── Test helpers ───────────────────────────────────────────────

function makeContext(): ActionContext {
  return {
    runId: 'test-run',
    stepId: 'test-step',
    backendPort: 9999,
    signal: new AbortController().signal,
    log: () => {},
    emitEvent: () => {},
    // Test-only property mirrored by other action suites. Not on the
    // type, but harmless extra field.
    resolveModel: async () => null,
  } as ActionContext;
}

async function runAskAi(
  params: Record<string, unknown>,
  wiredInputs: Record<string, unknown> = {},
) {
  return askAiAction.execute({
    params,
    wiredInputs,
    scratchpad: new RunScratchpad(),
    context: makeContext(),
  });
}

beforeEach(() => {
  claudeSpy.mockReset();
  claudeSpy.mockResolvedValue('OK');
});

// ── Registry identity ──────────────────────────────────────────

describe('askAiAction: registry shape', () => {
  it('registers under the canonical "ask_ai" type', () => {
    expect(askAiAction.type).toBe('ask_ai');
  });

  it('ships a legacy "model_call" alias pointing at the same behavior', () => {
    expect(modelCallAction.type).toBe('model_call');
    expect(modelCallAction.execute).toBe(askAiAction.execute);
  });
});

// ── Mustache templating against wiredInputs ────────────────────

describe('askAiAction: variable templating', () => {
  it('replaces {{variable}} in the prompt with upstream wiredInputs', async () => {
    await runAskAi(
      { prompt: 'Summarize:\n\n{{previous_output}}' },
      { previous_output: 'Raw article text here.' },
    );

    expect(claudeSpy).toHaveBeenCalledOnce();
    const call = claudeSpy.mock.calls[0][0];
    expect(call.prompt).toContain('Raw article text here.');
    expect(call.prompt).not.toContain('{{previous_output}}');
  });

  it('replaces {{variable}} in the system prompt and prepends it', async () => {
    await runAskAi(
      {
        prompt: 'Go!',
        system_prompt: 'You are {{persona}}.',
      },
      { persona: 'a terse analyst' },
    );

    const call = claudeSpy.mock.calls[0][0];
    expect(call.prompt.startsWith('You are a terse analyst.')).toBe(true);
    expect(call.prompt.endsWith('Go!')).toBe(true);
  });

  it('does not HTML-escape angle brackets or ampersands (output goes to an LLM, not a browser)', async () => {
    await runAskAi(
      { prompt: 'Respond with: {{snippet}}' },
      { snippet: '<b>bold & bright</b>' },
    );
    const call = claudeSpy.mock.calls[0][0];
    expect(call.prompt).toContain('<b>bold & bright</b>');
  });

  it('treats missing variables as empty strings rather than crashing', async () => {
    const out = await runAskAi(
      { prompt: 'Hello {{name}}, welcome.' },
      {},
    );
    const call = claudeSpy.mock.calls[0][0];
    expect(call.prompt).toBe('Hello , welcome.');
    expect(out.data.response).toBe('OK');
  });
});

// ── Subagent selection ─────────────────────────────────────────

describe('askAiAction: agent routing', () => {
  it('defaults to the "cerebro" subagent when no agent is specified', async () => {
    await runAskAi({ prompt: 'hi' });
    expect(claudeSpy.mock.calls[0][0].agent).toBe('cerebro');
  });

  it('honors a user-picked subagent', async () => {
    await runAskAi({ prompt: 'hi', agent: 'fitness-coach-ab12' });
    expect(claudeSpy.mock.calls[0][0].agent).toBe('fitness-coach-ab12');
  });

  it('falls back to "cerebro" when agent is blank / whitespace', async () => {
    await runAskAi({ prompt: 'hi', agent: '   ' });
    expect(claudeSpy.mock.calls[0][0].agent).toBe('cerebro');
  });
});

// ── Output shape ───────────────────────────────────────────────

describe('askAiAction: output', () => {
  it('returns the raw response under data.response', async () => {
    claudeSpy.mockResolvedValueOnce('The answer is 42.');
    const out = await runAskAi({ prompt: 'Compute.' });
    expect(out.data.response).toBe('The answer is 42.');
  });

  it('produces a short summary truncating at 80 chars', async () => {
    claudeSpy.mockResolvedValueOnce('x'.repeat(200));
    const out = await runAskAi({ prompt: 'Generate.' });
    expect(out.summary.startsWith('AI responded: ')).toBe(true);
    expect(out.summary.length).toBeLessThanOrEqual('AI responded: '.length + 80);
  });
});

// ── Guards ─────────────────────────────────────────────────────

describe('askAiAction: input guards', () => {
  it('throws a user-facing error when the prompt is empty', async () => {
    await expect(runAskAi({ prompt: '' })).rejects.toThrow(/prompt is empty/);
    expect(claudeSpy).not.toHaveBeenCalled();
  });

  it('throws when the rendered prompt becomes empty (all vars missing and no literal text)', async () => {
    await expect(
      runAskAi({ prompt: '{{not_there}}' }, {}),
    ).rejects.toThrow(/prompt is empty/);
  });
});
