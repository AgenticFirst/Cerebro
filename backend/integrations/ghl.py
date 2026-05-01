"""GoHighLevel API client.

Failures are logged but never re-raised so a broken GHL config cannot
interrupt task completion in the rest of the system.
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

GHL_BASE_URL = "https://services.leadconnectorhq.com"
GHL_API_VERSION = "2021-07-28"


def _classify_imd(total: float) -> str:
    if total >= 96:
        return "lider"
    if total >= 80:
        return "avanzado"
    if total >= 60:
        return "intermedio"
    return "basico"


class GHLClient:
    def __init__(self, api_key: str, location_id: str) -> None:
        self.location_id = location_id
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Version": GHL_API_VERSION,
            "Content-Type": "application/json",
        }

    async def find_or_create_contact(self, practice_name: str) -> Optional[str]:
        """Return existing contact_id or create one and return its id.

        Returns None on any API error so callers can short-circuit gracefully.
        """
        async with httpx.AsyncClient(base_url=GHL_BASE_URL, headers=self._headers) as client:
            # 1. Search first
            try:
                resp = await client.post(
                    "/contacts/search",
                    json={"locationId": self.location_id, "searchAfter": [], "filters": [], "query": practice_name, "pageLimit": 1},
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

    async def add_tags(self, contact_id: str, tags: list) -> bool:
        async with httpx.AsyncClient(base_url=GHL_BASE_URL, headers=self._headers) as client:
            try:
                resp = await client.patch(
                    f"/contacts/{contact_id}",
                    json={"tags": tags},
                    timeout=10.0,
                )
                resp.raise_for_status()
                logger.info("GHL: tags %s applied to contact %s", tags, contact_id)
                return True
            except Exception as exc:
                logger.error("GHL: failed to add tags to contact %s: %s", contact_id, exc)
                return False

    async def update_contact(self, contact_id: str, fields: dict) -> bool:
        async with httpx.AsyncClient(base_url=GHL_BASE_URL, headers=self._headers) as client:
            try:
                resp = await client.put(
                    f"/contacts/{contact_id}",
                    json=fields,
                    timeout=10.0,
                )
                resp.raise_for_status()
                logger.info("GHL: contact %s updated", contact_id)
                return True
            except Exception as exc:
                logger.error("GHL: failed to update contact %s: %s", contact_id, exc)
                return False

    async def create_opportunity(
        self,
        contact_id: str,
        name: str,
        pipeline_id: str,
        stage_id: Optional[str],
    ) -> Optional[str]:
        async with httpx.AsyncClient(base_url=GHL_BASE_URL, headers=self._headers) as client:
            try:
                payload: dict = {
                    "pipelineId": pipeline_id,
                    "locationId": self.location_id,
                    "name": name,
                    "contactId": contact_id,
                    "status": "open",
                }
                if stage_id is not None:
                    payload["pipelineStageId"] = stage_id
                resp = await client.post(
                    "/opportunities/",
                    json=payload,
                    timeout=10.0,
                )
                resp.raise_for_status()
                opportunity_id: str = resp.json()["opportunity"]["id"]
                logger.info("GHL: opportunity %s created for contact %s", opportunity_id, contact_id)
                return opportunity_id
            except Exception as exc:
                logger.error("GHL: failed to create opportunity for contact %s: %s", contact_id, exc)
                return None

    async def update_opportunity_stage(
        self,
        opportunity_id: str,
        stage_id: str,
        pipeline_id: str,
    ) -> bool:
        async with httpx.AsyncClient(base_url=GHL_BASE_URL, headers=self._headers) as client:
            try:
                resp = await client.put(
                    f"/opportunities/{opportunity_id}",
                    json={"pipelineId": pipeline_id, "pipelineStageId": stage_id},
                    timeout=10.0,
                )
                resp.raise_for_status()
                logger.info("GHL: opportunity %s moved to stage %s", opportunity_id, stage_id)
                return True
            except Exception as exc:
                logger.error("GHL: failed to update opportunity %s stage: %s", opportunity_id, exc)
                return False

    async def push_lead(
        self,
        lead: dict,
        scores: Optional[dict],
        pipeline_id: Optional[str],
        stage_id: Optional[str],
    ) -> tuple:
        industry = lead.get("industry", "aesthetic-medicine")
        language = lead.get("language", "en")
        business_name = lead.get("business_name", "")

        tags: list = ["cerebro-lead", f"industry-{industry}", f"lang-{language}"]

        if scores:
            dimension_values = [scores.get(f"d{n}") for n in range(1, 7)]
            numeric_values = [v for v in dimension_values if v is not None]
            if numeric_values:
                total = sum(numeric_values)
                tags.append(f"imd-score-{int(total)}")
                tags.append(f"imd-{_classify_imd(total)}")
            for n in range(1, 7):
                score = scores.get(f"d{n}")
                if score is not None:
                    tags.append(f"d{n}-{int(score)}")

        parts = business_name.strip().split(" ", 1)
        contact_payload: dict = {
            "locationId": self.location_id,
            "companyName": business_name,
            "firstName": parts[0],
            "lastName": parts[1] if len(parts) > 1 else "",
            "source": "cerebro",
        }
        for field in ("phone", "email", "website"):
            value = lead.get(field)
            if value:
                contact_payload[field] = value

        contact_id = await self.find_or_create_contact(business_name)
        if contact_id is None:
            logger.warning("GHL: push_lead aborted — could not resolve contact for %r", business_name)
            return None, None, []

        await self.update_contact(contact_id, contact_payload)
        await self.add_tags(contact_id, tags)

        note_lines = [f"# IMD Audit: {business_name}", "", "| Dimensión | Score |", "|---|---|"]
        dimension_labels = {
            "d1": "D1 Presencia",
            "d2": "D2 Tecnología",
            "d3": "D3 Contenido",
            "d4": "D4 Reputación",
            "d5": "D5 DM Digital",
            "d6": "D6 Teléfono",
        }
        score_values: list = []
        if scores:
            for key, label in dimension_labels.items():
                value = scores.get(key)
                if value is not None:
                    note_lines.append(f"| {label} | {value}/20 |")
                    score_values.append(value)

        if score_values:
            note_lines.append(f"| **Total** | **{sum(score_values):.1f}** |")

        if scores:
            pain_points = scores.get("pain_points") or []
            if pain_points:
                note_lines += ["", "## Pain Points", ""]
                for point in pain_points:
                    note_lines.append(f"- {point}")

            extra_notes = scores.get("notes")
            if extra_notes:
                note_lines += ["", "## Notes", "", extra_notes]

        await self.add_note(contact_id, "\n".join(note_lines))

        opportunity_id: Optional[str] = None
        if pipeline_id:
            opportunity_id = await self.create_opportunity(contact_id, business_name, pipeline_id, stage_id)

        return contact_id, opportunity_id, tags

    async def trigger_call(self, contact_id: str, language: str = "en") -> bool:
        tag = "ready-for-cold-call-en" if language == "en" else "ready-for-cold-call-es"
        return await self.add_tags(contact_id, [tag])

    async def get_custom_fields(self) -> list:
        """Return list of custom field dicts for the configured location.

        Returns an empty list on any error so callers can degrade gracefully.
        """
        async with httpx.AsyncClient(base_url=GHL_BASE_URL, headers=self._headers) as client:
            try:
                resp = await client.get(
                    f"/locations/{self.location_id}/customFields",
                    timeout=10.0,
                )
                resp.raise_for_status()
                data = resp.json()
                raw_fields = data.get("customFields", [])
                result = []
                for f in raw_fields:
                    result.append({
                        "id": f.get("id"),
                        "name": f.get("name"),
                        "fieldKey": f.get("fieldKey"),
                        "dataType": f.get("dataType"),
                        "position": f.get("position"),
                    })
                return result
            except Exception as exc:
                logger.error("GHL: failed to fetch custom fields: %s", exc)
                return []

    async def update_contact_custom_fields(self, contact_id: str, field_values: list) -> bool:
        """PUT custom field values onto an existing GHL contact.

        ``field_values`` is a list of ``{"id": "<field_id>", "value": "<string>"}``.
        Returns True on success, False on any error.
        """
        async with httpx.AsyncClient(base_url=GHL_BASE_URL, headers=self._headers) as client:
            try:
                resp = await client.put(
                    f"/contacts/{contact_id}",
                    json={"customFields": field_values},
                    timeout=10.0,
                )
                resp.raise_for_status()
                logger.info("GHL: custom fields updated on contact %s", contact_id)
                return True
            except Exception as exc:
                logger.error("GHL: failed to update custom fields on contact %s: %s", contact_id, exc)
                return False

    async def push_imd_scores_to_fields(
        self,
        contact_id: str,
        scores: dict,
        field_config: dict,
    ) -> bool:
        """Push IMD dimension scores to GHL contact custom fields.

        ``scores`` keys: d1, d2, d3, d4, d5, d6, total, classification.
        ``field_config`` keys: field_d1 … field_d6, field_total, field_classification
        — values are GHL custom field IDs (``None`` / missing means skip that dimension).

        Returns True when the update call succeeded, False if no fields were
        configured or the update failed.
        """
        score_key_to_config_key = {
            "d1": "field_d1",
            "d2": "field_d2",
            "d3": "field_d3",
            "d4": "field_d4",
            "d5": "field_d5",
            "d6": "field_d6",
            "total": "field_total",
            "classification": "field_classification",
        }

        field_values = []
        for score_key, config_key in score_key_to_config_key.items():
            field_id = field_config.get(config_key)
            if not field_id:
                continue
            score_value = scores.get(score_key)
            if score_value is None:
                continue
            field_values.append({"id": field_id, "value": str(score_value)})

        if not field_values:
            logger.debug("GHL: push_imd_scores_to_fields — no fields configured, skipping update")
            return False

        return await self.update_contact_custom_fields(contact_id, field_values)
