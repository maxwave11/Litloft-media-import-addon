"use client";

import { useEffect, useRef, useState } from "react";
import { MessagesSquare } from "lucide-react";
import { useTranslations } from "next-intl";

import { useOfferSelectionAction } from "@/lib/selectionActions";
import type { FileItem } from "@/types";

import { loadMissingComments } from "./api";

const CHUNK = 1000;

type State =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "started"; count: number }
  | { kind: "nothing" }
  | { kind: "failed" };

export default function LoadCommentsAction({
  drive,
  files,
}: {
  drive: string;
  files: readonly FileItem[];
}) {
  const t = useTranslations("mediaImport.comments.bulk");
  const [state, setState] = useState<State>({ kind: "idle" });
  const press = useRef(0);

  const selection = files.map((file) => file.id).join(",");
  useEffect(() => {
    press.current += 1;
    setState({ kind: "idle" });
  }, [selection]);

  async function run() {
    const ids = files
      .filter((file) => file.filename.toLowerCase().endsWith(".loft"))
      .map((file) => file.id);
    if (ids.length === 0) {
      setState({ kind: "nothing" });
      return;
    }
    const mine = ++press.current;
    setState({ kind: "running" });
    try {
      let queued = 0;
      for (let offset = 0; offset < ids.length; offset += CHUNK) {
        const answer = await loadMissingComments(ids.slice(offset, offset + CHUNK), drive);
        queued += answer.queued;
      }
      if (mine !== press.current) return;
      setState(queued > 0 ? { kind: "started", count: queued } : { kind: "nothing" });
    } catch {
      if (mine === press.current) setState({ kind: "failed" });
    }
  }

  const label =
    state.kind === "started"
      ? t("started", { count: state.count })
      : state.kind === "nothing"
        ? t("nothing")
        : state.kind === "failed"
          ? t("failed")
          : t("load");

  useOfferSelectionAction({
    id: "media_import.comments-load",
    label,
    icon: MessagesSquare,
    order: 20,
    disabled: state.kind !== "idle" && state.kind !== "failed",
    run: () => void run(),
  });

  return null;
}
