import type { LoftComment } from "./api";

interface CommentsSnapshot {
  comments: LoftComment[];
  total: number | null;
  fetched_at: string | null;
}

const ROLE_TAG = /\[(AUTHOR|VIEWER)\]/gi;

// A comment is anyone's text, so it must not be able to pass for the role
// tag the reader relies on: the tag is replaced inside the text, and every
// line of the text is quoted.
function plain(text: string): string {
  return text.replace(ROLE_TAG, "($1)");
}

function authorLines(comments: LoftComment[]): number {
  return comments.reduce(
    (sum, c) => sum + (c.author_is_uploader ? 1 : 0) + authorLines(c.replies),
    0,
  );
}

function fetchedDay(fetchedAt: string | null): string | null {
  return fetchedAt?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

function header(snapshot: CommentsSnapshot): string[] {
  const { comments, total } = snapshot;
  const day = fetchedDay(snapshot.fetched_at);
  const authored = authorLines(comments);
  const scope =
    `Top ${comments.length}` +
    (total !== null ? ` of ${total}` : "") +
    (day ? `, fetched ${day}` : "") +
    ".";
  const by = authored === 0 ? "none" : String(authored);
  return [
    `${scope} The video author wrote ${by} of the comments and replies below.`,
    "[AUTHOR] = the video's own channel. [VIEWER] = anyone else.",
  ];
}

function likes(count: number | null): string | null {
  if (count === null) return null;
  return count === 1 ? "1 like" : `${count} likes`;
}

function item(comment: LoftComment, indent: string): string[] {
  const author = plain(comment.author?.replace(/\s+/g, " ").trim() || "unknown");
  const facts = [
    likes(comment.like_count),
    comment.is_pinned ? "pinned" : null,
    comment.is_hearted ? "hearted by author" : null,
  ].filter((fact): fact is string => fact !== null);
  const role = comment.author_is_uploader ? "AUTHOR" : "VIEWER";
  const lines = [`${indent}- [${role}] ${[author, ...facts].join(" · ")}`];
  for (const raw of comment.text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line) lines.push(`${indent}  > ${plain(line)}`);
  }
  for (const reply of comment.replies) lines.push(...item(reply, `${indent}  `));
  return lines;
}

export function formatCommentsMarkdown(
  title: string,
  snapshot: CommentsSnapshot,
): string {
  const name = title.replace(/\s+/g, " ").trim();
  const heading = name ? `# YouTube comments: ${name}` : "# YouTube comments";
  if (snapshot.comments.length === 0) return `${heading}\n\nNo comments.`;
  const body = snapshot.comments.flatMap((comment) => item(comment, ""));
  return [heading, ...header(snapshot), "", ...body].join("\n");
}
