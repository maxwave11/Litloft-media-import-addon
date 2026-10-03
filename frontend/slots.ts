import { lazy } from "react";

// Side-effect: register Media Import's official .loft players (YouTube,
// Vimeo) against core's playerRegistry. Importing this module on slot
// load gives the registrations a chance to fire before LoftPlayer
// dispatches the .loft for the same file.
import "./players/registerMediaImportPlayers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const slotComponents: Record<string, React.LazyExoticComponent<React.ComponentType<any>>> = {
  "card-channel": lazy(() => import("./CardMetadata").then(mod => ({ default: mod.CardChannel }))),
  "card-comments": lazy(() => import("./CardMetadata").then(mod => ({ default: mod.CardComments }))),
  "loft-metadata": lazy(() => import("./LoftMetadataPanel")),
  comments: lazy(() => import("./YouTubeComments")),
  "comments-export": lazy(() => import("./CommentsExportSection")),
  "media-import-url": lazy(() => import("./ImportFromUrlMenuItem")),
  "loft-refresh": lazy(() => import("./LoftRefreshMenuItem")),
};
