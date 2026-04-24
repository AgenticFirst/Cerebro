/**
 * Minimal interface the HubSpot engine actions depend on.
 * Implemented by the HubSpot bridge / main-process holder — kept here so
 * action factories can import it without dragging the bridge module into
 * the engine layer.
 */

export interface HubSpotChannel {
  /** Returns the configured Private App access token, or null if not set. */
  getAccessToken(): string | null;
  /** Default ticket pipeline id configured in the Integrations screen. */
  getDefaultPipeline(): string | null;
  /** Default ticket stage id configured in the Integrations screen. */
  getDefaultStage(): string | null;
  /** HubSpot portal id discovered on token verification; used to build
   *  deep-link URLs back to tickets. */
  getPortalId(): string | null;
}
