/**
 * save_to_memory action — appends a timestamped entry to an agent's
 * memory directory (`<userData>/agent-memory/<agent>/routines/<date>.md`).
 *
 * "Global" memory is the `cerebro` subagent's directory. Picking an expert
 * writes under that expert's slug instead.
 *
 * Modes:
 *   - "write"   : persist the content verbatim (plus a timestamp header)
 *   - "extract" : first have Claude Code distill the content into a
 *                 bulleted fact list, then persist that
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { backendFetch } from './utils/backend-fetch';
import { singleShotClaudeCode } from '../../claude-code/single-shot';

interface SaveToMemoryParams {
  content: string;
  agent?: string;
  mode?: 'write' | 'extract';
  topic?: string;
  model?: string;
}

interface AgentMemoryFileContent {
  path: string;
  content: string;
  last_modified: string;
}

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function readExistingFile(
  port: number,
  agent: string,
  relPath: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const res = await backendFetch<AgentMemoryFileContent>(
      port,
      'GET',
      `/agent-memory/${encodeURIComponent(agent)}/files/${relPath.split('/').map(encodeURIComponent).join('/')}`,
      null,
      signal,
    );
    return typeof res.content === 'string' ? res.content : null;
  } catch (err) {
    // Only 404 means "no prior entry today, start fresh". Any other failure
    // (500, auth, network) must propagate — silently falling back to "new
    // file" would overwrite today's existing entries.
    const status = (err as { status?: number } | null)?.status;
    if (status === 404) return null;
    throw err;
  }
}

async function extractFacts(
  content: string,
  model: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const prompt = [
    'Distill the text below into a concise bulleted list of standalone facts.',
    '- One fact per bullet; drop opinions, filler, and duplicates.',
    '- Keep names, numbers, and dates exact.',
    '- Respond with the bullet list only — no preamble, no code fences.',
    '- Do NOT read any files, do NOT consult memory — work only from the text given here.',
    '',
    'TEXT:',
    content,
  ].join('\n');

  const raw = await singleShotClaudeCode({
    agent: 'cerebro',
    prompt,
    signal,
    // Pure text transformation — tools are disabled, so 1 turn should suffice;
    // keep a tiny cushion for retry on malformed response.
    maxTurns: 2,
    model: model?.trim() || undefined,
    // `Task` isn't a Claude Code tool the subagent can invoke — passing it
    // effectively disables all tool use, forcing the model to answer directly
    // instead of burning turns reading memory before distilling.
    allowedTools: 'Task',
  });

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    console.warn('[save_to_memory] extract returned empty string, falling back to raw content');
    return content.trim();
  }
  return trimmed;
}

export const saveToMemoryAction: ActionDefinition = {
  type: 'save_to_memory',
  name: 'Save to Memory',
  description: "Append an entry to an expert's or global memory.",

  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string' },
      agent: { type: 'string' },
      mode: { type: 'string', enum: ['write', 'extract'] },
      topic: { type: 'string' },
      model: { type: 'string' },
    },
    required: ['content'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      saved: { type: 'boolean' },
      item_id: { type: 'string' },
    },
    required: ['saved'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as SaveToMemoryParams;
    const { context } = input;

    const content = (params.content ?? '').trim();
    if (!content) {
      throw new Error('Save to memory requires content');
    }

    const agent = (params.agent && params.agent.trim()) || 'cerebro';
    const mode = params.mode === 'extract' ? 'extract' : 'write';
    const topic = params.topic?.trim() ?? '';

    const now = new Date();
    const date = formatDate(now);
    const ts = formatTimestamp(now);
    const relPath = `routines/${date}.md`;

    // Kick the existing-file GET off in parallel with extract — the two are
    // independent, and extract is the slow leg (multi-second Claude call).
    const existingPromise = readExistingFile(
      context.backendPort,
      agent,
      relPath,
      context.signal,
    );

    const body = mode === 'extract'
      ? await extractFacts(content, params.model, context.signal)
      : content;

    const header = topic ? `## ${ts} — ${topic}` : `## ${ts}`;
    const entry = `${header}\n\n${body}\n`;

    const existing = await existingPromise;

    const nextContent = existing && existing.trim().length > 0
      ? `${existing.replace(/\s+$/, '')}\n\n${entry}`
      : `# Routine notes — ${date}\n\n${entry}`;

    await backendFetch<AgentMemoryFileContent>(
      context.backendPort,
      'PUT',
      `/agent-memory/${encodeURIComponent(agent)}/files/${relPath.split('/').map(encodeURIComponent).join('/')}`,
      { content: nextContent },
      context.signal,
    );

    const preview = body.length > 50 ? body.slice(0, 50) + '...' : body;
    context.log(`Saved to ${agent}/${relPath}: ${preview}`);

    return {
      data: {
        saved: true,
        item_id: `${agent}:${relPath}`,
      },
      summary: `Saved to ${agent === 'cerebro' ? 'global' : agent} memory (${date})`,
    };
  },
};
