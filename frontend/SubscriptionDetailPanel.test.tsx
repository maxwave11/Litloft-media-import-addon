/**
 * Unit tests for SubscriptionDetailPanel — folder edit (C-2) and
 * backfill UI (C-3).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import SubscriptionDetailPanel from "@/addons/media_import/SubscriptionDetailPanel";
import type { Subscription, SubscriptionVideo } from "@/addons/media_import/api";

const mockPatch = vi.fn();
const mockListVideos = vi.fn();
const mockExtendBackfill = vi.fn();
const mockFetchAll = vi.fn();
const mockRemoveShorts = vi.fn();

vi.mock("@/addons/media_import/api", async () => {
  const actual = await vi.importActual<typeof import("@/addons/media_import/api")>(
    "@/addons/media_import/api",
  );
  return {
    ...actual,
    patchSubscription: (...args: unknown[]) => mockPatch(...args),
    listSubscriptionVideos: (...args: unknown[]) => mockListVideos(...args),
    extendBackfill: (...args: unknown[]) => mockExtendBackfill(...args),
    setFetchAllChannel: (...args: unknown[]) => mockFetchAll(...args),
    removeSubscriptionShorts: (...args: unknown[]) => mockRemoveShorts(...args),
    deleteSubscription: vi.fn(),
    syncSubscription: vi.fn(),
    refreshSubscriptionMetadata: vi.fn(),
    subscriptionAvatarUrl: (id: number) => `/avatar/${id}`,
  };
});

const ws = vi.hoisted(() => ({
  event: null as { event: string; data: Record<string, unknown> } | null,
}));

vi.mock("@/hooks/useWebSocket", () => ({
  useWebSocket: () => ws.event,
}));

function makeSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 1,
    provider: "youtube",
    source_kind: "channel",
    source_ref: "UCabc",
    drive: "d",
    folder_path: "YouTube/test",
    title: null,
    is_enabled: true,
    cooldown_minutes: 60,
    include_no_transcript: false,
    last_synced_at: null,
    cooldown_until: null,
    created_at: "2026-05-01T00:00:00",
    running: false,
    avatar_url: null,
    display_title: "Test Channel",
    display_mode: "library",
    include_shorts: true,
    ...overrides,
  };
}

const defaultProps = {
  drive: "d",
  subscription: makeSubscription(),
  onClose: vi.fn(),
  onChanged: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  ws.event = null;
  mockListVideos.mockResolvedValue([] as SubscriptionVideo[]);
  mockPatch.mockResolvedValue(makeSubscription());
  mockExtendBackfill.mockResolvedValue({ status: "queued" });
  mockRemoveShorts.mockResolvedValue({ status: "queued" });
});

describe("SubscriptionDetailPanel — folder edit", () => {
  it("shows folder path and edit button", async () => {
    render(<SubscriptionDetailPanel {...defaultProps} />);
    await waitFor(() => expect(screen.queryByText("読み込み中...")).not.toBeInTheDocument());
    expect(screen.getByText("/YouTube/test")).toBeInTheDocument();
    expect(screen.getByTestId("folder-edit")).toBeInTheDocument();
  });

  it("opens inline input on edit click", async () => {
    render(<SubscriptionDetailPanel {...defaultProps} />);
    await waitFor(() => expect(screen.queryByTestId("folder-edit")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("folder-edit"));
    expect(screen.getByTestId("folder-input")).toBeInTheDocument();
    expect(screen.getByTestId("folder-save")).toBeInTheDocument();
    expect(screen.getByTestId("folder-cancel")).toBeInTheDocument();
  });

  it("save button is disabled when value unchanged", async () => {
    render(<SubscriptionDetailPanel {...defaultProps} />);
    await waitFor(() => expect(screen.queryByTestId("folder-edit")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("folder-edit"));
    expect(screen.getByTestId("folder-save")).toBeDisabled();
  });

  it("calls patchSubscription with new folder_path on save", async () => {
    render(<SubscriptionDetailPanel {...defaultProps} />);
    await waitFor(() => expect(screen.queryByTestId("folder-edit")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("folder-edit"));
    fireEvent.change(screen.getByTestId("folder-input"), {
      target: { value: "YouTube/new" },
    });
    fireEvent.click(screen.getByTestId("folder-save"));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("d", 1, { folder_path: "YouTube/new" }),
    );
    // The request having been sent is not the same event as the panel
    // leaving edit mode: that waits on the response.
    await waitFor(() =>
      expect(screen.queryByTestId("folder-input")).not.toBeInTheDocument(),
    );
  });

  it("cancel restores original value and closes input", async () => {
    render(<SubscriptionDetailPanel {...defaultProps} />);
    await waitFor(() => expect(screen.queryByTestId("folder-edit")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("folder-edit"));
    fireEvent.change(screen.getByTestId("folder-input"), {
      target: { value: "YouTube/other" },
    });
    fireEvent.click(screen.getByTestId("folder-cancel"));
    expect(screen.queryByTestId("folder-input")).not.toBeInTheDocument();
    expect(screen.getByText("/YouTube/test")).toBeInTheDocument();
  });
});

describe("SubscriptionDetailPanel — backfill UI", () => {
  it("renders backfill row with count input and button", async () => {
    render(<SubscriptionDetailPanel {...defaultProps} />);
    await waitFor(() => expect(screen.queryByTestId("backfill-row")).toBeInTheDocument());
    expect(screen.getByTestId("backfill-count")).toBeInTheDocument();
    expect(screen.getByTestId("backfill-button")).toBeInTheDocument();
  });

  it("calls extendBackfill with drive, id, and count on click", async () => {
    render(<SubscriptionDetailPanel {...defaultProps} />);
    await waitFor(() => expect(screen.queryByTestId("backfill-button")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("backfill-count"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByTestId("backfill-button"));
    await waitFor(() =>
      expect(mockExtendBackfill).toHaveBeenCalledWith("d", 1, 30),
    );
  });

  it("shows queued message after successful backfill", async () => {
    render(<SubscriptionDetailPanel {...defaultProps} />);
    await waitFor(() => expect(screen.queryByTestId("backfill-button")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("backfill-button"));
    await waitFor(() =>
      expect(screen.getByTestId("backfill-message")).toBeInTheDocument(),
    );
  });

  it("shows error message when backfill fails", async () => {
    mockExtendBackfill.mockRejectedValue(new Error("network error"));
    render(<SubscriptionDetailPanel {...defaultProps} />);
    await waitFor(() => expect(screen.queryByTestId("backfill-button")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("backfill-button"));
    await waitFor(() =>
      expect(screen.getByTestId("backfill-message")).toBeInTheDocument(),
    );
  });
});


describe("Full channel background import controls", () => {
  it("starts from the channel detail and shows a stop control", async () => {
    mockFetchAll.mockResolvedValue(makeSubscription({ fetch_all_status: "active" }));
    render(<SubscriptionDetailPanel {...defaultProps} />);
    fireEvent.click(screen.getByTestId("fetch-all-button"));
    await waitFor(() => expect(mockFetchAll).toHaveBeenCalledWith("d", 1, true));
    await waitFor(() => expect(screen.getByTestId("fetch-all-button")).toHaveTextContent("Stop fetching"));
    expect(screen.getByTestId("backfill-button")).toBeDisabled();
    expect(screen.getByTestId("action-sync")).toBeDisabled();
  });

  it("allows stopping an active task on a paused subscription", async () => {
    mockFetchAll.mockResolvedValue(makeSubscription({ fetch_all_status: "cancelled", is_enabled: false }));
    render(<SubscriptionDetailPanel {...defaultProps} subscription={makeSubscription({ fetch_all_status: "active", is_enabled: false })} />);
    fireEvent.click(screen.getByTestId("fetch-all-button"));
    await waitFor(() => expect(mockFetchAll).toHaveBeenCalledWith("d", 1, false));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Fetching stopped"));
  });

  it("offers full history only for a channel", async () => {
    render(<SubscriptionDetailPanel {...defaultProps} subscription={makeSubscription({ source_kind: "playlist" })} />);
    expect(screen.queryByTestId("fetch-all-button")).not.toBeInTheDocument();
    await waitFor(() => expect(mockListVideos).toHaveBeenCalled());
  });
});


describe("Shorts controls", () => {
  it("patches include_shorts when the toggle is unchecked", async () => {
    render(<SubscriptionDetailPanel {...defaultProps} />);
    await waitFor(() => expect(screen.getByTestId("include-shorts")).toBeChecked());

    fireEvent.click(screen.getByTestId("include-shorts"));

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("d", 1, { include_shorts: false }),
    );
  });

  it("offers the Shorts controls only for a YouTube channel", async () => {
    render(
      <SubscriptionDetailPanel
        {...defaultProps}
        subscription={makeSubscription({ source_kind: "playlist" })}
      />,
    );
    expect(screen.queryByTestId("include-shorts")).not.toBeInTheDocument();
    expect(screen.queryByTestId("remove-shorts")).not.toBeInTheDocument();
  });

  it("queues removing Shorts after confirming", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SubscriptionDetailPanel {...defaultProps} />);
    await waitFor(() => expect(screen.getByTestId("remove-shorts")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("remove-shorts"));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    await waitFor(() => expect(mockRemoveShorts).toHaveBeenCalledWith("d", 1));
    await waitFor(() =>
      expect(screen.getByTestId("shorts-message")).toBeInTheDocument(),
    );
    confirmSpy.mockRestore();
  });

  it("sends nothing when the confirmation is declined", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<SubscriptionDetailPanel {...defaultProps} />);
    await waitFor(() => expect(screen.getByTestId("remove-shorts")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("remove-shorts"));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(mockRemoveShorts).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("reports how many Shorts the worker moved when it finishes", async () => {
    const { rerender } = render(<SubscriptionDetailPanel {...defaultProps} />);
    await waitFor(() => expect(screen.getByTestId("include-shorts")).toBeInTheDocument());

    ws.event = {
      event: "media_import.subscription.sync_completed",
      data: { subscription_id: 1, kind: "purge_shorts", removed: 12 },
    };
    rerender(<SubscriptionDetailPanel {...defaultProps} />);

    await waitFor(() =>
      expect(screen.getByTestId("shorts-message")).toHaveTextContent("12"),
    );
  });
});
