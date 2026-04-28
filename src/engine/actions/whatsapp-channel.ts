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
}
