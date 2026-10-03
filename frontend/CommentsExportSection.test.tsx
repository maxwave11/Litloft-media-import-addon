import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook } from "@testing-library/react";

const { getLoftComments, refreshLoftComments } = vi.hoisted(() => ({
  getLoftComments: vi.fn(),
  refreshLoftComments: vi.fn(),
}));

vi.mock("@/addons/media_import/api", () => ({ getLoftComments, refreshLoftComments }));

import CommentsExportSection from "@/addons/media_import/CommentsExportSection";
import { COMMENTS_LEGEND } from "@/addons/media_import/commentsMarkdown";
import { resetExportSections, useExportSections } from "@/lib/exportSections";
import type { FileItem } from "@/types";

const file = (over: Partial<FileItem> = {}) =>
  ({ id: "f1", filename: "Video.loft", file_type: "video", ...over }) as FileItem;

const stored = (over: Record<string, unknown> = {}) => ({
  supported: true,
  state: "ready",
  error_kind: null,
  fetched_at: "2026-10-03T10:00:00+00:00",
  total: 12345,
  comments: [
    {
      id: "c1",
      author: "@someone",
      author_is_uploader: false,
      is_pinned: false,
      is_hearted: false,
      text: "Nice",
      like_count: 4,
      published_at: null,
      replies: [],
    },
  ],
  ...over,
});

function offered() {
  render(<CommentsExportSection />);
  const { result } = renderHook(() => useExportSections());
  return result.current[0];
}

const signal = () => new AbortController().signal;

beforeEach(() => {
  getLoftComments.mockReset();
  refreshLoftComments.mockReset();
});

afterEach(() => {
  cleanup();
  act(() => resetExportSections());
});

describe("CommentsExportSection", () => {
  it("offers a provider named after the slot entry, after the transcript, with the key to the tags", () => {
    const provider = offered();

    expect(provider.id).toBe("comments-export");
    expect(provider.label).toBe("YouTube comments");
    expect(provider.order).toBe(20);
    expect(provider.preamble).toBe(COMMENTS_LEGEND);
  });

  it("writes the stored comments", async () => {
    getLoftComments.mockResolvedValue(stored());

    const result = await offered().build(file(), "d", signal());

    expect(result).toEqual({
      kind: "section",
      markdown: [
        "Top 1 of 12345, fetched 2026-10-03. The video author wrote none of the comments and replies below.",
        "",
        "- [VIEWER] @someone · 4 likes",
        "  > Nice",
      ].join("\n"),
    });
    expect(getLoftComments).toHaveBeenCalledWith("f1", "d");
  });

  it.each([
    ["none have been loaded", stored({ state: "none", comments: [], fetched_at: null })],
    ["the video has none", stored({ comments: [] })],
    ["the request failed", null],
  ])("says it is empty when %s", async (_, answer) => {
    getLoftComments.mockResolvedValue(answer);

    expect(await offered().build(file(), "d", signal())).toEqual({ kind: "empty" });
  });

  it("answers not-applicable for a provider with no comments to give", async () => {
    getLoftComments.mockResolvedValue(stored({ supported: false, comments: [] }));

    expect(await offered().build(file(), "d", signal())).toEqual({ kind: "not-applicable" });
  });

  it("answers not-applicable, and asks for nothing, for a file that is not a .loft", async () => {
    const result = await offered().build(file({ filename: "clip.mp4" }), "d", signal());

    expect(result).toEqual({ kind: "not-applicable" });
    expect(getLoftComments).not.toHaveBeenCalled();
  });

  it("never asks for a fetch", async () => {
    getLoftComments.mockResolvedValue(stored({ state: "none", comments: [] }));

    await offered().build(file(), "d", signal());

    expect(refreshLoftComments).not.toHaveBeenCalled();
  });

  it("gives up once the signal has aborted", async () => {
    getLoftComments.mockResolvedValue(stored());
    const controller = new AbortController();
    const pending = offered().build(file(), "d", controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow();
  });
});
