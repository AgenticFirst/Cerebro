"""Tests for the News app: parsing, ranking, and the stale-while-revalidate
endpoint. No real network — ``service.fetch_feeds`` is monkeypatched.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from news import service
from news.service import ParsedArticle

# ── parse_feed (pure, against inline fixtures) ─────────────────────────────

RSS_FIXTURE = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Example</title>
    <item>
      <title>Mars rover finds something</title>
      <link>https://example.com/mars</link>
      <description>A &lt;b&gt;rover&lt;/b&gt; discovered water.</description>
      <pubDate>Wed, 01 Jun 2026 12:00:00 GMT</pubDate>
      <media:thumbnail url="https://example.com/mars.jpg"/>
    </item>
    <item>
      <title>No image here</title>
      <link>https://example.com/plain</link>
      <description>Plain text &amp; entities.</description>
      <pubDate>Tue, 31 May 2026 09:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>"""

ATOM_FIXTURE = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <entry>
    <title>Atom story</title>
    <link rel="alternate" href="https://example.com/atom"/>
    <summary>An atom summary.</summary>
    <published>2026-06-01T08:30:00Z</published>
  </entry>
</feed>"""

_FEED = {"id": "test", "name": "Test Source", "url": "x", "category": "science"}


def test_parse_rss():
    arts = service.parse_feed(_FEED, RSS_FIXTURE)
    assert len(arts) == 2
    first = arts[0]
    assert first.title == "Mars rover finds something"
    assert first.url == "https://example.com/mars"
    assert first.summary == "A rover discovered water."  # tags stripped, entities unescaped
    assert first.image_url == "https://example.com/mars.jpg"
    assert first.category == "science"
    assert first.published_at is not None and first.published_at.year == 2026
    # stable id = sha1(url)
    assert first.id == service.sha1(b"https://example.com/mars").hexdigest()


def test_parse_atom():
    arts = service.parse_feed(_FEED, ATOM_FIXTURE)
    assert len(arts) == 1
    art = arts[0]
    assert art.title == "Atom story"
    assert art.url == "https://example.com/atom"
    assert art.summary == "An atom summary."
    assert art.published_at is not None


def test_parse_malformed_is_safe():
    assert service.parse_feed(_FEED, b"<not xml") == []


def test_image_picks_widest_media_content():
    # Feeds list the same image at several widths; we want the largest, not the first.
    xml = b"""<?xml version="1.0"?>
    <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
      <channel><item>
        <title>T</title><link>https://ex.com/x</link>
        <media:content url="https://i.guim.co.uk/a.jpg?width=140&amp;s=aaa" width="140"/>
        <media:content url="https://i.guim.co.uk/a.jpg?width=700&amp;s=ccc" width="700"/>
        <media:content url="https://i.guim.co.uk/a.jpg?width=460&amp;s=bbb" width="460"/>
      </item></channel>
    </rss>"""
    art = service.parse_feed(_FEED, xml)[0]
    assert art.image_url == "https://i.guim.co.uk/a.jpg?width=700&s=ccc"


def test_bbc_ichef_width_upscaled():
    xml = b"""<?xml version="1.0"?>
    <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
      <channel><item>
        <title>T</title><link>https://ex.com/y</link>
        <media:thumbnail url="https://ichef.bbci.co.uk/ace/standard/240/cpsprodpb/aa/live/bb.jpg"/>
      </item></channel>
    </rss>"""
    art = service.parse_feed(_FEED, xml)[0]
    assert art.image_url == "https://ichef.bbci.co.uk/ace/standard/1280/cpsprodpb/aa/live/bb.jpg"


def test_rank_dedupes_and_interleaves():
    now = datetime(2026, 6, 1, tzinfo=timezone.utc)

    def mk(feed_id, n, minute):
        url = f"https://{feed_id}.com/{n}"
        return ParsedArticle(
            id=service.sha1(url.encode()).hexdigest(),
            feed_id=feed_id, source_name=feed_id, title=f"{feed_id}-{n}",
            url=url, summary=None, image_url=None, category="tech",
            published_at=now.replace(minute=minute),
        )

    # feed A floods 5 recent items; feed B has 2 older ones.
    arts = [mk("A", i, 50 - i) for i in range(5)] + [mk("B", i, 10 - i) for i in range(2)]
    # add a duplicate of A-0 to prove dedup
    arts.append(mk("A", 0, 50))

    ranked = service.rank_articles(arts, limit=4)
    ids = [a.id for a in ranked]
    assert len(ids) == len(set(ids))  # no dupes
    # round-robin: B should appear in the top 4 even though A is more recent
    assert any(a.feed_id == "B" for a in ranked)


# ── endpoint: stale-while-revalidate ───────────────────────────────────────


def _canned(category="science"):
    return [
        ParsedArticle(
            id=service.sha1(b"https://example.com/a").hexdigest(),
            feed_id="bbc-science", source_name="BBC News",
            title="Story A", url="https://example.com/a",
            summary="summary a", image_url=None, category=category,
            published_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        )
    ]


def test_first_call_populates_and_is_fresh(client, monkeypatch):
    calls = {"n": 0}

    async def fake_fetch(feeds):
        calls["n"] += 1
        return _canned()

    monkeypatch.setattr(service, "fetch_feeds", fake_fetch)

    res = client.get("/news?category=science")
    assert res.status_code == 200
    body = res.json()
    assert body["count"] == 1
    assert body["stale"] is False
    assert body["category"] == "science"
    assert calls["n"] == 1


def test_second_call_within_ttl_skips_fetch(client, monkeypatch):
    calls = {"n": 0}

    async def fake_fetch(feeds):
        calls["n"] += 1
        return _canned()

    monkeypatch.setattr(service, "fetch_feeds", fake_fetch)

    client.get("/news?category=science")
    client.get("/news?category=science")
    assert calls["n"] == 1  # cached the second time


def test_refresh_param_forces_fetch(client, monkeypatch):
    calls = {"n": 0}

    async def fake_fetch(feeds):
        calls["n"] += 1
        return _canned()

    monkeypatch.setattr(service, "fetch_feeds", fake_fetch)

    client.get("/news?category=science")
    client.get("/news?category=science&refresh=true")
    assert calls["n"] == 2


def test_fetch_error_serves_cache_with_stale_flag(client, monkeypatch):
    async def ok_fetch(feeds):
        return _canned()

    monkeypatch.setattr(service, "fetch_feeds", ok_fetch)
    client.get("/news?category=science")  # seed cache

    async def boom(feeds):
        raise RuntimeError("network down")

    monkeypatch.setattr(service, "fetch_feeds", boom)
    res = client.get("/news?category=science&refresh=true")  # force refresh -> fails
    body = res.json()
    assert res.status_code == 200
    assert body["count"] == 1  # still serving cached row
    assert body["stale"] is True


def test_unknown_category_rejected(client):
    res = client.get("/news?category=politics")
    assert res.status_code == 400
