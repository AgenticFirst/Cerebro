/**
 * E2E coverage for the Codex CLI engine integration.
 *
 * Connects over CDP to a running app (CEREBRO_E2E_DEBUG_PORT=9229 npm start),
 * like every other spec. Requires BOTH the `claude` and `codex` CLIs installed
 * and signed in on the host (the suite skips itself if Codex isn't available).
 *
 * What it proves end-to-end:
 *   1. Integrations → Engine shows both engine cards and an active-engine picker.
 *   2. Selecting Codex persists `selected_engine` and a real chat turn streams a
 *      reply — attributed to Codex via a fresh `logs/codex/<runId>.log` written
 *      by CodexRunner (ground truth: the codex subprocess actually spawned).
 *   3. A shell request under Codex renders a Bash tool-call card (the JSONL
 *      command_execution → tool_start/tool_end mapping works in the live UI).
 *   4. Switching the engine back to Claude Code keeps chat working (both engines
 *      coexist), attributed via a fresh `logs/claude-code/<runId>.log`.
 */

import { test, expect, type Browser, type Page } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  connectToApp,
  dismissModals,
  goToChat,
  lastAssistantMessage,
  waitForExpertReply,
  readLastMessageToolCalls,
  getSetting,
  snapshotConversationIds,
  deleteConversationsNotIn,
} from './helpers';

// app.setName('Cerebro') → userData = ~/Library/Application Support/Cerebro
const USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'Cerebro');
const CODEX_LOG_DIR = path.join(USER_DATA, 'logs', 'codex');
const CLAUDE_LOG_DIR = path.join(USER_DATA, 'logs', 'claude-code');

const REPLY_TIMEOUT = 180_000;

let browser: Browser;
let page: Page;
let preexistingConversations: Set<string>;

test.beforeAll(async () => {
  ({ browser, page } = await connectToApp());

  // CI-safety: skip the whole suite unless Codex is detected on the host.
  const codexAvailable = await page.evaluate(async () => {
    try {
      const info = await (window as unknown as {
        cerebro: { codex: { getStatus: () => Promise<{ status: string }> } };
      }).cerebro.codex.getStatus();
      return info?.status === 'available';
    } catch {
      return false;
    }
  });
  test.skip(!codexAvailable, 'Codex CLI not detected on host — skipping Codex engine e2e.');

  preexistingConversations = await snapshotConversationIds(page);
});

test.afterAll(async () => {
  if (!page) return;
  // Restore the default engine so we don't leave the app pinned to Codex.
  await selectEngine(page, 'claude-code').catch(() => {});
  await deleteConversationsNotIn(page, preexistingConversations).catch(() => {});
  await browser?.close();
});

// ── local helpers ────────────────────────────────────────────────

const ENGINE_LABELS = { 'claude-code': 'Claude Code', codex: 'Codex' } as const;
type EngineId = keyof typeof ENGINE_LABELS;

/** Navigate to Integrations → Engine (the default inner section). */
async function goToEngineSection(p: Page): Promise<void> {
  await dismissModals(p);
  await p.locator('nav button').filter({ hasText: /^Integrations$/ }).first().click({ force: true });
  await p.waitForSelector('h2:has-text("Engine")', { timeout: 8_000 });
}

/** The active-engine radio button for an engine (a <button> whose text is the
 *  engine label — distinct from the non-button card title). */
function engineRadio(p: Page, engine: EngineId) {
  const label = ENGINE_LABELS[engine];
  return p.locator('button').filter({ hasText: new RegExp(`^${label}$`) }).first();
}

/** Pick the active engine via the real EngineSection picker and confirm the
 *  `selected_engine` setting persisted. Uses the UI (not a raw setting write)
 *  so EngineContext's in-memory state updates without a reload race. */
async function selectEngine(p: Page, engine: EngineId): Promise<void> {
  await goToEngineSection(p);
  const radio = engineRadio(p, engine);
  await expect(radio).toBeEnabled({ timeout: 15_000 });
  await radio.click();
  await expect
    .poll(async () => getSetting<string>(p, 'selected_engine'), { timeout: 8_000 })
    .toBe(engine);
}

function listLogs(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.log')));
  } catch {
    return new Set();
  }
}

/** Poll a log dir until a `.log` file appears that wasn't in `before`. Returns
 *  the new filename, or null on timeout. Ground-truth proof a given engine's
 *  runner spawned its subprocess. */
async function waitForNewLog(dir: string, before: Set<string>, timeoutMs = REPLY_TIMEOUT): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of listLogs(dir)) {
      if (!before.has(f)) return f;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** Start a fresh conversation via the sidebar "New Chat" button, then land on
 *  the chat composer. */
async function startNewChat(p: Page): Promise<void> {
  await dismissModals(p);
  const newChat = p.locator('button[title="New Chat"]').first();
  if ((await newChat.count()) > 0) {
    await newChat.click({ force: true });
  } else {
    await goToChat(p);
  }
  await p.waitForSelector('textarea[placeholder*="message" i]', { timeout: 10_000 });
}

/** Send a message on the main Cerebro chat composer. */
async function sendChatMessage(p: Page, text: string): Promise<void> {
  const ta = p.locator('textarea[placeholder*="message" i]').last();
  await ta.click();
  await ta.fill(text);
  if (((await ta.inputValue()) || '').trim().length === 0) {
    await ta.pressSequentially(text, { delay: 10 });
  }
  await ta.press('Enter');
}

// ── tests ────────────────────────────────────────────────────────

test('Engine section shows both engines and the active-engine picker', async () => {
  await goToEngineSection(page);

  // Both engine cards render their titles.
  await expect(page.getByText('Claude Code', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Codex', { exact: true }).first()).toBeVisible();

  // Codex must be detected on this host (both CLIs installed for the suite),
  // so at least one "Detected" badge appears once detection settles.
  await expect
    .poll(async () => page.getByText('Detected').count(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);

  // Both picker radios exist.
  await expect(engineRadio(page, 'claude-code')).toBeVisible();
  await expect(engineRadio(page, 'codex')).toBeVisible();
});

test('selecting Codex routes a real chat turn through the codex subprocess', async () => {
  await selectEngine(page, 'codex');
  await startNewChat(page);

  const before = listLogs(CODEX_LOG_DIR);
  await sendChatMessage(page, 'Reply with exactly the single word PONG in uppercase and nothing else. Do not run any tools.');

  const reply = await waitForExpertReply(page, { timeoutMs: REPLY_TIMEOUT });
  expect(reply.toLowerCase()).toContain('pong');

  // Ground truth: CodexRunner wrote a fresh per-run log → codex actually ran.
  const newLog = await waitForNewLog(CODEX_LOG_DIR, before, 10_000);
  expect(newLog, 'expected a new logs/codex/<runId>.log from the Codex run').not.toBeNull();
});

test('Codex renders a Bash tool-call card for a shell request', async () => {
  await selectEngine(page, 'codex');
  await startNewChat(page);

  // Force a genuine shell invocation: the output of `date +%s%N` is unknowable,
  // so the model can't shortcut by guessing — it MUST run the command, which
  // produces a JSONL command_execution item → a Bash tool-call card in the UI.
  await sendChatMessage(
    page,
    'You MUST use your shell tool to run exactly this command: date +%s%N\n' +
      'Do not guess the value. After it runs, reply with the number it printed.',
  );

  const reply = await waitForExpertReply(page, { timeoutMs: REPLY_TIMEOUT });
  expect(reply.trim().length).toBeGreaterThan(0);

  // The JSONL command_execution item must surface as a Bash tool-call card —
  // proof the CodexRunner's tool mapping renders in the live chat UI.
  const toolCalls = await readLastMessageToolCalls(page);
  expect(
    toolCalls.some((tc) => tc.name === 'Bash'),
    `expected a Bash tool-call card; saw: [${toolCalls.map((t) => t.name).join(', ') || 'none'}]`,
  ).toBe(true);
});

test('switching back to Claude Code keeps chat working (both engines coexist)', async () => {
  await selectEngine(page, 'claude-code');
  await startNewChat(page);

  const before = listLogs(CLAUDE_LOG_DIR);
  await sendChatMessage(page, 'Reply with exactly the single word READY in uppercase and nothing else.');

  const reply = await waitForExpertReply(page, { timeoutMs: REPLY_TIMEOUT });
  expect(reply.toLowerCase()).toContain('ready');

  const newLog = await waitForNewLog(CLAUDE_LOG_DIR, before, 10_000);
  expect(newLog, 'expected a new logs/claude-code/<runId>.log from the Claude run').not.toBeNull();
});
