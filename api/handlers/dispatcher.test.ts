import { describe, it, expect, vi } from "vitest";
import { registerHandlerDispatcher } from "./dispatcher.js";
import type { Handler } from "./types.js";

describe("registerHandlerDispatcher", () => {
  it("does not register webhook listeners for an empty event map", () => {
    const probotApp = {
      on: vi.fn(),
    };

    registerHandlerDispatcher(probotApp as never, { eventMap: {} });

    expect(probotApp.on).not.toHaveBeenCalled();
  });

  it("runs handlers sequentially with shared per-event context", async () => {
    const invocations: string[] = [];
    const handlerOne: Handler = {
      name: "one",
      handle: vi.fn(async () => {
        invocations.push("one");
      }),
    };
    const handlerTwo: Handler = {
      name: "two",
      handle: vi.fn(async () => {
        invocations.push("two");
      }),
    };

    let eventCallback: ((context: unknown) => Promise<void>) | undefined;
    const probotApp = {
      on: vi.fn((event: string, callback: (context: unknown) => Promise<void>) => {
        expect(event).toBe("issues.opened");
        eventCallback = callback;
      }),
    };

    const sharedContext = { test: true };
    const createContext = vi.fn(async () => sharedContext);

    registerHandlerDispatcher(probotApp as never, {
      eventMap: { "issues.opened": [handlerOne, handlerTwo] },
      createContext,
    });

    await eventCallback?.({ payload: { issue: { number: 1 } } });

    expect(createContext).toHaveBeenCalledTimes(1);
    expect(handlerOne.handle).toHaveBeenCalledTimes(1);
    expect(handlerTwo.handle).toHaveBeenCalledTimes(1);
    expect(invocations).toEqual(["one", "two"]);

    const firstCall = vi.mocked(handlerOne.handle).mock.calls[0];
    expect(firstCall[0].name).toBe("issues.opened");
    expect(firstCall[1]).toBe(sharedContext);
  });
});
