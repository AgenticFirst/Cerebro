"""Contract tests for the agent memory file-browser API.

Each Claude Code subagent owns a directory under `<userData>/agent-memory/<slug>/`
containing markdown files. These tests verify the CRUD, security, and validation
guarantees that the Settings > Memory UI depends on.

The router depends on `app.state.agent_memory_dir` being set to a tmp path, which
conftest.py handles via the `client` fixture.
"""

import os
from pathlib import Path


def test_list_directories_empty_root(client):
    """GET /agent-memory/dirs returns empty list when no directories exist."""
    response = client.get("/agent-memory")
    assert response.status_code == 200
    body = response.json()
    assert body == {"directories": []}


def test_list_directories_with_files(client):
    """GET /agent-memory/dirs lists directories with file_count and last_modified."""
    # Create a directory and files directly on disk.
    root = Path(client.app.state.agent_memory_dir)
    slug_dir = root / "researcher"
    slug_dir.mkdir(parents=True, exist_ok=True)
    (slug_dir / "notes.md").write_text("# Research notes", encoding="utf-8")
    (slug_dir / "findings.md").write_text("## Findings", encoding="utf-8")

    response = client.get("/agent-memory")
    assert response.status_code == 200
    body = response.json()
    assert len(body["directories"]) == 1
    dir_info = body["directories"][0]
    assert dir_info["slug"] == "researcher"
    assert dir_info["file_count"] == 2
    assert dir_info["last_modified"] is not None


def test_list_directories_ignores_non_md_files(client):
    """GET /agent-memory/dirs only counts .md files."""
    root = Path(client.app.state.agent_memory_dir)
    slug_dir = root / "analyst"
    slug_dir.mkdir(parents=True, exist_ok=True)
    (slug_dir / "report.md").write_text("Report", encoding="utf-8")
    (slug_dir / "data.txt").write_text("Not markdown", encoding="utf-8")
    (slug_dir / "image.png").write_bytes(b"fake png")

    response = client.get("/agent-memory")
    body = response.json()
    assert body["directories"][0]["file_count"] == 1


def test_list_directories_ignores_hidden_directories(client):
    """GET /agent-memory/dirs skips directories starting with .."""
    root = Path(client.app.state.agent_memory_dir)
    (root / ".hidden").mkdir(parents=True, exist_ok=True)
    (root / ".hidden" / "secret.md").write_text("Hidden", encoding="utf-8")
    (root / "visible").mkdir(parents=True, exist_ok=True)
    (root / "visible" / "public.md").write_text("Public", encoding="utf-8")

    response = client.get("/agent-memory")
    body = response.json()
    slugs = [d["slug"] for d in body["directories"]]
    assert "visible" in slugs
    assert ".hidden" not in slugs


def test_list_files_nonexistent_directory(client):
    """GET /agent-memory/{slug}/files for non-existent slug returns empty list."""
    response = client.get("/agent-memory/nonexistent/files")
    assert response.status_code == 200
    body = response.json()
    assert body == {"files": []}


def test_list_files_empty_directory(client):
    """GET /agent-memory/{slug}/files for empty directory returns empty list."""
    root = Path(client.app.state.agent_memory_dir)
    (root / "empty").mkdir(parents=True, exist_ok=True)

    response = client.get("/agent-memory/empty/files")
    assert response.status_code == 200
    body = response.json()
    assert body == {"files": []}


def test_list_files_with_markdown_files(client):
    """GET /agent-memory/{slug}/files lists .md files with path, size, last_modified."""
    root = Path(client.app.state.agent_memory_dir)
    slug_dir = root / "coder"
    slug_dir.mkdir(parents=True, exist_ok=True)
    (slug_dir / "main.md").write_text("# Code notes", encoding="utf-8")
    (slug_dir / "todo.md").write_text("- Fix bug", encoding="utf-8")

    response = client.get("/agent-memory/coder/files")
    assert response.status_code == 200
    body = response.json()
    assert len(body["files"]) == 2
    paths = sorted([f["path"] for f in body["files"]])
    assert paths == ["main.md", "todo.md"]
    for f in body["files"]:
        assert "size" in f
        assert "last_modified" in f
        assert f["size"] > 0


def test_list_files_nested_paths(client):
    """GET /agent-memory/{slug}/files returns nested .md files with relative paths."""
    root = Path(client.app.state.agent_memory_dir)
    slug_dir = root / "designer"
    slug_dir.mkdir(parents=True, exist_ok=True)
    (slug_dir / "root.md").write_text("Root", encoding="utf-8")
    (slug_dir / "folder").mkdir(parents=True, exist_ok=True)
    (slug_dir / "folder" / "nested.md").write_text("Nested", encoding="utf-8")
    (slug_dir / "folder" / "deep").mkdir(parents=True, exist_ok=True)
    (slug_dir / "folder" / "deep" / "file.md").write_text("Deep", encoding="utf-8")

    response = client.get("/agent-memory/designer/files")
    body = response.json()
    paths = sorted([f["path"] for f in body["files"]])
    assert "root.md" in paths
    assert "folder/nested.md" in paths
    assert "folder/deep/file.md" in paths


def test_read_file_success(client):
    """GET /agent-memory/{slug}/files/{path} returns file content."""
    root = Path(client.app.state.agent_memory_dir)
    slug_dir = root / "reader"
    slug_dir.mkdir(parents=True, exist_ok=True)
    content = "# My notes\n\nThis is important."
    (slug_dir / "notes.md").write_text(content, encoding="utf-8")

    response = client.get("/agent-memory/reader/files/notes.md")
    assert response.status_code == 200
    body = response.json()
    assert body["path"] == "notes.md"
    assert body["content"] == content
    assert "last_modified" in body


def test_read_file_nested_path(client):
    """GET /agent-memory/{slug}/files/{path} handles nested paths."""
    root = Path(client.app.state.agent_memory_dir)
    slug_dir = root / "reader"
    slug_dir.mkdir(parents=True, exist_ok=True)
    (slug_dir / "subfolder").mkdir(parents=True, exist_ok=True)
    nested_content = "Nested content"
    (slug_dir / "subfolder" / "nested.md").write_text(nested_content, encoding="utf-8")

    response = client.get("/agent-memory/reader/files/subfolder/nested.md")
    assert response.status_code == 200
    body = response.json()
    assert body["path"] == "subfolder/nested.md"
    assert body["content"] == nested_content


def test_read_nonexistent_file(client):
    """GET /agent-memory/{slug}/files/{path} for non-existent file returns 404."""
    response = client.get("/agent-memory/anyslug/files/missing.md")
    assert response.status_code == 404


def test_write_file_creates_new_file(client):
    """PUT /agent-memory/{slug}/files/{path} creates a new .md file."""
    content = "# New file\nFresh content"
    response = client.put(
        "/agent-memory/writer/files/new.md",
        json={"content": content}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["path"] == "new.md"
    assert body["content"] == content
    assert "last_modified" in body

    # Verify file exists on disk.
    root = Path(client.app.state.agent_memory_dir)
    assert (root / "writer" / "new.md").read_text(encoding="utf-8") == content


def test_write_file_overwrites_existing(client):
    """PUT /agent-memory/{slug}/files/{path} overwrites existing file."""
    root = Path(client.app.state.agent_memory_dir)
    slug_dir = root / "writer"
    slug_dir.mkdir(parents=True, exist_ok=True)
    (slug_dir / "existing.md").write_text("Old content", encoding="utf-8")

    new_content = "Updated content"
    response = client.put(
        "/agent-memory/writer/files/existing.md",
        json={"content": new_content}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["content"] == new_content
    assert (slug_dir / "existing.md").read_text(encoding="utf-8") == new_content


def test_write_file_nested_path_creates_parents(client):
    """PUT /agent-memory/{slug}/files/{path} creates parent directories."""
    content = "Nested file"
    response = client.put(
        "/agent-memory/writer/files/a/b/c/nested.md",
        json={"content": content}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["path"] == "a/b/c/nested.md"

    root = Path(client.app.state.agent_memory_dir)
    assert (root / "writer" / "a" / "b" / "c" / "nested.md").read_text(encoding="utf-8") == content


def test_write_file_non_md_extension_rejected(client):
    """PUT /agent-memory/{slug}/files/{path} rejects non-.md files."""
    response = client.put(
        "/agent-memory/writer/files/file.txt",
        json={"content": "text content"}
    )
    assert response.status_code == 400

    response = client.put(
        "/agent-memory/writer/files/script.py",
        json={"content": "python code"}
    )
    assert response.status_code == 400


def test_delete_file_success(client):
    """DELETE /agent-memory/{slug}/files/{path} removes the file."""
    root = Path(client.app.state.agent_memory_dir)
    slug_dir = root / "deleter"
    slug_dir.mkdir(parents=True, exist_ok=True)
    (slug_dir / "remove_me.md").write_text("To be deleted", encoding="utf-8")

    response = client.delete("/agent-memory/deleter/files/remove_me.md")
    assert response.status_code == 204

    # Verify file is gone.
    assert not (slug_dir / "remove_me.md").exists()

    # Subsequent read returns 404.
    response = client.get("/agent-memory/deleter/files/remove_me.md")
    assert response.status_code == 404


def test_delete_nonexistent_file(client):
    """DELETE /agent-memory/{slug}/files/{path} for non-existent file returns 204."""
    response = client.delete("/agent-memory/deleter/files/ghost.md")
    assert response.status_code == 204


def test_delete_nested_file(client):
    """DELETE /agent-memory/{slug}/files/{path} removes nested files."""
    root = Path(client.app.state.agent_memory_dir)
    slug_dir = root / "deleter"
    slug_dir.mkdir(parents=True, exist_ok=True)
    (slug_dir / "sub").mkdir(parents=True, exist_ok=True)
    (slug_dir / "sub" / "nested.md").write_text("Nested", encoding="utf-8")

    response = client.delete("/agent-memory/deleter/files/sub/nested.md")
    assert response.status_code == 204

    assert not (slug_dir / "sub" / "nested.md").exists()


# Note: httpx resolves `..` segments client-side per RFC 3986 before sending,
# so plain `../` in the URL never reaches the server. To actually exercise the
# `_safe_join` guard we URL-encode the dots (`%2E%2E`), which httpx leaves
# intact and FastAPI decodes at handler time.

def test_path_traversal_via_dotdot_rejected(client):
    """GET with URL-encoded `..` triggers _safe_join → 400."""
    response = client.get("/agent-memory/test/files/%2E%2E/%2E%2E/etc/passwd")
    assert response.status_code == 400


def test_path_traversal_in_write_rejected(client):
    """PUT with URL-encoded `..` triggers _safe_join → 400."""
    response = client.put(
        "/agent-memory/test/files/%2E%2E/%2E%2E/etc/passwd.md",
        json={"content": "malicious"},
    )
    assert response.status_code == 400


def test_path_traversal_in_delete_rejected(client):
    """DELETE with URL-encoded `..` triggers _safe_join → 400."""
    response = client.delete("/agent-memory/test/files/%2E%2E/%2E%2E/etc/passwd.md")
    assert response.status_code == 400


def test_absolute_path_rejected(client):
    """Leading `/` in file_path (encoded so httpx doesn't collapse) → 400."""
    response = client.get("/agent-memory/test/files/%2Fetc%2Fpasswd.md")
    assert response.status_code == 400


def test_slug_with_backslash_rejected(client):
    """Slug containing a backslash is rejected by _slug_dir."""
    # Backslash URL-encoded as %5C so it survives transport as part of the slug.
    response = client.get("/agent-memory/bad%5Cslug/files")
    assert response.status_code == 400


def test_slug_starting_with_dot_rejected(client):
    """Slug starting with `.` is rejected by _slug_dir."""
    response = client.get("/agent-memory/.hidden/files")
    assert response.status_code == 400


# Slugs containing `/` and empty slugs are not reachable via HTTP — the router
# simply won't match the pattern, so those cases can't be exercised here
# without leaking into a routing-layer test. The guard inside _slug_dir is
# defense-in-depth for programmatic callers; the tests above cover the
# externally-reachable inputs.
