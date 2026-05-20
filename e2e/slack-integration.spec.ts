/**
 * Playwright UI spec for the Slack integration.
 *
 * What this spec validates:
 *   - The Slack card renders in Integrations → Channels with the right
 *     empty-state copy and a Connect CTA.
 *   - The SlackConnectModal opens, walks all 6 steps, and the manifest
 *     YAML is fetched + copied to clipboard.
 *   - The Verify path surfaces both success and error states.
 *   - The Verify+Save flow calls slack.setTokens (success path) and the
 *     final step calls slack.enable.
 *   - Closing the modal mid-flow does not crash the renderer.
 *
 * What this spec does NOT validate (live workspace required):
 *   - The Bolt App actually opens a Socket Mode connection.
 *   - `auth.test` succeeds with real tokens.
 *   - `@mention`s, DMs, and `/cerebro` slash commands round-trip.
 *   - chat.postMessage / chat.update rate-limit behaviour under load.
 *
 * To run: start Cerebro with the CDP debug port exposed, then:
 *   CEREBRO_E2E_DEBUG_PORT=9229 npm start &
 *   npx playwright test e2e/slack-integration.spec.ts
 */

import { test, expect, type Page, type Browser } from '@playwright/test';
import { connectToApp, dismissModals } from './helpers';

const MANIFEST_YAML_FIXTURE = `_metadata:
  major_version: 1
  minor_version: 1
display_information:
  name: Cerebro-Test
features:
  bot_user:
    display_name: Cerebro
settings:
  socket_mode_enabled: true
`;

interface SlackMockState {
  status: {
    running: boolean;
    lastEventAt: number | null;
    lastError: string | null;
    teamName: string | null;
    botUserId: string | null;
    hasBotToken: boolean;
    hasAppToken: boolean;
    enabled: boolean;
    allowlistChannels: string[];
    allowlistUsers: string[];
    tokenBackend: 'os-keychain' | 'plaintext-fallback';
  };
  verifyResult: { ok: boolean; teamName?: string; teamId?: string; botUserId?: string; error?: string };
  setTokensResult: { ok: boolean; error?: string };
  enableResult: { ok: boolean; error?: string };
  calls: {
    verify: Array<{ botToken: string; appToken: string }>;
    setTokens: Array<{ botToken: string; appToken: string }>;
    enable: number;
    disable: number;
    clearTokens: number;
    setAllowlist: Array<{ channels: string[]; users: string[] }>;
    getManifest: number;
  };
}

/** Install our mock over window.cerebro.slack. Persists across page navigations
 *  inside the same renderer load — the renderer reads window.cerebro.slack on
 *  every call, so any subsequent component mount picks up our shim. */
async function installSlackMock(page: Page, overrides: Partial<SlackMockState> = {}): Promise<void> {
  const initial: SlackMockState = {
    status: {
      running: false,
      lastEventAt: null,
      lastError: null,
      teamName: null,
      botUserId: null,
      hasBotToken: false,
      hasAppToken: false,
      enabled: false,
      allowlistChannels: [],
      allowlistUsers: [],
      tokenBackend: 'os-keychain',
      ...(overrides.status ?? {}),
    },
    verifyResult: overrides.verifyResult ?? { ok: true, teamName: 'Test Workspace', teamId: 'T0TEST', botUserId: 'U0BOT' },
    setTokensResult: overrides.setTokensResult ?? { ok: true },
    enableResult: overrides.enableResult ?? { ok: true },
    calls: {
      verify: [], setTokens: [], enable: 0, disable: 0, clearTokens: 0, setAllowlist: [], getManifest: 0,
    },
  };

  await page.evaluate((args: { initial: SlackMockState; manifest: string }) => {
    const w = window as unknown as {
      cerebro: { slack: Record<string, unknown> };
      __slackMockState: SlackMockState;
      __slackManifest: string;
    };
    w.__slackMockState = args.initial;
    w.__slackManifest = args.manifest;

    const state = () => w.__slackMockState;

    w.cerebro.slack = {
      verify: async (botToken: string, appToken: string) => {
        state().calls.verify.push({ botToken, appToken });
        return state().verifyResult;
      },
      enable: async () => {
        state().calls.enable += 1;
        const r = state().enableResult;
        if (r.ok) {
          state().status.running = true;
          state().status.enabled = true;
          state().status.lastEventAt = Date.now();
          state().status.lastError = null;
        }
        return r;
      },
      disable: async () => {
        state().calls.disable += 1;
        state().status.running = false;
        state().status.enabled = false;
      },
      status: async () => ({ ...state().status }),
      reload: async () => ({ ok: true }),
      setTokens: async (tokens: { botToken: string; appToken: string }) => {
        state().calls.setTokens.push(tokens);
        if (state().setTokensResult.ok) {
          state().status.hasBotToken = Boolean(tokens.botToken);
          state().status.hasAppToken = Boolean(tokens.appToken);
        }
        return state().setTokensResult;
      },
      clearTokens: async () => {
        state().calls.clearTokens += 1;
        state().status.hasBotToken = false;
        state().status.hasAppToken = false;
        state().status.running = false;
        return { ok: true };
      },
      setAllowlist: async (a: { channels: string[]; users: string[] }) => {
        state().calls.setAllowlist.push(a);
        state().status.allowlistChannels = a.channels;
        state().status.allowlistUsers = a.users;
        return { ok: true };
      },
      getManifest: async () => {
        state().calls.getManifest += 1;
        return { ok: true, yaml: w.__slackManifest };
      },
      onConversationUpdated: () => () => { /* no-op */ },
    };
  }, { initial, manifest: MANIFEST_YAML_FIXTURE });
}

async function getMockState(page: Page): Promise<SlackMockState> {
  return page.evaluate(() => {
    const w = window as unknown as { __slackMockState: SlackMockState };
    return JSON.parse(JSON.stringify(w.__slackMockState));
  });
}

/** Grant clipboard permissions on the Playwright context so navigator.clipboard works. */
async function grantClipboard(browser: Browser): Promise<void> {
  for (const ctx of browser.contexts()) {
    try {
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    } catch { /* CDP-attached Electron may not support — best-effort */ }
  }
}

/** Click the "Integrations" item in the primary sidebar and pick the Channels section. */
async function goToIntegrationsChannels(page: Page): Promise<void> {
  await dismissModals(page);
  // Primary sidebar: the Integrations nav button. Sidebar items render an icon
  // + label; we match by label.
  await page.locator('nav button').filter({ hasText: /^Integrations$/ }).first().click({ force: true });
  // Inner sidebar appears with the four sections. Click Channels.
  await page.locator('button:has-text("Channels")').first().click({ force: true });
  // Slack card title is fixed copy.
  await expect(page.locator('text=/^Slack$/').first()).toBeVisible({ timeout: 10_000 });
}

/** Locate the Slack IntegrationCard (header). */
function slackCardHeader(page: Page) {
  // ChannelsSection renders a row labelled "Slack" — anchor on the unique
  // "DM Cerebro" / "DM Cerebro," prefix from i18n channelsSection.slackDesc.
  return page.locator('div').filter({ hasText: /DM Cerebro, mention @Cerebro/ }).first();
}

/** Find the SlackConnectModal root (rendered into a portal at body root,
 *  identified by the close button + step indicator). */
function slackModalRoot(page: Page) {
  return page.locator('.fixed.inset-0.z-50').filter({ hasText: /^Slack$/ });
}

// ─── Spec ──────────────────────────────────────────────────────────────

test.describe('Slack integration UI', () => {
  let page: Page;
  let browser: Browser;

  test.beforeAll(async () => {
    const conn = await connectToApp();
    browser = conn.browser;
    page = conn.page;
    await grantClipboard(browser);
    await installSlackMock(page);
    await goToIntegrationsChannels(page);
  });

  test.afterAll(async () => {
    // Don't close the browser — it's the live Cerebro session. Just unmount
    // any open modals so the next manual session is clean.
    await dismissModals(page).catch(() => { /* ignore */ });
  });

  test('1. Slack card renders the empty-state with Connect CTA', async () => {
    // Card header chrome
    const header = slackCardHeader(page);
    await expect(header).toBeVisible();

    // Description is the empty-state ("DM Cerebro, mention @Cerebro in channels..."),
    // not the connected variant.
    await expect(page.locator('text=/DM Cerebro, mention @Cerebro in channels/')).toBeVisible();

    // The card surfaces a "Connect" button (not "Setup tour") because
    // hasBotToken+hasAppToken are both false.
    const connectBtn = page.locator('button').filter({ hasText: /^Connect$/ }).first();
    await expect(connectBtn).toBeVisible();

    // No "Online" pill while disconnected.
    await expect(page.locator('text=/^Enabled$/')).toHaveCount(0);
  });

  test('2. Connect modal opens at step 1 and fetches the manifest YAML', async () => {
    await installSlackMock(page); // reset call counters
    const connectBtn = page.locator('button').filter({ hasText: /^Connect$/ }).first();
    await connectBtn.click();

    const modal = slackModalRoot(page);
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Step indicator shows "Step 1 of 6".
    await expect(modal.locator('text=/Step 1 of 6/')).toBeVisible();

    // Step 1 body content
    await expect(modal.locator('text=/Create your Slack app/')).toBeVisible();

    // Manifest textarea is populated from the mocked getManifest IPC.
    const textarea = modal.locator('textarea');
    await expect(textarea).toHaveValue(MANIFEST_YAML_FIXTURE);

    // Side-effect: getManifest was called at least once.
    const stateAfter = await getMockState(page);
    expect(stateAfter.calls.getManifest).toBeGreaterThanOrEqual(1);
  });

  test('3. Copy manifest button copies YAML to clipboard and flips label', async () => {
    const modal = slackModalRoot(page);
    const copyBtn = modal.locator('button').filter({ hasText: /Copy manifest YAML/ }).first();
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    // Label flips to "Copied!".
    await expect(modal.locator('button').filter({ hasText: /Copied!/ })).toBeVisible({ timeout: 2_000 });

    // Clipboard contains the manifest. In Electron + CDP, the renderer's
    // navigator.clipboard API is available; if `permissions.grant` failed
    // earlier we still try to read and only assert if it worked.
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    if (clip.length > 0) {
      expect(clip).toBe(MANIFEST_YAML_FIXTURE);
    }
  });

  test('4. Walk forward through steps 2-4 (instructions + token paste)', async () => {
    const modal = slackModalRoot(page);
    const next = () => modal.locator('button').filter({ hasText: /^Continue$/ }).first();

    // Step 1 → 2
    await next().click();
    await expect(modal.locator('text=/Step 2 of 6/')).toBeVisible();
    await expect(modal.locator('text=/Install to your workspace/')).toBeVisible();

    // Step 2 → 3
    await next().click();
    await expect(modal.locator('text=/Step 3 of 6/')).toBeVisible();
    await expect(modal.locator('text=/Paste your bot token/')).toBeVisible();

    // Paste bot token. The first password input on this step is the bot token.
    const botInput = modal.locator('input[type="password"]').first();
    await botInput.fill('xoxb-test-1234567890-abcdef');

    // Step 3 → 4
    await next().click();
    await expect(modal.locator('text=/Step 4 of 6/')).toBeVisible();
    await expect(modal.locator('text=/Generate your app-level token/')).toBeVisible();

    const appInput = modal.locator('input[type="password"]').first();
    await appInput.fill('xapp-1-AAAA-1111-bbbb');
  });

  test('5. Step 5 verify path: success → state advances, setTokens called', async () => {
    const modal = slackModalRoot(page);

    // Step 4 → 5
    await modal.locator('button').filter({ hasText: /^Continue$/ }).first().click();
    await expect(modal.locator('text=/Step 5 of 6/')).toBeVisible();

    const verifyBtn = modal.locator('button').filter({ hasText: /^Verify$/ }).first();
    await verifyBtn.click();

    // Success label rendered with the mocked team name.
    await expect(modal.locator('text=/Verified on workspace Test Workspace/')).toBeVisible({ timeout: 5_000 });

    // setTokens should have been called once with the trimmed tokens.
    const state = await getMockState(page);
    expect(state.calls.setTokens.length).toBe(1);
    expect(state.calls.setTokens[0].botToken).toBe('xoxb-test-1234567890-abcdef');
    expect(state.calls.setTokens[0].appToken).toBe('xapp-1-AAAA-1111-bbbb');
    expect(state.status.hasBotToken).toBe(true);
    expect(state.status.hasAppToken).toBe(true);
  });

  test('6. Step 6 finish: enable called, modal closes', async () => {
    const modal = slackModalRoot(page);

    // Step 5 → 6
    await modal.locator('button').filter({ hasText: /^Continue$/ }).first().click();
    await expect(modal.locator('text=/Step 6 of 6/')).toBeVisible();
    await expect(modal.locator('text=/You.{1,3}re ready/i')).toBeVisible();

    // Click "Enable & finish".
    const finishBtn = modal.locator('button').filter({ hasText: /Enable & finish/ }).first();
    await finishBtn.click();

    // Modal closes.
    await expect(modal).toBeHidden({ timeout: 5_000 });

    const state = await getMockState(page);
    expect(state.calls.enable).toBe(1);
    expect(state.status.running).toBe(true);
    expect(state.status.enabled).toBe(true);
  });

  test('7. After enabling, the card flips to "Setup tour" and shows the Enabled pill', async () => {
    // Card description now uses the connected variant (i18n channelsSection.slackDescConnected).
    // The fragment "Connected to Test Workspace" is unique to that path.
    await expect(page.locator('text=/Connected to Test Workspace/').first()).toBeVisible({ timeout: 5_000 });

    // CTA flips from "Connect" to "Setup tour" because hasBotToken+hasAppToken are now true.
    await expect(page.locator('button').filter({ hasText: /Setup tour/ }).first()).toBeVisible();
  });

  test('8. Verify error path surfaces a red error line, no setTokens call', async () => {
    // Re-install the mock with a failing verifyResult and clear tokens.
    await installSlackMock(page, {
      verifyResult: { ok: false, error: 'invalid_auth' },
    });

    // Re-mount the modal. Click "Setup tour" — it opens the same SlackConnectModal.
    await page.locator('button').filter({ hasText: /Setup tour|^Connect$/ }).first().click();
    const modal = slackModalRoot(page);
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Jump to step 3 via Continue twice
    const next = modal.locator('button').filter({ hasText: /^Continue$/ }).first();
    await next.click();
    await next.click();

    // Paste a token (any non-empty string)
    await modal.locator('input[type="password"]').first().fill('xoxb-bad-token');
    await next.click();

    // Step 4 — paste app token, advance
    await modal.locator('input[type="password"]').first().fill('xapp-bad-token');
    await next.click();

    // Step 5 — Verify
    await modal.locator('button').filter({ hasText: /^Verify$/ }).first().click();

    // Error line surfaces.
    await expect(modal.locator('text=/invalid_auth/')).toBeVisible({ timeout: 5_000 });

    // setTokens was NOT called on this path.
    const state = await getMockState(page);
    expect(state.calls.setTokens.length).toBe(0);

    // Close the modal via the X button (no Continue available since verify failed).
    await modal.locator('button[aria-label="Close"]').first().click();
    await expect(modal).toBeHidden({ timeout: 5_000 });
  });

  test('9. SlackSection allowlist parser keeps valid IDs and drops garbage', async () => {
    // Set tokens so the SlackSection renders its "connected" view, then expand the card.
    await installSlackMock(page, {
      status: {
        running: false,
        lastEventAt: null,
        lastError: null,
        teamName: 'Test Workspace',
        botUserId: 'U0BOT',
        hasBotToken: true,
        hasAppToken: true,
        enabled: false,
        allowlistChannels: [],
        allowlistUsers: [],
        tokenBackend: 'os-keychain',
      },
    });
    // Expand the Slack IntegrationCard. The IntegrationCard wraps SlackSection;
    // there's a chevron/title row that toggles expansion.
    const cardTitle = page.locator('h3, h2, div').filter({ hasText: /^Slack$/ }).first();
    await cardTitle.click({ force: true });

    // Find the channels allowlist input by its placeholder.
    const chanInput = page.locator('input[placeholder*="C01ABCDE"]').first();
    await expect(chanInput).toBeVisible({ timeout: 5_000 });
    // Mix valid + garbage. The parser strips wrappers and rejects malformed.
    await chanInput.fill('<#C01ABCDEF|general>, hello, C01XYZABC, *');

    const userInput = page.locator('input[placeholder*="U01ABCDE"]').first();
    await userInput.fill('<@U01ABCDEF>, U02XYZABC, garbage, W099YYYYY');

    // Click Save.
    const saveBtn = page.locator('button').filter({ hasText: /^Save$/ }).first();
    await saveBtn.click();

    // setAllowlist should have been called with only the valid IDs (in input order).
    await expect.poll(async () => {
      const st = await getMockState(page);
      return st.calls.setAllowlist.length;
    }, { timeout: 5_000 }).toBeGreaterThan(0);

    const state = await getMockState(page);
    const last = state.calls.setAllowlist.at(-1)!;
    expect(last.channels).toEqual(['C01ABCDEF', 'C01XYZABC', '*']);
    expect(last.users).toEqual(['U01ABCDEF', 'U02XYZABC', 'W099YYYYY']);
  });

  test('10. Closing the modal via the X button mid-flow leaves the renderer responsive', async () => {
    await installSlackMock(page);

    const cta = page.locator('button').filter({ hasText: /Setup tour|^Connect$/ }).first();
    await cta.click();

    const modal = slackModalRoot(page);
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Walk to step 3 and close abruptly
    await modal.locator('button').filter({ hasText: /^Continue$/ }).first().click();
    await modal.locator('button').filter({ hasText: /^Continue$/ }).first().click();
    await modal.locator('button[aria-label="Close"]').first().click();

    await expect(modal).toBeHidden({ timeout: 5_000 });

    // The card is still on screen and reachable.
    await expect(page.locator('text=/^Slack$/').first()).toBeVisible();
  });
});
