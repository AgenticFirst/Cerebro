/** Regression for the bug where every new conversation surfaced
 *
 *   "Error: Claude Code session not found — restoring from conversation history."
 *
 * The renderer included the just-typed user message in `recentMessages`, so
 * AgentRuntime read `length > 0` as "has prior turns" and spawned the very
 * first turn with `--resume <uuid>` — against a session that did not yet
 * exist on disk. The runtime's transparent recovery DID fire, but the error
 * event reached the renderer first, which unsubscribed and pinned the
 * error string as the assistant message.
 *
 * This spec verifies both layers of the fix:
 *  - The spawn for the first turn uses `--session-id`, not `--resume`.
 *  - Even if `session_missing` ever fires (e.g. data-dir wipe), the error
 *    text does NOT surface in the chat as the assistant reply.
 *
 * Requires Cerebro running with CDP:  CEREBRO_E2E_DEBUG_PORT=9229 npm start
 */

import { test, expect, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { connectToApp, dismissModals } from './helpers';

const SESSION_MISSING_ERROR = /Claude Code session not found/i;
// Raw CLI fingerprints that must NEVER reach the chat UI — Cerebro mimics
// Claude Code, which never shows the user a CLI error. The session-recovery
// and idle-retry paths rewrite all of these to friendly, recoverable copy.
const RAW_CLI_ERROR = /Session ID .* is already in use|produced no output for \d+ seconds|Claude Code error \(code/i;

// Cerebro's userData dir on macOS dev.
const CLAUDE_CODE_LOG_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Cerebro',
  'logs',
  'claude-code',
);

let browser: Browser;
let page: Page;

// Locale-tolerant selectors. The chat nav label is the brand "Cerebro" in
// every locale; the New Chat button and textarea placeholder are translated
// (EN: "New Chat" / "Send a message…", ES: "Nuevo chat" / "Escribe un mensaje…").
const CHAT_INPUT = 'textarea[placeholder*="message" i], textarea[placeholder*="mensaje" i]';

async function goToChat(page: Page): Promise<void> {
  await dismissModals(page);
  const chatBtn = page.locator('nav button').filter({ hasText: /^Cerebro$/ }).first();
  await chatBtn.click({ force: true });
  await page.waitForSelector(CHAT_INPUT, { timeout: 10_000 });
}

async function startNewChat(page: Page): Promise<void> {
  const newChatBtn = page.locator('button').filter({ hasText: /New[- ]?Chat|Nuevo[- ]?chat/i }).first();
  if ((await newChatBtn.count()) > 0) {
    await newChatBtn.click({ force: true }).catch(() => {});
  }
}

async function sendChatMessage(page: Page, text: string): Promise<void> {
  const ta = page.locator(CHAT_INPUT).first();
  await ta.click();
  await ta.fill(text);
  await ta.press('Enter');
}

/** Snapshot the set of claude-code log files BEFORE the test send so we can
 *  identify the new one our send produced. */
function snapshotLogFiles(): Set<string> {
  if (!fs.existsSync(CLAUDE_CODE_LOG_DIR)) return new Set();
  return new Set(fs.readdirSync(CLAUDE_CODE_LOG_DIR).filter((n) => n.endsWith('.log')));
}

async function waitForNewLogFile(before: Set<string>, timeoutMs = 30_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(CLAUDE_CODE_LOG_DIR)) {
      const after = fs.readdirSync(CLAUDE_CODE_LOG_DIR).filter((n) => n.endsWith('.log'));
      const fresh = after.find((n) => !before.has(n));
      if (fresh) return path.join(CLAUDE_CODE_LOG_DIR, fresh);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

test.beforeAll(async () => {
  ({ browser, page } = await connectToApp());
});

test.afterAll(async () => {
  await browser?.close();
});

test('new conversation: first turn spawns with --session-id, not --resume', async () => {
  const before = snapshotLogFiles();

  await goToChat(page);
  await startNewChat(page);
  // Trivial prompt; we don't care about the response — we only inspect the
  // spawn line in the per-run log file the runner writes synchronously.
  await sendChatMessage(page, 'hola');

  const logPath = await waitForNewLogFile(before, 20_000);
  expect(logPath, 'A new claude-code log file should appear within 20s of sending').not.toBeNull();

  const startLine = fs.readFileSync(logPath as string, 'utf-8').split('\n')[0] ?? '';
  expect(startLine, `spawn line:\n${startLine}`).toContain('--session-id');
  expect(startLine, `spawn line should NOT use --resume on the first turn:\n${startLine}`)
    .not.toContain('--resume');
});

test('new conversation: assistant message never shows the session_missing error string', async () => {
  await goToChat(page);
  await startNewChat(page);
  await sendChatMessage(page, 'di hola en una palabra');

  // Poll briefly — even a fast Claude Code reply takes a few seconds; an
  // error would appear within ~1s of the spawn failing.
  const deadline = Date.now() + 25_000;
  let seenError = false;
  while (Date.now() < deadline) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (SESSION_MISSING_ERROR.test(bodyText)) {
      seenError = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  expect(seenError, 'session_missing error must never reach the chat UI').toBe(false);
});

test('chat UI never surfaces a raw Claude Code CLI error string', async () => {
  // Sibling guard for the session_in_use / idle_hang recovery paths: whatever
  // the CLI throws under the hood ("Session ID … is already in use", "produced
  // no output for 90 seconds", "Claude Code error (code 1)"), the user must
  // only ever see friendly, recoverable copy — never the raw string.
  await goToChat(page);
  await startNewChat(page);
  await sendChatMessage(page, 'di hola en una palabra');

  const deadline = Date.now() + 25_000;
  let leaked = '';
  while (Date.now() < deadline) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const m = bodyText.match(RAW_CLI_ERROR);
    if (m) { leaked = m[0]; break; }
    await page.waitForTimeout(500);
  }
  expect(leaked, `a raw CLI error string leaked into the chat UI: "${leaked}"`).toBe('');
});
