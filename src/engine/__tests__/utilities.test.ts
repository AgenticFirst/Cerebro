/**
 * Unit tests for engine utility modules:
 * - ActionRegistry
 * - RunScratchpad
 * - RunEventEmitter
 * - parsePath / extractByPath
 */

import { describe, it, expect, vi } from 'vitest';
import { ActionRegistry } from '../actions/registry';
import { RunScratchpad } from '../scratchpad';
import { RunEventEmitter } from '../events/emitter';
import { parsePath, extractByPath } from '../utils';
import type { ActionDefinition } from '../actions/types';
import type { ExecutionEvent } from '../events/types';

// ── ActionRegistry ──────────────────────────────────────────────

function makeFakeAction(type: string): ActionDefinition {
  return {
    type,
    name: `${type} action`,
    description: `A ${type} action`,
    inputSchema: {},
    outputSchema: {},
    execute: async () => ({ data: {}, summary: 'ok' }),
  };
}

describe('ActionRegistry', () => {
  it('register and retrieve an action', () => {
    const registry = new ActionRegistry();
    const action = makeFakeAction('test');
    registry.register(action);
    expect(registry.get('test')).toBe(action);
    expect(registry.has('test')).toBe(true);
  });

  it('duplicate registration throws', () => {
    const registry = new ActionRegistry();
    registry.register(makeFakeAction('test'));
    expect(() => registry.register(makeFakeAction('test'))).toThrow('already registered');
  });

  it('get() returns undefined for unknown type', () => {
    const registry = new ActionRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('list() returns all registered actions', () => {
    const registry = new ActionRegistry();
    registry.register(makeFakeAction('alpha'));
    registry.register(makeFakeAction('beta'));
    registry.register(makeFakeAction('gamma'));
    const listed = registry.list();
    expect(listed).toHaveLength(3);
    expect(listed.map(a => a.type).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });
});

// ── RunScratchpad ───────────────────────────────────────────────

describe('RunScratchpad', () => {
  it('set and get round-trip', () => {
    const pad = new RunScratchpad();
    pad.set('greeting', 'hello');
    expect(pad.get('greeting')).toBe('hello');
  });

  it('get missing key returns undefined', () => {
    const pad = new RunScratchpad();
    expect(pad.get('missing')).toBeUndefined();
  });

  it('has() returns correct boolean', () => {
    const pad = new RunScratchpad();
    expect(pad.has('key')).toBe(false);
    pad.set('key', 42);
    expect(pad.has('key')).toBe(true);
  });

  it('clear() removes all entries', () => {
    const pad = new RunScratchpad();
    pad.set('a', 1);
    pad.set('b', 2);
    expect(pad.entries()).toHaveLength(2);
    pad.clear();
    expect(pad.entries()).toHaveLength(0);
    expect(pad.has('a')).toBe(false);
  });
});

// ── RunEventEmitter ─────────────────────────────────────────────

describe('RunEventEmitter', () => {
  const makeEvent = (type: string): ExecutionEvent => ({
    type: 'step_log',
    runId: 'run-1',
    stepId: 'step-1',
    message: type,
    timestamp: new Date().toISOString(),
  });

  it('emit() buffers events in order', () => {
    const wc = { isDestroyed: () => false, send: vi.fn() } as any;
    const emitter = new RunEventEmitter(wc, 'run-1');

    emitter.emit(makeEvent('first'));
    emitter.emit(makeEvent('second'));
    emitter.emit(makeEvent('third'));

    const buffer = emitter.getBuffer();
    expect(buffer).toHaveLength(3);
    expect((buffer[0] as any).message).toBe('first');
    expect((buffer[1] as any).message).toBe('second');
    expect((buffer[2] as any).message).toBe('third');
  });

  it('emit() sends via webContents.send with correct channel', () => {
    const send = vi.fn();
    const wc = { isDestroyed: () => false, send } as any;
    const emitter = new RunEventEmitter(wc, 'my-run');

    const event = makeEvent('test');
    emitter.emit(event);

    // Sends to run-specific channel + wildcard channel for cross-run listeners
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith('engine:event:my-run', event);
    expect(send).toHaveBeenCalledWith('engine:any-event', event);
  });

  it('emit() skips send when webContents.isDestroyed() returns true', () => {
    const send = vi.fn();
    const wc = { isDestroyed: () => true, send } as any;
    const emitter = new RunEventEmitter(wc, 'run-1');

    emitter.emit(makeEvent('test'));

    // Still buffered
    expect(emitter.getBuffer()).toHaveLength(1);
    // But not sent
    expect(send).not.toHaveBeenCalled();
  });

  it('getBuffer() returns copy, clear() empties buffer', () => {
    const wc = { isDestroyed: () => false, send: vi.fn() } as any;
    const emitter = new RunEventEmitter(wc, 'run-1');

    emitter.emit(makeEvent('a'));
    emitter.emit(makeEvent('b'));

    const bufferCopy = emitter.getBuffer();
    expect(bufferCopy).toHaveLength(2);

    emitter.clear();
    expect(emitter.getBuffer()).toHaveLength(0);
    // Original copy unaffected
    expect(bufferCopy).toHaveLength(2);
  });
});

// ── parsePath ───────────────────────────────────────────────────

describe('parsePath', () => {
  it('simple dot-path: "a.b.c"', () => {
    expect(parsePath('a.b.c')).toEqual(['a', 'b', 'c']);
  });

  it('array index: "items[0].name"', () => {
    expect(parsePath('items[0].name')).toEqual(['items', 0, 'name']);
  });

  it('consecutive brackets: "matrix[1][0]"', () => {
    expect(parsePath('matrix[1][0]')).toEqual(['matrix', 1, 0]);
  });
});

// ── extractByPath ───────────────────────────────────────────────

describe('extractByPath', () => {
  it('extracts from nested object', () => {
    const data = { user: { profile: { name: 'Alice' } } };
    expect(extractByPath(data, 'user.profile.name')).toBe('Alice');
  });

  it('returns undefined for missing path', () => {
    const data = { a: { b: 1 } };
    expect(extractByPath(data, 'a.c.d')).toBeUndefined();
  });

  it('handles null/undefined in chain', () => {
    expect(extractByPath(null, 'a.b')).toBeUndefined();
    expect(extractByPath(undefined, 'a')).toBeUndefined();
    expect(extractByPath({ a: null }, 'a.b')).toBeUndefined();
  });

  it('empty path returns data itself', () => {
    const data = { x: 1 };
    expect(extractByPath(data, '')).toBe(data);
  });

  it('array index access', () => {
    const data = { items: ['a', 'b', 'c'] };
    expect(extractByPath(data, 'items[1]')).toBe('b');
  });

  it('returns undefined for out-of-bounds array index', () => {
    const data = { items: [1, 2] };
    expect(extractByPath(data, 'items[5]')).toBeUndefined();
  });
});
