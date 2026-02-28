"""Tests for the local models module: catalog, state, hardware, download, inference."""

import json
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from main import app
from database import init_db
from local_models.catalog import (
    CATALOG,
    detect_hardware,
    get_catalog,
    get_catalog_entry,
    get_model_state,
    load_state,
    recover_interrupted,
    recommend_model,
    remove_model_state,
    save_state,
    set_model_state,
)
from local_models.schemas import HardwareInfo


@pytest.fixture()
def models_dir(tmp_path):
    """Provide a temporary models directory."""
    d = tmp_path / "models"
    d.mkdir()
    return str(d)


@pytest.fixture()
def client_with_models(tmp_path):
    """Test client with both DB and models directory configured."""
    db_path = str(tmp_path / "test.db")
    models_dir = str(tmp_path / "models")
    os.makedirs(models_dir, exist_ok=True)

    app.state.db_path = db_path
    app.state.models_dir = models_dir
    init_db(db_path)

    # Initialize singletons for the router
    from local_models.router import init_singletons
    init_singletons()

    with TestClient(app) as c:
        yield c, models_dir


# ── Catalog tests ────────────────────────────────────────────────


class TestCatalog:
    def test_catalog_has_three_models(self):
        assert len(CATALOG) == 3

    def test_catalog_model_ids(self):
        ids = [m["id"] for m in CATALOG]
        assert "gemma-3-4b" in ids
        assert "gemma-3-12b" in ids
        assert "qwen3.5-35b-a3b" in ids

    def test_catalog_tiers(self):
        tiers = {m["id"]: m["tier"] for m in CATALOG}
        assert tiers["gemma-3-4b"] == "starter"
        assert tiers["gemma-3-12b"] == "balanced"
        assert tiers["qwen3.5-35b-a3b"] == "power"

    def test_catalog_required_fields(self):
        required = [
            "id", "name", "family", "variant", "description", "tagline",
            "tier", "size_bytes", "context_length", "architecture",
            "total_params", "active_params", "hf_repo", "hf_filename",
            "requires_ram_gb", "recommended_ram_gb",
        ]
        for entry in CATALOG:
            for field in required:
                assert field in entry, f"Missing {field} in {entry['id']}"

    def test_get_catalog_entry_found(self):
        entry = get_catalog_entry("gemma-3-4b")
        assert entry is not None
        assert entry["name"] == "Gemma 3 4B"

    def test_get_catalog_entry_not_found(self):
        assert get_catalog_entry("nonexistent") is None

    def test_get_catalog_merges_state(self, models_dir):
        set_model_state(models_dir, "gemma-3-4b", status="downloaded", file_path="/tmp/model.gguf")
        catalog = get_catalog(models_dir)
        model = next(m for m in catalog if m.id == "gemma-3-4b")
        assert model.status == "downloaded"
        assert model.file_path == "/tmp/model.gguf"

    def test_get_catalog_defaults_to_available(self, models_dir):
        catalog = get_catalog(models_dir)
        for model in catalog:
            assert model.status == "available"


# ── State management tests ───────────────────────────────────────


class TestState:
    def test_empty_state(self, models_dir):
        state = load_state(models_dir)
        assert state == {}

    def test_save_and_load(self, models_dir):
        save_state(models_dir, {"gemma-3-4b": {"status": "downloaded"}})
        state = load_state(models_dir)
        assert state["gemma-3-4b"]["status"] == "downloaded"

    def test_set_and_get_model_state(self, models_dir):
        set_model_state(models_dir, "gemma-3-4b", status="downloading")
        state = get_model_state(models_dir, "gemma-3-4b")
        assert state["status"] == "downloading"

    def test_remove_model_state(self, models_dir):
        set_model_state(models_dir, "gemma-3-4b", status="downloaded")
        remove_model_state(models_dir, "gemma-3-4b")
        state = get_model_state(models_dir, "gemma-3-4b")
        assert state == {}

    def test_recover_interrupted(self, models_dir):
        save_state(
            models_dir,
            {
                "gemma-3-4b": {"status": "downloading"},
                "gemma-3-12b": {"status": "downloaded"},
            },
        )
        recover_interrupted(models_dir)
        state = load_state(models_dir)
        assert state["gemma-3-4b"]["status"] == "interrupted"
        assert state["gemma-3-12b"]["status"] == "downloaded"

    def test_recover_interrupted_no_change(self, models_dir):
        save_state(models_dir, {"gemma-3-4b": {"status": "downloaded"}})
        recover_interrupted(models_dir)
        state = load_state(models_dir)
        assert state["gemma-3-4b"]["status"] == "downloaded"

    def test_corrupt_state_returns_empty(self, models_dir):
        path = os.path.join(models_dir, "state.json")
        with open(path, "w") as f:
            f.write("not json{{{")
        state = load_state(models_dir)
        assert state == {}


# ── Hardware detection tests ─────────────────────────────────────


class TestHardware:
    def test_detect_hardware_returns_valid(self):
        hw = detect_hardware()
        assert hw.total_ram_gb > 0
        assert hw.available_ram_gb > 0
        assert hw.available_ram_gb <= hw.total_ram_gb

    def test_recommend_starter(self):
        hw = HardwareInfo(total_ram_gb=8, available_ram_gb=4)
        assert recommend_model(hw) == "gemma-3-4b"

    def test_recommend_balanced(self):
        hw = HardwareInfo(total_ram_gb=16, available_ram_gb=8)
        assert recommend_model(hw) == "gemma-3-12b"

    def test_recommend_power(self):
        hw = HardwareInfo(total_ram_gb=32, available_ram_gb=16)
        assert recommend_model(hw) == "qwen3.5-35b-a3b"

    def test_recommend_low_ram(self):
        hw = HardwareInfo(total_ram_gb=4, available_ram_gb=2)
        assert recommend_model(hw) is None


# ── API endpoint tests ───────────────────────────────────────────


class TestCatalogEndpoint:
    def test_get_catalog(self, client_with_models):
        client, _ = client_with_models
        res = client.get("/models/catalog")
        assert res.status_code == 200
        data = res.json()
        assert len(data["models"]) == 3
        assert data["recommended_model_id"] is not None

    def test_get_hardware(self, client_with_models):
        client, _ = client_with_models
        res = client.get("/models/hardware")
        assert res.status_code == 200
        data = res.json()
        assert "total_ram_gb" in data
        assert "available_ram_gb" in data

    def test_get_engine_status(self, client_with_models):
        client, _ = client_with_models
        res = client.get("/models/status")
        assert res.status_code == 200
        data = res.json()
        assert data["state"] == "idle"
        assert data["loaded_model_id"] is None


class TestDownloadEndpoint:
    def test_download_unknown_model(self, client_with_models):
        client, _ = client_with_models
        res = client.post("/models/nonexistent/download")
        assert res.status_code == 404

    def test_delete_unknown_model(self, client_with_models):
        client, _ = client_with_models
        res = client.delete("/models/nonexistent")
        assert res.status_code == 404

    def test_delete_model_not_downloaded(self, client_with_models):
        client, _ = client_with_models
        res = client.delete("/models/gemma-3-4b")
        assert res.status_code == 200


class TestInferenceEndpoint:
    def test_load_not_downloaded(self, client_with_models):
        client, _ = client_with_models
        res = client.post("/models/gemma-3-4b/load")
        assert res.status_code == 400

    def test_unload_no_model(self, client_with_models):
        client, _ = client_with_models
        res = client.post("/models/unload")
        assert res.status_code == 200

    def test_chat_no_model_loaded(self, client_with_models):
        client, _ = client_with_models
        res = client.post(
            "/models/chat",
            json={"messages": [{"role": "user", "content": "hello"}]},
        )
        assert res.status_code == 400
