"""POST /link/comments/load-missing: which of the selected videos get queued."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text

from addons.media_import.service import _LOFT_MIME, LoftManager

DRIVE = "drv"
YT = "https://www.youtube.com/watch?v=abc"
URL = "/api/addons/media_import/link/comments/load-missing"
COMMENT_COLUMNS = "comments_fetched_at, comments_total, comments_error_kind"


@dataclass
class Video:
    url: str = YT
    drive: str = DRIVE
    mime: str = _LOFT_MIME
    trashed: bool = False
    missing: bool = False
    metadata: bool = True
    fetched_at: str | None = None
    total: int | None = None
    error_kind: str | None = None
    queued_before: bool = False
    extra: dict = field(default_factory=dict)


def _seed(session, file_id: str, video: Video) -> None:
    from app.models import File

    db = session()
    try:
        db.add(
            File(
                id=file_id,
                filename=f"{file_id}.loft",
                title=file_id,
                drive=video.drive,
                folder_path="",
                file_path=f"{file_id}.loft",
                file_size=1,
                file_type="video",
                mime_type=video.mime,
                deleted_at=datetime.now(UTC) if video.trashed else None,
                missing_since=datetime.now(UTC) if video.missing else None,
            )
        )
        db.commit()
        if video.metadata:
            db.execute(
                text(
                    "INSERT INTO loft_metadata (file_id, provider, url, "
                    "comments_fetched_at, comments_total, comments_error_kind) "
                    "VALUES (:f, 'youtube', :u, :at, :total, :kind)"
                ),
                {
                    "f": file_id,
                    "u": video.url,
                    "at": video.fetched_at,
                    "total": video.total,
                    "kind": video.error_kind,
                },
            )
            db.commit()
    finally:
        db.close()


def _comment_columns(session, file_id: str) -> tuple | None:
    db = session()
    try:
        row = db.execute(
            text(f"SELECT {COMMENT_COLUMNS} FROM loft_metadata WHERE file_id = :f"),
            {"f": file_id},
        ).first()
        return tuple(row) if row else None
    finally:
        db.close()


@pytest.fixture(autouse=True)
def _providers() -> None:
    from addons.media_import.provider_registration import register_media_import_providers

    register_media_import_providers()


@pytest.fixture()
def manager(monkeypatch) -> LoftManager:
    import addons.media_import.router as router

    fresh = LoftManager()
    monkeypatch.setattr(router, "loft_manager", fresh)
    return fresh


@pytest.fixture()
def emitted(monkeypatch) -> list[tuple]:
    import addons.media_import.router as router

    events: list[tuple] = []

    async def _capture(event, data, drives=None):
        events.append((event, data, drives))

    monkeypatch.setattr(router.event_hooks, "emit", _capture)
    return events


@pytest.fixture()
def client(media_import_db, drive_path, manager, emitted):
    from addons.media_import.router import router

    app = FastAPI()
    app.include_router(router)
    c = TestClient(app)
    c.headers["X-Lit-Drive"] = DRIVE
    return c


def _queue_ids(manager: LoftManager) -> list[str]:
    ids: list[str] = []
    while not manager._comments_queue.empty():
        ids.append(manager._comments_queue.get_nowait())
    return ids


STATES = {
    "never fetched": (Video(), True),
    "first fetch failed": (Video(error_kind="failed"), True),
    "stored set": (Video(fetched_at="2026-10-01T00:00:00", total=12), False),
    "stored set, refresh failed": (
        Video(fetched_at="2026-10-01T00:00:00", total=12, error_kind="rate_limited"),
        False,
    ),
    "already queued": (Video(queued_before=True), False),
    "not YouTube": (Video(url="https://vimeo.com/123"), False),
    "no metadata yet": (Video(metadata=False), False),
    "in the trash": (Video(trashed=True), False),
    "missing": (Video(missing=True), False),
    "on another drive": (Video(drive="other"), False),
    "not a .loft": (Video(mime="video/mp4"), False),
}


@pytest.mark.parametrize("state", STATES)
def test_queues_only_a_video_without_a_stored_comment_set(
    client, media_import_db, manager, emitted, state
) -> None:
    video, expected = STATES[state]
    _seed(media_import_db, "fvideo00001", video)
    if video.queued_before:
        asyncio.run(manager.enqueue_comments("fvideo00001", DRIVE))
        assert _queue_ids(manager) == ["fvideo00001"]
    before = _comment_columns(media_import_db, "fvideo00001")

    res = client.post(URL, json={"file_ids": ["fvideo00001"]})

    assert res.status_code == 202
    assert res.json() == {"queued": int(expected), "skipped": int(not expected)}
    assert _queue_ids(manager) == (["fvideo00001"] if expected else [])
    assert _comment_columns(media_import_db, "fvideo00001") == before
    assert emitted == (
        [("files.updated", {"file_ids": ["fvideo00001"]}, [DRIVE])] if expected else []
    )


def test_queues_in_the_order_given_and_counts_a_repeated_id_once(
    client, media_import_db, manager, emitted
) -> None:
    for file_id in ("fvideo0000a", "fvideo0000b", "fvideo0000c"):
        _seed(media_import_db, file_id, Video())
    _seed(media_import_db, "fvideo0000d", Video(fetched_at="2026-10-01T00:00:00"))

    res = client.post(
        URL,
        json={
            "file_ids": [
                "fvideo0000c", "fvideo0000d", "fvideo0000a",
                "fvideo0000c", "fvideo0000b",
            ]
        },
    )

    assert res.json() == {"queued": 3, "skipped": 1}
    assert _queue_ids(manager) == ["fvideo0000c", "fvideo0000a", "fvideo0000b"]
    assert emitted == [
        ("files.updated", {"file_ids": ["fvideo0000c", "fvideo0000a", "fvideo0000b"]}, [DRIVE])
    ]


def test_a_second_press_queues_nothing_more(client, media_import_db, manager, emitted) -> None:
    _seed(media_import_db, "fvideo00001", Video())

    first = client.post(URL, json={"file_ids": ["fvideo00001"]})
    second = client.post(URL, json={"file_ids": ["fvideo00001"]})

    assert first.json() == {"queued": 1, "skipped": 0}
    assert second.json() == {"queued": 0, "skipped": 1}
    assert _queue_ids(manager) == ["fvideo00001"]
    assert len(emitted) == 1


def test_another_drive_looks_like_a_file_that_does_not_exist(
    client, media_import_db, manager
) -> None:
    _seed(media_import_db, "fother00001", Video(drive="other"))

    elsewhere = client.post(URL, json={"file_ids": ["fother00001"]})
    nowhere = client.post(URL, json={"file_ids": ["fnobody0001"]})

    assert elsewhere.status_code == nowhere.status_code == 202
    assert elsewhere.json() == nowhere.json() == {"queued": 0, "skipped": 1}
    assert _queue_ids(manager) == []


def test_a_drive_the_caller_cannot_see_is_404_and_queues_nothing(
    client, media_import_db, manager, emitted, monkeypatch
) -> None:
    import app.config as config

    _seed(media_import_db, "fsecret0001", Video(drive="secret"))
    monkeypatch.setattr(
        config, "get_drive_access_group", lambda name: "vip" if name == "secret" else None
    )

    res = client.post(
        URL, json={"file_ids": ["fsecret0001"]}, headers={"X-Lit-Drive": "secret"}
    )

    assert res.status_code == 404
    assert _queue_ids(manager) == []
    assert emitted == []


def test_no_drive_header_is_400(client, media_import_db, manager) -> None:
    _seed(media_import_db, "fvideo00001", Video())
    del client.headers["X-Lit-Drive"]

    res = client.post(URL, json={"file_ids": ["fvideo00001"]})

    assert res.status_code == 400
    assert _queue_ids(manager) == []


@pytest.mark.parametrize("ids", [[], [f"f{i:011d}" for i in range(1001)]])
def test_refuses_an_empty_or_oversized_list(client, ids) -> None:
    assert client.post(URL, json={"file_ids": ids}).status_code == 422
