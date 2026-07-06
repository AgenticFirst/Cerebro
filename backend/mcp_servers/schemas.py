from datetime import datetime

from pydantic import BaseModel, Field


VALID_KINDS = {"gdrive", "custom"}
VALID_TRANSPORTS = {"stdio", "http"}
VALID_STATUSES = {"discovering", "connected", "error", "auth_expired"}


class McpToolInfo(BaseModel):
    name: str
    description: str = ""
    read_only: bool = False


class McpServerUpsert(BaseModel):
    """Full-row upsert from the Electron-side McpBridge (the owner of the
    connection lifecycle). Secrets never appear here — only shape metadata."""

    id: str = Field(max_length=32)
    slug: str = Field(max_length=64)
    name: str = Field(max_length=255)
    kind: str = Field("custom", max_length=20)
    transport: str = Field(max_length=10)
    command: str | None = None
    args: list[str] | None = None
    url: str | None = None
    env_names: list[str] | None = None
    header_names: list[str] | None = None
    chat_enabled: bool = True
    status: str = Field("discovering", max_length=20)
    last_error: str | None = None
    last_discovered_at: datetime | None = None
    tools: list[McpToolInfo] | None = None
    account_label: str | None = None


class McpServerPatch(BaseModel):
    name: str | None = Field(None, max_length=255)
    chat_enabled: bool | None = None
    status: str | None = Field(None, max_length=20)
    last_error: str | None = None
    last_discovered_at: datetime | None = None
    tools: list[McpToolInfo] | None = None
    account_label: str | None = None


class McpServerRead(BaseModel):
    id: str
    slug: str
    name: str
    kind: str
    transport: str
    command: str | None
    args: list[str]
    url: str | None
    env_names: list[str]
    header_names: list[str]
    chat_enabled: bool
    status: str
    last_error: str | None
    last_discovered_at: datetime | None
    tools: list[McpToolInfo]
    account_label: str | None
    created_at: datetime
    updated_at: datetime


class McpGrantCreate(BaseModel):
    mcp_server_id: str
    all_tools: bool = True
    selected_tools: list[str] | None = None


class McpGrantPatch(BaseModel):
    all_tools: bool | None = None
    selected_tools: list[str] | None = None


class McpGrantRead(BaseModel):
    id: str
    expert_id: str
    mcp_server_id: str
    all_tools: bool
    selected_tools: list[str]
    created_at: datetime
    # Joined server fields so neither the UI nor the installer needs a
    # second round-trip to /mcp-servers.
    server_slug: str
    server_name: str
    server_kind: str
    server_status: str
    server_account_label: str | None
    server_tools: list[McpToolInfo]
