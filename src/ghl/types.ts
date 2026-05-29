/**
 * GoHighLevel integration shared types — settings keys + the value shape
 * the GHLHolder caches from the backend.
 */

export const GHL_SETTING_KEYS = {
  apiKey: 'ghl_api_key',
  locationId: 'ghl_location_id',
} as const;

export interface GHLSettings {
  apiKey: string | null;
  locationId: string | null;
}
