from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import text

YT = "https://www.youtube.com/watch?v=abc"


def seed_loft(
    session,
    file_id: str,
    drive: str = "drv",
    *,
    url: str = YT,
    provider: str = "youtube",
    deleted: bool = False,
    missing: bool = False,
) -> None:
    from app.models import File

    now = datetime.now(UTC)
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
                file_type="other",
                mime_type="application/vnd.litloft.loft+json",
                created_at=now,
                updated_at=now,
                deleted_at=now if deleted else None,
                missing_since=now if missing else None,
            )
        )
        db.commit()
        db.execute(
            text(
                "INSERT INTO loft_metadata (file_id, provider, url) "
                "VALUES (:id, :provider, :url)"
            ),
            {"id": file_id, "provider": provider, "url": url},
        )
        db.commit()
    finally:
        db.close()


def comment_row(comment_id: str, parent_id: str | None = None, **fields) -> dict:
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
