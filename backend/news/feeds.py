"""Curated public RSS/Atom feeds for the News app.

No API keys, no config UI — just a hand-picked, dependency-free list of
reputable feeds. Keep it small (a handful per category) so the feed stays a
"top stories of the day" experience rather than an endless river.

Categories: ``world | tech | business | science``. The virtual ``top``
category aggregates the best-of across every feed.

If a publisher rotates its RSS path the corresponding fetch just fails softly
(see ``service.fetch_feeds``) and the rest of the batch is unaffected.
"""
from __future__ import annotations

CATEGORIES: list[str] = [
    "top",
    "world",
    "tech",
    "business",
    "science",
    "sports",
    "entertainment",
    "health",
]

# Each feed: stable id, display source name, RSS/Atom url, category.
FEEDS: list[dict[str, str]] = [
    # ── World / general ────────────────────────────────────────────────
    {"id": "bbc-world", "name": "BBC News", "url": "https://feeds.bbci.co.uk/news/world/rss.xml", "category": "world"},
    {"id": "guardian-world", "name": "The Guardian", "url": "https://www.theguardian.com/world/rss", "category": "world"},
    {"id": "npr-news", "name": "NPR", "url": "https://feeds.npr.org/1001/rss.xml", "category": "world"},
    # ── Technology ─────────────────────────────────────────────────────
    {"id": "bbc-tech", "name": "BBC News", "url": "https://feeds.bbci.co.uk/news/technology/rss.xml", "category": "tech"},
    {"id": "hacker-news", "name": "Hacker News", "url": "https://hnrss.org/frontpage", "category": "tech"},
    {"id": "techcrunch", "name": "TechCrunch", "url": "https://techcrunch.com/feed/", "category": "tech"},
    {"id": "ars-technica", "name": "Ars Technica", "url": "https://feeds.arstechnica.com/arstechnica/index", "category": "tech"},
    # ── Business ───────────────────────────────────────────────────────
    {"id": "bbc-business", "name": "BBC News", "url": "https://feeds.bbci.co.uk/news/business/rss.xml", "category": "business"},
    {"id": "guardian-business", "name": "The Guardian", "url": "https://www.theguardian.com/business/rss", "category": "business"},
    # ── Science ────────────────────────────────────────────────────────
    {"id": "bbc-science", "name": "BBC News", "url": "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml", "category": "science"},
    {"id": "guardian-science", "name": "The Guardian", "url": "https://www.theguardian.com/science/rss", "category": "science"},
    {"id": "npr-science", "name": "NPR", "url": "https://feeds.npr.org/1007/rss.xml", "category": "science"},
    # ── Sports ─────────────────────────────────────────────────────────
    {"id": "bbc-sport", "name": "BBC Sport", "url": "https://feeds.bbci.co.uk/sport/rss.xml", "category": "sports"},
    {"id": "guardian-sport", "name": "The Guardian", "url": "https://www.theguardian.com/sport/rss", "category": "sports"},
    # ── Entertainment / Culture ────────────────────────────────────────
    {"id": "bbc-entertainment", "name": "BBC News", "url": "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml", "category": "entertainment"},
    {"id": "guardian-culture", "name": "The Guardian", "url": "https://www.theguardian.com/culture/rss", "category": "entertainment"},
    # ── Health ─────────────────────────────────────────────────────────
    {"id": "bbc-health", "name": "BBC News", "url": "https://feeds.bbci.co.uk/news/health/rss.xml", "category": "health"},
    {"id": "guardian-society", "name": "The Guardian", "url": "https://www.theguardian.com/society/rss", "category": "health"},
]


def feeds_for_category(category: str) -> list[dict[str, str]]:
    """Return the feeds backing a category. ``top`` = every feed."""
    if category == "top":
        return FEEDS
    return [f for f in FEEDS if f["category"] == category]
