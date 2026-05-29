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
  /** True if a Telegram bot is currently paired and reachable. Used by the
   *  chat-actions catalog to decide if Telegram is invokable from chat. */
  isConnected(): boolean;

  // ── Outbound media (multipart) ────────────────────────────────
  // Each returns `{ messageId, error }` mirroring `sendActionMessage` so the
  // action layer can branch on either without throwing. The bridge enforces
  // the allowlist before each call.

  sendPhotoActionMessage(
    chatId: string,
    filePath: string,
    caption?: string,
  ): Promise<{ messageId: number | null; error: string | null }>;

  sendDocumentActionMessage(
    chatId: string,
    filePath: string,
    caption?: string,
  ): Promise<{ messageId: number | null; error: string | null }>;

  sendAudioActionMessage(
    chatId: string,
    filePath: string,
    caption?: string,
  ): Promise<{ messageId: number | null; error: string | null }>;

  sendVideoActionMessage(
    chatId: string,
    filePath: string,
    caption?: string,
  ): Promise<{ messageId: number | null; error: string | null }>;

  sendVoiceActionMessage(
    chatId: string,
    filePath: string,
    caption?: string,
  ): Promise<{ messageId: number | null; error: string | null }>;

  sendStickerActionMessage(
    chatId: string,
    filePath: string,
  ): Promise<{ messageId: number | null; error: string | null }>;

  sendLocationActionMessage(
    chatId: string,
    latitude: number,
    longitude: number,
  ): Promise<{ messageId: number | null; error: string | null }>;
}
