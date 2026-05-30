"""Supabase Storage client for syncing managed file blobs across devices.

The DB sync mirrors `file_items` *rows*; this moves the actual bytes. Only
``storage_kind == 'managed'`` files are synced (workspace files are pointers
into the user's own folders — meaningless on another machine). Object keys are
the file's relative ``storage_path``, which itself syncs, so the key is
identical on every device.

Thin httpx wrapper over the Storage REST API — no new dependency (httpx is
already required). Best-effort: every method swallows errors and logs, because
a Storage hiccup must never break the row-level sync loop.
"""

import logging

import httpx

log = logging.getLogger(__name__)


class SupabaseStorage:
    def __init__(self, project_url: str, key: str, bucket: str):
        self.base = project_url.rstrip("/")
        self.key = key
        self.bucket = bucket
        self._bucket_ready = False
        self._client: httpx.Client | None = None

    @property
    def configured(self) -> bool:
        return bool(self.base and self.key and self.bucket)

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.key}", "apikey": self.key}

    def _http(self) -> httpx.Client:
        """One reused connection-pooled client for all calls (default 60s timeout)."""
        if self._client is None:
            self._client = httpx.Client(timeout=60)
        return self._client

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def ensure_bucket(self) -> None:
        """Create the (private) bucket once. No-op if it already exists."""
        if self._bucket_ready or not self.configured:
            return
        try:
            r = self._http().post(
                f"{self.base}/storage/v1/bucket",
                headers={**self._headers(), "Content-Type": "application/json"},
                json={"id": self.bucket, "name": self.bucket, "public": False},
                timeout=15,
            )
            # 200 created; 400/409 "already exists" are fine.
            if r.status_code in (200, 201, 400, 409):
                self._bucket_ready = True
            else:
                log.warning("Storage ensure_bucket unexpected %s: %s", r.status_code, r.text[:200])
        except Exception as e:  # noqa: BLE001
            log.warning("Storage ensure_bucket failed: %s", e)

    def upload(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> bool:
        if not self.configured:
            return False
        self.ensure_bucket()
        try:
            r = self._http().post(
                f"{self.base}/storage/v1/object/{self.bucket}/{key}",
                headers={
                    **self._headers(),
                    "Content-Type": content_type,
                    "x-upsert": "true",
                },
                content=data,
            )
            if r.status_code in (200, 201):
                return True
            log.warning("Storage upload %s -> %s: %s", key, r.status_code, r.text[:200])
            return False
        except Exception as e:  # noqa: BLE001
            log.warning("Storage upload failed for %s: %s", key, e)
            return False

    def download(self, key: str) -> bytes | None:
        if not self.configured:
            return None
        try:
            r = self._http().get(
                f"{self.base}/storage/v1/object/{self.bucket}/{key}",
                headers=self._headers(),
            )
            if r.status_code == 200:
                return r.content
            if r.status_code != 404:
                log.warning("Storage download %s -> %s", key, r.status_code)
            return None
        except Exception as e:  # noqa: BLE001
            log.warning("Storage download failed for %s: %s", key, e)
            return None
