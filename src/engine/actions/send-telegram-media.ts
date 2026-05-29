/**
 * send_telegram_{photo,document,audio,video,voice,sticker,location} —
 * outbound-media chat actions for Telegram.
 *
 * All seven share the same shape: render `chat_id` (and any captions / coords)
 * via Mustache against `wiredInputs`, resolve the file via the shared
 * `resolveMediaInput` helper (which prefers `file_item_id` and falls back to
 * `file_path`), then delegate to the bridge's `sendXxxActionMessage`.
 *
 * They are all `chatExposable: true`, so the engine's chat-action surface
 * gates each call behind the standard human-approval card before anything
 * leaves the user's machine.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import { resolveMediaInput } from './utils/media-resolver';
import type { TelegramChannel } from './telegram-channel';

interface BaseMediaParams {
  chat_id: string;
  file_item_id?: string;
  file_path?: string;
  caption?: string;
}

interface LocationParams {
  chat_id: string;
  latitude: number | string;
  longitude: number | string;
}

type ChannelMediaMethod =
  | 'sendPhotoActionMessage'
  | 'sendDocumentActionMessage'
  | 'sendAudioActionMessage'
  | 'sendVideoActionMessage'
  | 'sendVoiceActionMessage'
  | 'sendStickerActionMessage';

interface MediaSpec {
  type: string;
  name: string;
  description: string;
  channelMethod: ChannelMediaMethod;
  acceptsCaption: boolean;
  chatLabel: { en: string; es: string };
  chatDescription: { en: string; es: string };
  chatExamples: Array<{ en: string; es: string }>;
}

const SPECS: MediaSpec[] = [
  {
    type: 'send_telegram_photo',
    name: 'Send Telegram Photo',
    description: 'Send a photo via the Telegram bot. Allowlist-enforced.',
    channelMethod: 'sendPhotoActionMessage',
    acceptsCaption: true,
    chatLabel: { en: 'Send Telegram photo', es: 'Enviar foto por Telegram' },
    chatDescription: {
      en: 'Send a photo (PNG/JPG/WebP/GIF) to a Telegram chat.',
      es: 'Envía una foto (PNG/JPG/WebP/GIF) a un chat de Telegram.',
    },
    chatExamples: [
      {
        en: 'Send Pablo the screenshot I just generated on Telegram.',
        es: 'Envíale a Pablo la captura que acabo de generar por Telegram.',
      },
    ],
  },
  {
    type: 'send_telegram_document',
    name: 'Send Telegram Document',
    description: 'Send any file as a document via the Telegram bot. Allowlist-enforced.',
    channelMethod: 'sendDocumentActionMessage',
    acceptsCaption: true,
    chatLabel: { en: 'Send Telegram document', es: 'Enviar documento por Telegram' },
    chatDescription: {
      en: 'Send a document (PDF, Word, Excel, etc.) to a Telegram chat.',
      es: 'Envía un documento (PDF, Word, Excel, etc.) a un chat de Telegram.',
    },
    chatExamples: [
      {
        en: 'Send Pablo the manual I generated as a PDF on Telegram.',
        es: 'Mándale a Pablo el manual que generé en PDF por Telegram.',
      },
    ],
  },
  {
    type: 'send_telegram_audio',
    name: 'Send Telegram Audio',
    description: 'Send a music/audio file (MP3, M4A, WAV) via the Telegram bot.',
    channelMethod: 'sendAudioActionMessage',
    acceptsCaption: true,
    chatLabel: { en: 'Send Telegram audio', es: 'Enviar audio por Telegram' },
    chatDescription: {
      en: 'Send an audio file (MP3/M4A/WAV) to a Telegram chat. Use voice for short voice notes.',
      es: 'Envía un archivo de audio (MP3/M4A/WAV) a un chat de Telegram. Usa voz para notas de voz.',
    },
    chatExamples: [
      {
        en: 'Send Pablo this MP3 on Telegram.',
        es: 'Envíale a Pablo este MP3 por Telegram.',
      },
    ],
  },
  {
    type: 'send_telegram_video',
    name: 'Send Telegram Video',
    description: 'Send a video via the Telegram bot.',
    channelMethod: 'sendVideoActionMessage',
    acceptsCaption: true,
    chatLabel: { en: 'Send Telegram video', es: 'Enviar video por Telegram' },
    chatDescription: {
      en: 'Send a video file (MP4, MOV) to a Telegram chat.',
      es: 'Envía un video (MP4, MOV) a un chat de Telegram.',
    },
    chatExamples: [
      {
        en: 'Send Pablo this clip on Telegram.',
        es: 'Mándale este clip a Pablo por Telegram.',
      },
    ],
  },
  {
    type: 'send_telegram_voice',
    name: 'Send Telegram Voice Note',
    description: 'Send a voice note (single OGG opus file, displayed as a waveform).',
    channelMethod: 'sendVoiceActionMessage',
    acceptsCaption: false,
    chatLabel: { en: 'Send Telegram voice note', es: 'Enviar nota de voz por Telegram' },
    chatDescription: {
      en: 'Send a voice note (OGG opus) to a Telegram chat — appears inline as a waveform.',
      es: 'Envía una nota de voz (OGG opus) a un chat de Telegram — aparece como onda inline.',
    },
    chatExamples: [
      {
        en: 'Reply to Pablo on Telegram with a voice note.',
        es: 'Respóndele a Pablo en Telegram con una nota de voz.',
      },
    ],
  },
  {
    type: 'send_telegram_sticker',
    name: 'Send Telegram Sticker',
    description: 'Send a sticker (WebP) via the Telegram bot.',
    channelMethod: 'sendStickerActionMessage',
    acceptsCaption: false,
    chatLabel: { en: 'Send Telegram sticker', es: 'Enviar sticker por Telegram' },
    chatDescription: {
      en: 'Send a sticker (WebP) to a Telegram chat.',
      es: 'Envía un sticker (WebP) a un chat de Telegram.',
    },
    chatExamples: [
      {
        en: 'Send Pablo a sticker on Telegram.',
        es: 'Envíale un sticker a Pablo por Telegram.',
      },
    ],
  },
];

export function createSendTelegramMediaActions(deps: {
  getChannel: () => TelegramChannel | null;
  backendPort: () => number | null;
}): ActionDefinition[] {
  return SPECS.map((spec) => makeMediaAction(spec, deps));
}

function makeMediaAction(
  spec: MediaSpec,
  deps: { getChannel: () => TelegramChannel | null; backendPort: () => number | null },
): ActionDefinition {
  return {
    type: spec.type,
    name: spec.name,
    description: spec.description,
    chatExposable: true,
    chatGroup: 'telegram',
    chatLabel: spec.chatLabel,
    chatDescription: spec.chatDescription,
    chatExamples: spec.chatExamples,
    availabilityCheck: () => {
      const ch = deps.getChannel();
      if (!ch) return 'not_connected';
      return ch.isConnected() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#telegram',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'Numeric Telegram chat id from your allowlist. Templated.',
        },
        file_item_id: {
          type: 'string',
          description: 'Preferred: id of a registered FileItem on disk.',
        },
        file_path: {
          type: 'string',
          description: 'Escape hatch: absolute path to a file on disk Cerebro just created.',
        },
        ...(spec.acceptsCaption
          ? {
              caption: {
                type: 'string',
                description: 'Optional caption shown alongside the media. Templated.',
              },
            }
          : {}),
      },
      required: ['chat_id'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        sent: { type: 'boolean' },
        message_id: { type: ['number', 'null'] },
        chat_id: { type: 'string' },
        file_name: { type: 'string' },
        size_bytes: { type: 'number' },
        error: { type: ['string', 'null'] },
      },
      required: ['sent', 'chat_id'],
    },
    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) {
        throw new Error(
          `${spec.name}: Telegram bridge is not enabled. Connect Telegram in Integrations first.`,
        );
      }
      const port = deps.backendPort();
      if (!port) {
        throw new Error(`${spec.name}: backend not ready.`);
      }
      const params = input.params as unknown as BaseMediaParams;
      const vars = input.wiredInputs ?? {};

      const chatId = renderTemplate(params.chat_id ?? '', vars).trim();
      if (!chatId) throw new Error(`${spec.name}: chat_id is empty.`);
      if (!channel.isAllowlisted(chatId)) {
        throw new Error(`${spec.name}: chat_id ${chatId} is not in the Telegram allowlist.`);
      }

      const renderedFileItemId = params.file_item_id
        ? renderTemplate(params.file_item_id, vars).trim() || undefined
        : undefined;
      const renderedFilePath = params.file_path
        ? renderTemplate(params.file_path, vars).trim() || undefined
        : undefined;

      let resolved;
      try {
        resolved = await resolveMediaInput(port, renderedFileItemId, renderedFilePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${spec.name}: ${msg}`);
      }

      const caption = spec.acceptsCaption && params.caption
        ? renderTemplate(params.caption, vars)
        : undefined;

      const fn = channel[spec.channelMethod].bind(channel) as (
        chatId: string,
        filePath: string,
        caption?: string,
      ) => Promise<{ messageId: number | null; error: string | null }>;
      const { messageId, error } = await fn(chatId, resolved.absPath, caption);

      if (error) {
        input.context.log(`${spec.name} failed for ${chatId}: ${error}`);
        return {
          data: {
            sent: false,
            message_id: messageId,
            chat_id: chatId,
            file_name: resolved.fileName,
            size_bytes: resolved.sizeBytes,
            error,
          },
          summary: `${spec.name}: ${error}`,
        };
      }
      input.context.log(
        `${spec.name}: sent ${resolved.fileName} (${resolved.sizeBytes} bytes) to ${chatId}`,
      );
      return {
        data: {
          sent: true,
          message_id: messageId,
          chat_id: chatId,
          file_name: resolved.fileName,
          size_bytes: resolved.sizeBytes,
          error: null,
        },
        summary: `Sent ${spec.chatLabel.en.toLowerCase()} (${resolved.fileName}) to ${chatId}`,
      };
    },
  };
}

/** Location is its own factory because it doesn't take a file. */
export function createSendTelegramLocationAction(deps: {
  getChannel: () => TelegramChannel | null;
}): ActionDefinition {
  return {
    type: 'send_telegram_location',
    name: 'Send Telegram Location',
    description: 'Send a static location pin (latitude/longitude) via the Telegram bot.',
    chatExposable: true,
    chatGroup: 'telegram',
    chatLabel: { en: 'Send Telegram location', es: 'Enviar ubicación por Telegram' },
    chatDescription: {
      en: 'Send a static location pin to a Telegram chat (no live tracking).',
      es: 'Envía un pin de ubicación a un chat de Telegram (sin seguimiento en vivo).',
    },
    chatExamples: [
      {
        en: 'Send Pablo my coordinates on Telegram.',
        es: 'Mándale a Pablo mis coordenadas por Telegram.',
      },
    ],
    availabilityCheck: () => {
      const ch = deps.getChannel();
      if (!ch) return 'not_connected';
      return ch.isConnected() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#telegram',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Numeric Telegram chat id. Templated.' },
        latitude: { type: ['number', 'string'], description: 'Decimal latitude.' },
        longitude: { type: ['number', 'string'], description: 'Decimal longitude.' },
      },
      required: ['chat_id', 'latitude', 'longitude'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        sent: { type: 'boolean' },
        message_id: { type: ['number', 'null'] },
        chat_id: { type: 'string' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        error: { type: ['string', 'null'] },
      },
      required: ['sent', 'chat_id'],
    },
    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) {
        throw new Error(
          'Send Telegram Location: Telegram bridge is not enabled. Connect Telegram in Integrations first.',
        );
      }
      const params = input.params as unknown as LocationParams;
      const vars = input.wiredInputs ?? {};

      const chatId = renderTemplate(params.chat_id ?? '', vars).trim();
      if (!chatId) throw new Error('Send Telegram Location: chat_id is empty.');
      if (!channel.isAllowlisted(chatId)) {
        throw new Error(`Send Telegram Location: chat_id ${chatId} is not in the Telegram allowlist.`);
      }
      const lat = Number(typeof params.latitude === 'string'
        ? renderTemplate(params.latitude, vars)
        : params.latitude);
      const lon = Number(typeof params.longitude === 'string'
        ? renderTemplate(params.longitude, vars)
        : params.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error('Send Telegram Location: latitude/longitude must be numeric.');
      }
      const { messageId, error } = await channel.sendLocationActionMessage(chatId, lat, lon);
      if (error) {
        return {
          data: { sent: false, message_id: messageId, chat_id: chatId, latitude: lat, longitude: lon, error },
          summary: `Send Telegram location failed: ${error}`,
        };
      }
      return {
        data: { sent: true, message_id: messageId, chat_id: chatId, latitude: lat, longitude: lon, error: null },
        summary: `Sent location (${lat}, ${lon}) to Telegram chat ${chatId}`,
      };
    },
  };
}
