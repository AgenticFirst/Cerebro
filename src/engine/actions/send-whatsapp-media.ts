/**
 * send_whatsapp_{photo,document,audio,video,voice,sticker,location} —
 * outbound-media chat actions for WhatsApp. Mirrors send-telegram-media.ts.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import { resolveMediaInput } from './utils/media-resolver';
import type { WhatsAppChannel } from './whatsapp-channel';

interface BaseMediaParams {
  phone_number: string;
  file_item_id?: string;
  file_path?: string;
  caption?: string;
}

interface LocationParams {
  phone_number: string;
  latitude: number | string;
  longitude: number | string;
}

type MediaMethod =
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
  channelMethod: MediaMethod;
  acceptsCaption: boolean;
  chatLabel: { en: string; es: string };
  chatDescription: { en: string; es: string };
  chatExamples: Array<{ en: string; es: string }>;
}

const SPECS: MediaSpec[] = [
  {
    type: 'send_whatsapp_photo',
    name: 'Send WhatsApp Photo',
    description: 'Send a photo via WhatsApp. Allowlist-enforced.',
    channelMethod: 'sendPhotoActionMessage',
    acceptsCaption: true,
    chatLabel: { en: 'Send WhatsApp photo', es: 'Enviar foto por WhatsApp' },
    chatDescription: {
      en: 'Send a photo (PNG/JPG/WebP) to a WhatsApp number.',
      es: 'Envía una foto (PNG/JPG/WebP) a un número de WhatsApp.',
    },
    chatExamples: [
      {
        en: "Send Maria the screenshot on WhatsApp.",
        es: 'Envíale a Maria la captura por WhatsApp.',
      },
    ],
  },
  {
    type: 'send_whatsapp_document',
    name: 'Send WhatsApp Document',
    description: 'Send any file as a document via WhatsApp.',
    channelMethod: 'sendDocumentActionMessage',
    acceptsCaption: true,
    chatLabel: { en: 'Send WhatsApp document', es: 'Enviar documento por WhatsApp' },
    chatDescription: {
      en: 'Send a document (PDF, Word, Excel, etc.) to a WhatsApp number.',
      es: 'Envía un documento (PDF, Word, Excel, etc.) a un número de WhatsApp.',
    },
    chatExamples: [
      {
        en: 'Send Maria the manual as a PDF on WhatsApp.',
        es: 'Mándale a Maria el manual en PDF por WhatsApp.',
      },
    ],
  },
  {
    type: 'send_whatsapp_audio',
    name: 'Send WhatsApp Audio',
    description: 'Send a music/audio file via WhatsApp.',
    channelMethod: 'sendAudioActionMessage',
    acceptsCaption: false,
    chatLabel: { en: 'Send WhatsApp audio', es: 'Enviar audio por WhatsApp' },
    chatDescription: {
      en: 'Send an audio file (MP3/M4A/WAV) to a WhatsApp number.',
      es: 'Envía un archivo de audio (MP3/M4A/WAV) a un número de WhatsApp.',
    },
    chatExamples: [
      {
        en: 'Send Maria this MP3 on WhatsApp.',
        es: 'Envíale a Maria este MP3 por WhatsApp.',
      },
    ],
  },
  {
    type: 'send_whatsapp_video',
    name: 'Send WhatsApp Video',
    description: 'Send a video via WhatsApp.',
    channelMethod: 'sendVideoActionMessage',
    acceptsCaption: true,
    chatLabel: { en: 'Send WhatsApp video', es: 'Enviar video por WhatsApp' },
    chatDescription: {
      en: 'Send a video (MP4) to a WhatsApp number.',
      es: 'Envía un video (MP4) a un número de WhatsApp.',
    },
    chatExamples: [
      {
        en: 'Send Maria this clip on WhatsApp.',
        es: 'Mándale este clip a Maria por WhatsApp.',
      },
    ],
  },
  {
    type: 'send_whatsapp_voice',
    name: 'Send WhatsApp Voice Note',
    description: 'Send a voice note (PTT — push-to-talk) via WhatsApp.',
    channelMethod: 'sendVoiceActionMessage',
    acceptsCaption: false,
    chatLabel: { en: 'Send WhatsApp voice note', es: 'Enviar nota de voz por WhatsApp' },
    chatDescription: {
      en: 'Send a voice note (OGG opus, displayed as a waveform) on WhatsApp.',
      es: 'Envía una nota de voz (OGG opus, aparece como onda) por WhatsApp.',
    },
    chatExamples: [
      {
        en: 'Reply to Maria on WhatsApp with a voice note.',
        es: 'Respóndele a Maria en WhatsApp con una nota de voz.',
      },
    ],
  },
  {
    type: 'send_whatsapp_sticker',
    name: 'Send WhatsApp Sticker',
    description: 'Send a sticker (WebP) via WhatsApp.',
    channelMethod: 'sendStickerActionMessage',
    acceptsCaption: false,
    chatLabel: { en: 'Send WhatsApp sticker', es: 'Enviar sticker por WhatsApp' },
    chatDescription: {
      en: 'Send a sticker (WebP) to a WhatsApp number.',
      es: 'Envía un sticker (WebP) a un número de WhatsApp.',
    },
    chatExamples: [
      {
        en: 'Send Maria a sticker on WhatsApp.',
        es: 'Envíale un sticker a Maria por WhatsApp.',
      },
    ],
  },
];

export function createSendWhatsAppMediaActions(deps: {
  getChannel: () => WhatsAppChannel | null;
  backendPort: () => number | null;
}): ActionDefinition[] {
  return SPECS.map((spec) => makeMediaAction(spec, deps));
}

function makeMediaAction(
  spec: MediaSpec,
  deps: { getChannel: () => WhatsAppChannel | null; backendPort: () => number | null },
): ActionDefinition {
  return {
    type: spec.type,
    name: spec.name,
    description: spec.description,
    chatExposable: true,
    chatGroup: 'whatsapp',
    chatLabel: spec.chatLabel,
    chatDescription: spec.chatDescription,
    chatExamples: spec.chatExamples,
    availabilityCheck: () => {
      const ch = deps.getChannel();
      if (!ch) return 'not_connected';
      return ch.isConnected() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#whatsapp',
    inputSchema: {
      type: 'object',
      properties: {
        phone_number: {
          type: 'string',
          description: 'WhatsApp phone (E.164 or digits) from your allowlist. Templated.',
        },
        file_item_id: { type: 'string', description: 'Preferred: id of a registered FileItem on disk.' },
        file_path: {
          type: 'string',
          description: 'Escape hatch: absolute path to a file on disk Cerebro just created.',
        },
        ...(spec.acceptsCaption
          ? { caption: { type: 'string', description: 'Optional caption. Templated.' } }
          : {}),
      },
      required: ['phone_number'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        sent: { type: 'boolean' },
        message_id: { type: ['string', 'null'] },
        phone_number: { type: 'string' },
        file_name: { type: 'string' },
        size_bytes: { type: 'number' },
        error: { type: ['string', 'null'] },
      },
      required: ['sent', 'phone_number'],
    },
    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) {
        throw new Error(
          `${spec.name}: WhatsApp bridge is not enabled. Connect WhatsApp in Integrations first.`,
        );
      }
      const port = deps.backendPort();
      if (!port) throw new Error(`${spec.name}: backend not ready.`);

      const params = input.params as unknown as BaseMediaParams;
      const vars = input.wiredInputs ?? {};

      const phone = renderTemplate(params.phone_number ?? '', vars).trim();
      if (!phone) throw new Error(`${spec.name}: phone_number is empty.`);
      if (!channel.isAllowlisted(phone)) {
        throw new Error(`${spec.name}: phone_number ${phone} is not in the WhatsApp allowlist.`);
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

      let outcome: { messageId: string | null; error: string | null };
      if (spec.channelMethod === 'sendDocumentActionMessage') {
        outcome = await channel.sendDocumentActionMessage(
          phone,
          resolved.absPath,
          caption,
          resolved.fileName,
        );
      } else if (spec.channelMethod === 'sendAudioActionMessage') {
        outcome = await channel.sendAudioActionMessage(phone, resolved.absPath);
      } else if (spec.channelMethod === 'sendVoiceActionMessage') {
        outcome = await channel.sendVoiceActionMessage(phone, resolved.absPath);
      } else if (spec.channelMethod === 'sendStickerActionMessage') {
        outcome = await channel.sendStickerActionMessage(phone, resolved.absPath);
      } else {
        const fn = channel[spec.channelMethod].bind(channel) as (
          phone: string,
          path: string,
          caption?: string,
        ) => Promise<{ messageId: string | null; error: string | null }>;
        outcome = await fn(phone, resolved.absPath, caption);
      }

      if (outcome.error) {
        input.context.log(`${spec.name} failed for ${phone}: ${outcome.error}`);
        return {
          data: {
            sent: false,
            message_id: outcome.messageId,
            phone_number: phone,
            file_name: resolved.fileName,
            size_bytes: resolved.sizeBytes,
            error: outcome.error,
          },
          summary: `${spec.name}: ${outcome.error}`,
        };
      }
      input.context.log(`${spec.name}: sent ${resolved.fileName} (${resolved.sizeBytes} bytes) to ${phone}`);
      return {
        data: {
          sent: true,
          message_id: outcome.messageId,
          phone_number: phone,
          file_name: resolved.fileName,
          size_bytes: resolved.sizeBytes,
          error: null,
        },
        summary: `Sent ${spec.chatLabel.en.toLowerCase()} (${resolved.fileName}) to ${phone}`,
      };
    },
  };
}

export function createSendWhatsAppLocationAction(deps: {
  getChannel: () => WhatsAppChannel | null;
}): ActionDefinition {
  return {
    type: 'send_whatsapp_location',
    name: 'Send WhatsApp Location',
    description: 'Send a static location pin via WhatsApp.',
    chatExposable: true,
    chatGroup: 'whatsapp',
    chatLabel: { en: 'Send WhatsApp location', es: 'Enviar ubicación por WhatsApp' },
    chatDescription: {
      en: 'Send a static location pin to a WhatsApp number.',
      es: 'Envía un pin de ubicación a un número de WhatsApp.',
    },
    chatExamples: [
      {
        en: 'Send Maria my coordinates on WhatsApp.',
        es: 'Mándale a Maria mis coordenadas por WhatsApp.',
      },
    ],
    availabilityCheck: () => {
      const ch = deps.getChannel();
      if (!ch) return 'not_connected';
      return ch.isConnected() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#whatsapp',
    inputSchema: {
      type: 'object',
      properties: {
        phone_number: { type: 'string', description: 'Phone (E.164 or digits). Templated.' },
        latitude: { type: ['number', 'string'], description: 'Decimal latitude.' },
        longitude: { type: ['number', 'string'], description: 'Decimal longitude.' },
      },
      required: ['phone_number', 'latitude', 'longitude'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        sent: { type: 'boolean' },
        message_id: { type: ['string', 'null'] },
        phone_number: { type: 'string' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        error: { type: ['string', 'null'] },
      },
      required: ['sent', 'phone_number'],
    },
    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) {
        throw new Error(
          'Send WhatsApp Location: WhatsApp bridge is not enabled. Connect WhatsApp in Integrations first.',
        );
      }
      const params = input.params as unknown as LocationParams;
      const vars = input.wiredInputs ?? {};

      const phone = renderTemplate(params.phone_number ?? '', vars).trim();
      if (!phone) throw new Error('Send WhatsApp Location: phone_number is empty.');
      if (!channel.isAllowlisted(phone)) {
        throw new Error(`Send WhatsApp Location: phone_number ${phone} is not in the WhatsApp allowlist.`);
      }
      const lat = Number(typeof params.latitude === 'string'
        ? renderTemplate(params.latitude, vars)
        : params.latitude);
      const lon = Number(typeof params.longitude === 'string'
        ? renderTemplate(params.longitude, vars)
        : params.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error('Send WhatsApp Location: latitude/longitude must be numeric.');
      }
      const { messageId, error } = await channel.sendLocationActionMessage(phone, lat, lon);
      if (error) {
        return {
          data: { sent: false, message_id: messageId, phone_number: phone, latitude: lat, longitude: lon, error },
          summary: `Send WhatsApp location failed: ${error}`,
        };
      }
      return {
        data: { sent: true, message_id: messageId, phone_number: phone, latitude: lat, longitude: lon, error: null },
        summary: `Sent location (${lat}, ${lon}) to WhatsApp ${phone}`,
      };
    },
  };
}
