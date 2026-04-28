/**
 * Live end-to-end tests for the propose-routine pipeline.
 *
 * Each test uses **claude-haiku-4-5** (via the Claude Code CLI) to draft a
 * routine JSON for a natural-language request, then feeds the draft through
 * `ExecutionEngine.dryRunRoutine` to verify:
 *
 *   1. Haiku produces structurally valid routine JSON given a focused prompt
 *      that mirrors what the propose-routine skill teaches
 *   2. The dry-run engine accepts the LLM output and exercises every step
 *   3. Side-effecty actions (HubSpot, Telegram, WhatsApp, send_*) are
 *      stubbed correctly so the dry-run doesn't actually call out
 *   4. The same flow works in English AND Spanish
 *
 * These are LIVE tests — they spawn the real `claude` binary and burn
 * tokens. They're skipped unless:
 *
 *   CEREBRO_LIVE_TESTS=1            opt-in flag
 *   CEREBRO_DATA_DIR (optional)     path to the Cerebro userData with
 *                                   .claude/agents/cerebro.md installed
 *
 * Run with:
 *
 *   CEREBRO_LIVE_TESTS=1 npm run test:frontend -- src/routine-templates/__tests__/propose-routine.live.test.ts
 */

import http from 'node:http';
import EventEmitter from 'node:events';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ExecutionEngine } from '../../engine/engine';
import type { DAGDefinition } from '../../engine/dag/types';
import { setClaudeCodeCwd, singleShotClaudeCode } from '../../claude-code/single-shot';
import { detectClaudeCode } from '../../claude-code/detector';

// ── Preconditions ────────────────────────────────────────────────

const LIVE_OPT_IN = process.env.CEREBRO_LIVE_TESTS === '1';

function defaultCerebroDataDir(): string {
  if (platform() === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'Cerebro');
  }
  if (platform() === 'win32') {
    return path.join(process.env.APPDATA ?? '', 'Cerebro');
  }
  return path.join(homedir(), '.config', 'Cerebro');
}
const DATA_DIR = process.env.CEREBRO_DATA_DIR ?? defaultCerebroDataDir();
const HAS_CEREBRO_AGENT = existsSync(path.join(DATA_DIR, '.claude', 'agents', 'cerebro.md'));

const READY = LIVE_OPT_IN && HAS_CEREBRO_AGENT;
const d = READY ? describe : describe.skip;

// ── Mock backend (engine persistence calls go nowhere) ───────────

let mockServer: http.Server;
let serverPort: number;

beforeAll(async () => {
  if (READY) {
    setClaudeCodeCwd(DATA_DIR);
    await detectClaudeCode();
  }
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => {
    mockServer.listen(0, '127.0.0.1', () => {
      serverPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
});

// ── Helpers ─────────────────────────────────────────────────────

function makeMockWebContents() {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
    ipc: { on: vi.fn(), removeListener: vi.fn() },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeMockRuntime() {
  return {
    startRun: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeEngine(): ExecutionEngine {
  return new ExecutionEngine(serverPort, makeMockRuntime(), new EventEmitter());
}

/**
 * Self-contained prompt that teaches Haiku how to draft a Cerebro routine.
 * Distilled from the propose-routine skill so we can call Haiku directly
 * without going through the full Claude Code subagent flow (which would
 * also spawn Bash and contact our HTTP bridge — not what we're testing).
 */
const ROUTINE_DRAFTING_PROMPT = `You are a routine drafter for Cerebro, a personal AI assistant. The user describes recurring or triggered work in natural language and you produce a routine as JSON.

OUTPUT FORMAT — return ONLY a single JSON object on one line, no commentary, no code fences. The shape is:

{
  "name": "<short title, 3-8 words>",
  "description": "<one-sentence description>",
  "trigger_type": "manual" | "cron" | "telegram_message" | "whatsapp_message" | "webhook",
  "cron_expression": "<5-field cron, REQUIRED when trigger_type=cron, otherwise null>",
  "plain_english_steps": ["step 1 description", "step 2 description", ...],
  "dag": {
    "steps": [
      {
        "id": "<unique stable id>",
        "name": "<human-readable label>",
        "actionType": "<one of the action types below>",
        "params": { "<per-action params>" },
        "dependsOn": ["<id of upstream step>", ...],
        "inputMappings": [{ "sourceStepId": "<id>", "sourceField": "<field name>", "targetField": "<param name>" }],
        "requiresApproval": false,
        "onError": "fail"
      }
    ]
  }
}

ACTION TYPES (use the type strings exactly):

  ai:        ask_ai, classify, extract, summarize, run_expert
  knowledge: search_memory, search_web, search_documents, save_to_memory
  output:    send_message, send_notification, send_telegram_message, send_whatsapp_message
  hubspot:   hubspot_create_ticket, hubspot_upsert_contact
  http:      http_request
  logic:     condition, loop, delay, approval_gate

REQUIRED PARAMS PER ACTION (must be present in params):

  ask_ai: { prompt: string, agent: "cerebro" }
  classify: { prompt: string, categories: string[] }
  summarize: { input_field: string }
  search_memory: { query: string }
  search_web: { query: string }
  send_notification: { title: string, body: string }
  send_telegram_message: { chat_id: string, message: string }
  send_whatsapp_message: { phone_number: string, message: string }
  hubspot_create_ticket: { subject: string, content: string }
  hubspot_upsert_contact: { email or phone: string }
  http_request: { method: string, url: string }
  delay: { duration: number, unit: "seconds"|"minutes"|"hours" }
  approval_gate: { summary: string }

WIRING — to read an upstream step's output in a downstream param, use a Mustache template like \`{{my_field}}\` AND add an entry to inputMappings: { sourceStepId, sourceField (the upstream output field), targetField (the variable name in the template) }.

For triggered routines, the inbound payload is exposed as a synthetic step with id "__trigger__". For Telegram triggers it has fields { chat_id, text }. For WhatsApp triggers { phone_number, text }.

For any step that creates/sends something visible to other people (Telegram, WhatsApp, HubSpot, send_notification), set requiresApproval: true.

USER REQUEST:
{{REQUEST}}

Return JSON now. No commentary.`;

function buildPrompt(request: string): string {
  return ROUTINE_DRAFTING_PROMPT.replace('{{REQUEST}}', request);
}

interface DraftedRoutine {
  name: string;
  description: string;
  trigger_type: string;
  cron_expression: string | null;
  plain_english_steps: string[];
  dag: DAGDefinition;
}

/**
 * Strips code fences and leading/trailing prose, then JSON-parses. Haiku
 * is good but not perfect at "ONLY JSON" — keep this forgiving so the test
 * doesn't flake on the model's prelude. Throws with a useful diagnostic
 * if no JSON object is recoverable.
 */
function parseDraft(raw: string): DraftedRoutine {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  // Find the outermost JSON object.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) {
    throw new Error(`Haiku did not return JSON. First 200 chars: ${text.slice(0, 200)}`);
  }
  const json = text.slice(start, end + 1);
  try {
    return JSON.parse(json) as DraftedRoutine;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`JSON parse failed (${msg}). Body: ${json.slice(0, 400)}`);
  }
}

/**
 * Calls Haiku with the routine-drafting prompt and returns the parsed
 * candidate. Allows up to two attempts because Haiku occasionally wraps
 * the JSON in prose despite "ONLY JSON" instructions.
 */
async function draftRoutineWithHaiku(request: string): Promise<DraftedRoutine> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await singleShotClaudeCode({
      agent: 'cerebro',
      prompt: buildPrompt(request),
      model: 'claude-haiku-4-5',
      maxTurns: 1,
    });
    try {
      return parseDraft(out);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ── Tests ────────────────────────────────────────────────────────

d('propose-routine — Haiku drafts and dry-run validates', () => {
  const TIMEOUT = 180_000; // 3 minutes per case (LLM + executor)

  it(
    'cron routine: every Monday at 9am, summarize memory and notify',
    async () => {
      const draft = await draftRoutineWithHaiku(
        'Every Monday at 9am, search my memory for "open projects", summarize what you find, and show me a desktop notification with the summary.',
      );

      // Structural assertions on the draft itself.
      expect(draft.trigger_type).toBe('cron');
      expect(draft.cron_expression).toMatch(/\S/);
      expect(draft.dag.steps.length).toBeGreaterThanOrEqual(2);
      const types = draft.dag.steps.map((s) => s.actionType);
      expect(types).toContain('send_notification');

      const result = await makeEngine().dryRunRoutine(makeMockWebContents(), { dag: draft.dag });
      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.steps.every((s) => s.status === 'completed' || s.status === 'skipped')).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'telegram-trigger routine: classify inbound message and reply',
    async () => {
      const draft = await draftRoutineWithHaiku(
        'When a Telegram message arrives, classify whether it\'s a question or a complaint. If it\'s a complaint, send a reply on Telegram saying "We\'re on it" to the same chat.',
      );

      expect(draft.trigger_type).toBe('telegram_message');
      const types = draft.dag.steps.map((s) => s.actionType);
      expect(types).toContain('classify');
      expect(types).toContain('send_telegram_message');

      const result = await makeEngine().dryRunRoutine(makeMockWebContents(), {
        dag: draft.dag,
        triggerPayload: { chat_id: '5551234', text: 'My order is broken!' },
      });
      expect(result.ok).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'spanish request: drafts a routine and dry-run passes',
    async () => {
      const draft = await draftRoutineWithHaiku(
        'Cada lunes a las 9 de la mañana, busca en mi memoria los temas pendientes, resúmelos y mándame una notificación de escritorio.',
      );

      expect(draft.trigger_type).toBe('cron');
      expect(draft.dag.steps.length).toBeGreaterThanOrEqual(2);

      const result = await makeEngine().dryRunRoutine(makeMockWebContents(), { dag: draft.dag });
      expect(result.ok).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'whatsapp-trigger routine: HubSpot ticket on complaint',
    async () => {
      const draft = await draftRoutineWithHaiku(
        'When a WhatsApp message arrives, decide if it\'s a complaint. If yes, create a HubSpot ticket with the message body as the description, and reply on WhatsApp letting them know we got it.',
      );

      expect(draft.trigger_type).toBe('whatsapp_message');
      const types = draft.dag.steps.map((s) => s.actionType);
      expect(types).toContain('hubspot_create_ticket');

      const result = await makeEngine().dryRunRoutine(makeMockWebContents(), {
        dag: draft.dag,
        triggerPayload: { phone_number: '+15551234567', text: 'My order is missing!' },
      });
      // The dry-run should pass — HubSpot ticket and WhatsApp send are
      // both stubbed. If Haiku produced a wired-up routine the ok flag is
      // true; if the wiring is broken we still want to see the diagnostic.
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.error('Failing routine:', JSON.stringify(draft, null, 2));
        // eslint-disable-next-line no-console
        console.error('Step results:', JSON.stringify(result.steps, null, 2));
      }
      expect(result.ok).toBe(true);
    },
    TIMEOUT,
  );
});
