"""CRUD for /mcp-servers and /experts/{expert_id}/mcp-grants.

The Electron-side McpBridge owns the connection lifecycle (credentials,
OAuth, tool discovery) and upserts non-secret metadata here. This router
persists that metadata plus the expert ↔ server grants the installer reads
when materializing agent files. Secrets never reach these tables — they
live encrypted in the settings table under the `mcp_<id>_` prefix.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from database import get_db
from models import Expert, ExpertMcpGrant, McpServer

from .schemas import (
    VALID_KINDS,
    VALID_STATUSES,
    VALID_TRANSPORTS,
    McpGrantCreate,
    McpGrantPatch,
    McpGrantRead,
    McpServerPatch,
    McpServerRead,
    McpServerUpsert,
    McpToolInfo,
)

servers_router = APIRouter(tags=["mcp-servers"])
grants_router = APIRouter(tags=["mcp-grants"])


def _loads_list(raw: str | None) -> list:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def _tools_from_json(raw: str | None) -> list[McpToolInfo]:
    return [
        McpToolInfo(
            name=t.get("name", ""),
            description=t.get("description", "") or "",
            read_only=bool(t.get("read_only", False)),
        )
        for t in _loads_list(raw)
        if isinstance(t, dict) and t.get("name")
    ]


def _server_to_read(row: McpServer) -> McpServerRead:
    return McpServerRead(
        id=row.id,
        slug=row.slug,
        name=row.name,
        kind=row.kind,
        transport=row.transport,
        command=row.command,
        args=_loads_list(row.args_json),
        url=row.url,
        env_names=_loads_list(row.env_names_json),
        header_names=_loads_list(row.header_names_json),
        chat_enabled=row.chat_enabled,
        status=row.status,
        last_error=row.last_error,
        last_discovered_at=row.last_discovered_at,
        tools=_tools_from_json(row.tools_json),
        account_label=row.account_label,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _grant_to_read(row: ExpertMcpGrant, server: McpServer) -> McpGrantRead:
    return McpGrantRead(
        id=row.id,
        expert_id=row.expert_id,
        mcp_server_id=row.mcp_server_id,
        all_tools=row.all_tools,
        selected_tools=_loads_list(row.selected_tools_json),
        created_at=row.created_at,
        server_slug=server.slug,
        server_name=server.name,
        server_kind=server.kind,
        server_status=server.status,
        server_account_label=server.account_label,
        server_tools=_tools_from_json(server.tools_json),
    )


def _dump_tools(tools: list[McpToolInfo] | None) -> str | None:
    if tools is None:
        return None
    return json.dumps([t.model_dump() for t in tools])


@servers_router.get("", response_model=list[McpServerRead])
def list_servers(db: Session = Depends(get_db)):
    rows = db.query(McpServer).order_by(McpServer.created_at).all()
    return [_server_to_read(r) for r in rows]


@servers_router.get("/{server_id}", response_model=McpServerRead)
def get_server(server_id: str, db: Session = Depends(get_db)):
    row = db.get(McpServer, server_id)
    if row is None:
        raise HTTPException(404, "MCP server not found")
    return _server_to_read(row)


@servers_router.put("/{server_id}", response_model=McpServerRead)
def upsert_server(
    server_id: str, body: McpServerUpsert, db: Session = Depends(get_db)
):
    if body.id != server_id:
        raise HTTPException(400, "Body id does not match path id")
    if body.kind not in VALID_KINDS:
        raise HTTPException(400, f"Invalid kind: {body.kind}")
    if body.transport not in VALID_TRANSPORTS:
        raise HTTPException(400, f"Invalid transport: {body.transport}")
    if body.status not in VALID_STATUSES:
        raise HTTPException(400, f"Invalid status: {body.status}")

    conflict = (
        db.query(McpServer)
        .filter(McpServer.slug == body.slug, McpServer.id != server_id)
        .first()
    )
    if conflict:
        raise HTTPException(409, f"Slug already in use: {body.slug}")

    row = db.get(McpServer, server_id)
    if row is None:
        row = McpServer(id=server_id)
        db.add(row)

    row.slug = body.slug
    row.name = body.name
    row.kind = body.kind
    row.transport = body.transport
    row.command = body.command
    row.args_json = json.dumps(body.args) if body.args is not None else None
    row.url = body.url
    row.env_names_json = (
        json.dumps(body.env_names) if body.env_names is not None else None
    )
    row.header_names_json = (
        json.dumps(body.header_names) if body.header_names is not None else None
    )
    row.chat_enabled = body.chat_enabled
    row.status = body.status
    row.last_error = body.last_error
    row.last_discovered_at = body.last_discovered_at
    row.tools_json = _dump_tools(body.tools)
    row.account_label = body.account_label
    db.commit()
    db.refresh(row)
    return _server_to_read(row)


@servers_router.patch("/{server_id}", response_model=McpServerRead)
def patch_server(
    server_id: str, body: McpServerPatch, db: Session = Depends(get_db)
):
    row = db.get(McpServer, server_id)
    if row is None:
        raise HTTPException(404, "MCP server not found")
    if body.status is not None:
        if body.status not in VALID_STATUSES:
            raise HTTPException(400, f"Invalid status: {body.status}")
        row.status = body.status
    if body.name is not None:
        row.name = body.name
    if body.chat_enabled is not None:
        row.chat_enabled = body.chat_enabled
    if body.last_error is not None:
        row.last_error = body.last_error or None
    if body.last_discovered_at is not None:
        row.last_discovered_at = body.last_discovered_at
    if body.tools is not None:
        row.tools_json = _dump_tools(body.tools)
    if body.account_label is not None:
        row.account_label = body.account_label or None
    db.commit()
    db.refresh(row)
    return _server_to_read(row)


@servers_router.delete("/{server_id}", status_code=204)
def delete_server(server_id: str, db: Session = Depends(get_db)):
    row = db.get(McpServer, server_id)
    if row is None:
        raise HTTPException(404, "MCP server not found")
    # Grants cascade via FK, but SQLite only honors ON DELETE with
    # foreign_keys=ON — delete explicitly so behavior never depends on it.
    db.query(ExpertMcpGrant).filter(
        ExpertMcpGrant.mcp_server_id == server_id
    ).delete()
    db.delete(row)
    db.commit()
    return Response(status_code=204)


@grants_router.get("/{expert_id}/mcp-grants", response_model=list[McpGrantRead])
def list_grants(expert_id: str, db: Session = Depends(get_db)):
    if not db.get(Expert, expert_id):
        raise HTTPException(404, "Expert not found")
    rows = (
        db.query(ExpertMcpGrant)
        .filter(ExpertMcpGrant.expert_id == expert_id)
        .order_by(ExpertMcpGrant.created_at)
        .all()
    )
    out: list[McpGrantRead] = []
    for row in rows:
        server = db.get(McpServer, row.mcp_server_id)
        if server is None:
            continue
        out.append(_grant_to_read(row, server))
    return out


@grants_router.post(
    "/{expert_id}/mcp-grants", response_model=McpGrantRead, status_code=201
)
def create_grant(
    expert_id: str, body: McpGrantCreate, db: Session = Depends(get_db)
):
    if not db.get(Expert, expert_id):
        raise HTTPException(404, "Expert not found")
    server = db.get(McpServer, body.mcp_server_id)
    if server is None:
        raise HTTPException(404, f"MCP server {body.mcp_server_id} not found")
    existing = (
        db.query(ExpertMcpGrant)
        .filter(
            ExpertMcpGrant.expert_id == expert_id,
            ExpertMcpGrant.mcp_server_id == body.mcp_server_id,
        )
        .first()
    )
    if existing:
        raise HTTPException(409, "Expert already has a grant for this server")

    row = ExpertMcpGrant(
        expert_id=expert_id,
        mcp_server_id=body.mcp_server_id,
        all_tools=body.all_tools,
        selected_tools_json=(
            json.dumps(body.selected_tools)
            if body.selected_tools is not None
            else None
        ),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _grant_to_read(row, server)


@grants_router.patch(
    "/{expert_id}/mcp-grants/{grant_id}", response_model=McpGrantRead
)
def patch_grant(
    expert_id: str,
    grant_id: str,
    body: McpGrantPatch,
    db: Session = Depends(get_db),
):
    row = db.get(ExpertMcpGrant, grant_id)
    if row is None or row.expert_id != expert_id:
        raise HTTPException(404, "Grant not found")
    if body.all_tools is not None:
        row.all_tools = body.all_tools
    if body.selected_tools is not None:
        row.selected_tools_json = json.dumps(body.selected_tools)
    db.commit()
    db.refresh(row)
    server = db.get(McpServer, row.mcp_server_id)
    if server is None:
        raise HTTPException(404, "Backing MCP server disappeared")
    return _grant_to_read(row, server)


@grants_router.delete("/{expert_id}/mcp-grants/{grant_id}", status_code=204)
def delete_grant(
    expert_id: str, grant_id: str, db: Session = Depends(get_db)
):
    row = db.get(ExpertMcpGrant, grant_id)
    if row is None or row.expert_id != expert_id:
        raise HTTPException(404, "Grant not found")
    db.delete(row)
    db.commit()
    return Response(status_code=204)
