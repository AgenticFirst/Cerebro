/**
 * ANSI escape stripping. Two variants:
 *
 *   - `stripAnsi` — fast path covering CSI (colors/cursor) and OSC-bell.
 *     Use when you just need readable text from a known-friendly stream.
 *   - `stripAnsiFull` — covers CSI variants, OSC (BEL or ST terminated),
 *     DCS/SOS/PM/APC, and short single-char ESC sequences. Use when the
 *     output may include hyperlinks, palette negotiation, or other rare
 *     sequences (e.g. for URL extraction in PTY output).
 */

export function stripAnsi(data: string): string {
  return data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

export function stripAnsiFull(data: string): string {
  return data
    .replace(/\x1b\[[0-9;?]*[a-zA-Z@]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
    .replace(/\x1b[=>NOc78]/g, '');
}
