"""Tests for GET /conversations/search — global full-text search over chats.

Uses the ``client`` fixture (fresh temp SQLite per test with init_db run), so
the FTS5 tables, triggers, and backfill from database._setup_chat_fts are live.
"""

from sqlalchemy import text

import database
from conversation_search import SNIP_END, SNIP_START, fts_match_query


def _mk_conv(client, title="New Chat", **kwargs):
    res = client.post("/conversations", json={"title": title, **kwargs})
    assert res.status_code == 201
    return res.json()["id"]


def _mk_msg(client, conv_id, content, role="user"):
    res = client.post(
        f"/conversations/{conv_id}/messages", json={"role": role, "content": content}
    )
    assert res.status_code == 201
    return res.json()["id"]


def _search(client, q, **params):
    res = client.get("/conversations/search", params={"q": q, **params})
    assert res.status_code == 200
    return res.json()["results"]


# ── Query builder ─────────────────────────────────────────────────


def test_fts_operators_are_neutralized():
    # Every token is quoted, so AND/OR/NEAR are literal terms, not operators.
    assert fts_match_query("foo AND bar") == '"foo"* "AND"* "bar"*'
    assert fts_match_query("a NEAR b") == '"a"* "NEAR"* "b"*'


def test_fts_quotes_are_escaped():
    assert fts_match_query('say "hola"') == '"say"* """hola"""*'


def test_fts_accented_tokens_survive():
    # Whitespace tokenization must not mangle accents ("qué" -> "qu" bug).
    assert fts_match_query("medición qué") == '"medición"* "qué"*'


def test_fts_empty_query_is_none():
    assert fts_match_query("") is None
    assert fts_match_query("   ") is None


# ── Endpoint: matching + snippets ─────────────────────────────────


def test_empty_query_returns_no_results(client):
    conv = _mk_conv(client, title="Algo")
    _mk_msg(client, conv, "contenido cualquiera")
    assert _search(client, "") == []
    assert _search(client, "   ") == []


def test_content_match_returns_conversation_with_snippet(client):
    conv = _mk_conv(client, title="Chat de prueba")
    _mk_msg(client, conv, "hablamos del presupuesto de marketing para otoño")
    other = _mk_conv(client, title="Otro chat")
    _mk_msg(client, other, "nada relacionado aquí")

    results = _search(client, "presupuesto")
    assert len(results) == 1
    hit = results[0]
    assert hit["conversation_id"] == conv
    assert hit["match_count"] == 1
    snippet = hit["message_hits"][0]["snippet"]
    assert SNIP_START in snippet and SNIP_END in snippet
    assert "presupuesto" in snippet


def test_diacritics_match_both_directions(client):
    conv = _mk_conv(client)
    _mk_msg(client, conv, "los resultados de la medición fueron buenos")

    assert [r["conversation_id"] for r in _search(client, "medicion")] == [conv]
    assert [r["conversation_id"] for r in _search(client, "medición")] == [conv]

    conv2 = _mk_conv(client)
    _mk_msg(client, conv2, "sin acentos: la medicion original")
    ids = {r["conversation_id"] for r in _search(client, "medición")}
    assert ids == {conv, conv2}


def test_prefix_match(client):
    conv = _mk_conv(client)
    _mk_msg(client, conv, "revisamos la medición del sensor")
    assert [r["conversation_id"] for r in _search(client, "medi")] == [conv]


def test_title_match_ranks_above_content_match(client):
    content_conv = _mk_conv(client, title="Sin relación")
    _mk_msg(client, content_conv, "el presupuesto quedó aprobado")
    title_conv = _mk_conv(client, title="Presupuesto marketing")

    results = _search(client, "presupuesto")
    assert [r["conversation_id"] for r in results] == [title_conv, content_conv]
    assert results[0]["title_snippet"] is not None
    assert SNIP_START in results[0]["title_snippet"]
    # Title-only hit still returns cleanly with no message hits.
    assert results[0]["message_hits"] == []


def test_hits_group_by_conversation_with_capped_snippets(client):
    conv = _mk_conv(client)
    for i in range(5):
        _mk_msg(client, conv, f"mensaje {i} sobre zanahorias")

    results = _search(client, "zanahorias")
    assert len(results) == 1
    assert results[0]["match_count"] == 5
    assert len(results[0]["message_hits"]) == 3


def test_tool_role_messages_are_excluded(client):
    conv = _mk_conv(client)
    _mk_msg(client, conv, "salida interna con zanahoria", role="tool")
    assert _search(client, "zanahoria") == []


# ── Triggers keep the index in sync ───────────────────────────────


def test_patched_message_content_reindexes(client):
    conv = _mk_conv(client)
    msg = _mk_msg(client, conv, "tema original alpha")
    res = client.patch(
        f"/conversations/{conv}/messages/{msg}", json={"content": "tema nuevo betelgeuse"}
    )
    assert res.status_code == 200

    assert _search(client, "alpha") == []
    assert [r["conversation_id"] for r in _search(client, "betelgeuse")] == [conv]


def test_renamed_conversation_reindexes(client):
    conv = _mk_conv(client, title="Nombre viejo")
    res = client.patch(f"/conversations/{conv}", json={"title": "Estrategia trimestral"})
    assert res.status_code == 200

    assert _search(client, "viejo") == []
    assert [r["conversation_id"] for r in _search(client, "estrategia")] == [conv]


def test_deleted_conversation_leaves_no_hits(client):
    conv = _mk_conv(client, title="Efímera")
    _mk_msg(client, conv, "contenido sobre zanahorias")
    assert len(_search(client, "zanahorias")) == 1

    res = client.delete(f"/conversations/{conv}")
    assert res.status_code in (200, 204)
    assert _search(client, "zanahorias") == []
    assert _search(client, "efímera") == []


def test_backfill_indexes_preexisting_rows(client):
    conv = _mk_conv(client, title="Histórica")
    _mk_msg(client, conv, "datos antiguos sobre albaricoques")

    # Simulate an older database: wipe the FTS artifacts, then re-run setup.
    with database.engine.connect() as conn:
        for trig in (
            "messages_fts_ai", "messages_fts_ad", "messages_fts_au",
            "conversations_fts_ai", "conversations_fts_ad", "conversations_fts_au",
        ):
            conn.execute(text(f"DROP TRIGGER IF EXISTS {trig}"))
        conn.execute(text("DROP TABLE IF EXISTS messages_fts"))
        conn.execute(text("DROP TABLE IF EXISTS conversations_fts"))
        conn.commit()

    database._setup_chat_fts(database.engine)
    assert database.CHAT_FTS_AVAILABLE is True
    assert [r["conversation_id"] for r in _search(client, "albaricoques")] == [conv]
    assert [r["conversation_id"] for r in _search(client, "histórica")] == [conv]


# ── ilike fallback ────────────────────────────────────────────────


def test_ilike_fallback_still_matches_and_highlights(client, monkeypatch):
    conv = _mk_conv(client, title="Plan de otoño")
    _mk_msg(client, conv, "hablamos del presupuesto de marketing")
    monkeypatch.setattr(database, "CHAT_FTS_AVAILABLE", False)

    results = _search(client, "presupuesto")
    assert [r["conversation_id"] for r in results] == [conv]
    snippet = results[0]["message_hits"][0]["snippet"]
    assert SNIP_START in snippet and SNIP_END in snippet

    # Title matches work in the fallback too.
    results = _search(client, "otoño")
    assert results and results[0]["conversation_id"] == conv


def test_ilike_fallback_escapes_wildcards(client, monkeypatch):
    conv = _mk_conv(client)
    _mk_msg(client, conv, "cobertura al 100% del plan")
    monkeypatch.setattr(database, "CHAT_FTS_AVAILABLE", False)

    # A literal % must not act as a wildcard.
    assert [r["conversation_id"] for r in _search(client, "100%")] == [conv]
    assert _search(client, "999%") == []
