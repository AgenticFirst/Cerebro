/**
 * Pending Settings section — a one-shot hand-off so callers outside the
 * Settings screen (e.g. the sandbox opt-in banner) can request a specific
 * inner section before navigating to `settings`. SettingsScreen consumes
 * the value once on mount and clears it.
 */

export type PendingSettingsSection = 'memory' | 'sandbox' | 'appearance' | 'about';

let pending: PendingSettingsSection | null = null;

export function setPendingSettingsSection(section: PendingSettingsSection): void {
  pending = section;
}

export function consumePendingSettingsSection(): PendingSettingsSection | null {
  const value = pending;
  pending = null;
  return value;
}
