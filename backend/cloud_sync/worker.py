"""Background sync worker: reconciles local SQLite with Supabase Postgres.

Runs in a daemon thread. Each tick it **pushes** pending outbox rows to the
remote mirror (upsert / delete + tombstone, last-write-wins) and **pulls** rows
changed since a per-device cursor, applying them locally (also LWW). A failed
tick (offline) leaves the outbox intact and simply retries — that is the
"sync when back online" behaviour. Apply-locally writes are flagged so the
outbox capture skips them (no echo).
"""

import json
import logging
import mimetypes
import os
import threading
from datetime import datetime, timezone

from sqlalchemy import DateTime, func, inspect as sa_inspect, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

import database
import models as _models
from database import Base, build_engine

from .config import (
    MTIME_COLUMN,
    PK_COLUMN,
    SYNCED_TABLES,
    blob_path_from_payload,
    is_local_only_setting,
)
from .outbox import set_sync_enabled
from .schema import _build_remote_metadata, ensure_remote_schema, remote_metadata

_build_remote_metadata()  # populate the mirror table objects at import

log = logging.getLogger(__name__)

CURSOR_SETTING_KEY = "sync:cursor"  # local-only (sync: prefix) — never leaves device


def _session_local():
    """Resolve the live ``SessionLocal`` from the database module.

    The worker is imported (and this module's globals are bound) *before*
    ``database.init_db()`` runs, when ``database.SessionLocal`` is still
    ``None``. Reading it through the module at call time — rather than via a
    ``from database import SessionLocal`` that captures the stale ``None`` —
    guarantees we get the real sessionmaker once init has happened.
    """
    return database.SessionLocal

# table name -> ORM model class (for applying pulled rows locally)
MODEL_BY_TABLE: dict[str, type] = {
    obj.__tablename__: obj
    for obj in vars(_models).values()
    if isinstance(obj, type) and issubclass(obj, Base) and hasattr(obj, "__tablename__")
}


# Per-model maps from DB column NAME -> (ORM attribute key, column type).
# Built once; the ORM attribute differs from the DB name where a column was
# renamed (e.g. messages.metadata_json maps to column "metadata").
_ATTR_INFO: dict[type, dict[str, tuple[str, object]]] = {}


def _attr_info(model) -> dict[str, tuple[str, object]]:
    cached = _ATTR_INFO.get(model)
    if cached is None:
        mapper = sa_inspect(model)
        cached = {
            prop.columns[0].name: (prop.key, prop.columns[0].type)
            for prop in mapper.column_attrs
        }
        _ATTR_INFO[model] = cached
    return cached


def _parse_dt(value):
    """ISO string / datetime -> naive-UTC datetime for consistent comparison."""
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            return None
    if isinstance(value, datetime) and value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def _coerce_for_remote(table_name: str, row: dict) -> dict:
    """Turn JSON-decoded payload values into types the remote columns expect."""
    tbl = remote_metadata.tables[table_name]
    out = {}
    for name, val in row.items():
        col = tbl.columns.get(name)
        if col is not None and isinstance(col.type, DateTime) and isinstance(val, str):
            out[name] = _parse_dt(val)
        else:
            out[name] = val
    return out


class SyncWorker:
    def __init__(
        self,
        remote_url: str,
        storage=None,
        files_dir: str | None = None,
        interval_s: float = 20.0,
    ):
        self.remote_url = remote_url
        self.storage = storage  # SupabaseStorage | None
        self.files_dir = files_dir
        self.interval_s = interval_s
        self.remote_engine = None
        self._thread: threading.Thread | None = None
        self._wake = threading.Event()
        self._stop = threading.Event()
        # status surfaced to the UI
        self.status = "idle"  # idle | syncing | offline | error
        self.last_synced_at: str | None = None
        self.last_error: str | None = None
        # One successful purge of leaked local-only settings per worker
        # lifetime (the worker is rebuilt on every start_sync, so each app
        # launch re-purges).
        self._purged_local_only = False

    # ----- lifecycle -----
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        set_sync_enabled(True)
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="cloud-sync", daemon=True)
        self._thread.start()
        log.info("Cloud sync worker started")

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        set_sync_enabled(False)
        if self.storage is not None:
            self.storage.close()

    def trigger(self) -> None:
        """Ask the worker to sync now (e.g. right after a write burst)."""
        self._wake.set()

    def snapshot(self) -> dict:
        return {
            "status": self.status,
            "last_synced_at": self.last_synced_at,
            "last_error": self.last_error,
            "pending": self._pending_count(),
        }

    # ----- main loop -----
    def _run(self) -> None:
        try:
            self.remote_engine = build_engine(self.remote_url)
            ensure_remote_schema(self.remote_engine)
        except Exception as e:  # noqa: BLE001
            self.status = "offline"
            self.last_error = str(e)
            log.warning("Cloud sync: remote unreachable at startup: %s", e)

        while not self._stop.is_set():
            try:
                self._tick()
            except Exception as e:  # noqa: BLE001
                self.status = "offline"
                self.last_error = str(e)
                log.warning("Cloud sync tick failed (will retry): %s", e)
            self._wake.wait(timeout=self.interval_s)
            self._wake.clear()

    def _tick(self) -> None:
        if self.remote_engine is None:
            self.remote_engine = build_engine(self.remote_url)
            ensure_remote_schema(self.remote_engine)
        self.status = "syncing"
        if not self._purged_local_only:
            self._purge_local_only_leftovers()
            self._purged_local_only = True
        self._push()
        self._pull()
        self.status = "idle"
        self.last_error = None
        self.last_synced_at = datetime.now(timezone.utc).isoformat()

    # ----- repair -----
    def _purge_local_only_leftovers(self) -> None:
        """Remove local-only settings that ever leaked into the sync plane.

        Older builds pushed credential settings (keychain ciphertext that is
        useless on any other machine) before their prefixes were added to
        LOCAL_ONLY_SETTING_PREFIXES. Those rows keep clobbering every device's
        working tokens on pull, so delete them at the source: the remote
        `settings` mirror, remote `sync_tombstones`, and any still-pending
        local outbox rows queued before the prefix existed. Plain remote
        DELETEs never surface in other devices' pulls (pulls filter on
        server_updated_at / deleted_at > cursor), and every device keeps its
        own local copy — nothing local is lost.
        """
        settings_tbl = remote_metadata.tables["settings"]
        tomb_tbl = remote_metadata.tables["sync_tombstones"]
        purged_settings = purged_tombstones = 0
        with self.remote_engine.begin() as conn:
            keys = [
                row[0]
                for row in conn.execute(select(settings_tbl.c.key))
                if is_local_only_setting(str(row[0]))
            ]
            for i in range(0, len(keys), 500):
                chunk = keys[i : i + 500]
                conn.execute(settings_tbl.delete().where(settings_tbl.c.key.in_(chunk)))
            purged_settings = len(keys)

            tomb_pks = [
                row[0]
                for row in conn.execute(
                    select(tomb_tbl.c.row_pk).where(tomb_tbl.c.table_name == "settings")
                )
                if is_local_only_setting(str(row[0]))
            ]
            for i in range(0, len(tomb_pks), 500):
                chunk = tomb_pks[i : i + 500]
                conn.execute(
                    tomb_tbl.delete().where(
                        (tomb_tbl.c.table_name == "settings")
                        & (tomb_tbl.c.row_pk.in_(chunk))
                    )
                )
            purged_tombstones = len(tomb_pks)

        purged_outbox = 0
        session_local = _session_local()
        if session_local is not None:
            s = session_local()
            s.info["cloud_sync_apply"] = True
            try:
                pending = (
                    s.query(_models.SyncOutbox)
                    .filter(
                        _models.SyncOutbox.status == "pending",
                        _models.SyncOutbox.table_name == "settings",
                    )
                    .all()
                )
                for ob in pending:
                    if is_local_only_setting(str(ob.row_pk)):
                        s.delete(ob)
                        purged_outbox += 1
                s.commit()
            finally:
                s.close()

        if purged_settings or purged_tombstones or purged_outbox:
            log.info(
                "Cloud sync: purged leaked local-only settings — "
                "%d remote rows, %d tombstones, %d pending outbox rows",
                purged_settings,
                purged_tombstones,
                purged_outbox,
            )

    # ----- push -----
    def _pending_count(self) -> int:
        session_local = _session_local()
        if session_local is None:
            return 0
        s = session_local()
        try:
            return (
                s.query(_models.SyncOutbox)
                .filter(_models.SyncOutbox.status == "pending")
                .count()
            )
        finally:
            s.close()

    def _push(self) -> None:
        session_local = _session_local()
        if session_local is None:
            # Surface a real, non-empty reason. A bare ``assert`` would raise
            # ``AssertionError('')`` whose empty message the run loop stores as
            # ``last_error``, leaving the UI showing 'offline' with no reason.
            raise RuntimeError(
                "cloud sync: local database not initialized (SessionLocal is None)"
            )
        s = session_local()
        try:
            rows = (
                s.query(_models.SyncOutbox)
                .filter(_models.SyncOutbox.status == "pending")
                .order_by(_models.SyncOutbox.created_at, _models.SyncOutbox.id)
                .limit(500)
                .all()
            )
            if not rows:
                return
            blob_paths: list[str] = []
            with self.remote_engine.begin() as conn:
                for ob in rows:
                    data = json.loads(ob.payload_json) if ob.payload_json else None
                    self._push_one(conn, ob, data)
                    if ob.op in ("insert", "update") and data is not None:
                        sp = blob_path_from_payload(ob.table_name, data)
                        if sp:
                            blob_paths.append(sp)
                    ob.status = "done"
            s.commit()
            self._upload_blobs(blob_paths)
        finally:
            s.close()

    def _push_one(self, conn, ob, data) -> None:
        table = ob.table_name
        pk = PK_COLUMN[table]
        mtime = MTIME_COLUMN[table]
        tbl = remote_metadata.tables[table]
        if ob.op == "delete":
            conn.execute(tbl.delete().where(tbl.c[pk] == ob.row_pk))
            tomb = remote_metadata.tables["sync_tombstones"]
            ins = pg_insert(tomb).values(
                table_name=table, row_pk=ob.row_pk, deleted_at=func.now()
            )
            conn.execute(
                ins.on_conflict_do_update(
                    index_elements=["table_name", "row_pk"],
                    set_={"deleted_at": func.now()},
                )
            )
            return

        row = _coerce_for_remote(table, data)
        ins = pg_insert(tbl).values(**row)
        update_cols = {c: ins.excluded[c] for c in row if c != pk}
        update_cols["server_updated_at"] = func.now()
        where = None
        if mtime in row and row.get(mtime) is not None:
            # LWW: only overwrite the remote if our row is at least as new.
            where = tbl.c[mtime] <= ins.excluded[mtime]
        conn.execute(
            ins.on_conflict_do_update(index_elements=[pk], set_=update_cols, where=where)
        )

    # ----- pull -----
    def _get_cursor(self) -> datetime | None:
        s = _session_local()()
        try:
            row = s.get(_models.Setting, CURSOR_SETTING_KEY)
            return _parse_dt(row.value) if row else None
        finally:
            s.close()

    def _set_cursor(self, value: datetime) -> None:
        s = _session_local()()
        s.info["cloud_sync_apply"] = True  # bookkeeping, never sync the cursor
        try:
            row = s.get(_models.Setting, CURSOR_SETTING_KEY)
            iso = value.isoformat()
            if row:
                row.value = iso
            else:
                s.add(_models.Setting(key=CURSOR_SETTING_KEY, value=iso))
            s.commit()
        finally:
            s.close()

    def _pull(self) -> None:
        cursor = self._get_cursor()
        high = cursor
        with self.remote_engine.connect() as conn:
            for table in SYNCED_TABLES:
                high = self._pull_table(conn, table, cursor, high)
            high = self._pull_tombstones(conn, cursor, high)
        if high is not None and (cursor is None or high > cursor):
            self._set_cursor(high)

    def _pull_table(self, conn, table, cursor, high):
        tbl = remote_metadata.tables[table]
        stmt = select(tbl)
        if cursor is not None:
            stmt = stmt.where(tbl.c.server_updated_at > cursor)
        stmt = stmt.order_by(tbl.c.server_updated_at).limit(1000)
        result = conn.execute(stmt).mappings().all()
        if not result:
            return high
        model = MODEL_BY_TABLE[table]
        pk = PK_COLUMN[table]
        mtime = MTIME_COLUMN[table]
        s = _session_local()()
        s.info["cloud_sync_apply"] = True
        blob_paths: list[str] = []
        try:
            for rrow in result:
                server_ts = _parse_dt(rrow["server_updated_at"])
                if server_ts is not None and (high is None or server_ts > high):
                    high = server_ts
                # Local-only settings must never be applied from the remote:
                # credential envelopes are OS-keychain ciphertext from another
                # machine and would clobber this device's working token. The
                # cursor still advances (above) so a batch of skipped rows
                # can't stall the pull.
                if table == "settings" and is_local_only_setting(str(rrow[pk])):
                    continue
                data = {k: v for k, v in rrow.items() if k != "server_updated_at"}
                self._apply_local(s, model, pk, mtime, data)
                sp = blob_path_from_payload(table, data)
                if sp:
                    blob_paths.append(sp)
            s.commit()
        finally:
            s.close()
        self._download_blobs(blob_paths)
        return high

    def _apply_local(self, s, model, pk, mtime, data) -> None:
        # Remote rows are keyed by DB column NAME; the local ORM is keyed by
        # attribute KEY. These differ where a column was renamed (e.g.
        # messages.metadata_json -> column "metadata"). Translate, and normalise
        # datetime columns to naive-UTC for the local SQLite store.
        info = _attr_info(model)
        norm: dict = {}
        for name, v in data.items():
            attr, coltype = info.get(name, (name, None))
            norm[attr] = _parse_dt(v) if isinstance(coltype, DateTime) else v

        pk_key = info.get(pk, (pk, None))[0]
        mtime_key = info.get(mtime, (mtime, None))[0]
        pk_val = norm[pk_key]
        existing = s.get(model, pk_val)
        incoming_mtime = _parse_dt(data.get(mtime))
        if existing is None:
            s.add(model(**norm))
            return
        local_mtime = _parse_dt(getattr(existing, mtime_key, None))
        if incoming_mtime is not None and local_mtime is not None and incoming_mtime < local_mtime:
            return  # local is newer — keep it
        for key, v in norm.items():
            if key == pk_key:
                continue
            setattr(existing, key, v)

    def _pull_tombstones(self, conn, cursor, high):
        tomb = remote_metadata.tables["sync_tombstones"]
        stmt = select(tomb)
        if cursor is not None:
            stmt = stmt.where(tomb.c.deleted_at > cursor)
        stmt = stmt.order_by(tomb.c.deleted_at).limit(1000)
        result = conn.execute(stmt).mappings().all()
        if not result:
            return high
        s = _session_local()()
        s.info["cloud_sync_apply"] = True
        try:
            for rrow in result:
                ts = _parse_dt(rrow["deleted_at"])
                if ts is not None and (high is None or ts > high):
                    high = ts
                table = rrow["table_name"]
                model = MODEL_BY_TABLE.get(table)
                if model is None:
                    continue
                # A remote tombstone must not delete this device's local-only
                # settings (e.g. a credential another device cleared).
                if table == "settings" and is_local_only_setting(str(rrow["row_pk"])):
                    continue
                existing = s.get(model, rrow["row_pk"])
                if existing is not None:
                    s.delete(existing)
            s.commit()
        finally:
            s.close()
        return high

    # ----- file blobs (Supabase Storage) -----
    def _blob_abs(self, storage_path: str) -> str | None:
        if not self.files_dir:
            return None
        return os.path.abspath(os.path.join(self.files_dir, storage_path))

    def _upload_blobs(self, storage_paths: list[str]) -> None:
        if not self.storage or not self.storage.configured or not self.files_dir:
            return
        for sp in set(storage_paths):
            abs_p = self._blob_abs(sp)
            if not abs_p or not os.path.isfile(abs_p):
                continue
            try:
                with open(abs_p, "rb") as fh:
                    data = fh.read()
            except OSError as e:
                log.warning("Storage: could not read %s: %s", abs_p, e)
                continue
            ct = mimetypes.guess_type(sp)[0] or "application/octet-stream"
            self.storage.upload(sp, data, ct)

    def _download_blobs(self, storage_paths: list[str]) -> None:
        """Eagerly fetch any managed blob present in Storage but missing locally."""
        if not self.storage or not self.storage.configured or not self.files_dir:
            return
        for sp in set(storage_paths):
            abs_p = self._blob_abs(sp)
            if not abs_p or os.path.isfile(abs_p):
                continue  # already have it
            data = self.storage.download(sp)
            if data is None:
                continue
            try:
                os.makedirs(os.path.dirname(abs_p), exist_ok=True)
                with open(abs_p, "wb") as fh:
                    fh.write(data)
            except OSError as e:
                log.warning("Storage: could not write %s: %s", abs_p, e)
