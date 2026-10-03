"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { useToast } from "@/components/ToastProvider";
import { useWebSocket } from "@/hooks/useWebSocket";
import { copyText } from "@/lib/copyText";

import { getLoftComments, refreshLoftComments, type LoftComments } from "../api";
import { formatCommentsMarkdown } from "../commentsMarkdown";
import YouTubeCommentsPresenter from "./YouTubeCommentsPresenter";

/** The socket can drop while a fetch runs, so a pending page also asks on a timer. */
const PENDING_POLL_MS = 10_000;

interface Props {
  fileId: string;
  drive: string;
  filename?: string;
  title?: string;
}

export default function YouTubeCommentsContainer({
  fileId,
  drive,
  filename,
  title,
}: Props) {
  const t = useTranslations("mediaImport.comments");
  const toast = useToast();
  const filesUpdated = useWebSocket("drive.file_updated");
  const eligible = !filename || filename.toLowerCase().endsWith(".loft");
  const [data, setData] = useState<LoftComments | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const key = `${drive}/${fileId}`;
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  }, [key]);

  const reload = useCallback(async () => {
    try {
      const next = await getLoftComments(fileId, drive);
      if (keyRef.current === `${drive}/${fileId}`) setData(next);
    } catch {
      // Leaves what is on screen.
    }
  }, [fileId, drive]);

  useEffect(() => {
    if (!eligible) return;
    setData(null);
    setShowAll(false);
    void reload();
  }, [eligible, reload]);

  const pending = data?.state === "queued";

  // The event carries the drive and no file id, so it only says "look again".
  const seenEvent = useRef(filesUpdated);
  useEffect(() => {
    if (filesUpdated === seenEvent.current) return;
    seenEvent.current = filesUpdated;
    if (pending && filesUpdated?.data?.drive === drive) void reload();
  }, [filesUpdated, pending, drive, reload]);

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void reload(), PENDING_POLL_MS);
    return () => clearInterval(timer);
  }, [pending, reload]);

  const request = useCallback(async () => {
    setBusy(true);
    try {
      await refreshLoftComments(fileId, drive);
      await reload();
    } catch {
      toast.error(t("requestFailed"));
    } finally {
      setBusy(false);
    }
  }, [fileId, drive, reload, toast, t]);

  const copy = useCallback(async () => {
    if (!data) return;
    const markdown = formatCommentsMarkdown(title || filename || "", data);
    if (await copyText(markdown)) toast.success(t("copied"));
    else toast.error(t("copyFailed"));
  }, [data, title, filename, toast, t]);

  if (!eligible || !data || !data.supported) return null;

  return (
    <YouTubeCommentsPresenter
      data={data}
      busy={busy}
      showAll={showAll}
      onShowAll={() => setShowAll(true)}
      onRequest={request}
      onCopy={copy}
    />
  );
}
