import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import { modelCallAction } from '../actions/model-call';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

// ── Mock SSE server ─────────────────────────────────────────────

let server: http.Server;
let serverPort: number;

/**
 * Configurable SSE response. Tests set this before each call.
 * Each entry becomes a `data: {...}\n\n` SSE line.
 */
let sseEvents: Array<Record<string, unknown>> = [];
let lastRequestBody: Record<string, unknown> | null = null;
let lastRequestPath: string | null = null;
let respondWithStatus = 200;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastRequestPath = req.url ?? null;

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { lastRequestBody = JSON.parse(body); } catch { lastRequestBody = null; }

      if (respondWithStatus >= 400) {
        res.writeHead(respondWithStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: `Error ${respondWithStatus}` }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      for (const event of sseEvents) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      serverPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  sseEvents = [];
  lastRequestBody = null;
  lastRequestPath = null;
  respondWithStatus = 200;
});

// ── Helpers ─────────────────────────────────────────────────────

function makeContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    runId: 'test-run',
    stepId: 'test-step',
    backendPort: serverPort,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    resolveModel: async () => ({
      source: 'cloud' as const,
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      displayName: 'Claude Sonnet',
    }),
    ...overrides,
  };
}

function execute(
  params: Record<string, unknown>,
  contextOverrides: Partial<ActionContext> = {},
) {
  const context = makeContext(contextOverrides);
  return modelCallAction.execute({
    params,
    wiredInputs: {},
    scratchpad: new RunScratchpad(),
    context,
  });
}

// ── Tests ───────────────────────────────────────────────────────

describe('model_call action', () => {
  it('collects streamed tokens into a single response', async () => {
    sseEvents = [
      { token: 'Hello' },
      { token: ' world' },
      { token: '!' },
      { done: true },
    ];

    const output = await execute({ prompt: 'Say hello' });
    expect(output.data.response).toBe('Hello world!');
  });

  it('routes cloud models to /cloud/chat with provider and model', async () => {
    sseEvents = [{ token: 'ok' }, { done: true }];

    await execute({ prompt: 'test' });

    expect(lastRequestPath).toBe('/cloud/chat');
    expect(lastRequestBody).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      stream: true,
    });
  });

  it('routes local models to /models/chat without provider/model fields', async () => {
    sseEvents = [{ token: 'ok' }, { done: true }];

    await execute({ prompt: 'test' }, {
      resolveModel: async () => ({
        source: 'local' as const,
        modelId: 'gemma-3-4b',
        displayName: 'Gemma 3 4B',
      }),
    });

    expect(lastRequestPath).toBe('/models/chat');
    expect(lastRequestBody).not.toHaveProperty('provider');
    expect(lastRequestBody).not.toHaveProperty('model');
  });

  it('includes system prompt in messages when provided', async () => {
    sseEvents = [{ token: 'ok' }, { done: true }];

    await execute({ prompt: 'Do the thing', systemPrompt: 'You are helpful' });

    const messages = (lastRequestBody as any).messages;
    expect(messages[0]).toEqual({ role: 'system', content: 'You are helpful' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Do the thing' });
  });

  it('sends only user message when no system prompt', async () => {
    sseEvents = [{ token: 'ok' }, { done: true }];

    await execute({ prompt: 'Just this' });

    const messages = (lastRequestBody as any).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: 'user', content: 'Just this' });
  });

  it('calls context.log for each streamed chunk', async () => {
    sseEvents = [
      { token: 'chunk1' },
      { token: 'chunk2' },
      { done: true },
    ];

    const log = vi.fn();
    await execute({ prompt: 'test' }, { log });

    expect(log).toHaveBeenCalledWith('chunk1');
    expect(log).toHaveBeenCalledWith('chunk2');
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('throws when no model is available', async () => {
    await expect(
      execute({ prompt: 'test' }, { resolveModel: async () => null }),
    ).rejects.toThrow('No model available');
  });

  it('throws on backend HTTP error with detail message', async () => {
    respondWithStatus = 500;

    await expect(
      execute({ prompt: 'test' }),
    ).rejects.toThrow('Error 500');
  });

  it('throws on backend stream error (finish_reason: error)', async () => {
    sseEvents = [
      { token: 'partial' },
      { done: true, finish_reason: 'error', usage: { error: 'Rate limit exceeded' } },
    ];

    await expect(
      execute({ prompt: 'test' }),
    ).rejects.toThrow('Rate limit exceeded');
  });

  it('rejects immediately if signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      execute({ prompt: 'test' }, { signal: controller.signal }),
    ).rejects.toThrow('Aborted');
  });

  it('passes custom temperature and maxTokens to backend', async () => {
    sseEvents = [{ token: 'ok' }, { done: true }];

    await execute({ prompt: 'test', temperature: 0.2, maxTokens: 100 });

    expect(lastRequestBody).toMatchObject({
      temperature: 0.2,
      max_tokens: 100,
    });
  });

  it('uses default temperature 0.7 and maxTokens 4096', async () => {
    sseEvents = [{ token: 'ok' }, { done: true }];

    await execute({ prompt: 'test' });

    expect(lastRequestBody).toMatchObject({
      temperature: 0.7,
      max_tokens: 4096,
    });
  });

  it('truncates summary at 80 chars', async () => {
    const longToken = 'a'.repeat(100);
    sseEvents = [{ token: longToken }, { done: true }];

    const output = await execute({ prompt: 'test' });
    expect(output.summary.length).toBeLessThanOrEqual('Model responded: '.length + 80);
    expect(output.summary).toContain('...');
  });
});
