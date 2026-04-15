import { describe, it, expect } from 'vitest';
import { TaskStreamParser, type TaskStreamEvent } from './stream-parser';

function feedChunked(parser: TaskStreamParser, text: string, chunkSize = 7): TaskStreamEvent[] {
  const events: TaskStreamEvent[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    events.push(...parser.feed(text.slice(i, i + chunkSize)));
  }
  return events;
}

// ── Plan mode ────────────────────────────────────────────────

describe('TaskStreamParser (plan)', () => {
  it('parses clarification questions', () => {
    const p = new TaskStreamParser('plan');
    const json = JSON.stringify({
      questions: [
        { id: 'q1', kind: 'text', q: 'What style?', placeholder: 'e.g. modern' },
        { id: 'q2', kind: 'bool', q: 'Include dark mode?', default: true },
      ],
    });
    const events = p.feed(`<clarification>${json}</clarification>`);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('clarification');
    if (events[0].type === 'clarification') {
      expect(events[0].questions).toHaveLength(2);
      expect(events[0].questions[0].id).toBe('q1');
    }
  });

  it('handles chunked clarification', () => {
    const p = new TaskStreamParser('plan');
    const json = JSON.stringify({
      questions: [{ id: 'q1', kind: 'select', q: 'Platform?', options: ['Web', 'Mobile'] }],
    });
    const events = feedChunked(p, `<clarification>${json}</clarification>`, 10);
    expect(events.some((e) => e.type === 'clarification')).toBe(true);
  });

  it('does not spin on malformed clarification JSON', () => {
    // Regression: previously the silent catch held the parser in an
    // infinite re-match loop when JSON was invalid. Now we emit an
    // empty questions set and consume the match.
    const p = new TaskStreamParser('plan');
    const events = p.feed('<clarification>{not-json}</clarification>');
    expect(events).toHaveLength(1);
    if (events[0].type === 'clarification') {
      expect(events[0].questions).toEqual([]);
    }
    const events2 = p.feed(''); // Would previously re-match; now nothing.
    expect(events2).toHaveLength(0);
  });

  it('does not double-emit clarification', () => {
    const p = new TaskStreamParser('plan');
    const json = JSON.stringify({ questions: [{ id: 'q1', kind: 'text', q: 'x' }] });
    p.feed(`<clarification>${json}</clarification>`);
    const events2 = p.feed(`<clarification>${json}</clarification>`);
    expect(events2.filter((e) => e.type === 'clarification')).toHaveLength(0);
  });
});

// ── Execute mode ────────────────────────────────────────────────

describe('TaskStreamParser (execute)', () => {
  it('parses deliverable block', () => {
    const p = new TaskStreamParser('execute');
    const md = '# Report\n\nHere is the report content.';
    const events = p.feed(`<deliverable kind="markdown" title="Research Report">${md}</deliverable>`);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('deliverable');
    if (events[0].type === 'deliverable') {
      expect(events[0].kind).toBe('markdown');
      expect(events[0].title).toBe('Research Report');
      expect(events[0].markdown).toBe(md);
    }
  });

  it('parses code_app deliverable + run_info', () => {
    const p = new TaskStreamParser('execute');
    const deliverable = '<deliverable kind="code_app" title="Pomodoro Timer"># Timer App\n\nA pomodoro timer.</deliverable>';
    const runInfo = JSON.stringify({
      preview_type: 'web',
      setup_commands: ['npm install'],
      start_command: 'npm run dev',
      preview_url_pattern: 'Local:\\s+(https?://\\S+)',
    });
    const full = `${deliverable}\n<run_info>${runInfo}</run_info>`;

    const events = feedChunked(p, full, 15);
    const deliverableEvt = events.find((e) => e.type === 'deliverable');
    const runInfoEvt = events.find((e) => e.type === 'run_info');

    expect(deliverableEvt).toBeDefined();
    expect(runInfoEvt).toBeDefined();
    if (deliverableEvt?.type === 'deliverable') {
      expect(deliverableEvt.kind).toBe('code_app');
    }
    if (runInfoEvt?.type === 'run_info') {
      expect(runInfoEvt.info.preview_type).toBe('web');
      expect(runInfoEvt.info.setup_commands).toEqual(['npm install']);
    }
  });

  it('falls back to full buffer as deliverable on flush', () => {
    const p = new TaskStreamParser('execute');
    p.feed('Here is some untagged output from the LLM.');
    const events = p.flush();
    expect(events).toHaveLength(1);
    if (events[0].type === 'deliverable') {
      expect(events[0].kind).toBe('markdown');
      expect(events[0].markdown).toBe('Here is some untagged output from the LLM.');
    }
  });

  it('handles deliverable without title attribute', () => {
    const p = new TaskStreamParser('execute');
    const events = p.feed('<deliverable kind="markdown">Some markdown</deliverable>');
    expect(events).toHaveLength(1);
    if (events[0].type === 'deliverable') {
      expect(events[0].title).toBeNull();
    }
  });

  it('does not spin on malformed run_info JSON', () => {
    const p = new TaskStreamParser('execute');
    const events = p.feed('<run_info>{not-json}</run_info>');
    // No run_info emitted, but the match is consumed so no infinite loop
    expect(events.some((e) => e.type === 'run_info')).toBe(false);
    const events2 = p.feed('');
    expect(events2).toHaveLength(0);
  });
});
