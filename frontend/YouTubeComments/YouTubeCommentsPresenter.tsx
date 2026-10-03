import { Copy, Heart, Loader2, MessagesSquare, Pin, RefreshCw, ThumbsUp } from "lucide-react";
import { useTranslations } from "next-intl";

import type { LoftComment, LoftComments } from "../api";

export const INITIAL_COMMENTS = 20;

const ACTION_CLASS =
  "flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-primary disabled:opacity-50 pointer-coarse:min-h-11";

const PRIMARY_CLASS =
  "rounded-lg bg-accent-teal px-3 py-1.5 text-sm text-white transition-colors hover:bg-accent-teal/90 disabled:opacity-50 pointer-coarse:min-h-11";

/** A fetch that failed for a reason pressing again can change. */
const RETRYABLE = new Set(["rate_limited", "failed"]);

interface PresenterProps {
  data: LoftComments;
  busy: boolean;
  showAll: boolean;
  /** The block's own title; a tab already carries one. */
  heading: boolean;
  onShowAll: () => void;
  onRequest: () => void;
  onCopy: () => void;
}

function CommentCard({ comment }: { comment: LoftComment }) {
  const t = useTranslations("mediaImport.comments");
  const byAuthor = comment.author_is_uploader;

  return (
    <div
      data-role={byAuthor ? "author" : "viewer"}
      className={`min-w-0 ${byAuthor ? "border-l-2 border-accent-teal pl-3" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-muted">
        <span className="font-medium text-text-primary">{comment.author ?? "—"}</span>
        {byAuthor && (
          <span className="rounded-full bg-accent-teal px-1.5 py-0.5 text-[11px] font-medium text-white">
            {t("author")}
          </span>
        )}
        {comment.is_pinned && (
          <span className="inline-flex items-center gap-0.5">
            <Pin size={11} aria-hidden="true" />
            {t("pinned")}
          </span>
        )}
        {comment.like_count !== null && (
          <span className="inline-flex items-center gap-0.5">
            <ThumbsUp size={11} aria-hidden="true" />
            {comment.like_count.toLocaleString()}
          </span>
        )}
        {comment.is_hearted && (
          <Heart size={12} role="img" aria-label={t("heartedByAuthor")} />
        )}
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-text-primary">
        {comment.text}
      </p>
      {comment.replies.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-text-muted">
            {t("replies", { count: comment.replies.length })}
          </summary>
          <ul className="mt-2 space-y-3 border-l border-bg-border pl-3">
            {comment.replies.map((reply) => (
              <li key={reply.id}>
                <CommentCard comment={reply} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-3 py-8 text-center">{children}</div>
  );
}

export default function YouTubeCommentsPresenter({
  data,
  busy,
  showAll,
  heading,
  onShowAll,
  onRequest,
  onCopy,
}: PresenterProps) {
  const t = useTranslations("mediaImport.comments");
  const { comments, state } = data;
  const pending = state === "queued";
  const hasSnapshot = data.fetched_at !== null;
  const shown = showAll ? comments : comments.slice(0, INITIAL_COMMENTS);
  const day = data.fetched_at?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  const summary = [
    data.total !== null
      ? t("countOfTotal", { count: comments.length, total: data.total })
      : t("countOnly", { count: comments.length }),
    ...(day ? [t("fetchedOn", { date: day })] : []),
    t("mostLiked"),
  ].join(" · ");

  return (
    <section aria-label={t("title")} data-testid="youtube-comments" className="space-y-3">
      {(heading || hasSnapshot) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {heading && <h2 className="text-sm font-medium text-text-primary">{t("title")}</h2>}
          {hasSnapshot && <p className="text-xs text-text-muted">{summary}</p>}
          {hasSnapshot && (
            <div className="ml-auto flex items-center gap-1">
              {comments.length > 0 && (
                <button type="button" onClick={onCopy} className={ACTION_CLASS}>
                  <Copy size={12} aria-hidden="true" />
                  {t("copy")}
                </button>
              )}
              <button
                type="button"
                onClick={onRequest}
                disabled={busy || pending}
                className={ACTION_CLASS}
              >
                <RefreshCw
                  size={12}
                  aria-hidden="true"
                  className={busy || pending ? "animate-spin" : undefined}
                />
                {t("refresh")}
              </button>
            </div>
          )}
        </div>
      )}

      {state === "error" && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-danger"
        >
          <p>{t(`error.${data.error_kind ?? "failed"}`)}</p>
          {RETRYABLE.has(data.error_kind ?? "failed") && (
            <button
              type="button"
              onClick={onRequest}
              disabled={busy}
              className="underline disabled:opacity-50 pointer-coarse:min-h-11"
            >
              {t("retry")}
            </button>
          )}
        </div>
      )}

      {state === "none" && (
        <Centered>
          <MessagesSquare size={24} className="text-text-muted" aria-hidden="true" />
          <p className="text-sm text-text-primary">{t("notLoaded")}</p>
          <button type="button" onClick={onRequest} disabled={busy} className={PRIMARY_CLASS}>
            {t("load")}
          </button>
          <p className="max-w-sm text-xs leading-relaxed text-text-muted">{t("loadHint")}</p>
        </Centered>
      )}

      {pending && comments.length === 0 && (
        <Centered>
          <Loader2 size={24} className="animate-spin text-text-muted" aria-hidden="true" />
          <p role="status" className="text-sm text-text-primary">
            {t("loading")}
          </p>
          <p className="max-w-sm text-xs leading-relaxed text-text-muted">{t("loadHint")}</p>
        </Centered>
      )}

      {pending && comments.length > 0 && (
        <p role="status" className="flex items-center gap-2 text-xs text-text-muted">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          {t("loading")}
        </p>
      )}

      {state === "ready" && comments.length === 0 && (
        <p className="text-xs text-text-muted">{t("empty")}</p>
      )}

      {comments.length > 0 && (
        <ul className="space-y-3">
          {shown.map((comment) => (
            <li key={comment.id} data-testid="comment-root">
              <CommentCard comment={comment} />
            </li>
          ))}
        </ul>
      )}

      {!showAll && comments.length > INITIAL_COMMENTS && (
        <button type="button" onClick={onShowAll} className={ACTION_CLASS}>
          {t("showAll", { count: comments.length })}
        </button>
      )}
    </section>
  );
}
