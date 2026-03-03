/**
 * transformer action — pure data transformation.
 *
 * Runs entirely in the main process with no HTTP calls or LLM invocation.
 * Five operations: format, extract, filter, merge, template.
 *
 * SAFETY: No eval(), no new Function(), no arbitrary JS execution.
 * Filter predicates use expr-eval (safe expression evaluator).
 * Note: expr-eval uses `and`/`or`/`not` keywords (not `&&`/`||`/`!`).
 * Template rendering uses Mustache (logic-less, no code execution).
 * This is critical because routine definitions may come from marketplace packs.
 */

import Mustache from 'mustache';
import { Parser } from 'expr-eval';
import type { ActionDefinition, ActionInput, ActionOutput } from './types';

// ── Types ───────────────────────────────────────────────────────

type TransformOperation = 'format' | 'extract' | 'filter' | 'merge' | 'template';

interface TransformerParams {
  operation: TransformOperation;
  template?: string;
  path?: string;
  predicate?: string;
  mergeStrategy?: 'shallow' | 'deep';
}

// ── Action definition ───────────────────────────────────────────

export const transformerAction: ActionDefinition = {
  type: 'transformer',
  name: 'Transformer',
  description: 'Pure data transformation: format, extract, filter, merge, template.',

  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['format', 'extract', 'filter', 'merge', 'template'],
        description: 'Which transform operation to run',
      },
      template: { type: 'string', description: 'Template string for format/template operations' },
      path: { type: 'string', description: 'Dot-path for extract operation' },
      predicate: { type: 'string', description: 'Safe expression for filter operation' },
      mergeStrategy: {
        type: 'string',
        enum: ['shallow', 'deep'],
        description: 'Merge strategy (default: shallow)',
      },
    },
    required: ['operation'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      result: { description: 'The transformed data' },
    },
    required: ['result'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as TransformerParams;
    const data = input.wiredInputs;

    let result: unknown;

    switch (params.operation) {
      case 'format':
        result = formatOp(params.template ?? '', data.data as Record<string, unknown> ?? {});
        break;
      case 'extract':
        result = extractOp(params.path ?? '', data.data);
        break;
      case 'filter':
        result = filterOp(params.predicate ?? '', data.items as unknown[] ?? []);
        break;
      case 'merge':
        result = mergeOp(data.sources as Record<string, unknown>[] ?? [], params.mergeStrategy ?? 'shallow');
        break;
      case 'template':
        result = templateOp(params.template ?? '', data.data as Record<string, unknown> ?? {});
        break;
      default:
        throw new Error(`Unknown transformer operation: ${params.operation}`);
    }

    return {
      data: { result },
      summary: `Transformed data (${params.operation})`,
    };
  },
};

// ── format: simple {{key}} interpolation ────────────────────────

function formatOp(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
    const value = extractByPath(data, key);
    return value !== undefined ? String(value) : '';
  });
}

// ── extract: dot-path traversal ─────────────────────────────────

function extractOp(path: string, data: unknown): unknown {
  return extractByPath(data, path);
}

function extractByPath(data: unknown, path: string): unknown {
  if (!path) return data;

  const segments = parsePath(path);
  let current: unknown = data;

  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;

    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }

  return current;
}

/**
 * Parse a dot-path like "data.events[0].title" into segments.
 * Returns array of string keys and number indices.
 */
function parsePath(path: string): Array<string | number> {
  const segments: Array<string | number> = [];
  const re = /([^.[]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(path)) !== null) {
    if (match[1] !== undefined) {
      segments.push(match[1]);
    } else if (match[2] !== undefined) {
      segments.push(parseInt(match[2], 10));
    }
  }

  return segments;
}

// ── filter: safe predicate evaluation via expr-eval ─────────────

function filterOp(predicate: string, items: unknown[]): unknown[] {
  if (!predicate.trim()) return items;

  const parser = new Parser();
  const expr = parser.parse(predicate);

  return items.filter((item) => {
    if (typeof item !== 'object' || item === null) return false;
    try {
      return Boolean(expr.evaluate(item as Record<string, unknown>));
    } catch {
      return false;
    }
  });
}

// ── merge: combine objects ──────────────────────────────────────

function mergeOp(sources: Record<string, unknown>[], strategy: 'shallow' | 'deep'): Record<string, unknown> {
  if (strategy === 'deep') {
    return sources.reduce((acc, src) => deepMerge(acc, src), {} as Record<string, unknown>);
  }
  return Object.assign({}, ...sources);
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const targetVal = target[key];
    const sourceVal = source[key];

    if (
      targetVal && sourceVal &&
      typeof targetVal === 'object' && !Array.isArray(targetVal) &&
      typeof sourceVal === 'object' && !Array.isArray(sourceVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }

  return result;
}

// ── template: Mustache rendering ────────────────────────────────

function templateOp(template: string, data: Record<string, unknown>): string {
  return Mustache.render(template, data);
}
