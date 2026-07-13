import { afterEach, describe, expect, it, vi } from "vitest";

import { installContentRuntime } from "../src/content/runtime";
import { createContentCommand } from "../src/messaging/protocol";

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      resolvePromise?.(value);
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("programmatically injected content runtime", () => {
  it("installs one listener across repeated injection and routes translation to background", async () => {
    document.body.innerHTML = `<p>Readable paragraph for injected runtime.</p>`;
    const listeners: ((message: unknown) => Promise<unknown>)[] = [];
    const requestedIds: string[] = [];
    const translationOperationIds: string[] = [];
    const cancelledOperationIds: string[] = [];
    let settingsRequests = 0;
    const sendMessage = vi.fn((message: unknown) => {
      const record = message as {
        target?: string;
        command?: string;
        operationId?: string;
        request?: { segments: { id: string }[] };
      };
      if (record.target === "settings" && record.command === "get-content") {
        settingsRequests += 1;
        return Promise.resolve({
          protocolVersion: 1,
          ok: true,
          contentSettings: {
            retry: { enabled: true, maxRetries: 2 },
            appearance: {
              fontFamily: "serif",
              fontSize: 19,
              textColor: "#112233",
              backgroundColor: "#ddeeff",
              lineHeight: 1.8,
              opacity: 0.9,
              verticalSpacing: 12,
            },
            uiLanguage: "zh-CN",
          },
        });
      }
      if (
        record.target === "background" &&
        record.command === "cancel-translation"
      ) {
        if (record.operationId !== undefined) {
          cancelledOperationIds.push(record.operationId);
        }
        return Promise.resolve({
          protocolVersion: 1,
          ok: true,
          cancelled: true,
        });
      }
      const segment = record.request?.segments[0];
      if (segment !== undefined) {
        requestedIds.push(segment.id);
        if (record.operationId !== undefined) {
          translationOperationIds.push(record.operationId);
        }
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
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const translation = document.querySelector<HTMLElement>("p")
      ?.nextElementSibling as HTMLElement | undefined;
    expect(translation?.textContent).toBe("Injected runtime translation.");
    expect(translation?.style.fontSize).toBe("19px");

    await listener(createContentCommand("clear"));
    await listener(createContentCommand("translate"));
    expect(requestedIds).toHaveLength(2);
    expect(requestedIds[1]).toBe(requestedIds[0]);
    expect(translationOperationIds).toHaveLength(2);
    expect(translationOperationIds[1]).not.toBe(translationOperationIds[0]);
    expect(
      translationOperationIds.every((operationId) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          operationId,
        ),
      ),
    ).toBe(true);
    expect(cancelledOperationIds).toEqual([]);
    expect(settingsRequests).toBe(2);
    expect(sendMessage).toHaveBeenCalledWith({
      protocolVersion: 1,
      target: "settings",
      command: "get-content",
    });
  });

  it("sends cancel immediately for the exact active operation and ignores its late response", async () => {
    document.body.innerHTML = `<p>Readable paragraph for runtime cancellation.</p>`;
    const translationResponse = deferred<unknown>();
    const listeners: ((message: unknown) => Promise<unknown>)[] = [];
    let activeOperationId: string | undefined;
    const sendMessage = vi.fn((message: unknown) => {
      const record = message as {
        target?: string;
        command?: string;
        operationId?: string;
        request?: { segments: { id: string }[] };
      };
      if (record.target === "settings") {
        return Promise.resolve({
          protocolVersion: 1,
          ok: true,
          contentSettings: {
            retry: { enabled: true, maxRetries: 2 },
            appearance: {
              fontFamily: "system",
              fontSize: 16,
              textColor: "#1f2937",
              backgroundColor: "#f3f7f5",
              lineHeight: 1.6,
              opacity: 1,
              verticalSpacing: 8,
            },
            uiLanguage: "en",
          },
        });
      }
      if (record.command === "translate") {
        activeOperationId = record.operationId;
        return translationResponse.promise;
      }
      if (record.command === "cancel-translation") {
        expect(record.operationId).toBe(activeOperationId);
        return Promise.resolve({
          protocolVersion: 1,
          ok: true,
          cancelled: true,
        });
      }
      throw new Error("Unexpected runtime message.");
    });
    const runtime = {
      onMessage: {
        addListener(listener: (message: unknown) => Promise<unknown>) {
          listeners.push(listener);
        },
      },
      sendMessage,
    };
    installContentRuntime({ document, globalObject: {}, runtime });
    const listener = listeners[0];
    if (listener === undefined) {
      throw new Error("The runtime listener was not installed.");
    }

    const translating = listener(createContentCommand("translate"));
    await vi.waitFor(() => {
      expect(activeOperationId).toBeDefined();
    });
    const clearing = listener(createContentCommand("clear"));

    await expect(clearing).resolves.toMatchObject({
      ok: true,
      state: { translationCount: 0 },
    });
    expect(sendMessage).toHaveBeenCalledWith({
      protocolVersion: 1,
      target: "background",
      command: "cancel-translation",
      operationId: activeOperationId,
    });
    const requestMessage = sendMessage.mock.calls.find(
      ([message]) => (message as { command?: string }).command === "translate",
    )?.[0] as { request?: { segments?: { id: string }[] } } | undefined;
    const segmentId = requestMessage?.request?.segments?.[0]?.id;
    if (segmentId === undefined) {
      throw new Error("The translation request was not captured.");
    }
    translationResponse.resolve({
      protocolVersion: 1,
      ok: true,
      results: [
        {
          id: segmentId,
          status: "success",
          translatedText: "Must not render",
        },
      ],
    });
    await translating;
    expect(document.body.textContent).not.toContain("Must not render");
  });
});
