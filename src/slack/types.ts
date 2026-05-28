/**
 * Slack types — just the slice we need.
 *
 * Ref: https://docs.slack.dev/
 *
 * Cerebro uses Socket Mode (no public HTTPS endpoint). Two tokens:
 *  - Bot token (`xoxb-…`) issued at install. Used for every Web API call.
 *  - App-level token (`xapp-…`, scope `connections:write`) only for opening
 *    the Socket Mode WebSocket.
 */

// ── Incoming events (narrowed to what the bridge handles) ─────────

export interface SlackUser {
  id: string;            // U… (workspace) or W… (Enterprise Grid)
  name?: string;         // legacy login (rarely useful)
  real_name?: string;
  team_id?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
    email?: string;
    image_192?: string;
  };
  locale?: string;
  tz?: string;
}

export interface SlackTeamInfo {
  id: string;            // T…
  name: string;
  domain?: string;
}

/**
 * Common shape extracted from the various event payloads we care about.
 * We don't try to mirror Bolt's full discriminated-union event surface —
 * the bridge converts each event into this normalized form before
 * dispatching to `handleSlackMessage`.
 */
export interface SlackInboundContext {
  /** Slack event_id from the envelope, used for dedupe. */
  eventId: string;
  /** Workspace / team id (T…). */
  teamId: string;
  /** Channel where the event happened. DMs are D…, public C…, private G…. */
  channel: string;
  channelType?: 'im' | 'channel' | 'group' | 'mpim' | string;
  /** Slack user id (U…/W…) of the human who sent the message. */
  userId: string;
  /** ts of the inbound message. */
  ts: string;
  /** thread_ts when present — when absent we use ts as the thread root. */
  threadTs?: string;
  /** Raw inbound text, after Slack mrkdwn → text conversion. */
  text: string;
  /** Surface that produced the event — drives routing. */
  surface: 'app_mention' | 'message_im' | 'slash_command';
  /** For slash commands only: the subcommand and remaining args. */
  slashCommand?: {
    command: string;       // "/cerebro"
    text: string;          // raw args
    responseUrl: string;   // valid ~30 minutes after ack()
    triggerId: string;
  };
  /** Slack-supplied locale on the user (e.g. "en-US", "es-ES"), if known. */
  locale?: string;
}

// ── Settings shape (stored via /settings/{key}) ───────────────────

export interface SlackSettings {
  botToken: string | null;
  appToken: string | null;
  enabled: boolean;
  /** Slack channel ids (C…/G…). '*' means any channel. Empty = closed. */
  allowlistChannels: string[];
  /** Slack user ids (U…/W…). '*' means any user. Empty = closed. */
  allowlistUsers: string[];
  /** threadKey → Cerebro conversation id. */
  threadConversationMap: Record<string, string>;
  /** threadKey → expert id pinned to that conversation. */
  threadExpertMap: Record<string, string>;
  /** Cached user-id → display name (refreshed via users.info on inbound). */
  userDisplayNames: Record<string, string>;
  /**
   * Workspace-wide default: the experts every Slack person can use unless
   * they have an entry in `userExpertAccess`. `null` (default) means
   * unrestricted — everyone keeps access to every expert. A `string[]`
   * curates the baseline so an operator can configure a 50-person workspace
   * with one default and a handful of overrides instead of one entry per
   * person.
   */
  defaultExpertAccess: string[] | null;
  /**
   * Per-user override on top of the default. Maps Slack user id → expert
   * ids. The sentinel value `'*'` means "this person gets ALL experts,
   * regardless of the default" (the common case where the default is
   * restrictive but admins/power users need everything). An empty array
   * means "no experts at all". Users absent from this map fall back to
   * `defaultExpertAccess`.
   */
  userExpertAccess: Record<string, string[]>;
  /** Slack workspace name once auth.test resolves, for the UI status card. */
  teamName: string | null;
  /** Slack bot user id (e.g. "U098…") — used to strip self-mentions. */
  botUserId: string | null;
  /** Slack user id of the Cerebro operator. When the bundled Claude Code
   *  CLI loses auth, we DM the operator the sign-in link (and accept a
   *  paste-back code via their next DM) instead of leaking a useless
   *  "run `claude` in a terminal" message to the requesting user. When
   *  null, falls back to the first id in `allowlistUsers`. */
  operatorUserId: string | null;
}

export const SLACK_SETTING_KEYS = {
  botToken: 'slack_bot_token',
  appToken: 'slack_app_token',
  enabled: 'slack_enabled',
  allowlistChannels: 'slack_allowlist_channels',
  allowlistUsers: 'slack_allowlist_users',
  threadConversationMap: 'slack_thread_conversation_map',
  threadExpertMap: 'slack_thread_expert_map',
  userDisplayNames: 'slack_user_display_names',
  defaultExpertAccess: 'slack_default_expert_access',
  userExpertAccess: 'slack_user_expert_access',
  teamName: 'slack_team_name',
  botUserId: 'slack_bot_user_id',
  operatorUserId: 'slack_operator_user_id',
} as const;

// ── IPC surface (re-exports of the canonical types in types/ipc.ts) ──

export type {
  SlackVerifyResponse as SlackVerifyResult,
  SlackStatusResponse as SlackStatus,
} from '../types/ipc';
