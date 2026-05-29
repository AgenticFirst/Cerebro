/**
 * Minimal interface the GitHub engine actions depend on.
 * Implemented by the GitHub bridge — kept here so action factories
 * can import it without dragging the bridge module into the engine layer.
 */

export interface GitHubChannel {
  /** Returns the configured Personal Access Token, or null if not set. */
  getAccessToken(): string | null;
  /** Authenticated user's login (e.g. "octocat"). Used by routines/actions
   *  that need to identify the human-on-record. */
  getLogin(): string | null;
  /** Watched-repo allowlist ("owner/repo"). Triggers fire only for these
   *  repos. Outbound actions can target any repo the token reaches. */
  getWatchedRepos(): string[];
  /** True if a token is configured. The chat-actions catalog uses this for
   *  `availabilityCheck` so unconfigured users see a "connect" CTA. */
  isConnected(): boolean;
}
