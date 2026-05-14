/**
 * Format a 32-char hex ID (as produced by Python's `uuid.uuid4().hex` or
 * Cerebro's conversation IDs) into the dashed UUID form that Claude Code's
 * `--session-id` / `--resume` flags require. Leaves already-dashed UUIDs
 * untouched.
 */
export function toUuidFormat(id: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return id;
  }
  if (/^[0-9a-f]{32}$/i.test(id)) {
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  }
  return id;
}
