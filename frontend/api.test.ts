import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLoft, getLoftMetadata, refreshLoft } from "@/addons/media_import/api";

const fetchSpy = vi.fn(
  async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response("{}", { status: 200 }),
);

beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function sentHeaders(): Record<string, string> {
  return fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
}

describe("loft link calls carry the drive scope", () => {
  it("getLoftMetadata sends the percent-encoded drive", async () => {
    await getLoftMetadata("f1", "動画");

    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      "/api/addons/media_import/link/f1/metadata",
    );
    expect(sentHeaders()).toEqual({ "X-Lit-Drive": "%E5%8B%95%E7%94%BB" });
  });

  it("refreshLoft sends the percent-encoded drive", async () => {
    await refreshLoft("f1", "動画");

    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      "/api/addons/media_import/link/f1/refresh",
    );
    expect(fetchSpy.mock.calls[0][1]?.method).toBe("POST");
    expect(sentHeaders()).toEqual({ "X-Lit-Drive": "%E5%8B%95%E7%94%BB" });
  });
});

describe("refreshLoft", () => {
  it("rejects when the refresh is refused", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 404 }));

    await expect(refreshLoft("f1", "d")).rejects.toThrow();
  });
});

describe("createLoft error message", () => {
  it.each([
    ["JSON detail", new Response('{"detail":"Failed to create link"}', { status: 500, statusText: "Internal Server Error" }), "HTTP 500 Internal Server Error: Failed to create link"],
    ["validation list", new Response('{"detail":[{"loc":["body","drive"]}]}', { status: 422 }), 'HTTP 422: [{"loc":["body","drive"]}]'],
    ["plain-text body", new Response("Internal Server Error", { status: 500 }), "HTTP 500: Internal Server Error"],
    ["empty body", new Response("", { status: 502 }), "HTTP 502"],
  ])("keeps the status and body for %s", async (_name, res, message) => {
    fetchSpy.mockResolvedValueOnce(res);

    await expect(createLoft("https://example.com/v", "d", "")).rejects.toThrow(message);
  });
});
