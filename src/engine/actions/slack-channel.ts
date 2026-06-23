/**
 * Minimal interface the engine's send_slack_* actions depend on.
 * Implemented by SlackBridge — kept here so the action factory can be
 * imported without dragging the whole bridge module into the engine layer.
 */

export interface SlackChannel {
  /** True iff (channel, optional userId) is in the operator's allowlist. */
  isAllowlisted(channelId: string, userId?: string): boolean;

  /** Send a single message via the Slack bot. Chunks if the body exceeds
   *  the per-message text cap. Returns the first message's ts on success.
   *  Errors are returned in the result rather than thrown so the action
   *  can decide how to fail the step. */
  sendActionMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{ messageTs: string | null; channelId: string | null; error: string | null }>;

  /** Upload a file to a channel via `files.uploadV2`. */
  sendFileActionMessage(
    channel: string,
    filePath: string,
    options?: { comment?: string; threadTs?: string; fileName?: string },
  ): Promise<{ fileId: string | null; error: string | null }>;

  /** Read-only utility for routine drafts ("which channel should I post to?"). */
  listChannels(): Promise<{
    ok: boolean;
    channels?: Array<{ id: string; name: string; is_private: boolean }>;
    error?: string;
  }>;

  /** True when the bridge is paired and reachable — chat-actions catalog uses
   *  this to decide if Slack is invokable from chat right now. */
  isConnected(): boolean;

  /** If an inbound chat run for `conversationId` is currently in flight, return
   *  the Slack origin its reply is being auto-delivered to. Lets the engine drop
   *  a chat-triggered send_slack_message aimed at that same channel — otherwise
   *  the model's send double-posts content the stream sink already delivered.
   *  Returns null for routine runs / unknown conversations (no exact match). */
  activeConversationOrigin(conversationId: string): { channel: string } | null;
}
