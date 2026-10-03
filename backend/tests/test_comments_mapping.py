"""yt-dlp comment dicts → stored rows: tree, bounds and the author role."""
from __future__ import annotations

import pytest

from addons.media_import.comments import map_comments

CHANNEL = "UCchannel0000000000000001"


def _c(cid: str, parent: str = "root", **fields) -> dict:
    return {"id": cid, "parent": parent, "text": f"text {cid}", **fields}


def _by_id(rows: list[dict]) -> dict[str, dict]:
    return {r["comment_id"]: r for r in rows}


@pytest.mark.parametrize(
    ("fields", "channel_id", "is_author"),
    [
        ({"author_is_uploader": True}, CHANNEL, True),
        ({"author_id": CHANNEL}, CHANNEL, True),
        ({"author_is_uploader": True, "author_id": CHANNEL}, CHANNEL, True),
        ({"author_is_uploader": True, "author_id": "UCother"}, CHANNEL, True),
        ({"author_is_uploader": False, "author_id": "UCother"}, CHANNEL, False),
        ({"author_id": "UCother"}, CHANNEL, False),
        ({"author": "The Channel", "author_id": "UCimpostor"}, CHANNEL, False),
        ({"author_is_uploader": False, "author_id": CHANNEL}, CHANNEL, True),
        ({}, CHANNEL, False),
        ({"author_id": None}, None, False),
        ({}, None, False),
    ],
)
def test_author_role(fields, channel_id, is_author) -> None:
    rows = map_comments([_c("a", **fields)], channel_id=channel_id, max_roots=10)

    assert rows[0]["author_is_uploader"] is is_author


def test_hearted_viewer_is_still_a_viewer() -> None:
    rows = map_comments(
        [_c("a", author_id="UCother", is_favorited=True)],
        channel_id=CHANNEL,
        max_roots=10,
    )

    assert rows[0]["is_hearted"] is True
    assert rows[0]["author_is_uploader"] is False


def test_replies_attach_to_their_root_and_keep_order() -> None:
    raw = [
        _c("r1"),
        _c("r1a", parent="r1"),
        _c("r2"),
        _c("r1b", parent="r1"),
        _c("r2a", parent="r2"),
    ]

    rows = map_comments(raw, channel_id=CHANNEL, max_roots=10)
    by_id = _by_id(rows)

    assert [r["comment_id"] for r in rows if r["parent_id"] is None] == ["r1", "r2"]
    assert by_id["r1a"]["parent_id"] == "r1"
    assert by_id["r1b"]["parent_id"] == "r1"
    assert by_id["r2a"]["parent_id"] == "r2"
    assert (by_id["r1"]["position"], by_id["r2"]["position"]) == (0, 1)
    assert (by_id["r1a"]["position"], by_id["r1b"]["position"]) == (0, 1)


def test_roots_are_cut_to_the_limit_and_take_their_replies_with_them() -> None:
    raw = [_c("r1"), _c("r2"), _c("r3"), _c("r3a", parent="r3")]

    rows = map_comments(raw, channel_id=CHANNEL, max_roots=2)

    assert [r["comment_id"] for r in rows] == ["r1", "r2"]


def test_replies_are_cut_per_thread() -> None:
    raw = [_c("r1"), _c("r2")] + [
        _c(f"r1x{i}", parent="r1") for i in range(8)
    ] + [_c("r2a", parent="r2")]

    rows = map_comments(raw, channel_id=CHANNEL, max_roots=10, max_replies=5)

    assert [r["comment_id"] for r in rows if r["parent_id"] == "r1"] == [
        f"r1x{i}" for i in range(5)
    ]
    assert [r["comment_id"] for r in rows if r["parent_id"] == "r2"] == ["r2a"]


def test_reply_to_an_unknown_parent_is_dropped() -> None:
    rows = map_comments(
        [_c("r1"), _c("x", parent="missing")], channel_id=CHANNEL, max_roots=10
    )

    assert [r["comment_id"] for r in rows] == ["r1"]


def test_duplicate_ids_keep_the_first() -> None:
    first = _c("r1", text="first")
    again = _c("r1", text="again")

    rows = map_comments([first, again], channel_id=CHANNEL, max_roots=10)

    assert [(r["comment_id"], r["text"]) for r in rows] == [("r1", "first")]


@pytest.mark.parametrize("text", [None, "", "   "])
def test_comment_without_text_is_skipped(text) -> None:
    rows = map_comments(
        [{"id": "r1", "parent": "root", "text": text}, _c("r2")],
        channel_id=CHANNEL,
        max_roots=10,
    )

    assert [r["comment_id"] for r in rows] == ["r2"]


def test_flags_and_counts_are_carried_over() -> None:
    raw = [
        _c(
            "r1",
            author="@someone",
            author_id="UCsome",
            like_count=1200,
            is_pinned=True,
            is_favorited=True,
            timestamp=1760000000,
        )
    ]

    row = map_comments(raw, channel_id=CHANNEL, max_roots=10)[0]

    assert row["author"] == "@someone"
    assert row["author_channel_id"] == "UCsome"
    assert row["like_count"] == 1200
    assert row["is_pinned"] is True
    assert row["is_hearted"] is True
    assert row["published_at"] == "2025-10-09"


def test_missing_optional_fields_default() -> None:
    row = map_comments([_c("r1")], channel_id=CHANNEL, max_roots=10)[0]

    assert row["author"] is None
    assert row["author_channel_id"] is None
    assert row["like_count"] is None
    assert row["is_pinned"] is False
    assert row["is_hearted"] is False
    assert row["published_at"] is None


@pytest.mark.parametrize("raw", [None, []])
def test_nothing_in_nothing_out(raw) -> None:
    assert map_comments(raw, channel_id=CHANNEL, max_roots=10) == []
