/**
 * Shared types for the files-and-media foundation.
 *
 * A ResolvedAttachment is the unit of currency that flows through every
 * surface — chat upload, Telegram inbound, WhatsApp inbound, expert
 * context-file injection. Producers (the chat send path, the integration
 * bridges) all hand raw paths to MediaIngestService and consume the same
 * shape: a `promptInjection` ready to paste into the `claude -p` argument.
 */

export type MediaCategory =
  | 'image'      // PNG/JPG/WEBP/GIF — passthrough; Claude reads via Read tool
  | 'pdf'        // pre-extracted to markdown sidecar
  | 'office'     // .docx/.xlsx/.pptx → markdown sidecar
  | 'audio'      // STT-transcribed via /voice/stt/transcribe-file
  | 'text'       // .txt/.md — passthrough
  | 'video'      // currently no processing; surfaced as "video attached"
  | 'unknown';   // fall-through

export interface ResolvedAttachment {
  /** FileItem row id (registered via /files/items/from-path). */
  fileItemId: string;
  /** Absolute path to the original bytes on disk. */
  originalPath: string;
  /** Original filename (basename). */
  originalName: string;
  /** Detected MIME type (magic-bytes sniff with extension fallback). */
  mime: string | null;
  /** Bytes on disk. */
  sizeBytes: number;
  /** sha256 hex string. */
  sha256: string;
  /** Coarse category drives prompt-injection strategy. */
  category: MediaCategory;
  /** For office/pdf: absolute path to the markdown sidecar. */
  parsedTextPath?: string;
  /** For audio: short transcript inlined directly into the prompt. */
  inlineText?: string;
  /** Ready-to-paste prompt fragment — what callers actually emit. */
  promptInjection: string;
  /** True if parsing succeeded but the output was capped. */
  truncated?: boolean;
  /** Non-blocking warning to surface in UI. */
  warning?: string;
  /** Set if ingestion failed completely (parse error, file missing, etc.). */
  error?: string;
}

/** Source label written to FileItem.source so attachments group cleanly. */
export type IngestSource =
  | 'chat-upload'
  | 'telegram-inbound'
  | 'whatsapp-inbound'
  | 'expert-context';

export interface IngestRequest {
  filePath: string;
  /** Optional: pass through if caller already knows. Avoids re-hashing. */
  sha256?: string;
  /** Where this came from — drives FileItem.source. */
  source: IngestSource;
  conversationId?: string | null;
  messageId?: string | null;
}
