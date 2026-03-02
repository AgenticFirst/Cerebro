/**
 * Custom StreamFn that routes to our Python backend SSE endpoints.
 *
 * This bridges pi-agent-core's streaming interface with our backend's
 * /cloud/chat and /models/chat SSE endpoints.
 */

import http from 'node:http';
import type { ResolvedModel } from './types';

import { createAssistantMessageEventStream } from '@mariozechner/pi-ai';
import type { AssistantMessageEventStream } from '@mariozechner/pi-ai';

interface StreamFnContext {
  systemPrompt?: string;
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
    timestamp?: number;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  }>;
  tools?: Array<{ name: string; description: string; parameters: unknown }>;
}

interface BackendChatStreamEvent {
  token?: string | null;
  done?: boolean;
  finish_reason?: string | null;
  usage?: Record<string, unknown> | null;
  tool_calls?: Array<{ id: string; name: string; arguments: string }> | null;
}

/**
 * Creates a streamFn bound to a specific resolved model and backend port.
 */
export function createBackendStreamFn(resolvedModel: ResolvedModel, backendPort: number) {
  // Return a function matching pi-agent-core's StreamFn type
  // StreamFn = (...args: Parameters<typeof streamSimple>) => AssistantMessageEventStream
  return function backendStreamFn(
    _model: unknown,
    context: StreamFnContext,
    options?: { signal?: AbortSignal; maxTokens?: number; temperature?: number },
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();

    // Convert pi-agent-core context to our backend format
    const backendMessages = convertMessages(context);
    const backendTools = convertTools(context.tools);

    // Determine endpoint
    const isLocal = resolvedModel.source === 'local';
    const path = isLocal ? '/models/chat' : '/cloud/chat';

    const body: Record<string, unknown> = {
      messages: backendMessages,
      stream: true,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
    };

    if (!isLocal) {
      body.provider = resolvedModel.provider;
      body.model = resolvedModel.modelId;
    }

    if (backendTools && backendTools.length > 0) {
      body.tools = backendTools;
    }

    // Start async streaming
    streamFromBackend(backendPort, path, body, stream, options?.signal);

    return stream;
  };
}

function convertMessages(context: StreamFnContext): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  // Add system prompt
  if (context.systemPrompt) {
    result.push({ role: 'system', content: context.systemPrompt });
  }

  for (const msg of context.messages) {
    if (msg.role === 'user') {
      const content = typeof msg.content === 'string'
        ? msg.content
        : msg.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n');
      result.push({ role: 'user', content });
    } else if (msg.role === 'assistant') {
      // Extract text and tool calls from content array
      const contentParts = Array.isArray(msg.content) ? msg.content : [];
      const textParts = contentParts
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
      const toolCalls = contentParts
        .filter((c) => c.type === 'toolCall')
        .map((c) => ({
          id: c.id ?? '',
          name: c.name ?? '',
          arguments: JSON.stringify(c.arguments ?? {}),
        }));

      const assistantMsg: Record<string, unknown> = { role: 'assistant' };
      if (textParts) assistantMsg.content = textParts;
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      if (!textParts && toolCalls.length === 0) assistantMsg.content = '';
      result.push(assistantMsg);
    } else if (msg.role === 'toolResult') {
      result.push({
        role: 'tool',
        tool_call_id: (msg as any).toolCallId ?? '',
        tool_name: (msg as any).toolName ?? '',
        content: typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((c) => c.type === 'text')
                .map((c) => c.text)
                .join('\n')
            : '',
      });
    }
  }

  return result;
}

function convertTools(
  tools?: Array<{ name: string; description: string; parameters: unknown }>,
): Array<Record<string, unknown>> | null {
  if (!tools || tools.length === 0) return null;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

function streamFromBackend(
  port: number,
  path: string,
  body: Record<string, unknown>,
  stream: AssistantMessageEventStream,
  signal?: AbortSignal,
): void {
  const bodyStr = JSON.stringify(body);

  const options: http.RequestOptions = {
    hostname: '127.0.0.1',
    port,
    path,
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr).toString(),
    },
  };

  const req = http.request(options, (res) => {
    if (res.statusCode && res.statusCode >= 400) {
      let errorBody = '';
      res.on('data', (chunk: Buffer) => {
        errorBody += chunk.toString();
      });
      res.on('end', () => {
        let errorMsg = `Backend error (${res.statusCode})`;
        try {
          const parsed = JSON.parse(errorBody);
          if (parsed.detail) errorMsg = parsed.detail;
        } catch {
          // use default
        }
        emitError(stream, errorMsg);
      });
      return;
    }

    let buffer = '';
    let contentIndex = 0;
    let accumulatedText = '';
    let toolCallIndex = 0;

    // Build the partial AssistantMessage-like object for events
    const partialContent: unknown[] = [];
    const partial = {
      role: 'assistant' as const,
      content: partialContent,
      api: 'custom' as const,
      provider: 'cerebro' as const,
      model: 'cerebro',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop' as const,
      timestamp: Date.now(),
    };

    // Emit start
    stream.push({ type: 'start', partial: partial as any });

    res.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);

        let event: BackendChatStreamEvent;
        try {
          event = JSON.parse(dataStr);
        } catch {
          continue;
        }

        // Handle text tokens
        if (event.token) {
          if (accumulatedText === '') {
            // First text — emit text_start
            partialContent.push({ type: 'text', text: '' });
            stream.push({ type: 'text_start', contentIndex, partial: partial as any });
          }
          accumulatedText += event.token;
          (partialContent[contentIndex] as any).text = accumulatedText;
          stream.push({ type: 'text_delta', contentIndex, delta: event.token, partial: partial as any });
        }

        // Handle tool calls
        if (event.tool_calls && event.tool_calls.length > 0) {
          // Close text block if open
          if (accumulatedText !== '') {
            stream.push({ type: 'text_end', contentIndex, content: accumulatedText, partial: partial as any });
            contentIndex++;
            accumulatedText = '';
          }

          for (const tc of event.tool_calls) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.arguments || '{}');
            } catch {
              // leave empty
            }
            const toolCall = {
              type: 'toolCall' as const,
              id: tc.id,
              name: tc.name,
              arguments: args,
            };
            partialContent.push(toolCall);
            stream.push({ type: 'toolcall_start', contentIndex, partial: partial as any });
            stream.push({ type: 'toolcall_delta', contentIndex, delta: tc.arguments || '{}', partial: partial as any });
            stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: partial as any });
            contentIndex++;
            toolCallIndex++;
          }
        }

        // Handle done
        if (event.done) {
          // Close text block if still open
          if (accumulatedText !== '') {
            stream.push({ type: 'text_end', contentIndex, content: accumulatedText, partial: partial as any });
          }

          if (event.finish_reason === 'error') {
            const errorMsg = (event.usage as any)?.error || 'Request failed';
            emitError(stream, errorMsg);
            return;
          }

          const hasToolCalls = toolCallIndex > 0;
          const stopReason = hasToolCalls ? 'toolUse' : 'stop';
          partial.stopReason = stopReason as any;

          stream.push({
            type: 'done',
            reason: stopReason as any,
            message: partial as any,
          });
          return;
        }
      }
    });

    res.on('end', () => {
      // If stream ended without a done event, emit done
      if (accumulatedText !== '') {
        stream.push({ type: 'text_end', contentIndex, content: accumulatedText, partial: partial as any });
      }
      stream.push({ type: 'done', reason: 'stop' as any, message: partial as any });
    });

    res.on('error', (err) => {
      emitError(stream, err.message);
    });
  });

  req.on('error', (err) => {
    emitError(stream, err.message);
  });

  // Handle abort
  if (signal) {
    signal.addEventListener('abort', () => {
      req.destroy();
    });
  }

  req.write(bodyStr);
  req.end();
}

function emitError(stream: AssistantMessageEventStream, message: string): void {
  const errorPartial = {
    role: 'assistant' as const,
    content: [],
    api: 'custom' as const,
    provider: 'cerebro' as const,
    model: 'cerebro',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'error' as const,
    errorMessage: message,
    timestamp: Date.now(),
  };
  stream.push({ type: 'error', reason: 'error' as any, error: errorPartial as any });
}
