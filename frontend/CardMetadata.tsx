"use client";

import { fetchJSON } from "@/lib/api";
import { createFileMetadataStore } from "@/lib/fileMetadataStore";
import { MediaIndicator, type MediaStatus } from "@/components/MediaIndicator";

interface Metadata { channel: string | null; comments: MediaStatus | null }
const useMetadata = createFileMetadataStore<Metadata>((drive, ids) => fetchJSON(
  "/api/addons/media_import/link/card-metadata",
  { method: "POST", headers: { "Content-Type": "application/json", "X-Lit-Drive": encodeURIComponent(drive) }, body: JSON.stringify({ file_ids: ids }) },
));

type Props = { fileId: string; drive: string; filename: string };

export function CardChannel(props: Props) {
  return props.filename.toLowerCase().endsWith(".loft") ? <Channel {...props} /> : null;
}

function Channel({ fileId, drive }: Props) {
  const data = useMetadata(fileId, drive);
  return data?.channel ? <span className="truncate" title={data.channel}>{data.channel}</span> : null;
}

export function CardComments(props: Props) {
  return props.filename.toLowerCase().endsWith(".loft") ? <Comments {...props} /> : null;
}

function Comments({ fileId, drive }: Props) {
  const data = useMetadata(fileId, drive);
  if (data?.comments === null) return null;
  return <MediaIndicator kind="comments" status={data?.comments ?? "unknown"} />;
}
