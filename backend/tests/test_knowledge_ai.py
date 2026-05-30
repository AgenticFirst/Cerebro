"""Tests for the Knowledge Base 'Ask AI' threads + messages API."""


def _page(client, title="Doc"):
    res = client.post("/knowledge/pages", json={"title": title})
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _thread(client, page_id, title="New chat"):
    res = client.post("/knowledge/ai/threads", json={"page_id": page_id, "title": title})
    assert res.status_code == 201, res.text
    return res.json()


def test_create_and_list_threads_for_page(client):
    page = _page(client)
    t1 = _thread(client, page, "First")
    t2 = _thread(client, page, "Second")

    threads = client.get("/knowledge/ai/threads", params={"page_id": page}).json()["threads"]
    ids = {t["id"] for t in threads}
    assert ids == {t1["id"], t2["id"]}
    assert all(t["page_id"] == page for t in threads)


def test_threads_are_page_scoped(client):
    page_a, page_b = _page(client, "A"), _page(client, "B")
    ta = _thread(client, page_a)
    _thread(client, page_b)

    a_threads = client.get("/knowledge/ai/threads", params={"page_id": page_a}).json()["threads"]
    assert [t["id"] for t in a_threads] == [ta["id"]]


def test_create_thread_under_missing_page_404(client):
    res = client.post("/knowledge/ai/threads", json={"page_id": "ghost", "title": "x"})
    assert res.status_code == 404


def test_rename_thread(client):
    page = _page(client)
    t = _thread(client, page, "Old")
    res = client.patch(f"/knowledge/ai/threads/{t['id']}", json={"title": "New Title"})
    assert res.status_code == 200
    assert res.json()["title"] == "New Title"


def test_append_and_list_messages_in_order(client):
    page = _page(client)
    t = _thread(client, page)
    for role, content in [("user", "hi"), ("assistant", "hello"), ("user", "more")]:
        res = client.post(
            f"/knowledge/ai/threads/{t['id']}/messages",
            json={"role": role, "content": content},
        )
        assert res.status_code == 201, res.text

    msgs = client.get(f"/knowledge/ai/threads/{t['id']}/messages").json()["messages"]
    assert [(m["role"], m["content"]) for m in msgs] == [
        ("user", "hi"),
        ("assistant", "hello"),
        ("user", "more"),
    ]


def test_message_under_missing_thread_404(client):
    assert (
        client.post("/knowledge/ai/threads/ghost/messages", json={"role": "user", "content": "x"}).status_code
        == 404
    )
    assert client.get("/knowledge/ai/threads/ghost/messages").status_code == 404


def test_delete_thread_cascades_messages(client):
    page = _page(client)
    t = _thread(client, page)
    client.post(f"/knowledge/ai/threads/{t['id']}/messages", json={"role": "user", "content": "x"})

    assert client.delete(f"/knowledge/ai/threads/{t['id']}").status_code == 204
    # Thread gone; its messages cascaded.
    assert client.get(f"/knowledge/ai/threads/{t['id']}/messages").status_code == 404


def test_deleting_page_cascades_threads_and_messages(client):
    page = _page(client)
    t = _thread(client, page)
    client.post(f"/knowledge/ai/threads/{t['id']}/messages", json={"role": "user", "content": "x"})

    assert client.delete(f"/knowledge/pages/{page}").status_code == 204
    # The page's threads cascaded away (listing returns empty, not 404).
    assert client.get("/knowledge/ai/threads", params={"page_id": page}).json()["threads"] == []
    assert client.get(f"/knowledge/ai/threads/{t['id']}/messages").status_code == 404
