"""Build the Supabase Postgres mirror schema.

The remote is a *convergent copy*, not the authoritative store — referential
integrity is enforced by each device's local SQLite. So the mirror tables are
created **without foreign-key constraints** (which sidesteps all insert-ordering
and self-reference headaches during push) and **without app defaults** (values
arrive fully-formed in the outbox payload). Each mirror table gains a
``server_updated_at`` column that the pull cursor walks, plus a shared
``sync_tombstones`` table so deletes propagate.
"""

from sqlalchemy import (
    Column,
    DateTime,
    Index,
    MetaData,
    String,
    Table,
    func,
)

from database import Base

from .config import SYNCED_TABLES

# Mirror of the synced tables, FK-free, with a server clock column.
remote_metadata = MetaData()


def _build_remote_metadata() -> None:
    if remote_metadata.tables:
        return
    for tname in SYNCED_TABLES:
        src = Base.metadata.tables[tname]
        cols = [
            Column(c.name, c.type, primary_key=c.primary_key, nullable=True)
            for c in src.columns
        ]
        cols.append(
            Column(
                "server_updated_at",
                DateTime(timezone=True),
                server_default=func.now(),
                nullable=False,
            )
        )
        tbl = Table(tname, remote_metadata, *cols)
        Index(f"ix_{tname}_server_updated_at", tbl.c.server_updated_at)

    Table(
        "sync_tombstones",
        remote_metadata,
        Column("table_name", String(64), primary_key=True),
        Column("row_pk", String(128), primary_key=True),
        Column("deleted_at", DateTime(timezone=True), server_default=func.now(), nullable=False),
        Index("ix_sync_tombstones_deleted_at", "deleted_at"),
    )


def ensure_remote_schema(remote_engine) -> None:
    """Create the mirror tables + tombstones on the Supabase Postgres (idempotent)."""
    _build_remote_metadata()
    remote_metadata.create_all(bind=remote_engine)


def remote_columns(table_name: str) -> list[str]:
    """Column names of a mirror table (excludes server_updated_at)."""
    _build_remote_metadata()
    return [c.name for c in remote_metadata.tables[table_name].columns if c.name != "server_updated_at"]
