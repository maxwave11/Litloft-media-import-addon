import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook } from "@testing-library/react";

const { loadMissingComments } = vi.hoisted(() => ({ loadMissingComments: vi.fn() }));

vi.mock("@/addons/media_import/api", () => ({ loadMissingComments }));

import LoadCommentsAction from "@/addons/media_import/LoadCommentsAction";
import { resetSelectionActions, useSelectionActions } from "@/lib/selectionActions";
import type { FileItem } from "@/types";

const file = (id: string, filename = `${id}.loft`) => ({ id, filename }) as FileItem;

function mount(files: FileItem[]) {
  const view = render(<LoadCommentsAction drive="d" files={files} />);
  const { result } = renderHook(() => useSelectionActions());
  return {
    action: () => result.current[0],
    rerender: (next: FileItem[]) => view.rerender(<LoadCommentsAction drive="d" files={next} />),
  };
}

async function press(action: () => { run: () => void }) {
  await act(async () => {
    action().run();
  });
}

beforeEach(() => {
  loadMissingComments.mockReset();
});

afterEach(() => {
  cleanup();
  act(() => resetSelectionActions());
});

describe("LoadCommentsAction", () => {
  it("is offered at once, ready, and asks nothing until pressed", () => {
    const { action } = mount([file("a")]);

    expect(action()).toMatchObject({
      id: "media_import.comments-load",
      label: "Load comments",
      disabled: false,
    });
    expect(loadMissingComments).not.toHaveBeenCalled();
  });

  it("asks once with the selected .loft files only, and says how many started", async () => {
    loadMissingComments.mockResolvedValue({ queued: 2, skipped: 1 });
    const { action } = mount([file("a"), file("b", "clip.MP4"), file("c", "C.LOFT"), file("d")]);

    await press(action);

    expect(loadMissingComments).toHaveBeenCalledTimes(1);
    expect(loadMissingComments).toHaveBeenCalledWith(["a", "c", "d"], "d");
    expect(action()).toMatchObject({ label: "Loading started (2)", disabled: true });
  });

  it("says there is nothing to load when the server queued none", async () => {
    loadMissingComments.mockResolvedValue({ queued: 0, skipped: 2 });
    const { action } = mount([file("a"), file("b")]);

    await press(action);

    expect(action()).toMatchObject({ label: "Nothing to load", disabled: true });
  });

  it("says so without a request when the selection holds no .loft", async () => {
    const { action } = mount([file("a", "clip.mp4")]);

    await press(action);

    expect(loadMissingComments).not.toHaveBeenCalled();
    expect(action()).toMatchObject({ label: "Nothing to load", disabled: true });
  });

  it("stays pressable after a failure, and asks again", async () => {
    loadMissingComments.mockRejectedValueOnce(new Error("HTTP 500"));
    loadMissingComments.mockResolvedValueOnce({ queued: 1, skipped: 0 });
    const { action } = mount([file("a")]);

    await press(action);
    expect(action()).toMatchObject({ label: "Couldn't start", disabled: false });

    await press(action);
    expect(loadMissingComments).toHaveBeenCalledTimes(2);
    expect(action()).toMatchObject({ label: "Loading started (1)", disabled: true });
  });

  it("is disabled while the request is in flight", async () => {
    let finish: (v: { queued: number; skipped: number }) => void = () => {};
    loadMissingComments.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { action } = mount([file("a")]);

    await press(action);
    expect(action().disabled).toBe(true);

    await act(async () => finish({ queued: 1, skipped: 0 }));
    expect(action().label).toBe("Loading started (1)");
  });

  it("returns to ready when the selection changes", async () => {
    loadMissingComments.mockResolvedValue({ queued: 1, skipped: 0 });
    const { action, rerender } = mount([file("a")]);
    await press(action);
    expect(action().disabled).toBe(true);

    rerender([file("a"), file("b")]);

    expect(action()).toMatchObject({ label: "Load comments", disabled: false });
  });

  it("drops the answer to a request the selection has moved on from", async () => {
    let finish: (v: { queued: number; skipped: number }) => void = () => {};
    loadMissingComments.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { action, rerender } = mount([file("a")]);
    await press(action);

    rerender([file("b")]);
    await act(async () => finish({ queued: 1, skipped: 0 }));

    expect(action()).toMatchObject({ label: "Load comments", disabled: false });
  });

  it("does not report a failure to a selection that was never pressed", async () => {
    let fail: (reason: Error) => void = () => {};
    loadMissingComments.mockImplementation(
      () => new Promise((_resolve, reject) => { fail = reject; }),
    );
    const { action, rerender } = mount([file("a")]);
    await press(action);

    rerender([file("b")]);
    await act(async () => {
      fail(new Error("HTTP 500"));
    });

    expect(action()).toMatchObject({ label: "Load comments", disabled: false });
  });

  it("splits a large selection into requests of at most 1000 and adds the answers", async () => {
    loadMissingComments.mockResolvedValueOnce({ queued: 900, skipped: 100 });
    loadMissingComments.mockResolvedValueOnce({ queued: 50, skipped: 0 });
    const files = Array.from({ length: 1050 }, (_, i) => file(`f${i}`));
    const { action } = mount(files);

    await press(action);

    expect(loadMissingComments.mock.calls.map(([ids]) => ids.length)).toEqual([1000, 50]);
    expect(action().label).toBe("Loading started (950)");
  });
});
