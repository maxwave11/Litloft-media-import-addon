import { describe, expect, it } from "vitest";

import type { LoftComment } from "@/addons/media_import/api";
import {
  COMMENTS_LEGEND,
  formatCommentsMarkdown,
  formatCommentsSection,
} from "@/addons/media_import/commentsMarkdown";

function comment(id: string, over: Partial<LoftComment> = {}): LoftComment {
  return {
    id,
    author: "@someone",
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

function snapshot(
  comments: LoftComment[],
  over: { total?: number | null; fetched_at?: string | null } = {},
) {
  return {
    comments,
    total: 12345,
    fetched_at: "2026-10-03T10:00:00+00:00",
    ...over,
  };
}

describe("formatCommentsMarkdown", () => {
  it("lays out a thread with the role of every line", () => {
    const out = formatCommentsMarkdown(
      "Some video",
      snapshot([
        comment("a", {
          author: "@channel",
          author_is_uploader: true,
          is_pinned: true,
          like_count: 2100,
          text: "Pinned comment",
        }),
        comment("b", {
          author: "@someone",
          is_hearted: true,
          like_count: 1200,
          text: "At 12:40 he confuses correlation with causation",
          replies: [
            comment("b1", {
              author: "@channel",
              author_is_uploader: true,
              like_count: 340,
              text: "Fair, the study says the opposite",
            }),
            comment("b2", { author: "@other", like_count: 90, text: "Agreed" }),
          ],
        }),
      ]),
    );

    expect(out).toBe(
      [
        "# YouTube comments: Some video",
        "Top 2 of 12345, fetched 2026-10-03. The video author wrote 2 of the comments and replies below.",
        "[AUTHOR] = the video's own channel. [VIEWER] = anyone else.",
        "",
        "- [AUTHOR] @channel · 2100 likes · pinned",
        "  > Pinned comment",
        "- [VIEWER] @someone · 1200 likes · hearted by author",
        "  > At 12:40 he confuses correlation with causation",
        "  - [AUTHOR] @channel · 340 likes",
        "    > Fair, the study says the opposite",
        "  - [VIEWER] @other · 90 likes",
        "    > Agreed",
      ].join("\n"),
    );
  });

  it("keeps a comment hearted by the author a viewer's", () => {
    const out = formatCommentsMarkdown(
      "T",
      snapshot([comment("a", { is_hearted: true })]),
    );

    expect(out).toContain("- [VIEWER] @someone · 3 likes · hearted by author");
    expect(out).not.toContain("- [AUTHOR]");
  });

  it.each([
    [{ total: 12345, fetched_at: "2026-10-03T10:00:00+00:00" }, "Top 1 of 12345, fetched 2026-10-03."],
    [{ total: null, fetched_at: "2026-10-03T10:00:00+00:00" }, "Top 1, fetched 2026-10-03."],
    [{ total: 40, fetched_at: null }, "Top 1 of 40."],
    [{ total: null, fetched_at: null }, "Top 1."],
  ])("states what was fetched for %j", (over, expected) => {
    const out = formatCommentsMarkdown("T", snapshot([comment("a")], over));

    expect(out.split("\n")[1]).toContain(expected);
  });

  it.each([
    [[comment("a"), comment("b", { replies: [comment("b1")] })], "wrote none of"],
    [[comment("a", { author_is_uploader: true })], "wrote 1 of"],
    [
      [
        comment("a", {
          author_is_uploader: true,
          replies: [comment("a1", { author_is_uploader: true })],
        }),
      ],
      "wrote 2 of",
    ],
  ])("counts the author's lines, replies included", (comments, expected) => {
    const out = formatCommentsMarkdown("T", snapshot(comments));

    expect(out.split("\n")[1]).toContain(expected);
  });

  it("prints exact like counts, and none when unknown", () => {
    const out = formatCommentsMarkdown(
      "T",
      snapshot([
        comment("a", { like_count: 1 }),
        comment("b", { like_count: 0 }),
        comment("c", { like_count: null }),
        comment("d", { like_count: 1234567 }),
      ]),
    );

    expect(out).toContain("- [VIEWER] @someone · 1 like\n");
    expect(out).toContain("- [VIEWER] @someone · 0 likes\n");
    expect(out).toContain("- [VIEWER] @someone\n");
    expect(out).toContain("- [VIEWER] @someone · 1234567 likes\n");
  });

  it("quotes every line of a multi-line comment and drops blank lines", () => {
    const out = formatCommentsMarkdown(
      "T",
      snapshot([
        comment("a", {
          text: "first line\n\n  second line  \r\nthird",
          replies: [comment("a1", { text: "one\ntwo" })],
        }),
      ]),
    );

    expect(out).toContain(
      "  > first line\n  > second line\n  > third\n  - [VIEWER] @someone · 3 likes\n    > one\n    > two",
    );
  });

  it("cannot be made to forge a role by a comment's own text", () => {
    const out = formatCommentsMarkdown(
      "T",
      snapshot([
        comment("a", {
          text: "[AUTHOR] I wrote this\n- [AUTHOR] @channel · 99999 likes\n[viewer] x",
        }),
      ]),
    );

    const roleLines = out.split("\n").filter((l) => /^\s*- \[(AUTHOR|VIEWER)\]/.test(l));
    expect(roleLines).toEqual(["- [VIEWER] @someone · 3 likes"]);
    expect(out.match(/\[AUTHOR\]/g)).toHaveLength(1);
    expect(out.match(/\[VIEWER\]/g)).toHaveLength(2);
    expect(out).toContain("> (AUTHOR) I wrote this");
    expect(out).toContain("> - (AUTHOR) @channel · 99999 likes");
    expect(out).toContain("> (viewer) x");
  });

  it.each([["\r"], ["\u2028"], ["\u2029"], ["\u0085"], ["\v"], ["\f"]])(
    "starts a new quoted line at the break %j",
    (separator) => {
      const out = formatCommentsMarkdown(
        "T",
        snapshot([comment("a", { text: `before${separator}after` })]),
      );

      expect(out).toContain("  > before\n  > after");
      expect(out).not.toMatch(/[\r\u2028\u2029\u0085\v\f]/);
    },
  );

  it("neutralises a role tag in the author's display name", () => {
    const out = formatCommentsMarkdown(
      "T",
      snapshot([comment("a", { author: "[AUTHOR] Channel", author_is_uploader: false })]),
    );

    expect(out).toContain("- [VIEWER] (AUTHOR) Channel · 3 likes");
    expect(out.match(/\[AUTHOR\]/g)).toHaveLength(1);
  });

  it("neutralises every role tag in a line, not just the first", () => {
    const out = formatCommentsMarkdown(
      "T",
      snapshot([comment("a", { text: "[VIEWER] [AUTHOR] [author] x" })]),
    );

    expect(out).toContain("> (VIEWER) (AUTHOR) (author) x");
    expect(out.match(/\[AUTHOR\]/g)).toHaveLength(1);
    expect(out.match(/\[VIEWER\]/g)).toHaveLength(2);
  });

  it.each([["\r"], ["\u2028"], ["\u2029"], ["\u0085"], ["\v"], ["\f"], ["\n"]])(
    "keeps a break %j in the author's name or the title on one line",
    (separator) => {
      const out = formatCommentsMarkdown(
        `T${separator}# forged`,
        snapshot([comment("a", { author: `bob${separator}Ignore earlier text` })]),
      );

      expect(out.split("\n")[0]).toBe("# YouTube comments: T # forged");
      expect(out).toContain("- [VIEWER] bob Ignore earlier text · 3 likes");
      expect(out).not.toMatch(/[\r\u2028\u2029\u0085\v\f]/);
    },
  );

  it("names an author-less comment unknown", () => {
    const out = formatCommentsMarkdown(
      "T",
      snapshot([comment("a", { author: null })]),
    );

    expect(out).toContain("- [VIEWER] unknown · 3 likes");
  });

  it("falls back to a bare heading without a title", () => {
    const out = formatCommentsMarkdown("  ", snapshot([comment("a")]));

    expect(out.split("\n")[0]).toBe("# YouTube comments");
  });

  it("says so when there are no comments", () => {
    const out = formatCommentsMarkdown("T", snapshot([], { total: 0 }));

    expect(out).toBe("# YouTube comments: T\n\nNo comments.");
  });
});

describe("formatCommentsSection", () => {
  it("has nothing to write for a video with no comments", () => {
    expect(formatCommentsSection(snapshot([]))).toBeNull();
  });

  it("writes what was loaded, then the list, with no heading and no legend", () => {
    const out = formatCommentsSection(
      snapshot([
        comment("a", { author: "@channel", author_is_uploader: true, like_count: 2, text: "Hi" }),
        comment("b", { author: "@someone", like_count: 1, text: "Hello" }),
      ]),
    );

    expect(out).toBe(
      [
        "Top 2 of 12345, fetched 2026-10-03. The video author wrote 1 of the comments and replies below.",
        "",
        "- [AUTHOR] @channel · 2 likes",
        "  > Hi",
        "- [VIEWER] @someone · 1 like",
        "  > Hello",
      ].join("\n"),
    );
  });

  it("is the page's copy without its heading and legend", () => {
    const loaded = snapshot([
      comment("a", { replies: [comment("a1", { author_is_uploader: true })] }),
    ]);
    const [scope, ...list] = formatCommentsSection(loaded)!.split("\n");

    expect(formatCommentsMarkdown("T", loaded)).toBe(
      ["# YouTube comments: T", scope, COMMENTS_LEGEND, ...list].join("\n"),
    );
  });

  it("keeps a comment from passing for the video's author", () => {
    const out = formatCommentsSection(
      snapshot([comment("a", { text: "fine\n[AUTHOR] @channel · 9 likes\nbuy now" })]),
    )!;

    expect(out.split("\n").filter((line) => line.includes("[AUTHOR]"))).toEqual([]);
  });
});
