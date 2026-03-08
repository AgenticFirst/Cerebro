import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { searchWebAction } from '../actions/search-web';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/search' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          results: [
            { title: 'Result 1', url: 'https://example.com/1', content: 'First result', score: 0.9 },
            { title: 'Result 2', url: 'https://example.com/2', content: 'Second result', score: 0.8 },
          ],
          answer: 'AI answer summary',
        }));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      port = (server.address() as any).port;
      resolve();
    });
  });
});

afterAll(() => server.close());

function makeContext(): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: port,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    resolveModel: vi.fn(),
  };
}

describe('searchWebAction', () => {
  it('transforms Tavily response correctly', async () => {
    const result = await searchWebAction.execute({
      params: { query: 'test query', max_results: 5 },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    const results = result.data.results as Array<{ title: string; url: string; snippet: string }>;
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Result 1');
    expect(results[0].url).toBe('https://example.com/1');
    expect(results[0].snippet).toBe('First result');
    expect(result.data.ai_answer).toBe('AI answer summary');
  });

  it('throws when query is missing', async () => {
    await expect(
      searchWebAction.execute({
        params: { query: '' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('requires a query');
  });
});
