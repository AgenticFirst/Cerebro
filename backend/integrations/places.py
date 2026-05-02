"""Google Places API client for business lead research."""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_TEXT_SEARCH_URL = "https://maps.googleapis.com/maps/api/place/textsearch/json"
_DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json"
_TIMEOUT = 10.0


def _extract_city_from_address(formatted_address: str, default_city: str) -> str:
    """Try to parse city from '123 Main St, Fort Lauderdale, FL 33301, USA'.

    Returns the city part (before the state abbreviation) if parseable,
    else returns default_city.
    """
    try:
        # Split on commas; typically: [street, city, state+zip, country]
        parts = [p.strip() for p in formatted_address.split(",")]
        if len(parts) >= 3:
            # The city is usually the second-to-last part before "State ZIP"
            # Walk from the end: last part is country, second-to-last is "FL 33301"
            # third-to-last is the city
            return parts[-3]
    except Exception:
        pass
    return default_city


async def _fetch_place_details(
    client: httpx.AsyncClient, place_id: str, api_key: str
) -> dict:
    """Fetch place details for a single place_id. Returns raw result dict or {}."""
    try:
        resp = await client.get(
            _DETAILS_URL,
            params={
                "place_id": place_id,
                "fields": "name,formatted_phone_number,website,formatted_address,rating,user_ratings_total,url",
                "key": api_key,
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("result", {})
    except Exception as exc:
        logger.error("places details fetch failed for %s: %s", place_id, exc)
        return {}


def _build_lead(text_result: dict, details: dict, default_city: str, default_state: str) -> dict:
    """Merge text-search result and place details into a normalised lead dict."""
    name = details.get("name") or text_result.get("name", "")
    phone = details.get("formatted_phone_number") or text_result.get("formatted_phone_number")
    website = details.get("website") or text_result.get("website")
    address = (
        details.get("formatted_address")
        or text_result.get("formatted_address")
    )
    rating = details.get("rating") or text_result.get("rating")
    review_count = (
        details.get("user_ratings_total")
        or text_result.get("user_ratings_total")
    )
    google_maps_url = details.get("url")
    google_place_id = text_result.get("place_id")

    city = default_city
    if address:
        city = _extract_city_from_address(address, default_city)

    return {
        "name": name,
        "phone": phone,
        "website": website,
        "address": address,
        "city": city,
        "state": default_state,
        "rating": float(rating) if rating is not None else None,
        "review_count": int(review_count) if review_count is not None else None,
        "google_place_id": google_place_id,
        "google_maps_url": google_maps_url,
    }


async def search_businesses(
    query: str,
    city: str,
    state: str,
    limit: int,
    api_key: str,
) -> list[dict]:
    """Search Google Places for businesses and enrich with place details.

    Args:
        query: Business type / specialty, e.g. "plastic surgery".
        city:  City name, e.g. "Fort Lauderdale".
        state: State abbreviation, e.g. "FL".
        limit: Max number of results (capped at 20 by Places API).
        api_key: Google Places API key.

    Returns:
        List of lead dicts with name, phone, website, address, city, state,
        rating, review_count, google_place_id, google_maps_url.
    """
    full_query = f"{query} {city} {state}"
    results: list[dict] = []

    try:
        async with httpx.AsyncClient() as client:
            # ── Step 1: Text Search ───────────────────────────────────────────
            try:
                resp = await client.get(
                    _TEXT_SEARCH_URL,
                    params={
                        "query": full_query,
                        "type": "establishment",
                        "key": api_key,
                    },
                    timeout=_TIMEOUT,
                )
                resp.raise_for_status()
                text_results = resp.json().get("results", [])
            except Exception as exc:
                logger.error("places text search failed for '%s': %s", full_query, exc)
                return []

            # Honour the limit (Places returns up to 20 anyway)
            text_results = text_results[:min(limit, 20)]

            if not text_results:
                return []

            # ── Step 2: Concurrent place details fetches ──────────────────────
            place_ids = [r.get("place_id", "") for r in text_results]
            detail_coros = [
                _fetch_place_details(client, pid, api_key) for pid in place_ids
            ]
            all_details: list[dict] = await asyncio.gather(*detail_coros)

            for text_result, details in zip(text_results, all_details):
                lead = _build_lead(text_result, details, city, state)
                results.append(lead)

    except Exception as exc:
        logger.error("search_businesses unexpected error: %s", exc)

    return results
