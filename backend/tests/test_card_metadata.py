from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from addons.media_import.comments import replace_snapshot
from .comments_seed import seed_loft


@pytest.mark.parametrize("pending,expected", [(False, "ready"), (True, "working")])
def test_empty_snapshot_is_loaded_and_refresh_is_pending(media_import_db, drive_path, pending, expected):
    from addons.media_import.router import loft_manager, router
    from addons.media_import.provider_registration import register_media_import_providers

    register_media_import_providers()
    seed_loft(media_import_db, "visible")
    seed_loft(media_import_db, "hidden", drive="other")
    with media_import_db() as db:
        replace_snapshot(db, "visible", [], 0, fetched_at="2026-10-03T10:00:00+00:00")
    app = FastAPI()
    app.include_router(router)
    with patch.object(loft_manager, "comments_pending", return_value=pending):
        response = TestClient(app).post(
            "/api/addons/media_import/link/card-metadata",
            headers={"X-Lit-Drive": "drv"},
            json={"file_ids": ["visible", "hidden", "unknown"]},
        )
    assert response.status_code == 200
    assert set(response.json()) == {"visible"}
    assert response.json()["visible"]["comments"] == expected
