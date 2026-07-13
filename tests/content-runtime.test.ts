import { afterEach, describe, expect, it, vi } from "vitest";

import { installContentRuntime } from "../src/content/runtime";
import { createContentCommand } from "../src/messaging/protocol";

afterEach(() => {
  document.body.replaceChildren();
});

describe("programmatically injected content runtime", () => {
  it("installs one listener across repeated injection and routes translation to background", async () => {
    document.body.innerHTML = `<p>Readable paragraph for injected runtime.</p>`;
    const listeners: ((message: unknown) => Promise<unknown>)[] = [];
    const requestedIds: string[] = [];
    const sendMessage = vi.fn((message: unknown) => {
      const record = message as {
        request: { segments: { id: string }[] };
      };
      const segment = record.request.segments[0];
      if (segment !== undefined) {
        requestedIds.push(segment.id);
      }
      return Promise.resolve({
        protocolVersion: 1,
        ok: true,
        results:
          segment === undefined
            ? []
            : [
                {
                  id: segment.id,
                  status: "success",
                  translatedText: "Injected runtime translation.",
                },
              ],
      });
    });
    const runtime = {
      onMessage: {
        addListener: vi.fn(
          (listener: (message: unknown) => Promise<unknown>) => {
            listeners.push(listener);
          },
        ),
      },
      sendMessage,
    };
    const globalObject: Record<string, unknown> = {};

    expect(installContentRuntime({ document, globalObject, runtime })).toBe(
      true,
    );
    expect(installContentRuntime({ document, globalObject, runtime })).toBe(
      false,
    );
    expect(runtime.onMessage.addListener).toHaveBeenCalledOnce();

    const listener = listeners[0];
    if (listener === undefined) {
      throw new Error("The runtime listener was not installed.");
    }

    await expect(
      listener(createContentCommand("translate")),
    ).resolves.toMatchObject({
      ok: true,
      state: { translationCount: 1 },
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(document.querySelector("p")?.nextElementSibling?.textContent).toBe(
      "Injected runtime translation.",
    );

    await listener(createContentCommand("clear"));
    await listener(createContentCommand("translate"));
    expect(requestedIds).toHaveLength(2);
    expect(requestedIds[1]).toBe(requestedIds[0]);
  });
});
