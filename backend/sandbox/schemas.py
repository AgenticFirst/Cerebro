"""Pydantic schemas for the sandbox module.

Sandbox state is persisted as flat ``sandbox:*`` rows in the ``settings`` table,
following the same namespacing convention as ``memory:context:*``. The router
translates those rows into this shape on read and back to rows on write.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

LinkMode = Literal["read", "write"]


class LinkedProject(BaseModel):
    id: str
    path: str
    mode: LinkMode
    label: str
    added_at: str  # ISO-8601 UTC


class SandboxConfig(BaseModel):
    enabled: bool
    workspace_path: str
    linked_projects: list[LinkedProject] = Field(default_factory=list)
    banner_dismissed: bool = False
    platform_supported: bool  # True only on macOS for v1
    # Canonical list of home-relative paths that are always denied. Served from
    # the backend so the Seatbelt profile generator and the Settings UI can't
    # drift apart.
    forbidden_home_subpaths: list[str] = Field(default_factory=list)


class SandboxConfigPatch(BaseModel):
    enabled: bool | None = None
    workspace_path: str | None = None
    banner_dismissed: bool | None = None


class LinkedProjectCreate(BaseModel):
    path: str
    mode: LinkMode = "read"
    label: str | None = None


class LinkedProjectPatch(BaseModel):
    mode: LinkMode
