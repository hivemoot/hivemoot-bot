import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StandupData } from "./standup.js";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

vi.mock("./llm/provider.js", () => ({
  createModelFromEnv: vi.fn(),
}));

describe("generateStandupLLMContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes JSON repair hook to generateObject", async () => {
    const { generateObject } = await import("ai");
    const { createModelFromEnv } = await import("./llm/provider.js");
    const { generateStandupLLMContent } = await import("./standup.js");

    vi.mocked(createModelFromEnv).mockReturnValue({
      model: {} as never,
      config: {
        provider: "google",
        model: "gemini-3-flash-preview",
        maxTokens: 500,
      },
    });
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        narrative: "Colony progressed with one implementation and no blockers.",
        keyUpdates: ["Implementation PR #10 advanced through review."],
        queensTake: {
          wentWell: "Review turnaround was quick.",
          focusAreas: "Move one proposal from voting to implementation.",
          needsAttention: "No urgent risks detected.",
        },
      },
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 50 },
      rawResponse: undefined,
      response: undefined,
      warnings: undefined,
      experimental_providerMetadata: undefined,
      toJsonResponse: () => new Response(),
    } as never);

    const data: StandupData = {
      discussionPhase: [],
      votingPhase: [],
      extendedVoting: [],
      readyToImplement: [{ number: 1, title: "Feature A" }],
      implementationPRs: [{ number: 10, title: "PR #10", author: "agent" }],
      repoFullName: "hivemoot/colony",
      reportDate: "2026-02-06",
      dayNumber: 42,
    };

    const result = await generateStandupLLMContent(data);

    expect(result).not.toBeNull();
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        experimental_repairText: expect.any(Function),
      })
    );
  });

  it("logs when repair hook successfully repairs malformed JSON", async () => {
    const { generateObject } = await import("ai");
    const { createModelFromEnv } = await import("./llm/provider.js");
    const { generateStandupLLMContent } = await import("./standup.js");

    vi.mocked(createModelFromEnv).mockReturnValue({
      model: {} as never,
      config: {
        provider: "google",
        model: "gemini-3-flash-preview",
        maxTokens: 500,
      },
    });
    vi.mocked(generateObject).mockResolvedValue({
      object: {
        narrative: "Colony progressed.",
        keyUpdates: ["PR #10 advanced."],
        queensTake: {
          wentWell: "Quick turnaround.",
          focusAreas: "Move proposal forward.",
          needsAttention: "No risks.",
        },
      },
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 50 },
      rawResponse: undefined,
      response: undefined,
      warnings: undefined,
      experimental_providerMetadata: undefined,
      toJsonResponse: () => new Response(),
    } as never);

    const data: StandupData = {
      discussionPhase: [],
      votingPhase: [],
      extendedVoting: [],
      readyToImplement: [{ number: 1, title: "Feature A" }],
      implementationPRs: [{ number: 10, title: "PR #10", author: "agent" }],
      repoFullName: "hivemoot/colony",
      reportDate: "2026-02-06",
      dayNumber: 42,
    };

    await generateStandupLLMContent(data);

    const callArgs = vi.mocked(generateObject).mock.calls[0][0] as Record<string, unknown>;
    const repairFn = callArgs.experimental_repairText as (args: { text: string; error: { message: string } }) => Promise<string | null>;

    const repaired = await repairFn({
      text: "```json\n{\"narrative\":\"Test\"}\n```",
      error: { message: "JSON parsing failed" },
    });
    expect(repaired).toBe("{\"narrative\":\"Test\"}");
  });
});
