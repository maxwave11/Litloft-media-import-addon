import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import type { LoftComment, LoftComments } from "@/addons/media_import/api";
import en from "@/addons/media_import/messages/en.json";

const getLoftComments = vi.fn();
const refreshLoftComments = vi.fn();
vi.mock("@/addons/media_import/api", () => ({
  getLoftComments: (...args: unknown[]) => getLoftComments(...args),
  refreshLoftComments: (...args: unknown[]) => refreshLoftComments(...args),
}));

let wsEvent: { event: string; data: { drive: string } } | null = null;
vi.mock("@/hooks/useWebSocket", () => ({ useWebSocket: () => wsEvent }));

const copyText = vi.fn();
vi.mock("@/lib/copyText", () => ({
  copyText: (...args: unknown[]) => copyText(...args),
}));

const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("@/components/ToastProvider", () => ({ useToast: () => toast }));

// The global mock renders `{count}` but not an ICU plural, and these strings
// have plurals, so the real translator formats this addon's own messages.
vi.mock("next-intl", async () => {
  const actual = await vi.importActual<typeof import("next-intl")>("next-intl");
  const { default: messages } = await import("@/addons/media_import/messages/en.json");
  return {
    ...actual,
    useTranslations: (namespace: "mediaImport.comments") =>
      actual.createTranslator({
        locale: "en",
        messages: { mediaImport: messages.mediaImport },
        namespace,
      }),
  };
});

import YouTubeComments from "@/addons/media_import/YouTubeComments";

function comment(id: string, over: Partial<LoftComment> = {}): LoftComment {
  return {
    id,
    author: `@user-${id}`,
    author_is_uploader: false,
    is_pinned: false,
    is_hearted: false,
    text: `text ${id}`,
    like_count: 3,
    published_at: null,
    replies: [],
    ...over,
  };
}

function payload(over: Partial<LoftComments> = {}): LoftComments {
  return {
    supported: true,
    state: "ready",
    error_kind: null,
    fetched_at: "2026-10-03T10:00:00+00:00",
    total: 12345,
    comments: [comment("a")],
    ...over,
  };
}

function ui(props: Partial<React.ComponentProps<typeof YouTubeComments>> = {}) {
  return (
    <NextIntlClientProvider locale="en" messages={{ mediaImport: en.mediaImport }}>
      <YouTubeComments
        fileId="f1"
        drive="d"
        filename="Video.loft"
        title="Video"
        {...props}
      />
    </NextIntlClientProvider>
  );
}

async function renderLoaded(data: LoftComments, props = {}) {
  getLoftComments.mockResolvedValue(data);
  const view = render(ui(props));
  await act(async () => {});
  return view;
}

beforeEach(() => {
  getLoftComments.mockReset();
  refreshLoftComments.mockReset();
  copyText.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  wsEvent = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("what is shown", () => {
  it("shows nothing, and asks for nothing, for a file that is not a .loft", async () => {
    const { container } = await renderLoaded(payload(), { filename: "movie.mp4" });

    expect(container).toBeEmptyDOMElement();
    expect(getLoftComments).not.toHaveBeenCalled();
  });

  it("shows nothing for a loft whose provider has no comments", async () => {
    const { container } = await renderLoaded(
      payload({ supported: false, state: "none", comments: [] }),
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing when the server does not know the file", async () => {
    getLoftComments.mockResolvedValue(null);
    const { container } = render(ui());
    await act(async () => {});

    expect(container).toBeEmptyDOMElement();
  });

  it("says how many of the video's comments it holds", async () => {
    await renderLoaded(payload({ comments: [comment("a"), comment("b")] }));

    expect(screen.getByText(/2 of 12345 comments/)).toBeInTheDocument();
    expect(screen.getByText(/loaded 2026-10-03/)).toBeInTheDocument();
  });

  it("drops 'of N' when the total is unknown", async () => {
    await renderLoaded(payload({ total: null }));

    expect(screen.getByText(/1 comment\b/)).toBeInTheDocument();
    expect(screen.queryByText(/ of /)).not.toBeInTheDocument();
  });

  it("says so when the video has no comments", async () => {
    await renderLoaded(payload({ comments: [], total: 0 }));

    expect(screen.getByText("No comments.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
  });
});

describe("telling the video's author from everyone else", () => {
  async function thread() {
    await renderLoaded(
      payload({
        comments: [
          comment("pinned", { author: "@channel", author_is_uploader: true, is_pinned: true }),
          comment("viewer", {
            is_hearted: true,
            replies: [
              comment("answer", { author: "@channel", author_is_uploader: true }),
              comment("other"),
            ],
          }),
        ],
      }),
    );
  }

  it("badges the author's comments and replies and nobody else's", async () => {
    await thread();

    const authors = document.querySelectorAll('[data-role="author"]');
    const viewers = document.querySelectorAll('[data-role="viewer"]');
    expect(authors).toHaveLength(2);
    expect(viewers).toHaveLength(2);
    for (const el of authors) expect(within(el as HTMLElement).getAllByText("Author")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Author")).toHaveLength(2);
  });

  it("marks a comment the author liked without calling it the author's", async () => {
    await renderLoaded(payload({ comments: [comment("viewer", { is_hearted: true })] }));

    const liked = screen.getByLabelText("Liked by the video's author");
    const owner = liked.closest("[data-role]") as HTMLElement;
    expect(owner.dataset.role).toBe("viewer");
    expect(within(owner).queryByText("Author")).not.toBeInTheDocument();
  });

  it("only gives the author an accent rule", async () => {
    await thread();

    for (const el of document.querySelectorAll<HTMLElement>("[data-role]")) {
      expect(el.className.includes("border-accent-teal")).toBe(el.dataset.role === "author");
    }
  });
});

describe("a long list", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => comment(`c${i}`));

  it("shows the first twenty and the rest on request", async () => {
    await renderLoaded(payload({ comments: many(25) }));

    expect(screen.getAllByTestId("comment-root")).toHaveLength(20);
    fireEvent.click(screen.getByRole("button", { name: "Show all 25" }));
    expect(screen.getAllByTestId("comment-root")).toHaveLength(25);
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("offers no 'show all' for twenty or fewer", async () => {
    await renderLoaded(payload({ comments: many(20) }));

    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("keeps replies folded under a count", async () => {
    await renderLoaded(
      payload({ comments: [comment("a", { replies: [comment("r1"), comment("r2")] })] }),
    );

    const summary = screen.getByText("2 replies");
    expect(summary.closest("details")).not.toHaveAttribute("open");
  });
});

describe("loading", () => {
  it("offers to load comments that were never loaded, and then waits", async () => {
    getLoftComments
      .mockResolvedValueOnce(payload({ state: "none", comments: [], total: null, fetched_at: null }))
      .mockResolvedValue(payload({ state: "queued", comments: [], total: null, fetched_at: null }));
    refreshLoftComments.mockResolvedValue({ status: "queued" });
    render(ui());
    await act(async () => {});

    expect(screen.getByText("The comments have not been loaded yet.")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load comments" }));
    });

    expect(refreshLoftComments).toHaveBeenCalledWith("f1", "d");
    expect(screen.getByText("Loading comments…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load comments" })).not.toBeInTheDocument();
  });

  it("refreshes a loaded snapshot on request and keeps showing it", async () => {
    refreshLoftComments.mockResolvedValue({ status: "queued" });
    await renderLoaded(payload());
    getLoftComments.mockResolvedValue(payload({ state: "queued" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });

    expect(refreshLoftComments).toHaveBeenCalledWith("f1", "d");
    expect(screen.getByText("Loading comments…")).toBeInTheDocument();
    expect(screen.getByText("text a")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  });

  it("tells the viewer when loading could not be started", async () => {
    refreshLoftComments.mockRejectedValue(new Error("HTTP 400"));
    await renderLoaded(payload());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });

    expect(toast.error).toHaveBeenCalledWith("Could not start loading the comments");
  });

  it("ignores an answer that arrives after the page moved to another file", async () => {
    let answerFirst!: (value: LoftComments) => void;
    getLoftComments.mockImplementationOnce(
      () => new Promise<LoftComments>((resolve) => (answerFirst = resolve)),
    );
    const { rerender } = render(ui());
    getLoftComments.mockResolvedValue(payload({ comments: [comment("second")] }));

    rerender(ui({ fileId: "f2" }));
    await act(async () => {});
    await act(async () => {
      answerFirst(payload({ comments: [comment("first")] }));
    });

    expect(screen.getByText("text second")).toBeInTheDocument();
    expect(screen.queryByText("text first")).not.toBeInTheDocument();
  });

  it("starts over for another file", async () => {
    const { rerender } = await renderLoaded(payload());
    getLoftComments.mockResolvedValue(payload({ comments: [comment("other-file")] }));

    rerender(ui({ fileId: "f2" }));
    await act(async () => {});

    expect(getLoftComments).toHaveBeenLastCalledWith("f2", "d");
    expect(screen.getByText("text other-file")).toBeInTheDocument();
    expect(screen.queryByText("text a")).not.toBeInTheDocument();
  });
});

describe("a failed load", () => {
  it.each([
    ["rate_limited", "YouTube is limiting requests right now. Try again later."],
    ["permanent", "This video is unavailable, so its comments cannot be read."],
    ["disabled", "Comments are turned off or unavailable for this video."],
    ["failed", "The comments could not be loaded."],
  ] as const)("explains %s and keeps the earlier snapshot", async (kind, message) => {
    await renderLoaded(payload({ state: "error", error_kind: kind }));

    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByText("text a")).toBeInTheDocument();
  });

  it("explains a failure when nothing was ever stored", async () => {
    await renderLoaded(
      payload({ state: "error", error_kind: "disabled", comments: [], total: null, fetched_at: null }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent("turned off");
    expect(screen.queryByText("No comments.")).not.toBeInTheDocument();
  });
});

describe("following a pending fetch", () => {
  const queued = () => payload({ state: "queued" });

  it("re-reads when the drive reports an update", async () => {
    const { rerender } = await renderLoaded(queued());
    getLoftComments.mockClear();

    wsEvent = { event: "drive.file_updated", data: { drive: "d" } };
    rerender(ui());
    await act(async () => {});

    expect(getLoftComments).toHaveBeenCalledTimes(1);
  });

  it("ignores another drive's update", async () => {
    const { rerender } = await renderLoaded(queued());
    getLoftComments.mockClear();

    wsEvent = { event: "drive.file_updated", data: { drive: "elsewhere" } };
    rerender(ui());
    await act(async () => {});

    expect(getLoftComments).not.toHaveBeenCalled();
  });

  it("does not re-read on updates when nothing is pending", async () => {
    const { rerender } = await renderLoaded(payload());
    getLoftComments.mockClear();

    wsEvent = { event: "drive.file_updated", data: { drive: "d" } };
    rerender(ui());
    await act(async () => {});

    expect(getLoftComments).not.toHaveBeenCalled();
  });

  it("does not treat an old update as news when a fetch starts", async () => {
    wsEvent = { event: "drive.file_updated", data: { drive: "d" } };
    refreshLoftComments.mockResolvedValue({ status: "queued" });
    await renderLoaded(payload());
    getLoftComments.mockClear();
    getLoftComments.mockResolvedValue(queued());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });

    expect(getLoftComments).toHaveBeenCalledTimes(1);
  });

  it("asks again every ten seconds while pending, in case the socket dropped", async () => {
    vi.useFakeTimers();
    getLoftComments.mockResolvedValue(queued());
    render(ui());
    await act(async () => {});
    getLoftComments.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(9_999);
    });
    expect(getLoftComments).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(getLoftComments).toHaveBeenCalledTimes(1);
  });

  it("stops asking once the fetch is done", async () => {
    vi.useFakeTimers();
    getLoftComments.mockResolvedValueOnce(queued()).mockResolvedValue(payload());
    render(ui());
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    getLoftComments.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(getLoftComments).not.toHaveBeenCalled();
  });
});

describe("copying for an AI", () => {
  it("copies the thread with its roles and says so", async () => {
    copyText.mockResolvedValue(true);
    await renderLoaded(
      payload({
        comments: [
          comment("a", { author: "@channel", author_is_uploader: true, text: "From the author" }),
          comment("b", { text: "From a viewer" }),
        ],
      }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });

    const markdown = copyText.mock.calls[0][0] as string;
    expect(markdown.startsWith("# YouTube comments: Video\n")).toBe(true);
    expect(markdown).toContain("- [AUTHOR] @channel · 3 likes\n  > From the author");
    expect(markdown).toContain("- [VIEWER] @user-b · 3 likes\n  > From a viewer");
    expect(toast.success).toHaveBeenCalledWith("Comments copied");
  });

  it("falls back to the file name when the page has no title", async () => {
    copyText.mockResolvedValue(true);
    await renderLoaded(payload(), { title: undefined });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });

    expect((copyText.mock.calls[0][0] as string).split("\n")[0]).toBe(
      "# YouTube comments: Video.loft",
    );
  });

  it("says when the clipboard refused", async () => {
    copyText.mockResolvedValue(false);
    await renderLoaded(payload());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });

    expect(toast.error).toHaveBeenCalledWith("Could not copy the comments");
    expect(toast.success).not.toHaveBeenCalled();
  });
});
