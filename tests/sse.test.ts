import { describe, expect, it } from "vitest";

import { readServerSentEvents } from "../src/translation/sse";

function streamingResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("server-sent event reader", () => {
  it("joins frames split across network chunks and ignores DONE", async () => {
    const events: unknown[] = [];
    await readServerSentEvents(
      "https://example.com/stream",
      { method: "POST" },
      {
        fetch: () =>
          Promise.resolve(
            streamingResponse([
              'data: {"type":"response.output_text.',
              'delta","delta":"甲"}\n\n',
              "data: [DONE]\n\n",
            ]),
          ),
      },
      (event) => events.push(event),
    );

    expect(events).toEqual([
      { type: "response.output_text.delta", delta: "甲" },
    ]);
  });
});
