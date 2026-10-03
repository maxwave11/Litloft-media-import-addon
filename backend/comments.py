from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import UTC, datetime

from app.services.provider_registry import detect_provider
from sqlalchemy import text
from sqlalchemy.orm import Session

MAX_REPLIES_PER_THREAD = 5
DEFAULT_MAX_ROOTS = 300
_REQUEST_SLEEP_SECONDS = 1.0

_STATUS_COLUMNS = (
    "comments_fetched_at TEXT",
    "comments_total INTEGER",
    "comments_error_kind TEXT",
)

_ROW_COLUMNS = (
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
)


def ensure_comments_schema(db: Session) -> None:
    db.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS loft_comments (
                file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                comment_id TEXT NOT NULL,
                parent_id TEXT,
                author TEXT,
                author_channel_id TEXT,
                author_is_uploader BOOLEAN NOT NULL DEFAULT FALSE,
                is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
                is_hearted BOOLEAN NOT NULL DEFAULT FALSE,
                text TEXT NOT NULL,
                like_count INTEGER,
                published_at TEXT,
                position INTEGER NOT NULL,
                PRIMARY KEY (file_id, comment_id)
            )
            """
        )
    )
    for column in _STATUS_COLUMNS:
        try:
            db.execute(text(f"ALTER TABLE loft_metadata ADD COLUMN {column}"))
        except Exception:
            pass


def _is_video_author(comment: dict, channel_id: str | None) -> bool:
    # The display name is deliberately not compared: anyone can pick the
    # channel's name. An absent id on both sides must not read as a match.
    if comment.get("author_is_uploader"):
        return True
    return bool(channel_id and comment.get("author_id") == channel_id)


def _published_day(comment: dict) -> str | None:
    timestamp = comment.get("timestamp")
    if not isinstance(timestamp, int | float):
        return None
    return datetime.fromtimestamp(timestamp, UTC).date().isoformat()


def _row(comment: dict, parent_id: str | None, position: int, channel_id: str | None) -> dict:
    return {
        "comment_id": comment["id"],
        "parent_id": parent_id,
        "author": comment.get("author"),
        "author_channel_id": comment.get("author_id"),
        "author_is_uploader": _is_video_author(comment, channel_id),
        "is_pinned": bool(comment.get("is_pinned")),
        "is_hearted": bool(comment.get("is_favorited")),
        "text": comment["text"],
        "like_count": comment.get("like_count"),
        "published_at": _published_day(comment),
        "position": position,
    }


def map_comments(
    raw: list[dict] | None,
    *,
    channel_id: str | None,
    max_roots: int,
    max_replies: int = MAX_REPLIES_PER_THREAD,
) -> list[dict]:
    seen: set[str] = set()
    roots: list[dict] = []
    replies: dict[str, list[dict]] = {}
    for comment in raw or []:
        comment_id = comment.get("id")
        if not comment_id or comment_id in seen:
            continue
        if not (comment.get("text") or "").strip():
            continue
        seen.add(comment_id)
        parent = comment.get("parent")
        if parent in (None, "root"):
            roots.append(comment)
        else:
            replies.setdefault(parent, []).append(comment)

    rows: list[dict] = []
    for position, root in enumerate(roots[:max_roots]):
        rows.append(_row(root, None, position, channel_id))
        for reply_position, reply in enumerate(replies.get(root["id"], [])[:max_replies]):
            rows.append(_row(reply, root["id"], reply_position, channel_id))
    return rows


def replace_snapshot(
    db: Session,
    file_id: str,
    rows: list[dict],
    total: int | None,
    *,
    fetched_at: str | None = None,
) -> None:
    stamp = fetched_at or datetime.now(UTC).isoformat()
    try:
        updated = db.execute(
            text(
                "UPDATE loft_metadata SET comments_fetched_at = :at, "
                "comments_total = :total, comments_error_kind = NULL "
                "WHERE file_id = :f"
            ),
            {"at": stamp, "total": total, "f": file_id},
        ).rowcount
        if updated != 1:
            raise LookupError(f"no loft_metadata row for {file_id}")
        db.execute(text("DELETE FROM loft_comments WHERE file_id = :f"), {"f": file_id})
        if rows:
            columns = ", ".join(_ROW_COLUMNS)
            params = ", ".join(f":{c}" for c in _ROW_COLUMNS)
            db.execute(
                text(f"INSERT INTO loft_comments ({columns}) VALUES ({params})"),
                [{**row, "file_id": file_id} for row in rows],
            )
        db.commit()
    except Exception:
        db.rollback()
        raise


def record_failure(db: Session, file_id: str, error_kind: str) -> None:
    try:
        db.execute(
            text("UPDATE loft_metadata SET comments_error_kind = :k WHERE file_id = :f"),
            {"k": error_kind, "f": file_id},
        )
        db.commit()
    except Exception:
        db.rollback()
        raise


@dataclass(frozen=True)
class CommentsResult:
    comments: list[dict] | None
    total: int | None
    channel_id: str | None


def comments_limit() -> int:
    raw = os.environ.get("MEDIA_IMPORT_COMMENTS_MAX", "").strip()
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_MAX_ROOTS
    return value if value > 0 else DEFAULT_MAX_ROOTS


def supports_comments(url: str) -> bool:
    return detect_provider(url) == "youtube"


def fetch_comments_sync(url: str, *, max_roots: int) -> CommentsResult:
    import yt_dlp

    # The count needs its own request: after a normal finish yt-dlp replaces
    # ``comment_count`` with the number it extracted.

    base = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "socket_timeout": 30,
        "sleep_interval_requests": _REQUEST_SLEEP_SECONDS,
    }
    with yt_dlp.YoutubeDL(base) as ydl:
        page = ydl.extract_info(url, download=False) or {}

    # The CLI splits this option on commas; the Python API does not, so each
    # value must be its own item or the whole string reads as "no limit".
    # Order: total, parents, replies, replies per thread, depth.
    max_comments = [
        str(max_roots * (1 + MAX_REPLIES_PER_THREAD)),
        str(max_roots),
        "all",
        str(MAX_REPLIES_PER_THREAD),
        "2",
    ]
    options = {
        **base,
        "getcomments": True,
        "extractor_args": {
            "youtube": {"comment_sort": ["top"], "max_comments": max_comments}
        },
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=False) or {}

    return CommentsResult(
        comments=info.get("comments"),
        total=page.get("comment_count"),
        channel_id=page.get("channel_id"),
    )


def load_snapshot(db: Session, file_id: str) -> list[dict]:
    rows = db.execute(
        text(
            "SELECT comment_id, parent_id, author, author_is_uploader, is_pinned, "
            "is_hearted, text, like_count, published_at FROM loft_comments "
            "WHERE file_id = :f ORDER BY position, comment_id"
        ),
        {"f": file_id},
    ).mappings()
    roots: list[dict] = []
    replies: dict[str, list[dict]] = {}
    for row in rows:
        node = {
            "id": row["comment_id"],
            "author": row["author"],
            "author_is_uploader": bool(row["author_is_uploader"]),
            "is_pinned": bool(row["is_pinned"]),
            "is_hearted": bool(row["is_hearted"]),
            "text": row["text"],
            "like_count": row["like_count"],
            "published_at": row["published_at"],
            "replies": [],
        }
        if row["parent_id"] is None:
            roots.append(node)
        else:
            replies.setdefault(row["parent_id"], []).append(node)
    for root in roots:
        root["replies"] = replies.get(root["id"], [])
    return roots
