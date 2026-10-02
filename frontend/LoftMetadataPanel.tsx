"use client";

import { useCallback, useEffect, useState } from "react";
import { Captions, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";

import { useToast } from "@/components/ToastProvider";
import { useOfferFileAiAction } from "@/lib/fileAiActions";

import {
  generateLoftStt,
  getLoftMetadata,
  refreshLoft,
  type LoftMetadata,
} from "./api";
import CaptionStatusBadge from "./CaptionStatusBadge";
import LoftDescription from "./LoftDescription";
import { useLoftRefreshed } from "./loftRefresh";

// The URL comes from a user-editable .loft file, so only a web link may
// become an href (a `javascript:` URL would run on click).
function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** After intelligence's generators in the "AI" menu. */
const TRANSCRIBE_ORDER = 100;

/** How long a refresh is given before the panel reads the result. */
const REFRESH_REREAD_MS = 3000;

/**
 * LoftMetadataPanel — channel/description/captions-status panel rendered
 * below the Core LoftPlayer. Owned by the Media Import addon (Phase 1).
 */
export default function LoftMetadataPanel({
  fileId,
  drive,
}: {
  fileId: string;
  drive: string;
}) {
  const t = useTranslations("mediaImport.loftMetadata");
  const tp = useTranslations("mediaImport.player");
  const toast = useToast();
  const [metadata, setMetadata] = useState<LoftMetadata | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [queueingStt, setQueueingStt] = useState(false);

  useEffect(() => {
    getLoftMetadata(fileId, drive).then(setMetadata);
  }, [fileId, drive]);

  const rereadLater = useCallback(() => {
    // TODO: replace polling with a WS event listener for the loft fetch.
    setTimeout(() => {
      getLoftMetadata(fileId, drive).then(setMetadata);
      setRefreshing(false);
    }, REFRESH_REREAD_MS);
  }, [fileId, drive]);

  useLoftRefreshed(fileId, rereadLater);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refreshLoft(fileId, drive);
      rereadLater();
    } catch {
      setRefreshing(false);
      toast.error(t("refreshFailed"));
    }
  }

  async function handleGenerateStt() {
    setQueueingStt(true);
    try {
      const result = await generateLoftStt(fileId, drive);
      toast.success(t(`sttStatus.${result.status}`));
    } catch {
      toast.error(t("sttStatus.error"));
    } finally {
      setQueueingStt(false);
    }
  }

  useOfferFileAiAction({
    fileId,
    id: "media_import.transcribe",
    label: t("generateStt"),
    icon: Captions,
    order: TRANSCRIBE_ORDER,
    active: Boolean(drive),
    busy: queueingStt,
    run: handleGenerateStt,
  });

  if (!metadata) return null;

  return (
    <>
      <div className="mt-3 min-w-0 text-xs text-text-muted">
        {metadata.channel && (
          <span className="font-medium text-text-primary">
            {metadata.channel}
          </span>
        )}
        {metadata.published_at && <span> · {metadata.published_at}</span>}
        {isWebUrl(metadata.url) && (
          <div className="mt-1">
            <a
              href={metadata.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-accent-cta hover:underline"
              data-testid="loft-open-original"
            >
              <ExternalLink size={12} aria-hidden="true" />
              {metadata.provider === "youtube"
                ? tp("watchOnYouTube")
                : t("openOriginal")}
            </a>
          </div>
        )}
        {metadata.description && (
          <LoftDescription key={fileId} text={metadata.description} />
        )}
      </div>
      <CaptionStatusBadge
        metadata={metadata}
        onRetry={handleRefresh}
        isRetrying={refreshing}
      />
    </>
  );
}
