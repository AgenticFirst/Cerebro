/**
 * OAuth 2.0 Authorization-Code + PKCE flow — shared implementation lives in
 * src/shared/oauth.ts (lifted there when Gmail became the second OAuth
 * integration). This module re-exports the calendar-facing surface so existing
 * imports keep working.
 */

export { generatePkce, generateState, runOAuthFlow, type OAuthFlowProvider } from '../shared/oauth';
