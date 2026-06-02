"""Fetch, parse, and rank RSS/Atom feeds for the News app.

Design notes
------------
* **No third-party parser.** We use the stdlib ``xml.etree.ElementTree`` so the
  open-source install needs no extra dependency (``feedparser`` would have to be
  added to both ``requirements.txt`` and ``requirements-ci.txt``). RSS 2.0 and
  Atom are simple enough to handle directly. A malformed feed raises
  ``ET.ParseError`` which we swallow per-feed so one bad source never wedges the
  batch.
* **Frugal.** A single pooled ``httpx.AsyncClient`` fans all feed requests out
  concurrently with ``asyncio.gather(return_exceptions=True)``; a dead feed is
  invisible. The caller (router) only invokes this when its cache is stale.
* **Ranking.** Recency first, then a round-robin interleave across sources so one
  chatty feed (Hacker News, TechCrunch) can't dominate the top of the list.
"""
from __future__ import annotations

import asyncio
import html
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from hashlib import sha1
from xml.etree import ElementTree as ET

import httpx

log = logging.getLogger(__name__)

TTL_SECONDS = 1800  # 30 min — re-fetch a category only when its cache is older
MAX_ARTICLES = 24   # per category; the UI surfaces ~12-18 prominently

_HTTP_TIMEOUT = 8.0
_USER_AGENT = "Cerebro/1.0 (+https://github.com/AgenticFirst/Cerebro)"
_SUMMARY_MAX = 280

# XML namespaces seen in the wild.
_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "media": "http://search.yahoo.com/mrss/",
}

_TAG_RE = re.compile(r"<[^>]+>")
_IMG_RE = re.compile(r"""<img[^>]+src=["']([^"']+)["']""", re.IGNORECASE)


@dataclass
class ParsedArticle:
    id: str
    feed_id: str
    source_name: str
    title: str
    url: str
    summary: str | None
    image_url: str | None
    category: str | None
    published_at: datetime | None


# ── Fetch ──────────────────────────────────────────────────────────────────


async def fetch_feeds(feeds: list[dict[str, str]]) -> list[ParsedArticle]:
    """Fetch and parse every feed concurrently. Soft-fails per feed."""
    if not feeds:
        return []
    headers = {"User-Agent": _USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml"}
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT, follow_redirects=True, headers=headers) as client:
        results = await asyncio.gather(
            *(_fetch_one(client, feed) for feed in feeds),
            return_exceptions=True,
        )
    articles: list[ParsedArticle] = []
    for feed, result in zip(feeds, results):
        if isinstance(result, Exception):
            log.warning("news: feed %s failed: %s", feed["id"], result)
            continue
        articles.extend(result)
    return articles


async def _fetch_one(client: httpx.AsyncClient, feed: dict[str, str]) -> list[ParsedArticle]:
    resp = await client.get(feed["url"])
    if resp.status_code != 200:
        log.warning("news: feed %s returned HTTP %s", feed["id"], resp.status_code)
        return []
    return parse_feed(feed, resp.content)


# ── Parse ──────────────────────────────────────────────────────────────────


def parse_feed(feed: dict[str, str], xml_bytes: bytes) -> list[ParsedArticle]:
    """Parse RSS 2.0 or Atom bytes into ParsedArticles. Never raises."""
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        log.warning("news: feed %s xml parse error: %s", feed["id"], exc)
        return []

    items = root.findall(".//item")
    if items:
        return [a for a in (_parse_rss_item(feed, it) for it in items) if a is not None]

    entries = root.findall(".//atom:entry", _NS)
    return [a for a in (_parse_atom_entry(feed, e) for e in entries) if a is not None]


def _parse_rss_item(feed: dict[str, str], item: ET.Element) -> ParsedArticle | None:
    title = _text(item.find("title"))
    link = _text(item.find("link"))
    if not title or not link:
        return None
    raw_summary = _text(item.find("description"))
    published = _parse_rss_date(_text(item.find("pubDate")))
    image = _extract_image(item, raw_summary)
    return _build(feed, title, link, raw_summary, image, published)


def _parse_atom_entry(feed: dict[str, str], entry: ET.Element) -> ParsedArticle | None:
    title = _text(entry.find("atom:title", _NS))
    link = _atom_link(entry)
    if not title or not link:
        return None
    raw_summary = _text(entry.find("atom:summary", _NS)) or _text(entry.find("atom:content", _NS))
    published = _parse_atom_date(
        _text(entry.find("atom:published", _NS)) or _text(entry.find("atom:updated", _NS))
    )
    image = _extract_image(entry, raw_summary)
    return _build(feed, title, link, raw_summary, image, published)


def _build(
    feed: dict[str, str],
    title: str,
    link: str,
    raw_summary: str | None,
    image: str | None,
    published: datetime | None,
) -> ParsedArticle:
    return ParsedArticle(
        id=sha1(link.encode("utf-8")).hexdigest(),
        feed_id=feed["id"],
        source_name=feed["name"],
        title=_clean_text(title) or title.strip(),
        url=link.strip(),
        summary=_clean_summary(raw_summary),
        image_url=image,
        category=feed.get("category"),
        published_at=published,
    )


# ── Field helpers ──────────────────────────────────────────────────────────


def _text(el: ET.Element | None) -> str | None:
    if el is None or el.text is None:
        return None
    value = el.text.strip()
    return value or None


def _atom_link(entry: ET.Element) -> str | None:
    """Atom <link> is an attribute (href); prefer rel='alternate'."""
    fallback: str | None = None
    for link in entry.findall("atom:link", _NS):
        href = link.get("href")
        if not href:
            continue
        rel = link.get("rel")
        if rel == "alternate" or rel is None:
            return href
        fallback = fallback or href
    return fallback


def _extract_image(el: ET.Element, raw_summary: str | None) -> str | None:
    # 1. media:content / media:thumbnail — feeds often list the SAME image at
    #    several widths (e.g. The Guardian gives 140/460/700, each signed), so
    #    pick the widest rather than the first to avoid tiny, upscaled thumbnails.
    best_url: str | None = None
    best_w = -1
    for tag in ("media:content", "media:thumbnail"):
        for node in el.findall(tag, _NS):
            url = node.get("url")
            if not url:
                continue
            mtype = node.get("type") or ""
            if mtype and not mtype.startswith("image"):
                continue
            try:
                w = int(node.get("width") or 0)
            except ValueError:
                w = 0
            if w > best_w:
                best_w, best_url = w, url
    if best_url:
        return _upscale_image_url(best_url)
    # 2. <enclosure type="image/..."> (RSS)
    for enc in el.findall("enclosure"):
        if (enc.get("type") or "").startswith("image") and enc.get("url"):
            return _upscale_image_url(enc.get("url"))
    # 3. first <img src> inside the description HTML
    if raw_summary:
        match = _IMG_RE.search(raw_summary)
        if match:
            return _upscale_image_url(match.group(1))
    return None


# BBC's ichef CDN bakes the width into the path (…/standard/240/…) with no URL
# signature, so we can request a larger, sharper render. Other CDNs sign their
# resize params, so we never rewrite those — we just pick their widest variant.
_BBC_ICHEF_RE = re.compile(r"(ichef\.bbci\.co\.uk/(?:[a-z_]+/)*?)(\d{2,4})(/)")
_BBC_TARGET_WIDTH = 1280


def _upscale_image_url(url: str) -> str:
    match = _BBC_ICHEF_RE.search(url)
    if match:
        try:
            if int(match.group(2)) < _BBC_TARGET_WIDTH:
                return f"{url[:match.start(2)]}{_BBC_TARGET_WIDTH}{url[match.end(2):]}"
        except ValueError:
            pass
    return url


def _clean_summary(raw: str | None) -> str | None:
    cleaned = _clean_text(raw)
    if not cleaned:
        return None
    if len(cleaned) > _SUMMARY_MAX:
        cleaned = cleaned[:_SUMMARY_MAX].rsplit(" ", 1)[0].rstrip() + "…"
    return cleaned


def _clean_text(raw: str | None) -> str | None:
    if not raw:
        return None
    text = html.unescape(_TAG_RE.sub("", raw)).strip()
    return re.sub(r"\s+", " ", text) or None


def _parse_rss_date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return _aware(dt)


def _parse_atom_date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _aware(dt)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ── Rank ───────────────────────────────────────────────────────────────────


def rank_articles(articles: list[ParsedArticle], limit: int = MAX_ARTICLES) -> list[ParsedArticle]:
    """Dedupe by id, sort by recency, then round-robin across sources so a
    single chatty feed can't monopolise the top of the list."""
    # Dedupe (same URL surfaced by overlapping feeds) keeping the first seen.
    seen: set[str] = set()
    unique: list[ParsedArticle] = []
    for art in articles:
        if art.id in seen:
            continue
        seen.add(art.id)
        unique.append(art)

    # Recency desc; undated articles sink to the bottom.
    _EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
    unique.sort(key=lambda a: a.published_at or _EPOCH, reverse=True)

    # Bucket by source, then interleave round-robin (each bucket already recency-sorted).
    buckets: dict[str, list[ParsedArticle]] = {}
    for art in unique:
        buckets.setdefault(art.feed_id, []).append(art)

    interleaved: list[ParsedArticle] = []
    while buckets and len(interleaved) < limit:
        for feed_id in list(buckets.keys()):
            bucket = buckets[feed_id]
            interleaved.append(bucket.pop(0))
            if not bucket:
                del buckets[feed_id]
            if len(interleaved) >= limit:
                break
    return interleaved
