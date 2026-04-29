/**
 * Minimal interface the engine's send_whatsapp_message action depends on.
 * Implemented by WhatsAppBridge — kept here so the action factory can be
 * imported without dragging the Baileys module into the engine layer.
 */

export interface WhatsAppChannel {
  /** True if `phoneOrJid` is in the operator's WhatsApp allowlist.
   *  Accepts either a bare E.164-ish phone string or a full Baileys JID. */
  isAllowlisted(phoneOrJid: string): boolean;
  /** Send a single text message. Returns the message id (Baileys's key.id) on
   *  success. Errors are returned in the result rather than thrown so the
   *  action can decide how to fail the step. */
  sendActionMessage(
    phoneOrJid: string,
    text: string,
  ): Promise<{ messageId: string | null; error: string | null }>;
  /** True if a WhatsApp account is currently paired (Baileys session is
   *  authenticated). Used by the chat-actions catalog to decide if WhatsApp
   *  actions are invokable from chat. */
  isConnected(): boolean;

  // ── Outbound media ────────────────────────────────────────────
  // Each returns `{ messageId, error }` mirroring `sendActionMessage`. The
  // bridge enforces the allowlist + rate-limit before each call.

  sendPhotoActionMessage(
    phoneOrJid: string,
    filePath: string,
    caption?: string,
  ): Promise<{ messageId: string | null; error: string | null }>;

  sendDocumentActionMessage(
    phoneOrJid: string,
    filePath: string,
    caption?: string,
    fileName?: string,
  ): Promise<{ messageId: string | null; error: string | null }>;

  sendAudioActionMessage(
    phoneOrJid: string,
    filePath: string,
  ): Promise<{ messageId: string | null; error: string | null }>;

  sendVideoActionMessage(
    phoneOrJid: string,
    filePath: string,
    caption?: string,
  ): Promise<{ messageId: string | null; error: string | null }>;

  sendVoiceActionMessage(
    phoneOrJid: string,
    filePath: string,
  ): Promise<{ messageId: string | null; error: string | null }>;

  sendStickerActionMessage(
    phoneOrJid: string,
    filePath: string,
  ): Promise<{ messageId: string | null; error: string | null }>;

  sendLocationActionMessage(
    phoneOrJid: string,
    latitude: number,
    longitude: number,
  ): Promise<{ messageId: string | null; error: string | null }>;
}
