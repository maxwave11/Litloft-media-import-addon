"""``loft_comments`` storage: schema, atomic snapshot replace, failure record."""
from __future__ import annotations

import pytest
from sqlalchemy import text

from addons.media_import.comments import record_failure, replace_snapshot

FILE_ID = "fcomment001"
OTHER_ID = "fcomment002"


def _seed(session, file_id: str, *, with_metadata: bool = True) -> None:
    from app.models import File

    db = session()
    try:
        db.add(
            File(
                id=file_id,
                filename=f"{file_id}.loft",
                title=file_id,
                drive="d",
                folder_path="",
                file_path=f"{file_id}.loft",
                file_size=1,
                file_type="video",
                mime_type="application/vnd.litloft.loft+json",
            )
        )
        db.commit()
        if with_metadata:
            db.execute(
                text(
                    "INSERT INTO loft_metadata (file_id, provider, url) "
                    "VALUES (:f, 'youtube', 'https://youtu.be/x')"
                ),
                {"f": file_id},
            )
            db.commit()
    finally:
        db.close()


def _row(comment_id: str, parent_id: str | None = None, **fields) -> dict:
    return {
        "comment_id": comment_id,
        "parent_id": parent_id,
        "author": "@someone",
        "author_channel_id": "UCsome",
        "author_is_uploader": False,
        "is_pinned": False,
        "is_hearted": False,
        "text": f"text {comment_id}",
        "like_count": 3,
        "published_at": "2026-10-01",
        "position": 0,
        **fields,
    }


def _stored_ids(session, file_id: str) -> list[str]:
    db = session()
    try:
        return [
            r[0]
            for r in db.execute(
                text(
                    "SELECT comment_id FROM loft_comments "
                    "WHERE file_id = :f ORDER BY comment_id"
                ),
                {"f": file_id},
            )
        ]
    finally:
        db.close()


def _status(session, file_id: str) -> tuple:
    db = session()
    try:
        return tuple(
            db.execute(
                text(
                    "SELECT comments_fetched_at, comments_total, comments_error_kind "
                    "FROM loft_metadata WHERE file_id = :f"
                ),
                {"f": file_id},
            ).one()
        )
    finally:
        db.close()


def _replace(session, file_id, rows, total=None, fetched_at="2026-10-03T10:00:00+00:00"):
    db = session()
    try:
        replace_snapshot(db, file_id, rows, total, fetched_at=fetched_at)
    finally:
        db.close()


def _fail(session, file_id, kind):
    db = session()
    try:
        record_failure(db, file_id, kind)
    finally:
        db.close()


def test_schema_has_the_comment_table_and_status_columns(media_import_db) -> None:
    db = media_import_db()
    try:
        comment_cols = {r[1] for r in db.execute(text("PRAGMA table_info(loft_comments)"))}
        meta_cols = {r[1] for r in db.execute(text("PRAGMA table_info(loft_metadata)"))}
    finally:
        db.close()

    assert comment_cols == {
        "file_id",
        "comment_id",
        "parent_id",
        "author",
        "author_channel_id",
        "author_is_uploader",
        "is_pinned",
        "is_hearted",
        "text",
        "like_count",
        "published_at",
        "position",
    }
    assert {"comments_fetched_at", "comments_total", "comments_error_kind"} <= meta_cols


def test_ensuring_the_schema_again_keeps_stored_comments(media_import_db) -> None:
    from addons.media_import.service import _ensure_loft_table

    _seed(media_import_db, FILE_ID)
    _replace(media_import_db, FILE_ID, [_row("a")], total=10)

    _ensure_loft_table()
    _ensure_loft_table()

    assert _stored_ids(media_import_db, FILE_ID) == ["a"]
    assert _status(media_import_db, FILE_ID)[1] == 10


def test_replace_stores_rows_and_status(media_import_db) -> None:
    _seed(media_import_db, FILE_ID)

    _replace(
        media_import_db,
        FILE_ID,
        [
            _row("a", author_is_uploader=True, is_pinned=True, like_count=None),
            _row("b", parent_id="a", is_hearted=True),
        ],
        total=12345,
    )

    db = media_import_db()
    try:
        stored = {
            r["comment_id"]: r
            for r in db.execute(
                text("SELECT * FROM loft_comments WHERE file_id = :f"), {"f": FILE_ID}
            ).mappings()
        }
    finally:
        db.close()
    assert stored["a"]["author_is_uploader"] == 1
    assert stored["a"]["is_pinned"] == 1
    assert stored["a"]["like_count"] is None
    assert stored["a"]["parent_id"] is None
    assert stored["b"]["parent_id"] == "a"
    assert stored["b"]["is_hearted"] == 1
    assert _status(media_import_db, FILE_ID) == ("2026-10-03T10:00:00+00:00", 12345, None)


def test_replace_swaps_the_whole_previous_snapshot(media_import_db) -> None:
    _seed(media_import_db, FILE_ID)
    _replace(media_import_db, FILE_ID, [_row("a"), _row("b")], total=5)

    _replace(media_import_db, FILE_ID, [_row("c")], total=None, fetched_at="2026-10-04T00:00:00+00:00")

    assert _stored_ids(media_import_db, FILE_ID) == ["c"]
    assert _status(media_import_db, FILE_ID) == ("2026-10-04T00:00:00+00:00", None, None)


def test_replace_clears_an_earlier_failure(media_import_db) -> None:
    _seed(media_import_db, FILE_ID)
    _fail(media_import_db, FILE_ID, "rate_limited")

    _replace(media_import_db, FILE_ID, [_row("a")])

    assert _status(media_import_db, FILE_ID)[2] is None


def test_replace_with_no_comments_leaves_an_empty_snapshot(media_import_db) -> None:
    _seed(media_import_db, FILE_ID)
    _replace(media_import_db, FILE_ID, [_row("a")])

    _replace(media_import_db, FILE_ID, [])

    assert _stored_ids(media_import_db, FILE_ID) == []
    assert _status(media_import_db, FILE_ID)[0] is not None


def test_failed_replace_keeps_the_previous_snapshot_and_status(media_import_db) -> None:
    _seed(media_import_db, FILE_ID)
    _replace(media_import_db, FILE_ID, [_row("a"), _row("b")], total=7)

    with pytest.raises(Exception):
        _replace(
            media_import_db,
            FILE_ID,
            [_row("x"), _row("x")],
            total=99,
            fetched_at="2026-10-09T00:00:00+00:00",
        )

    assert _stored_ids(media_import_db, FILE_ID) == ["a", "b"]
    assert _status(media_import_db, FILE_ID) == ("2026-10-03T10:00:00+00:00", 7, None)


def test_replace_for_a_file_without_metadata_stores_nothing(media_import_db) -> None:
    _seed(media_import_db, FILE_ID, with_metadata=False)

    with pytest.raises(LookupError):
        _replace(media_import_db, FILE_ID, [_row("a")])

    assert _stored_ids(media_import_db, FILE_ID) == []


def test_replace_leaves_other_files_alone(media_import_db) -> None:
    _seed(media_import_db, FILE_ID)
    _seed(media_import_db, OTHER_ID)
    _replace(media_import_db, OTHER_ID, [_row("a")], total=4)

    _replace(media_import_db, FILE_ID, [_row("a"), _row("b")], total=9)

    assert _stored_ids(media_import_db, OTHER_ID) == ["a"]
    assert _status(media_import_db, OTHER_ID)[1] == 4


def test_failure_is_recorded_and_the_snapshot_stays(media_import_db) -> None:
    _seed(media_import_db, FILE_ID)
    _replace(media_import_db, FILE_ID, [_row("a")], total=3)

    _fail(media_import_db, FILE_ID, "rate_limited")

    assert _stored_ids(media_import_db, FILE_ID) == ["a"]
    assert _status(media_import_db, FILE_ID) == (
        "2026-10-03T10:00:00+00:00",
        3,
        "rate_limited",
    )


def test_deleting_the_file_deletes_its_comments(media_import_db) -> None:
    _seed(media_import_db, FILE_ID)
    _seed(media_import_db, OTHER_ID)
    _replace(media_import_db, FILE_ID, [_row("a")])
    _replace(media_import_db, OTHER_ID, [_row("a")])

    db = media_import_db()
    try:
        db.execute(text("DELETE FROM files WHERE id = :f"), {"f": FILE_ID})
        db.commit()
    finally:
        db.close()

    assert _stored_ids(media_import_db, FILE_ID) == []
    assert _stored_ids(media_import_db, OTHER_ID) == ["a"]
