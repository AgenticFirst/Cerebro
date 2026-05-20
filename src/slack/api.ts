/**
 * Thin typed wrapper around `@slack/web-api`.
 *
 * Bolt creates its own WebClient under the hood, but we still hold one
 * here for verify-time probes (auth.test before the bridge starts) and
 * for outbound action sends that don't go through a Bolt handler.
 *
 * All error strings are scrubbed via `scrubTokenish` before they cross
 * any boundary the operator might see.
 */

import { WebClient, type ChatPostMessageArguments, type ChatUpdateArguments } from '@slack/web-api';

/** Remove anything resembling a Slack token from a string. */
export function scrubTokenish(s: string): string {
  if (!s) return s;
  // xoxb-…, xoxa-…, xoxp-…, xoxs-…, xapp-…
  return s.replace(/xox[abps]-[A-Za-z0-9-]{8,}/g, '***')
    .replace(/xapp-[A-Za-z0-9-]{8,}/g, '***');
}

export class SlackApiError extends Error {
  readonly code: string | null;
  readonly method: string;

  constructor(method: string, code: string | null, description: string) {
    super(scrubTokenish(description));
    this.name = 'SlackApiError';
    this.method = method;
    this.code = code;
  }
}

/** Minimal shape we use from `auth.test`. */
export interface SlackAuthInfo {
  ok: boolean;
  url?: string;
  team?: string;
  user?: string;
  team_id?: string;
  user_id?: string;
  bot_id?: string;
}

/** Minimal shape we use from `users.info`. */
export interface SlackUserInfo {
  id: string;
  name?: string;
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
  is_bot?: boolean;
}

export interface SlackPostMessageResult {
  ts: string;
  channel: string;
}

export interface SlackChannelSummary {
  id: string;
  name: string;
  is_im: boolean;
  is_private: boolean;
  is_archived?: boolean;
  num_members?: number;
}

export class SlackApi {
  private client: WebClient;
  private token: string;

  constructor(botToken: string) {
    this.token = botToken;
    this.client = new WebClient(botToken, {
      retryConfig: { retries: 2 },
    });
  }

  setToken(botToken: string): void {
    this.token = botToken;
    this.client = new WebClient(botToken, {
      retryConfig: { retries: 2 },
    });
  }

  /**
   * Probe whether a bot token is valid. Returns `auth.test` payload on
   * success; throws `SlackApiError` on any failure (network, invalid token).
   */
  async authTest(): Promise<SlackAuthInfo> {
    try {
      const res = await this.client.auth.test();
      return res as unknown as SlackAuthInfo;
    } catch (err) {
      throw this.wrap('auth.test', err);
    }
  }

  /**
   * Probe whether an app-level token can open Socket Mode. Bolt itself does
   * this at start time; we surface it here so the connect modal can show
   * a meaningful "your xapp- token is valid" check without actually opening
   * a long-lived socket.
   *
   * The endpoint requires the app-level token, not the bot token, so we
   * spin up a one-off client.
   */
  async appsConnectionsOpen(appToken: string): Promise<{ url: string }> {
    const client = new WebClient(appToken);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (client.apps.connections as any).open();
      if (!res?.ok || typeof res.url !== 'string') {
        throw new SlackApiError('apps.connections.open', null, 'malformed response');
      }
      return { url: res.url };
    } catch (err) {
      throw this.wrap('apps.connections.open', err);
    }
  }

  async usersInfo(userId: string): Promise<SlackUserInfo | null> {
    try {
      const res = await this.client.users.info({ user: userId });
      return (res.user ?? null) as SlackUserInfo | null;
    } catch (err) {
      throw this.wrap('users.info', err);
    }
  }

  async chatPostMessage(args: ChatPostMessageArguments): Promise<SlackPostMessageResult> {
    try {
      const res = await this.client.chat.postMessage(args);
      if (!res.ts || !res.channel) {
        throw new SlackApiError('chat.postMessage', null, 'missing ts/channel in response');
      }
      return { ts: String(res.ts), channel: String(res.channel) };
    } catch (err) {
      throw this.wrap('chat.postMessage', err);
    }
  }

  async chatUpdate(args: ChatUpdateArguments): Promise<SlackPostMessageResult> {
    try {
      const res = await this.client.chat.update(args);
      if (!res.ts || !res.channel) {
        throw new SlackApiError('chat.update', null, 'missing ts/channel in response');
      }
      return { ts: String(res.ts), channel: String(res.channel) };
    } catch (err) {
      throw this.wrap('chat.update', err);
    }
  }

  async chatPostEphemeral(args: {
    channel: string;
    user: string;
    text: string;
    thread_ts?: string;
    blocks?: ChatPostMessageArguments['blocks'];
  }): Promise<void> {
    try {
      await this.client.chat.postEphemeral(args);
    } catch (err) {
      throw this.wrap('chat.postEphemeral', err);
    }
  }

  /** Publish (or update) a user's App Home tab view. */
  async viewsPublish(args: { userId: string; view: object }): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.client.views.publish({ user_id: args.userId, view: args.view as any });
    } catch (err) {
      throw this.wrap('views.publish', err);
    }
  }

  /**
   * Upload a file via the modern `files.uploadV2` helper. Slack handles the
   * stage-and-finalize dance internally.
   */
  async filesUpload(args: {
    channelId: string;
    filePath: string;
    threadTs?: string;
    initialComment?: string;
    fileName?: string;
  }): Promise<{ fileId?: string | null }> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await (this.client.files as any).uploadV2({
        channel_id: args.channelId,
        file: args.filePath,
        filename: args.fileName,
        initial_comment: args.initialComment,
        thread_ts: args.threadTs,
      });
      // uploadV2 returns either a `files: [...]` array or a `file: {...}`.
      const fileId: string | null = res?.files?.[0]?.id ?? res?.file?.id ?? null;
      return { fileId };
    } catch (err) {
      throw this.wrap('files.uploadV2', err);
    }
  }

  async conversationsList(types: string = 'public_channel,private_channel'): Promise<SlackChannelSummary[]> {
    try {
      const out: SlackChannelSummary[] = [];
      let cursor: string | undefined;
      // Paginate until we hit 1000 channels max — beyond that the picker
      // becomes unusable anyway.
      for (let page = 0; page < 10; page++) {
        const res = await this.client.conversations.list({
          types,
          limit: 200,
          cursor,
          exclude_archived: true,
        });
        const items = (res.channels ?? []) as Array<{
          id?: string;
          name?: string;
          is_im?: boolean;
          is_private?: boolean;
          is_archived?: boolean;
          num_members?: number;
        }>;
        for (const c of items) {
          if (!c.id || !c.name) continue;
          out.push({
            id: c.id,
            name: c.name,
            is_im: Boolean(c.is_im),
            is_private: Boolean(c.is_private),
            is_archived: Boolean(c.is_archived),
            num_members: typeof c.num_members === 'number' ? c.num_members : undefined,
          });
        }
        cursor = res.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
      return out;
    } catch (err) {
      throw this.wrap('conversations.list', err);
    }
  }

  /**
   * Late-post a reply to a slash command via the supplied `response_url`.
   * Used when inference takes longer than the 3-second ack window.
   *
   * `response_url` is workspace-bearer-authed by Slack — no app token needed.
   */
  async respondToSlashCommand(args: {
    responseUrl: string;
    text: string;
    inChannel?: boolean;
    replace?: boolean;
  }): Promise<void> {
    const body = {
      response_type: args.inChannel ? 'in_channel' : 'ephemeral',
      replace_original: Boolean(args.replace),
      text: args.text,
    };
    let res: Response;
    try {
      res = await fetch(args.responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SlackApiError('respond', null, scrubTokenish(msg));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new SlackApiError('respond', null, `slash respond failed (${res.status}): ${scrubTokenish(text)}`);
    }
  }

  /** Surface the bot token (for logging purposes only — never to renderer). */
  getToken(): string {
    return this.token;
  }

  private wrap(method: string, err: unknown): SlackApiError {
    const msg = err instanceof Error ? err.message : String(err);
    // @slack/web-api errors carry `.data.error` for the Slack response code.
    let code: string | null = null;
    if (err && typeof err === 'object' && 'data' in err) {
      const data = (err as { data?: { error?: unknown } }).data;
      if (data && typeof data.error === 'string') code = data.error;
    }
    return new SlackApiError(method, code, scrubTokenish(msg));
  }
}
