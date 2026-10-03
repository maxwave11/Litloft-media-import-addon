"""``GET`` and ``POST`` for a ``.loft``'s comments: shape, states and access."""
from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from addons.media_import.comments import record_failure, replace_snapshot

from .comments_seed import comment_row, seed_loft

FILE_ID = "fcmtrouter1"
GET_PATH = "/api/addons/media_import/link/{id}/comments"
POST_PATH = "/api/addons/media_import/link/{id}/comments/refresh"
ENDPOINTS = [("GET", GET_PATH), ("POST", POST_PATH)]


@pytest.fixture(autouse=True)
def _providers() -> None:
    from addons.media_import.provider_registration import register_media_import_providers

    register_media_import_providers()


@pytest.fixture()
def client(media_import_db, drive_path):
    from addons.media_import.router import router

    app = FastAPI()
    app.include_router(router)
    c = TestClient(app)
    c.headers["X-Lit-Drive"] = "drv"
    return c


@pytest.fixture()
def enqueued():
    from addons.media_import.router import loft_manager

    captured: list[tuple] = []

    async def _capture(file_id: str, drive: str) -> str:
        captured.append((file_id, drive))
        return "queued"

    with patch.object(loft_manager, "enqueue_comments", _capture):
        yield captured


def _store(session, rows, total=None, file_id=FILE_ID) -> None:
    db = session()
    try:
        replace_snapshot(db, file_id, rows, total, fetched_at="2026-10-03T10:00:00+00:00")
    finally:
        db.close()


def _fail(session, kind, file_id=FILE_ID) -> None:
    db = session()
    try:
        record_failure(db, file_id, kind)
    finally:
        db.close()


class TestGet:
    def test_a_loft_never_loaded_has_nothing_yet(self, client, media_import_db) -> None:
        seed_loft(media_import_db, FILE_ID)

        body = client.get(GET_PATH.format(id=FILE_ID)).json()

        assert body == {
            "supported": True,
            "state": "none",
            "error_kind": None,
            "fetched_at": None,
            "total": None,
            "comments": [],
        }

    def test_a_snapshot_comes_back_as_a_tree_in_stored_order(
        self, client, media_import_db
    ) -> None:
        seed_loft(media_import_db, FILE_ID)
        _store(
            media_import_db,
            [
                comment_row("z1", position=0, like_count=1200, is_pinned=True),
                comment_row("z1-a", "z1", position=1, author_is_uploader=True),
                comment_row("z1-y", "z1", position=0, is_hearted=True),
                comment_row("a2", position=1, like_count=None),
            ],
            total=12345,
        )

        body = client.get(GET_PATH.format(id=FILE_ID)).json()

        assert body["state"] == "ready"
        assert body["total"] == 12345
        assert body["fetched_at"] == "2026-10-03T10:00:00+00:00"
        assert [c["id"] for c in body["comments"]] == ["z1", "a2"]
        first, second = body["comments"]
        assert first["like_count"] == 1200
        assert first["is_pinned"] is True
        assert [r["id"] for r in first["replies"]] == ["z1-y", "z1-a"]
        assert first["replies"][0]["is_hearted"] is True
        assert first["replies"][1]["author_is_uploader"] is True
        assert first["replies"][1]["replies"] == []
        assert second["like_count"] is None
        assert second["replies"] == []
        assert set(first) == {
            "id",
            "author",
            "author_is_uploader",
            "is_pinned",
            "is_hearted",
            "text",
            "like_count",
            "published_at",
            "replies",
        }

    def test_an_empty_snapshot_is_ready(self, client, media_import_db) -> None:
        seed_loft(media_import_db, FILE_ID)
        _store(media_import_db, [], total=0)

        body = client.get(GET_PATH.format(id=FILE_ID)).json()

        assert (body["state"], body["total"], body["comments"]) == ("ready", 0, [])

    def test_a_failure_keeps_showing_the_earlier_snapshot(
        self, client, media_import_db
    ) -> None:
        seed_loft(media_import_db, FILE_ID)
        _store(media_import_db, [comment_row("r1")], total=9)
        _fail(media_import_db, "rate_limited")

        body = client.get(GET_PATH.format(id=FILE_ID)).json()

        assert body["state"] == "error"
        assert body["error_kind"] == "rate_limited"
        assert [c["id"] for c in body["comments"]] == ["r1"]

    def test_a_failure_with_nothing_stored_is_an_error_without_comments(
        self, client, media_import_db
    ) -> None:
        seed_loft(media_import_db, FILE_ID)
        _fail(media_import_db, "disabled")

        body = client.get(GET_PATH.format(id=FILE_ID)).json()

        assert (body["state"], body["error_kind"], body["comments"]) == (
            "error",
            "disabled",
            [],
        )

    def test_a_queued_fetch_reads_as_queued_with_the_snapshot(
        self, client, media_import_db
    ) -> None:
        from addons.media_import.router import loft_manager

        seed_loft(media_import_db, FILE_ID)
        _store(media_import_db, [comment_row("r1")])

        with patch.object(loft_manager, "comments_pending", lambda _fid: True):
            body = client.get(GET_PATH.format(id=FILE_ID)).json()

        assert body["state"] == "queued"
        assert [c["id"] for c in body["comments"]] == ["r1"]

    def test_a_vimeo_loft_is_not_supported(self, client, media_import_db) -> None:
        seed_loft(
            media_import_db, FILE_ID, url="https://vimeo.com/1", provider="vimeo"
        )

        body = client.get(GET_PATH.format(id=FILE_ID)).json()

        assert (body["supported"], body["state"], body["comments"]) == (False, "none", [])

    def test_comments_of_another_file_are_not_mixed_in(
        self, client, media_import_db
    ) -> None:
        seed_loft(media_import_db, FILE_ID)
        seed_loft(media_import_db, "fcmtother01")
        _store(media_import_db, [comment_row("mine")])
        _store(media_import_db, [comment_row("theirs")], file_id="fcmtother01")

        body = client.get(GET_PATH.format(id=FILE_ID)).json()

        assert [c["id"] for c in body["comments"]] == ["mine"]


class TestRefresh:
    def test_queues_the_comments_for_the_scoped_drive(
        self, client, media_import_db, enqueued
    ) -> None:
        seed_loft(media_import_db, FILE_ID)

        res = client.post(POST_PATH.format(id=FILE_ID))

        assert res.status_code == 202
        assert res.json() == {"status": "queued"}
        assert enqueued == [(FILE_ID, "drv")]

    def test_a_repeat_while_queued_is_still_accepted(
        self, client, media_import_db
    ) -> None:
        from addons.media_import.router import loft_manager

        seed_loft(media_import_db, FILE_ID)

        async def _already(_file_id: str, _drive: str) -> str:
            return "already_queued"

        with patch.object(loft_manager, "enqueue_comments", _already):
            res = client.post(POST_PATH.format(id=FILE_ID))

        assert (res.status_code, res.json()) == (202, {"status": "already_queued"})

    def test_a_non_youtube_loft_is_refused(self, client, media_import_db) -> None:
        seed_loft(
            media_import_db, FILE_ID, url="https://vimeo.com/1", provider="vimeo"
        )

        res = client.post(POST_PATH.format(id=FILE_ID))

        assert res.status_code == 400

    def test_an_unknown_file_is_404(self, client, media_import_db) -> None:
        res = client.post(POST_PATH.format(id="fnothere001"))

        assert res.status_code == 404


class TestAccess:
    def _lock_drive(self, monkeypatch, locked_drive: str, group: str) -> None:
        import app.config as config

        monkeypatch.setattr(
            config,
            "get_drive_access_group",
            lambda name: group if name == locked_drive else None,
        )

    @pytest.mark.parametrize("method,path", ENDPOINTS)
    def test_locked_drive_is_404_and_leaks_nothing(
        self, client, media_import_db, monkeypatch, enqueued, method, path
    ) -> None:
        seed_loft(media_import_db, "flocked001", "secret")
        _store(media_import_db, [comment_row("hidden")], file_id="flocked001")
        self._lock_drive(monkeypatch, "secret", "vip")

        res = client.request(
            method, path.format(id="flocked001"), headers={"X-Lit-Drive": "secret"}
        )

        assert res.status_code == 404
        assert "hidden" not in res.text and "youtube" not in res.text
        assert enqueued == []

    @pytest.mark.parametrize("method,path", ENDPOINTS)
    def test_file_on_another_drive_is_404(
        self, client, media_import_db, enqueued, method, path
    ) -> None:
        seed_loft(media_import_db, "fother0001", "other")
        _store(media_import_db, [comment_row("hidden")], file_id="fother0001")

        res = client.request(method, path.format(id="fother0001"))

        assert res.status_code == 404
        assert "hidden" not in res.text
        assert enqueued == []

    @pytest.mark.parametrize("method,path", ENDPOINTS)
    def test_missing_drive_header_is_400(
        self, client, media_import_db, enqueued, method, path
    ) -> None:
        seed_loft(media_import_db, "fnohdr0001")

        res = client.request(
            method, path.format(id="fnohdr0001"), headers={"X-Lit-Drive": ""}
        )

        assert res.status_code == 400
        assert enqueued == []

    @pytest.mark.parametrize("method,path", ENDPOINTS)
    @pytest.mark.parametrize("state", [{"deleted": True}, {"missing": True}])
    def test_trashed_or_missing_file_is_404(
        self, client, media_import_db, enqueued, method, path, state
    ) -> None:
        seed_loft(media_import_db, "fgone00001", **state)
        _store(media_import_db, [comment_row("hidden")], file_id="fgone00001")

        res = client.request(method, path.format(id="fgone00001"))

        assert res.status_code == 404
        assert "hidden" not in res.text
        assert enqueued == []
