"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";

import { useOfferExportSection, type ExportSectionProvider } from "@/lib/exportSections";

import { getLoftComments } from "./api";
import { COMMENTS_LEGEND, formatCommentsSection } from "./commentsMarkdown";

export default function CommentsExportSection() {
  const t = useTranslations("mediaImport.comments");
  const label = t("exportSection");

  const provider = useMemo<ExportSectionProvider>(
    () => ({
      id: "comments-export",
      label,
      order: 20,
      preamble: COMMENTS_LEGEND,
      build: async (file, drive, signal) => {
        if (!file.filename.toLowerCase().endsWith(".loft")) return { kind: "not-applicable" };
        const stored = await getLoftComments(file.id, drive);
        signal.throwIfAborted();
        if (stored === null) return { kind: "empty" };
        if (!stored.supported) return { kind: "not-applicable" };
        const section = formatCommentsSection(stored);
        return section === null ? { kind: "empty" } : { kind: "section", markdown: section };
      },
    }),
    [label],
  );

  useOfferExportSection(provider);
  return null;
}
