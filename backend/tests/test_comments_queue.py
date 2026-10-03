"""The comments queue: the job, who may enqueue, and when an import enqueues."""
from __future__ import annotations

import asyncio
from contextlib import suppress
from datetime import UTC, datetime

import pytest
from sqlalchemy import text

from addons.media_import import service
from addons.media_import.comments import CommentsResult
from addons.media_import.schemas import LoftFetchItem
from addons.media_import.service import _LOFT_MIME, LoftManager

FILE_ID = "fqueue00001"
DRIVE = "drv"
YT = "https://www.youtube.com/watch?v=abc"
VIMEO = "https://vimeo.com/123"


def _seed(
    session,
    file_id: str = FILE_ID,
    *,
    url: str = YT,
    provider: str = "youtube",
    drive: str = DRIVE,
    mime: str = _LOFT_MIME,
    trashed: bool = False,
    missing: bool = False,
    with_metadata: bool = True,
) -> None:
    from app.models import File

    db = session()
    try:
        db.add(
            File(
                id=file_id,
                filename=f"{file_id}.loft",
                title=file_id,
                drive=drive,
                folder_path="",
                file_path=f"{file_id}.loft",
                file_size=1,
                file_type="video",
                mime_type=mime,
                deleted_at=datetime.now(UTC) if trashed else None,
                missing_since=datetime.now(UTC) if missing else None,
            )
        )
        db.commit()
        if with_metadata:
            db.execute(
                text(
                    "INSERT INTO loft_metadata (file_id, provider, url) "
                    "VALUES (:f, :p, :u)"
                ),
                {"f": file_id, "p": provider, "u": url},
            )
            db.commit()
    finally:
        db.close()


def _item(file_id: str = FILE_ID, url: str = YT, **kw) -> LoftFetchItem:
    return LoftFetchItem(file_id=file_id, url=url, drive=DRIVE, **kw)


def _raw(cid: str, parent: str = "root", **fields) -> dict:
    return {"id": cid, "parent": parent, "text": f"text {cid}", **fields}


def _stored(session, file_id: str = FILE_ID) -> dict[str, dict]:
    db = session()
    try:
        return {
            r["comment_id"]: dict(r)
            for r in db.execute(
                text("SELECT * FROM loft_comments WHERE file_id = :f"), {"f": file_id}
            ).mappings()
        }
    finally:
        db.close()


def _status(session, file_id: str = FILE_ID) -> tuple:
    db = session()
    try:
        return tuple(
            db.execute(
                text(
                    "SELECT comments_fetched_at IS NOT NULL, comments_total, "
                    "comments_error_kind FROM loft_metadata WHERE file_id = :f"
                ),
                {"f": file_id},
            ).one()
        )
    finally:
        db.close()


@pytest.fixture(autouse=True)
def _providers() -> None:
    from addons.media_import.provider_registration import register_media_import_providers

    register_media_import_providers()


@pytest.fixture()
def emitted(monkeypatch) -> list[tuple]:
    events: list[tuple] = []

    def _capture(event, payload, drives=None):
        events.append((event, payload, drives))

    monkeypatch.setattr(service.event_hooks, "emit_sync", _capture)
    return events


def _fetch_returns(monkeypatch, result: CommentsResult) -> list[dict]:
    calls: list[dict] = []

    def _fake(url, *, max_roots):
        calls.append({"url": url, "max_roots": max_roots})
        return result

    monkeypatch.setattr(service, "fetch_comments_sync", _fake)
    return calls


def _fail_inserting(session, message: str) -> None:
    db = session()
    try:
        db.execute(
            text(
                "CREATE TRIGGER fail_insert BEFORE INSERT ON loft_comments "
                "WHEN NEW.text = 'boom' "
                f"BEGIN SELECT RAISE(ABORT, '{message}'); END"
            )
        )
        db.commit()
    finally:
        db.close()


def _fetch_raises(monkeypatch, message: str) -> None:
    def _fake(url, *, max_roots):
        raise RuntimeError(message)

    monkeypatch.setattr(service, "fetch_comments_sync", _fake)


class TestFetchAndStore:
    def test_stores_the_snapshot_with_roles_and_total(
        self, media_import_db, monkeypatch, emitted
    ) -> None:
        _seed(media_import_db)
        _fetch_returns(
            monkeypatch,
            CommentsResult(
                comments=[
                    _raw("a", author_id="UCviewer"),
                    _raw("b", parent="a", author_id="UCchan"),
                ],
                total=777,
                channel_id="UCchan",
            ),
        )

        LoftManager()._fetch_and_store_comments(_item())

        stored = _stored(media_import_db)
        assert stored["a"]["author_is_uploader"] == 0
        assert stored["b"]["author_is_uploader"] == 1
        assert stored["b"]["parent_id"] == "a"
        assert _status(media_import_db) == (1, 777, None)
        assert emitted == [("files.updated", {"file_ids": [FILE_ID]}, [DRIVE])]

    def test_keeps_no_more_than_the_configured_roots(
        self, media_import_db, monkeypatch, emitted
    ) -> None:
        monkeypatch.setenv("MEDIA_IMPORT_COMMENTS_MAX", "50")
        _seed(media_import_db)
        calls = _fetch_returns(
            monkeypatch,
            CommentsResult(
                comments=[_raw(f"r{i}") for i in range(60)], total=60, channel_id=None
            ),
        )

        LoftManager()._fetch_and_store_comments(_item())

        assert calls == [{"url": YT, "max_roots": 50}]
        assert len(_stored(media_import_db)) == 50

    @pytest.mark.parametrize(
        ("message", "kind"),
        [
            ("ERROR: HTTP Error 429: Too Many Requests", "rate_limited"),
            ("Sign in to confirm you're not a bot", "rate_limited"),
            ("Private video", "permanent"),
            ("something nobody has seen before", "failed"),
        ],
    )
    def test_a_failure_is_recorded_and_the_old_snapshot_stays(
        self, media_import_db, monkeypatch, emitted, message, kind
    ) -> None:
        _seed(media_import_db)
        _fetch_returns(
            monkeypatch,
            CommentsResult(comments=[_raw("old")], total=5, channel_id=None),
        )
        manager = LoftManager()
        manager._fetch_and_store_comments(_item())
        emitted.clear()

        _fetch_raises(monkeypatch, message)
        manager._fetch_and_store_comments(_item())

        assert set(_stored(media_import_db)) == {"old"}
        assert _status(media_import_db) == (1, 5, kind)
        assert emitted == [("files.updated", {"file_ids": [FILE_ID]}, [DRIVE])]

    def test_disabled_comments_are_recorded_as_disabled(
        self, media_import_db, monkeypatch, emitted
    ) -> None:
        _seed(media_import_db)
        _fetch_returns(
            monkeypatch, CommentsResult(comments=None, total=None, channel_id="UCchan")
        )

        LoftManager()._fetch_and_store_comments(_item())

        assert _stored(media_import_db) == {}
        assert _status(media_import_db) == (0, None, "disabled")

    def test_a_video_with_no_comments_is_a_ready_empty_snapshot(
        self, media_import_db, monkeypatch, emitted
    ) -> None:
        _seed(media_import_db)
        _fetch_returns(
            monkeypatch, CommentsResult(comments=[], total=0, channel_id="UCchan")
        )

        LoftManager()._fetch_and_store_comments(_item())

        assert _stored(media_import_db) == {}
        assert _status(media_import_db) == (1, 0, None)

    @pytest.mark.parametrize(
        ("broken", "error"),
        [
            ("map_comments", RuntimeError("bad comment shape")),
            ("replace_snapshot", RuntimeError("database is locked")),
            ("replace_snapshot", LookupError("no loft_metadata row")),
        ],
    )
    def test_a_failure_while_storing_is_recorded_not_lost(
        self, media_import_db, monkeypatch, emitted, broken, error
    ) -> None:
        _seed(media_import_db)
        _fetch_returns(
            monkeypatch,
            CommentsResult(comments=[_raw("old")], total=5, channel_id=None),
        )
        manager = LoftManager()
        manager._fetch_and_store_comments(_item())
        emitted.clear()

        def _boom(*_a, **_kw):
            raise error

        monkeypatch.setattr(service, broken, _boom)
        manager._fetch_and_store_comments(_item())

        assert set(_stored(media_import_db)) == {"old"}
        assert _status(media_import_db) == (1, 5, "failed")
        assert emitted == [("files.updated", {"file_ids": [FILE_ID]}, [DRIVE])]

    def test_a_statement_failing_in_the_store_step_leaves_the_old_snapshot(
        self, media_import_db, monkeypatch, emitted
    ) -> None:
        _seed(media_import_db)
        _fetch_returns(
            monkeypatch,
            CommentsResult(comments=[_raw("old")], total=5, channel_id=None),
        )
        manager = LoftManager()
        manager._fetch_and_store_comments(_item())
        emitted.clear()

        _fail_inserting(media_import_db, "disk is full")
        _fetch_returns(
            monkeypatch,
            CommentsResult(comments=[_raw("new", text="boom")], total=9, channel_id=None),
        )
        manager._fetch_and_store_comments(_item())

        assert set(_stored(media_import_db)) == {"old"}
        assert _status(media_import_db) == (1, 5, "failed")
        assert emitted == [("files.updated", {"file_ids": [FILE_ID]}, [DRIVE])]

    @pytest.mark.parametrize(
        "marker", ["Private video", "HTTP Error 429: Too Many Requests"]
    )
    def test_a_store_error_is_never_read_for_fetch_markers(
        self, media_import_db, monkeypatch, emitted, marker
    ) -> None:
        _seed(media_import_db)
        _fail_inserting(media_import_db, marker)
        _fetch_returns(
            monkeypatch,
            CommentsResult(comments=[_raw("new", text="boom")], total=9, channel_id=None),
        )

        LoftManager()._fetch_and_store_comments(_item())

        assert _status(media_import_db) == (0, None, "failed")

    @pytest.mark.parametrize("marker", ["Private video", "Sign in to confirm you're not a bot"])
    def test_a_mapping_error_is_never_read_for_fetch_markers(
        self, media_import_db, monkeypatch, emitted, marker
    ) -> None:
        _seed(media_import_db)
        _fetch_returns(
            monkeypatch, CommentsResult(comments=[_raw("a")], total=1, channel_id=None)
        )

        def _boom(*_a, **_kw):
            raise RuntimeError(marker)

        monkeypatch.setattr(service, "map_comments", _boom)
        LoftManager()._fetch_and_store_comments(_item())

        assert _status(media_import_db) == (0, None, "failed")

    def test_failing_to_record_a_failure_still_lets_the_page_know(
        self, media_import_db, monkeypatch, emitted
    ) -> None:
        _seed(media_import_db)
        _fetch_raises(monkeypatch, "Sign in to confirm you're not a bot")

        def _boom(*_a, **_kw):
            raise RuntimeError("database is locked")

        monkeypatch.setattr(service, "record_failure", _boom)
        LoftManager()._fetch_and_store_comments(_item())

        assert emitted == [("files.updated", {"file_ids": [FILE_ID]}, [DRIVE])]

    def test_without_a_metadata_row_youtube_is_not_asked(
        self, media_import_db, monkeypatch, emitted
    ) -> None:
        _seed(media_import_db, with_metadata=False)
        calls = _fetch_returns(
            monkeypatch, CommentsResult(comments=[], total=0, channel_id=None)
        )

        LoftManager()._fetch_and_store_comments(_item())

        assert calls == []
        assert emitted == []


class TestEnqueue:
    def test_queues_a_youtube_loft(self, media_import_db) -> None:
        _seed(media_import_db)
        manager = LoftManager()

        status = asyncio.run(manager.enqueue_comments(FILE_ID, DRIVE))

        assert status == "queued"
        assert manager.comments_pending(FILE_ID) is True
        assert manager._comments_queue.qsize() == 1

    def test_a_second_request_while_queued_is_a_no_op(self, media_import_db) -> None:
        _seed(media_import_db)
        manager = LoftManager()

        async def _twice() -> tuple[str, str]:
            return (
                await manager.enqueue_comments(FILE_ID, DRIVE),
                await manager.enqueue_comments(FILE_ID, DRIVE),
            )

        assert asyncio.run(_twice()) == ("queued", "already_queued")
        assert manager._comments_queue.qsize() == 1

    def test_a_fetch_in_flight_counts_as_pending(self, media_import_db) -> None:
        _seed(media_import_db)
        manager = LoftManager()
        manager._comments_items[FILE_ID] = _item(status="fetching")

        assert manager.comments_pending(FILE_ID) is True
        assert asyncio.run(manager.enqueue_comments(FILE_ID, DRIVE)) == "already_queued"
        assert manager._comments_queue.qsize() == 0

    def test_pending_is_false_for_an_unknown_file(self) -> None:
        assert LoftManager().comments_pending("nobody") is False

    @pytest.mark.parametrize(
        ("seed_kw", "error"),
        [
            ({"drive": "other"}, FileNotFoundError),
            ({"trashed": True}, FileNotFoundError),
            ({"missing": True}, FileNotFoundError),
            ({"mime": "video/mp4"}, FileNotFoundError),
            ({"with_metadata": False}, ValueError),
            ({"provider": "vimeo", "url": VIMEO}, ValueError),
        ],
    )
    def test_refuses_what_it_cannot_serve(
        self, media_import_db, seed_kw, error
    ) -> None:
        _seed(media_import_db, **seed_kw)
        manager = LoftManager()

        with pytest.raises(error):
            asyncio.run(manager.enqueue_comments(FILE_ID, DRIVE))

        assert manager._comments_queue.qsize() == 0


class TestImportHook:
    def _run_worker(self, manager: LoftManager, item_kw: dict, url: str = YT) -> None:
        async def _go() -> None:
            task = asyncio.create_task(manager._worker())
            await manager.enqueue_fetch(FILE_ID, url, DRIVE, **item_kw)
            await manager._queue.join()
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

        asyncio.run(_go())

    def _patched(self, monkeypatch, *, fetch_error: Exception | None = None):
        manager = LoftManager()
        queued: list[tuple[str, str]] = []

        def _fetch(item) -> None:
            if fetch_error:
                raise fetch_error

        async def _enqueue(file_id: str, drive: str) -> str:
            queued.append((file_id, drive))
            return "queued"

        monkeypatch.setattr(manager, "_fetch_and_update", _fetch)
        monkeypatch.setattr(manager, "enqueue_comments", _enqueue)
        return manager, queued

    def test_a_single_import_asks_for_comments_after_the_metadata(
        self, monkeypatch
    ) -> None:
        manager, queued = self._patched(monkeypatch)

        self._run_worker(manager, {"fetch_comments": True})

        assert queued == [(FILE_ID, DRIVE)]

    @pytest.mark.parametrize(
        ("item_kw", "url"),
        [
            ({}, YT),
            ({"fetch_comments": False}, YT),
            ({"fetch_comments": True}, VIMEO),
        ],
    )
    def test_nothing_is_asked_otherwise(self, monkeypatch, item_kw, url) -> None:
        manager, queued = self._patched(monkeypatch)

        self._run_worker(manager, item_kw, url)

        assert queued == []

    def test_a_failed_metadata_fetch_asks_for_no_comments(self, monkeypatch) -> None:
        manager, queued = self._patched(monkeypatch, fetch_error=RuntimeError("boom"))

        self._run_worker(manager, {"fetch_comments": True})

        assert queued == []

    def test_a_comments_error_does_not_fail_the_import(self, monkeypatch) -> None:
        manager, _ = self._patched(monkeypatch)

        async def _raise(file_id: str, drive: str) -> str:
            raise RuntimeError("comments queue is broken")

        monkeypatch.setattr(manager, "enqueue_comments", _raise)

        self._run_worker(manager, {"fetch_comments": True})

        assert manager._items[FILE_ID].status == "completed"
