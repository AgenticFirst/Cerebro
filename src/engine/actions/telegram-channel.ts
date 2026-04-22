/**
 * Minimal interface the engine's send_telegram_message action depends on.
 * Implemented by TelegramBridge — kept here so the action factory can be
 * imported without dragging the whole bridge module into the engine layer.
 */

export interface TelegramChannel {
  /** True if `chatId` is in the operator's Telegram allowlist. */
  isAllowlisted(chatId: string): boolean;
  /** Send a single message via the bot. Returns the first message_id (chunked
   *  sends use additional ids that the action does not currently surface).
   *  Errors are returned in the result rather than thrown so the action can
   *  decide how to fail the step. */
  sendActionMessage(
    chatId: string,
    text: string,
    parseMode?: 'HTML' | 'MarkdownV2' | 'none',
  ): Promise<{ messageId: number | null; error: string | null }>;
}
