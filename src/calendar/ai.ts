/**
 * Calendar AI helpers — all inference goes through the Claude Code CLI
 * (singleShotClaudeCode), never a cloud SDK. Two capabilities:
 *
 *   - parseCalendarCommand: natural language ("move my 3pm to Friday") → a
 *     structured calendar_* action the command bar dispatches (approval-gated).
 *   - summarizeCalendar: prose summary of the user's day / week.
 *
 * Both are given the current date, the user's time zone, and the relevant
 * events (with ids) so the model can resolve relative references precisely.
 */

import { singleShotClaudeCode, ClaudeCodeUnavailableError } from '../claude-code/single-shot';
import type { CalendarEventDTO, CalendarParsedCommand } from '../types/calendar';

const MODEL = 'claude-haiku-4-5';

interface AiDeps {
  /** Read events in a window (bound to the bridge). */
  queryEvents: (opts: { startISO: string; endISO: string }) => Promise<CalendarEventDTO[]>;
}

function nowParts(): { iso: string; tz: string } {
  return { iso: new Date().toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

/** Strip ``` fences and pull the first JSON object out of a model response. */
function extractJson(raw: string): unknown | null {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function slimEvents(events: CalendarEventDTO[]): Array<Record<string, unknown>> {
  return events
    .filter((e) => e.status !== 'cancelled')
    .slice(0, 100)
    .map((e) => ({
      id: e.id,
      title: e.title,
      start: e.start_utc,
      end: e.end_utc,
      all_day: e.all_day,
      attendees: e.attendees?.map((a) => a.email) ?? [],
    }));
}

const VALID_ACTIONS = [
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
  'calendar_rsvp',
  'calendar_query_events',
  'calendar_find_free_time',
];

export async function parseCalendarCommand(
  text: string,
  deps: AiDeps,
  signal?: AbortSignal,
): Promise<{ ok: boolean; command?: CalendarParsedCommand; error?: string }> {
  const { iso, tz } = nowParts();
  // Context window: a few days back to two weeks ahead covers "my 3pm" / "next week".
  const start = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const end = new Date(Date.now() + 14 * 86_400_000).toISOString();
  let events: CalendarEventDTO[] = [];
  try {
    events = await deps.queryEvents({ startISO: start, endISO: end });
  } catch {
    /* proceed without event context */
  }

  const prompt = [
    'You convert a natural-language calendar request into ONE structured action.',
    `Current time: ${iso} (time zone ${tz}). All datetimes you output must be ISO 8601 in that zone.`,
    '',
    'Valid actions and their params:',
    '- calendar_create_event { title, start, end, tz?, all_day?, location?, description?, attendees?: string[], busy?, conference? }',
    '- calendar_update_event { event_id, title?, start?, end?, location?, busy? }   // reschedule/edit; resolve event_id from the events list',
    '- calendar_delete_event { event_id }',
    '- calendar_rsvp { event_id, response: "accepted"|"declined"|"tentative" }',
    '- calendar_query_events { start, end }',
    '- calendar_find_free_time { duration_mins, start, end }',
    '',
    'Existing events (resolve references like "my 3pm" to one of these by id):',
    JSON.stringify(slimEvents(events)),
    '',
    `Request: "${text}"`,
    '',
    'Respond with ONLY a JSON object: {"action": <one of the valid actions or "none">, "params": {...}, "summary": "<one short sentence describing what will happen>"}.',
    'If the request is not a calendar action, use {"action":"none","params":{},"summary":""}.',
    'No prose, no code fences — just the JSON.',
  ].join('\n');

  try {
    const raw = await singleShotClaudeCode({ agent: 'cerebro', prompt, model: MODEL, signal, maxTurns: 1 });
    const parsed = extractJson(raw) as CalendarParsedCommand | null;
    if (!parsed || typeof parsed.action !== 'string') {
      return { ok: false, error: 'Could not understand the command' };
    }
    if (parsed.action === 'none' || !VALID_ACTIONS.includes(parsed.action)) {
      return { ok: false, error: 'noMatch' };
    }
    return { ok: true, command: { action: parsed.action, params: parsed.params ?? {}, summary: parsed.summary } };
  } catch (err) {
    if (err instanceof ClaudeCodeUnavailableError) return { ok: false, error: 'Claude Code is not available' };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function summarizeCalendar(
  range: 'day' | 'week' | 'month',
  startISO: string,
  deps: AiDeps,
  signal?: AbortSignal,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const start = new Date(startISO);
  const end = new Date(start);
  end.setDate(end.getDate() + (range === 'month' ? 42 : range === 'week' ? 7 : 1));
  let events: CalendarEventDTO[] = [];
  try {
    events = await deps.queryEvents({ startISO: start.toISOString(), endISO: end.toISOString() });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const { tz } = nowParts();
  const prompt = [
    `Summarize the user's ${range} based on these calendar events. Time zone: ${tz}.`,
    'Be concise and friendly: total number of meetings, the busiest stretches, any back-to-back or conflicting events, and free gaps. Use short paragraphs or a few bullets. Match the language of the event titles.',
    '',
    'Events (JSON):',
    JSON.stringify(slimEvents(events)),
    '',
    events.length === 0 ? 'There are no events — say the calendar is clear.' : '',
  ].join('\n');

  try {
    const text = await singleShotClaudeCode({ agent: 'cerebro', prompt, model: MODEL, signal, maxTurns: 1 });
    return { ok: true, text: text.trim() };
  } catch (err) {
    if (err instanceof ClaudeCodeUnavailableError) return { ok: false, error: 'Claude Code is not available' };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
