"""``fetch_comments_sync``: what is asked of yt-dlp and what is read back."""
from __future__ import annotations

import pytest

from addons.media_import.comments import comments_limit, fetch_comments_sync

URL = "https://www.youtube.com/watch?v=abc"


class _FakeYDL:
    calls: list[dict] = []
    responses: list = []

    def __init__(self, opts: dict) -> None:
        self.opts = opts

    def __enter__(self):
        return self

    def __exit__(self, *_exc) -> None:
        return None

    def extract_info(self, url: str, download: bool = True):
        type(self).calls.append({"url": url, "download": download, "opts": self.opts})
        response = type(self).responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


@pytest.fixture()
def ydl(monkeypatch):
    import yt_dlp

    _FakeYDL.calls = []
    _FakeYDL.responses = []
    monkeypatch.setattr(yt_dlp, "YoutubeDL", _FakeYDL)
    return _FakeYDL


def _page(count=12345, channel="UCchan") -> dict:
    return {"comment_count": count, "channel_id": channel}


def test_total_is_read_before_the_comments_are_requested(ydl) -> None:
    ydl.responses = [_page(), {"comment_count": 2, "comments": [{"id": "a"}]}]

    fetch_comments_sync(URL, max_roots=300)

    first, second = ydl.calls
    assert "getcomments" not in first["opts"]
    assert second["opts"]["getcomments"] is True
    assert all(c["url"] == URL and c["download"] is False for c in ydl.calls)
    assert all(c["opts"]["sleep_interval_requests"] == 1.0 for c in ydl.calls)


def test_total_and_channel_come_from_the_page_not_the_comment_run(ydl) -> None:
    ydl.responses = [
        _page(count=12345, channel="UCchan"),
        {"comment_count": 2, "channel_id": "UCelse", "comments": [{"id": "a"}, {"id": "b"}]},
    ]

    result = fetch_comments_sync(URL, max_roots=300)

    assert result.total == 12345
    assert result.channel_id == "UCchan"
    assert result.comments == [{"id": "a"}, {"id": "b"}]


@pytest.mark.parametrize(
    ("max_roots", "expected"),
    [
        (300, ["1800", "300", "all", "5", "2"]),
        (50, ["300", "50", "all", "5", "2"]),
        (1, ["6", "1", "all", "5", "2"]),
    ],
)
def test_limits_are_sent_as_separate_list_items(ydl, max_roots, expected) -> None:
    ydl.responses = [_page(), {"comments": []}]

    fetch_comments_sync(URL, max_roots=max_roots)

    youtube_args = ydl.calls[1]["opts"]["extractor_args"]["youtube"]
    assert youtube_args["max_comments"] == expected
    assert youtube_args["comment_sort"] == ["top"]


def test_disabled_comments_read_as_none(ydl) -> None:
    ydl.responses = [_page(count=None), {"comments": None, "comment_count": None}]

    result = fetch_comments_sync(URL, max_roots=300)

    assert result.comments is None


def test_no_comments_posted_reads_as_empty_list(ydl) -> None:
    ydl.responses = [_page(count=0), {"comments": [], "comment_count": 0}]

    result = fetch_comments_sync(URL, max_roots=300)

    assert result.comments == []


def test_a_failing_page_request_skips_the_comment_request(ydl) -> None:
    ydl.responses = [RuntimeError("HTTP Error 429: Too Many Requests")]

    with pytest.raises(RuntimeError, match="429"):
        fetch_comments_sync(URL, max_roots=300)

    assert len(ydl.calls) == 1


def test_a_failing_comment_request_propagates(ydl) -> None:
    ydl.responses = [_page(), RuntimeError("Sign in to confirm you're not a bot")]

    with pytest.raises(RuntimeError, match="Sign in"):
        fetch_comments_sync(URL, max_roots=300)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, 300),
        ("", 300),
        ("50", 50),
        (" 80 ", 80),
        ("abc", 300),
        ("0", 300),
        ("-5", 300),
        ("2.5", 300),
    ],
)
def test_limit_comes_from_the_environment(monkeypatch, raw, expected) -> None:
    if raw is None:
        monkeypatch.delenv("MEDIA_IMPORT_COMMENTS_MAX", raising=False)
    else:
        monkeypatch.setenv("MEDIA_IMPORT_COMMENTS_MAX", raw)

    assert comments_limit() == expected
