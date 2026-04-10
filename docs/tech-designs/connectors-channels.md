# Connectors & Channels

## Problem Statement

Cerebro can think, remember, delegate, and orchestrate — but it can't act on the user's behalf in external services. A morning briefing routine can search the web, but it can't pull today's calendar events. A fitness coach expert can track workouts in knowledge entries, but it can't import them from Strava. A team can produce a polished email draft, but it can't send it.

Connectors and channels close this gap. Connectors give Cerebro read/write access to external services (Google Calendar, Gmail, Notion, GitHub, Strava, Slack). Channels give Cerebro the ability to send and receive messages through communication platforms (Telegram, WhatsApp, Email). Both require OAuth or token-based authentication, both need to survive app restarts, and both need to integrate with the existing execution engine, agent tools, and approval gates.

The plumbing is already in place. The `required_connections` field exists on both Expert and Routine models. The execution engine has `connector` and `channel` action stubs. The Integrations screen has "Coming Soon" cards for six connectors and three channels. The actions tech design defines specific integration nodes (`integration_google_calendar`, `integration_gmail`, etc.). What's missing is the connector interface itself, the OAuth flow, token lifecycle management, and the adapter layer that bridges connectors into the engine and agent tool system.

## Design Principles

1. **Each connector is a specific adapter, not a generic plugin.** There is no abstract "connector SDK" that third parties extend. Each connector is a Python module in `backend/connectors/` that implements a known interface against a known API. This keeps the surface area small and lets us ship connectors that actually work rather than a framework that theoretically could.

2. **OAuth happens in the Electron main process.** OAuth requires opening a browser, receiving a redirect callback, and exchanging an authorization code for tokens. The main process owns the browser window, the local HTTP server for the redirect, and the encrypted credential store. The backend never touches OAuth directly — it receives tokens via the same `POST /credentials` push pattern used for API keys today.

3. **Token refresh is invisible.** The backend adapter checks token expiry before every API call. If the access token is expired but the refresh token is valid, it refreshes silently and pushes the new token back to the credential store. The user never sees an "expired" state unless the refresh token itself is revoked.

4. **Connectors are agent tools first, engine actions second.** The most common path is a user asking Cerebro a question ("What's on my calendar today?") and the LLM deciding to call a tool. The engine action path (routines executing `connector` steps) reuses the same adapter but with structured parameters instead of LLM-generated ones. One adapter, two entry points.

5. **Channels are connectors with a message-oriented interface.** A channel is a connector whose primary operations are `send` and `receive`. The distinction exists in the UI (separate section in Integrations) and in the type system (`ConnectorType` vs `ChannelType`), but the underlying OAuth flow, token storage, and adapter pattern are identical. Inbound message handling is covered by the Remote Access system (section 10 of the roadmap) — identity pairing, relay client, and inbound event routing.

## Architecture Overview

```
User clicks "Connect" on Google Calendar card
       |
       v
Electron Main Process
  |
  ├─ Opens system browser: https://accounts.google.com/o/oauth2/auth?...
  |    redirect_uri=http://127.0.0.1:{port}/oauth/callback
  |
  ├─ Starts local HTTP server on ephemeral port (listens for callback)
  |
  ├─ Receives callback: ?code=AUTH_CODE
  |    Stops local server
  |
  ├─ Exchanges code for tokens via POST to Google's token endpoint
  |    Returns: { access_token, refresh_token, expires_in, scope }
  |
  ├─ Stores tokens via safeStorage:
  |    credential:set("google_calendar", "oauth_tokens", JSON.stringify({
  |      access_token, refresh_token, expires_at, scope
  |    }))
  |
  └─ Pushes tokens to backend:
       POST /credentials { key: "GOOGLE_CALENDAR_OAUTH", value: <tokens_json> }
       |
       v
Backend receives tokens → connector adapter can now make API calls
```

### Connector Adapter Pattern

```
                    ┌─────────────────────────────────────────────┐
                    │           ConnectorAdapter (ABC)             │
                    │                                             │
                    │  service_id: str                            │
                    │  required_scopes: list[str]                 │
                    │  operations: dict[str, OperationSpec]       │
                    │                                             │
                    │  async execute(op, params) -> ConnectorResult│
                    │  async validate_connection() -> bool        │
                    │  async refresh_if_needed() -> None          │
                    └──────────────┬──────────────────────────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         │                         │                         │
         v                         v                         v
┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────┐
│ GoogleCalendar   │  │ Gmail            │  │ Notion               │
│                  │  │                  │  │                      │
│ list_events      │  │ search           │  │ query_database       │
│ create_event     │  │ send             │  │ create_page          │
│ update_event     │  │ get_message      │  │ update_page          │
│ delete_event     │  │ list_labels      │  │ search               │
└─────────────────┘  └──────────────────┘  └──────────────────────┘
```

Each adapter is a self-contained Python module that:
- Defines its supported operations and their parameter schemas
- Handles its own API calls via `httpx`
- Manages token refresh internally (reads current token from credential store, refreshes if expired, writes back)
- Returns structured `ConnectorResult` objects

## Data Model

### `connections` Table (New)

```python
class Connection(Base):
    __tablename__ = "connections"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_id)
    service_id: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
        # "google_calendar" | "gmail" | "notion" | "slack" | "github" | "strava"
        # "telegram" | "whatsapp" | "email"
        # NOTE: unique=True limits to one connection per service. If multi-account
        # support is needed later (e.g., personal + work Google), migrate to a
        # unique constraint on (service_id, account_label) instead.
    type: Mapped[str] = mapped_column(String(20), nullable=False)
        # "connector" | "channel"
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="disconnected")
        # "disconnected" | "authorizing" | "connected" | "expired" | "error"
    scopes_granted: Mapped[str | None] = mapped_column(Text, nullable=True)
        # JSON list of OAuth scopes the user granted
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    connected_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
```

Tokens are NOT stored in the database — they stay in Electron's encrypted credential store (`safeStorage`). The `connections` table tracks status and metadata only.

### `ConnectorResult` Schema

```python
# backend/connectors/schemas.py

@dataclass
class ConnectorResult:
    success: bool
    data: Any = None                    # Normalized JSON (list or dict) — adapter-specific
    error: str | None = None            # Human-readable error message
    reconnect_required: bool = False    # True when refresh token is revoked/missing

@dataclass
class ConnectorRequest:
    service_id: str                     # e.g. "google_calendar"
    operation: str                      # e.g. "list_events"
    params: dict = field(default_factory=dict)

@dataclass
class OperationSpec:
    description: str
    input_schema: dict[str, str]        # param name → description
    output_schema: dict[str, str] | None = None
    mutates: bool = False               # True for write operations (triggers approval gate)
```

### Credential Key Convention

Extending the existing `CREDENTIAL_ENV_KEYS` pattern:

```typescript
// src/main.ts — additions
const CONNECTOR_CREDENTIAL_KEYS: Record<string, string> = {
  google_calendar: 'GOOGLE_CALENDAR_OAUTH',
  gmail: 'GMAIL_OAUTH',
  notion: 'NOTION_OAUTH',
  slack: 'SLACK_OAUTH',
  github: 'GITHUB_OAUTH',
  strava: 'STRAVA_OAUTH',
  telegram: 'TELEGRAM_BOT_TOKEN',
  whatsapp: 'WHATSAPP_TOKEN',
  email: 'EMAIL_SMTP_CONFIG',
};
```

OAuth tokens are stored as JSON strings: `{ access_token, refresh_token, expires_at, scope }`. Simple token services (Telegram bot token) store plain strings.

## OAuth Flow

### Service Configuration

```typescript
// src/connectors/oauth-config.ts

interface OAuthServiceConfig {
  serviceId: string;
  authUrl: string;
  tokenUrl: string;
  clientId: string;                 // Bundled (Cerebro registers as an OAuth app)
  scopes: string[];
  usePKCE: boolean;                 // true for all OAuth flows (desktop app = public client)
  additionalParams?: Record<string, string>;  // e.g. { access_type: 'offline' }
}

const OAUTH_CONFIGS: Record<string, OAuthServiceConfig> = {
  google_calendar: {
    serviceId: 'google_calendar',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: GOOGLE_CLIENT_ID,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly',
             'https://www.googleapis.com/auth/calendar.events'],
    usePKCE: true,
    additionalParams: { access_type: 'offline', prompt: 'consent' },
  },
  gmail: {
    serviceId: 'gmail',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: GOOGLE_CLIENT_ID,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly',
             'https://www.googleapis.com/auth/gmail.send'],
    usePKCE: true,
    additionalParams: { access_type: 'offline', prompt: 'consent' },
  },
  // ... other services
};
```

Google Calendar and Gmail share the same Google OAuth app but request different scopes. To avoid double-consent and token revocation issues, they share a single OAuth grant with combined scopes. When the user connects the second Google service, the flow merges scopes from both services and re-authorizes with the combined set. The `scopes_granted` field on the `connections` record tracks what was actually granted.

```typescript
// In OAuthFlowManager.startOAuthFlow()
// Before building the auth URL, merge scopes with any existing Google grant
if (config.authUrl.includes('accounts.google.com')) {
  const existingGoogleScopes = await this.getGrantedGoogleScopes();
  mergedScopes = [...new Set([...config.scopes, ...existingGoogleScopes])];
}
```

Both `google_calendar` and `gmail` connection records are updated to "connected" after a merged grant succeeds.

### Flow Manager (Main Process)

```typescript
// src/connectors/oauth-flow.ts

class OAuthFlowManager {
  private activeFlows = new Map<string, { server: http.Server; resolve: Function }>();

  /**
   * Initiates OAuth for a service. Returns when the user completes or cancels.
   * Uses PKCE (RFC 7636) since desktop apps are public clients.
   */
  async startOAuthFlow(serviceId: string): Promise<OAuthResult> {
    const config = OAUTH_CONFIGS[serviceId];
    if (!config) throw new Error(`Unknown service: ${serviceId}`);

    let server: http.Server | null = null;

    try {
      // 1. Start local callback server on ephemeral port
      const callbackServer = await this.startCallbackServer();
      server = callbackServer.server;
      const redirectUri = `http://127.0.0.1:${callbackServer.port}/oauth/callback`;

      // 2. Generate PKCE code verifier and challenge
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const codeChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');

      // 3. Build authorization URL with PKCE
      const state = crypto.randomUUID();
      const scopes = await this.resolveScopesForService(config);
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        ...config.additionalParams,
      });
      const authUrl = `${config.authUrl}?${params}`;

      // 4. Open in system browser (not Electron BrowserWindow)
      shell.openExternal(authUrl);

      // 5. Wait for callback (120s timeout — user may need to log in and complete 2FA)
      const code = await this.waitForCallback(server, state, 120_000);

      // 6. Exchange code for tokens (with PKCE verifier, no client secret)
      const tokens = await this.exchangeCodePKCE(config, code, redirectUri, codeVerifier);

      // 7. Store encrypted tokens
      await credentialStore.setCredential(serviceId, 'oauth_tokens', JSON.stringify(tokens));

      // 8. Push to backend
      await pushCredentialToBackend(CONNECTOR_CREDENTIAL_KEYS[serviceId], JSON.stringify(tokens));

      // 9. Update connection status in backend
      await backendPost('/connections/status', {
        service_id: serviceId,
        status: 'connected',
        scopes_granted: scopes,
      });

      return { success: true, serviceId };
    } finally {
      // Always clean up: close server and remove from active flows
      if (server) server.close();
      this.activeFlows.delete(serviceId);
    }
  }

  /**
   * Merge scopes with existing Google grants to avoid double-consent.
   */
  private async resolveScopesForService(config: OAuthServiceConfig): Promise<string[]> {
    if (!config.authUrl.includes('accounts.google.com')) return config.scopes;
    const existingScopes = await this.getGrantedGoogleScopes();
    return [...new Set([...config.scopes, ...existingScopes])];
  }

  /**
   * Exchange authorization code using PKCE (no client_secret).
   */
  private async exchangeCodePKCE(
    config: OAuthServiceConfig, code: string, redirectUri: string, codeVerifier: string,
  ): Promise<OAuthTokens> {
    const resp = await net.fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }).toString(),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Token exchange failed: ${resp.status} ${resp.statusText} — ${body}`);
    }
    const data = await resp.json();
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() / 1000 + data.expires_in,
      scope: data.scope,
    };
  }

  async disconnect(serviceId: string): Promise<void> {
    await credentialStore.deleteCredential(serviceId, 'oauth_tokens');
    await pushCredentialToBackend(CONNECTOR_CREDENTIAL_KEYS[serviceId], null);
    await backendPost('/connections/status', {
      service_id: serviceId,
      status: 'disconnected',
    });
  }
}
```

### IPC Channels

```typescript
// Additions to IPC_CHANNELS
CONNECTOR_OAUTH_START: 'connector:oauth:start',     // serviceId → OAuthResult
CONNECTOR_OAUTH_DISCONNECT: 'connector:oauth:disconnect', // serviceId → void
CONNECTOR_STATUS: 'connector:status',               // → ConnectionStatus[]
```

## Backend Adapter Layer

### Module Structure

```
backend/connectors/
  __init__.py
  schemas.py           # ConnectorRequest, ConnectorResult, ConnectionStatus
  router.py            # /connections/* endpoints
  registry.py          # Service registry + adapter lookup
  base.py              # ConnectorAdapter ABC
  token_manager.py     # Token refresh logic
  adapters/
    __init__.py
    google_calendar.py
    gmail.py
    notion.py
    slack.py
    github.py
    strava.py
    telegram.py         # Channel adapter
```

### Base Adapter

```python
# backend/connectors/base.py

class ConnectorAdapter(ABC):
    service_id: str
    operations: dict[str, OperationSpec]  # name → { description, input_schema, output_schema }

    def __init__(self, credential_sync_port: int):
        """Registry passes the Electron credential sync port at initialization."""
        self._electron_port = credential_sync_port

    @abstractmethod
    async def execute(self, operation: str, params: dict) -> ConnectorResult:
        """Execute an operation. Handles token refresh internally."""
        ...

    async def get_tokens(self) -> dict | None:
        """Read OAuth tokens from credential store."""
        raw = get_credential(CONNECTOR_CREDENTIAL_KEYS[self.service_id])
        return json.loads(raw) if raw else None

    async def refresh_if_needed(self) -> None:
        """Refresh access token if expired. Syncs new tokens to both in-memory store and Electron."""
        tokens = await self.get_tokens()
        if not tokens or not tokens.get("refresh_token"):
            return
        if datetime.now(timezone.utc).timestamp() < tokens.get("expires_at", 0) - 60:
            return  # Still valid (with 60s buffer)
        new_tokens = await self._refresh_token(tokens["refresh_token"])
        token_json = json.dumps(new_tokens)
        # Update the in-memory credential store
        set_credential(
            CONNECTOR_CREDENTIAL_KEYS[self.service_id],
            token_json,
        )
        # Notify Electron to persist the refreshed tokens in safeStorage immediately.
        # This prevents token loss if the app crashes before a clean shutdown.
        await self._notify_token_refresh(self.service_id, token_json)

    async def _notify_token_refresh(self, service_id: str, token_json: str) -> None:
        """POST refreshed tokens back to Electron's credential sync endpoint."""
        # Electron exposes a local endpoint for token writeback (see IPC section).
        # If the notification fails (e.g., Electron is unresponsive), the in-memory
        # store is still updated — safeStorage will catch up on next clean startup.
        try:
            async with httpx.AsyncClient() as client:
                await client.post(
                    f"http://127.0.0.1:{self._electron_port}/credentials/sync",
                    json={"service_id": service_id, "tokens": token_json},
                    timeout=5.0,
                )
        except Exception:
            pass  # Best-effort — in-memory store is the runtime source of truth
```

### Example Adapter: Google Calendar

```python
# backend/connectors/adapters/google_calendar.py

class GoogleCalendarAdapter(ConnectorAdapter):
    service_id = "google_calendar"
    operations = {
        "list_events": OperationSpec(
            description="List calendar events within a date range",
            input_schema={
                "time_min": "ISO datetime (required)",
                "time_max": "ISO datetime (required)",
                "calendar_id": "Calendar ID (default: primary)",
                "max_results": "Max events to return (default: 20)",
            },
        ),
        "create_event": OperationSpec(
            description="Create a new calendar event",
            input_schema={
                "summary": "Event title (required)",
                "start": "ISO datetime (required)",
                "end": "ISO datetime (required)",
                "description": "Event description",
                "location": "Event location",
            },
            mutates=True,
        ),
        "update_event": OperationSpec(..., mutates=True),
        "delete_event": OperationSpec(..., mutates=True),
    }

    async def execute(self, operation: str, params: dict) -> ConnectorResult:
        await self.refresh_if_needed()
        tokens = await self.get_tokens()
        if not tokens:
            return ConnectorResult(success=False, error="Not connected", reconnect_required=True)

        headers = {"Authorization": f"Bearer {tokens['access_token']}"}
        base = "https://www.googleapis.com/calendar/v3"

        if operation == "list_events":
            calendar_id = params.get("calendar_id", "primary")
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"{base}/calendars/{calendar_id}/events",
                    headers=headers,
                    params={
                        "timeMin": params["time_min"],
                        "timeMax": params["time_max"],
                        "maxResults": params.get("max_results", 20),
                        "singleEvents": True,
                        "orderBy": "startTime",
                    },
                )
                resp.raise_for_status()
                events = resp.json().get("items", [])
            return ConnectorResult(
                success=True,
                data=[{
                    "id": e["id"],
                    "summary": e.get("summary", "(No title)"),
                    "start": e.get("start", {}).get("dateTime", e.get("start", {}).get("date")),
                    "end": e.get("end", {}).get("dateTime", e.get("end", {}).get("date")),
                    "location": e.get("location"),
                    "status": e.get("status"),
                } for e in events],
            )
        # ... other operations
```

### Backend Router

```python
# backend/connectors/router.py

router = APIRouter(prefix="/connections", tags=["connections"])

@router.get("/")
async def list_connections(db: Session = Depends(get_db)) -> list[ConnectionStatus]:
    """Return status of all known services."""
    ...

@router.post("/status")
async def update_status(body: UpdateStatusRequest, db: Session = Depends(get_db)):
    """Update connection status (called by Electron after OAuth flow)."""
    ...

@router.post("/execute")
async def execute_connector(body: ConnectorRequest, db: Session = Depends(get_db)) -> ConnectorResult:
    """Execute a connector operation. Used by agent tools and engine actions."""
    adapter = get_adapter(body.service_id)
    if not adapter:
        raise HTTPException(404, f"Unknown service: {body.service_id}")
    return await adapter.execute(body.operation, body.params)

@router.get("/{service_id}/operations")
async def list_operations(service_id: str) -> list[OperationSpec]:
    """List available operations for a service. Used by LLM tool definitions."""
    ...
```

## Agent Tool Integration

Connectors surface as agent tools so the LLM can use them conversationally. The `ToolContext` interface gains a new `requestUserConfirmation()` method for write-op gating:

```typescript
// Addition to src/agents/tools/types.ts
interface ToolContext {
  // ... existing fields (backendPort, conversationId, etc.)
  requestUserConfirmation(request: {
    action: string;       // e.g. "Google Calendar: create_event"
    details: object;      // The operation params for user review
  }): Promise<boolean>;   // true = approved, false = cancelled
}
```

```typescript
// src/agents/tools/connector-tools.ts

export function createConnectorTool(serviceId: string, ctx: ToolContext): AgentTool {
  return {
    name: serviceId,  // e.g. "google_calendar"
    description: `Interact with ${SERVICE_LABELS[serviceId]}. Available operations: ...`,
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list_events', 'create_event', ...] },
        params: { type: 'object' },
      },
      required: ['operation'],
    },
    async execute({ operation, params }) {
      const result = await backendRequest(ctx.backendPort, 'POST', '/connections/execute', {
        service_id: serviceId,
        operation,
        params: params || {},
      });
      if (!result.success) return textResult(`Error: ${result.error}`);
      return textResult(formatConnectorResult(serviceId, operation, result.data));
    },
  };
}
```

Tools are registered dynamically based on which services are connected. The tool list is refreshed at the **start of each agent run** (not just app startup) so that mid-session connect/disconnect is reflected immediately:

```typescript
// In src/agents/tools/index.ts — called at the start of each agent run
const connectedServices = await getConnectedServices(backendPort);
for (const serviceId of connectedServices) {
  tools.push(createConnectorTool(serviceId, ctx));
}
```

The LLM system prompt also includes connected services so it knows what's available:

```
## Connected Services
- Google Calendar: list_events, create_event, update_event, delete_event
- Gmail: search, send, get_message
```

## Engine Action Integration

The existing `connector` action stub in the execution engine gets replaced with a real implementation that calls the same backend endpoint:

```typescript
// src/engine/actions/connector.ts — replaces the V0 stub

export const connectorAction: ActionDefinition = {
  type: 'connector',
  name: 'Connector',
  description: 'Execute an operation on a connected service',
  inputSchema: {
    service: { type: 'string', required: true },
    operation: { type: 'string', required: true },
    payload: { type: 'object' },
  },
  async execute(params, context) {
    const result = await context.backendRequest('POST', '/connections/execute', {
      service_id: params.service,
      operation: params.operation,
      params: params.payload || {},
    });
    return {
      data: result.data,
      statusCode: result.success ? 200 : 500,
      error: result.error,
    };
  },
};
```

The `channel` action stub similarly delegates to `/connections/execute` with `operation: 'send'`. Inbound message receiving is handled by the Remote Access relay system (identity pairing + inbound event routing), which routes incoming messages from paired platforms into the execution engine.

## UI Integration

### Updated ConnectedAppsSection

The existing "Coming Soon" cards in `ConnectedAppsSection.tsx` gain a "Connect" button that triggers the OAuth flow:

```
┌─────────────────────────────────────────────────────────────┐
│  📅  Google Calendar                        ● Connected     │
│      Read and create calendar events                        │
│ ─────────────────────────────────────────────────────────── │
│  Connected since: Mar 8, 2026                               │
│  Scopes: calendar.readonly, calendar.events                 │
│                                                             │
│  [ Disconnect ]                                             │
├─────────────────────────────────────────────────────────────┤
│  ✉️  Gmail                                 ○ Not connected  │
│      Search and send emails                                 │
│                                                             │
│  [ Connect ]                                                │
├─────────────────────────────────────────────────────────────┤
│  📝  Notion                                ○ Not connected  │
│      Query and update Notion databases                      │
│                                                             │
│  [ Connect ]                                                │
└─────────────────────────────────────────────────────────────┘
```

The status flow extends from the existing `ConnectionStatus` type:

```
disconnected → (user clicks Connect) → authorizing → connected
connected → (token expired, refresh fails) → expired → (user re-connects) → connected
connected → (user clicks Disconnect) → disconnected
```

### Updated ChannelsSection

Same pattern. Telegram uses a bot token (paste-in, like API keys), not OAuth. WhatsApp and Email have their own auth mechanisms.

### Required Connections Indicator

Routines and experts that have `required_connections` show which services are needed and whether they're connected:

```
Morning Briefing routine
  Required: ✅ Google Calendar, ❌ Gmail
  "Connect Gmail to enable this routine"
```

## Token Refresh Lifecycle

```
Backend adapter receives execute() call
  │
  ├─ Read tokens from in-memory credential store
  │
  ├─ Is access_token expired (or within 60s of expiry)?
  │    NO → proceed with API call
  │    YES ↓
  │
  ├─ Has refresh_token?
  │    NO → return { success: false, error: "reconnect_required" }
  │         → Frontend shows "Reconnect" button
  │    YES ↓
  │
  ├─ POST to token endpoint with refresh_token
  │    SUCCESS → update in-memory store
  │           → POST /credentials/sync to Electron (persist to safeStorage immediately)
  │           → proceed with API call
  │    FAILURE (invalid_grant) → update connection status to "expired"
  │                             → return reconnect_required error
```

When the backend refreshes a token, it updates the in-memory store and immediately notifies Electron via `POST /credentials/sync` so that `safeStorage` is updated in real time. This prevents token loss on crash — if the app exits uncleanly, `safeStorage` already has the refreshed token. If the sync notification fails (Electron unresponsive), the in-memory store remains the runtime source of truth and `safeStorage` catches up on next clean startup.

## MCP Bridge Extension (Claude Code)

When Claude Code is the active engine, connector tools are exposed through the existing MCP bridge:

```javascript
// Added to mcp-server.ts template — only for connected services

{ name: "cerebro_google_calendar", description: "...", inputSchema: { operation, params } }
{ name: "cerebro_gmail", description: "...", inputSchema: { operation, params } }
```

These bridge to the same `POST /connections/execute` endpoint. The list of exposed tools is refreshed each time the MCP bridge is (re)created, matching the per-agent-run refresh behavior of native connector tools.

## Security Considerations

- **Tokens never in the database.** OAuth tokens live exclusively in Electron's `safeStorage` (at rest) and the backend's in-memory store (at runtime). The `connections` table stores status metadata only.
- **Scope minimization.** Each connector requests only the scopes it needs. Google Calendar doesn't request Gmail scopes.
- **Write operations require confirmation at the tool layer.** Connector operations that mutate external state (`create_event`, `send`, `update_page`) are gated at the tool execution layer, not via LLM prompting. In routine/engine execution, they go through the existing approval gate. In conversational mode, the tool itself returns a confirmation prompt to the user before executing the mutation — the LLM cannot bypass this. The `mutates: bool` flag on `OperationSpec` determines which operations are gated.

```typescript
// In createConnectorTool — write-op confirmation for conversational mode
async execute({ operation, params }) {
  const opSpec = await getOperationSpec(serviceId, operation);
  if (opSpec.mutates) {
    // Return a confirmation request — the agent runtime surfaces this to the user
    // and only proceeds if the user approves. This is enforced at the tool layer,
    // not dependent on LLM behavior.
    const approved = await ctx.requestUserConfirmation({
      action: `${SERVICE_LABELS[serviceId]}: ${operation}`,
      details: params,
    });
    if (!approved) return textResult('Operation cancelled by user.');
  }
  const result = await backendRequest(ctx.backendPort, 'POST', '/connections/execute', {
    service_id: serviceId, operation, params: params || {},
  });
  if (!result.success) return textResult(`Error: ${result.error}`);
  return textResult(formatConnectorResult(serviceId, operation, result.data));
},
```
- **PKCE for public clients.** The OAuth flow uses PKCE (Proof Key for Code Exchange) with S256 challenge method. No client secret is used — Cerebro is a desktop app (public client) and cannot securely store secrets at rest. The `code_verifier` is generated per flow, held in memory only, and discarded after the token exchange.
- **Redirect URI validation.** The callback server binds to `127.0.0.1` only (not `0.0.0.0`) and validates the `state` parameter to prevent CSRF.
- **SMTP credentials treated as secrets.** The `EMAIL_SMTP_CONFIG` credential contains SMTP passwords. The memory system's secret detection regex covers SMTP auth patterns to prevent accidental storage in learned facts or knowledge entries.

## Implementation Sequence

| Order | File | Change |
|-------|------|--------|
| 1 | `backend/models.py` | Add `Connection` model |
| 2 | `backend/connectors/` | New module: `base.py`, `schemas.py`, `registry.py`, `router.py`, `token_manager.py` |
| 3 | `backend/main.py` | Mount connectors router |
| 4 | `src/connectors/oauth-config.ts` | OAuth service configurations |
| 5 | `src/connectors/oauth-flow.ts` | `OAuthFlowManager` with callback server |
| 6 | `src/main.ts` | IPC handlers for OAuth start/disconnect/status, `CONNECTOR_CREDENTIAL_KEYS` |
| 7 | `src/preload.ts` | Add connectors IPC bridge |
| 8 | `src/types/ipc.ts` | Add IPC channels and `ConnectorAPI` type |
| 9 | `src/context/ConnectorContext.tsx` | Connection status state, connect/disconnect actions |
| 10 | `src/components/screens/integrations/ConnectedAppsSection.tsx` | Replace "Coming Soon" with connect/disconnect flow |
| 11 | `src/components/screens/integrations/ChannelsSection.tsx` | Same treatment for channels |
| 12 | `backend/connectors/adapters/google_calendar.py` | First connector adapter |
| 13 | `backend/connectors/adapters/gmail.py` | Second adapter (shares Google OAuth) |
| 14 | `backend/connectors/adapters/notion.py` | Third adapter |
| 15 | `src/agents/tools/connector-tools.ts` | Agent tool factory for connected services |
| 16 | `src/agents/tools/index.ts` | Dynamic tool registration for connected services |
| 17 | `src/engine/actions/connector.ts` | Replace stub with real implementation |
| 18 | `src/engine/actions/channel.ts` | Replace stub with real implementation |
| 19 | `src/claude-code/mcp-bridge.ts` | Add connected services to MCP bridge |
| 20 | `backend/memory/recall.py` | Add "Connected Services" section to system prompt |
| 21 | `backend/connectors/tests/` | Adapter unit tests (mock httpx, test token refresh, error paths) |
| 22 | `src/connectors/__tests__/` | OAuth flow tests (callback server, PKCE, timeout, cleanup) |
| 23 | `tests/` | Integration tests (connect → execute → disconnect lifecycle) |
