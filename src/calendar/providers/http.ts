/**
 * Shared HTTP helpers for OAuth providers — implementation lives in
 * src/shared/oauth.ts (lifted there when Gmail became the second OAuth
 * integration). Re-exported here so calendar adapters keep their imports.
 */

export { ProviderHttpError, oauthTokenRequest, providerFetch } from '../../shared/oauth';
