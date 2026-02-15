import { describe, expect, it } from "vitest";

import { extractLikelyJsonPayload, repairMalformedJsonText } from "./json-repair.js";

describe("extractLikelyJsonPayload", () => {
  it("extracts JSON from fenced blocks", () => {
    const text = "```json\n{\"sentiment\":\"positive\"}\n```";
    expect(extractLikelyJsonPayload(text)).toBe("{\"sentiment\":\"positive\"}");
  });

  it("extracts fenced JSON when prefixed with noise", () => {
    const text = "ny\n```json\n{\"ok\":true}\n```";
    expect(extractLikelyJsonPayload(text)).toBe("{\"ok\":true}");
  });

  it("extracts payload from first JSON token when prose is prepended", () => {
    const text = "My immediate task is to respond.\n{\"color\":\"blue\"}";
    expect(extractLikelyJsonPayload(text)).toBe("{\"color\":\"blue\"}");
  });

  it("returns null when no repair candidate exists", () => {
    expect(extractLikelyJsonPayload("plain text without json")).toBeNull();
  });

  it("returns null for already-plain JSON (no repair needed)", () => {
    expect(extractLikelyJsonPayload("{\"already\":\"json\"}")).toBeNull();
  });
});

describe("repairMalformedJsonText", () => {
  it("returns repaired payload when recoverable", async () => {
    const repaired = await repairMalformedJsonText({
      text: "```json\n{\"value\":1}\n```",
      error: {} as never,
    });
    expect(repaired).toBe("{\"value\":1}");
  });

  it("returns null when text should not be modified", async () => {
    const repaired = await repairMalformedJsonText({
      text: "{\"already\":\"json\"}",
      error: {} as never,
    });
    expect(repaired).toBeNull();
  });
});

