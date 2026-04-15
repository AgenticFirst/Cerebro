/**
 * TaskStreamParser — stateful parser that scans the ANSI-stripped text
 * stream from a Claude Code task subprocess and emits structured events.
 *
 * Modes:
 *   'plan'    — emits <clarification>{JSON}</clarification>
 *   'execute' — emits <deliverable kind=... title=...>...</deliverable>
 *               and <run_info>{JSON}</run_info>
 *
 * The parser buffers text across chunks so partial tags don't break.
 */

import type { ClarificationQuestion, DeliverableKind, RunInfo } from './types';

// ── Event types ─────────────────────────────────────────────────

export type TaskStreamEvent =
  | { type: 'clarification'; questions: ClarificationQuestion[] }
  | { type: 'deliverable'; title: string | null; kind: DeliverableKind; markdown: string }
  | { type: 'run_info'; info: RunInfo };

// ── Regex patterns ──────────────────────────────────────────────

const RE_CLARIFICATION = /<clarification>([\s\S]*?)<\/clarification>/;
const RE_DELIVERABLE = /<deliverable\s+kind="([^"]*)"(?:\s+title="([^"]*)")?\s*>([\s\S]*?)<\/deliverable>/;
const RE_RUN_INFO = /<run_info>([\s\S]*?)<\/run_info>/;

// ── Parser ──────────────────────────────────────────────────────

export class TaskStreamParser {
  private buffer = '';
  private mode: 'plan' | 'execute';

  /** Track what we've already emitted so we don't double-fire. */
  private emittedClarification = false;
  private emittedDeliverable = false;
  private emittedRunInfo = false;

  constructor(mode: 'plan' | 'execute') {
    this.mode = mode;
  }

  /** Feed a chunk of streamed text. Returns any events that can now be emitted. */
  feed(chunk: string): TaskStreamEvent[] {
    this.buffer += chunk;
    const events: TaskStreamEvent[] = [];
    if (this.mode === 'plan') {
      this.parsePlanMode(events);
    } else {
      this.parseExecuteMode(events);
    }
    return events;
  }

  /** Flush remaining buffer on stream end. */
  flush(): TaskStreamEvent[] {
    const events: TaskStreamEvent[] = [];
    if (this.mode === 'execute') {
      this.parseExecuteMode(events);
      // If no deliverable was emitted, treat the entire buffer as markdown
      if (!this.emittedDeliverable && this.buffer.trim()) {
        events.push({
          type: 'deliverable',
          title: null,
          kind: 'markdown',
          markdown: this.buffer.trim(),
        });
        this.emittedDeliverable = true;
      }
    }
    return events;
  }

  // ── Private ───────────────────────────────────────────────────

  private parsePlanMode(events: TaskStreamEvent[]): void {
    if (this.emittedClarification) return;
    const m = RE_CLARIFICATION.exec(this.buffer);
    if (!m) return;
    try {
      const parsed = JSON.parse(m[1]);
      const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
      events.push({ type: 'clarification', questions });
    } catch {
      // Closing tag is present (regex matched) but JSON is malformed.
      // Emit an empty set rather than retrying forever — the Plan tab
      // will surface the failure as "no questions" and let the user
      // proceed manually, which is strictly better than hanging.
      console.warn('[TaskStreamParser] Malformed <clarification> JSON; emitting empty questions.');
      events.push({ type: 'clarification', questions: [] });
    }
    this.emittedClarification = true;
    this.consumeMatch(RE_CLARIFICATION);
  }

  private parseExecuteMode(events: TaskStreamEvent[]): void {
    if (!this.emittedDeliverable) {
      const m = RE_DELIVERABLE.exec(this.buffer);
      if (m) {
        const kind = this.parseKind(m[1]);
        const title = m[2] || null;
        const markdown = m[3].trim();
        events.push({ type: 'deliverable', title, kind, markdown });
        this.emittedDeliverable = true;
        this.consumeMatch(RE_DELIVERABLE);
      }
    }

    if (!this.emittedRunInfo) {
      const m = RE_RUN_INFO.exec(this.buffer);
      if (m) {
        try {
          const info = JSON.parse(m[1]) as RunInfo;
          events.push({ type: 'run_info', info });
          this.emittedRunInfo = true;
          this.consumeMatch(RE_RUN_INFO);
        } catch {
          // Closing tag present but JSON malformed — give up rather than
          // spin forever on the same broken buffer.
          console.warn('[TaskStreamParser] Malformed <run_info> JSON; skipping.');
          this.emittedRunInfo = true;
          this.consumeMatch(RE_RUN_INFO);
        }
      }
    }
  }

  private consumeMatch(re: RegExp): void {
    this.buffer = this.buffer.replace(re, '');
  }

  private parseKind(raw: string): DeliverableKind {
    if (raw === 'code_app' || raw === 'mixed') return raw;
    return 'markdown';
  }
}
