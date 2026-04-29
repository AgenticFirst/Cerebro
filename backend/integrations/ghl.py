"""GoHighLevel API client.

Failures are logged but never re-raised so a broken GHL config cannot
interrupt task completion in the rest of the system.
"""
from __future__ import annotations

import logging

import httpx

logger = logging.getLogger(__name__)

GHL_BASE_URL = "https://services.leadconnectorhq.com"
GHL_API_VERSION = "2021-07-28"


class GHLClient:
    def __init__(self, api_key: str, location_id: str) -> None:
        self.location_id = location_id
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Version": GHL_API_VERSION,
            "Content-Type": "application/json",
        }

    async def find_or_create_contact(self, practice_name: str) -> str | None:
        """Return existing contact_id or create one and return its id.

        Returns None on any API error so callers can short-circuit gracefully.
        """
        async with httpx.AsyncClient(base_url=GHL_BASE_URL, headers=self._headers) as client:
            # 1. Search first
            try:
                resp = await client.get(
                    "/contacts/search",
                    params={"locationId": self.location_id, "query": practice_name},
                    timeout=10.0,
                )
                resp.raise_for_status()
                data = resp.json()
                contacts = data.get("contacts", [])
                if contacts:
                    contact_id: str = contacts[0]["id"]
                    logger.debug("GHL: found existing contact %s for %r", contact_id, practice_name)
                    return contact_id
            except Exception as exc:
                logger.error("GHL: contact search failed for %r: %s", practice_name, exc)
                return None

            # 2. Create if not found
            try:
                parts = practice_name.strip().split(" ", 1)
                first_name = parts[0]
                last_name = parts[1] if len(parts) > 1 else ""
                resp = await client.post(
                    "/contacts/",
                    json={
                        "locationId": self.location_id,
                        "firstName": first_name,
                        "lastName": last_name,
                        "tags": ["cerebro-brief"],
                    },
                    timeout=10.0,
                )
                resp.raise_for_status()
                contact_id = resp.json()["contact"]["id"]
                logger.info("GHL: created contact %s for %r", contact_id, practice_name)
                return contact_id
            except Exception as exc:
                logger.error("GHL: contact creation failed for %r: %s", practice_name, exc)
                return None

    async def add_note(self, contact_id: str, note_body: str) -> None:
        """POST a note to an existing GHL contact."""
        async with httpx.AsyncClient(base_url=GHL_BASE_URL, headers=self._headers) as client:
            try:
                resp = await client.post(
                    f"/contacts/{contact_id}/notes",
                    json={"body": note_body, "userId": "cerebro"},
                    timeout=10.0,
                )
                resp.raise_for_status()
                logger.info("GHL: note added to contact %s", contact_id)
            except Exception as exc:
                logger.error("GHL: failed to add note to contact %s: %s", contact_id, exc)

    async def push_intel_brief(self, task_title: str, brief_md: str) -> None:
        """Orchestrate: find/create contact then attach the intel brief as a note."""
        contact_id = await self.find_or_create_contact(task_title)
        if contact_id is None:
            logger.warning("GHL: skipping note — no contact id resolved for %r", task_title)
            return
        await self.add_note(contact_id, brief_md)
