import { describe, it, expect } from 'vitest';
import { pickApprovalRun, type ApprovalRunCandidate } from '../approval-routing';

function run(id: string, conversationId: string, startedAt: number): ApprovalRunCandidate<string> {
  return { id, conversationId, startedAt };
}

describe('pickApprovalRun', () => {
  it('returns null when there are no active runs', () => {
    expect(pickApprovalRun([], 'conv-a')).toBeNull();
    expect(pickApprovalRun([], undefined)).toBeNull();
  });

  it('routes to the run whose conversationId matches — even with several in flight', () => {
    const runs = [
      run('A', 'conv-a', 100),
      run('B', 'conv-b', 200),
      run('C', 'conv-c', 300),
    ];
    // The old `size !== 1` heuristic would have dropped this; we route precisely.
    expect(pickApprovalRun(runs, 'conv-b')).toBe('B');
    expect(pickApprovalRun(runs, 'conv-a')).toBe('A');
  });

  it('falls back to the most recently started run when the conversationId does not match', () => {
    const runs = [
      run('A', 'conv-a', 100),
      run('B', 'conv-b', 300),
      run('C', 'conv-c', 200),
    ];
    // Never silently drop a chat-action approval — that would stall the engine.
    expect(pickApprovalRun(runs, 'conv-unknown')).toBe('B');
  });

  it('matches the single active run by id when its conversationId matches', () => {
    expect(pickApprovalRun([run('A', 'conv-a', 100)], 'conv-a')).toBe('A');
  });

  it('without a conversationId, attributes only when exactly one run is active', () => {
    expect(pickApprovalRun([run('A', 'conv-a', 100)], undefined)).toBe('A');
    expect(
      pickApprovalRun([run('A', 'conv-a', 100), run('B', 'conv-b', 200)], undefined),
    ).toBeNull();
  });
});
