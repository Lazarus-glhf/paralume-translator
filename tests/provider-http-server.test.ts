// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";

import type { TranslationRequest } from "../src/shared/types";
import { MicrosoftTranslationProvider } from "../src/translation/microsoft";
import { OpenAiTranslationProvider } from "../src/translation/openai";

const request: TranslationRequest = {
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  segments: [
    { id: "segment-a", text: "First local server segment." },
    { id: "segment-b", text: "Second local server segment." },
  ],
};

interface CapturedRequest {
  body: unknown;
  headers: IncomingMessage["headers"];
  pathname: string;
}

const captured: CapturedRequest[] = [];
let server: Server;
let origin: string;

async function readJson(requestMessage: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of requestMessage) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

beforeAll(async () => {
  const handleRequest = async (
    requestMessage: IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => {
    const url = new URL(
      requestMessage.url ?? "/",
      `http://${requestMessage.headers.host ?? "127.0.0.1"}`,
    );
    const body = await readJson(requestMessage);
    captured.push({
      body,
      headers: requestMessage.headers,
      pathname: url.pathname,
    });

    if (url.pathname === "/slow/responses") {
      setTimeout(() => {
        if (!response.writableEnded) {
          sendJson(response, 200, { output_text: "{}" });
        }
      }, 100);
      return;
    }
    if (url.pathname === "/rate-limited/responses") {
      sendJson(response, 429, {
        error: { message: "ignored upstream detail" },
      });
      return;
    }
    if (url.pathname === "/malformed/responses") {
      sendJson(response, 200, { output_text: "not-json" });
      return;
    }
    if (url.pathname === "/partial/translate") {
      sendJson(response, 200, [
        { translations: [{ text: "只有一个结果", to: "zh-Hans" }] },
      ]);
      return;
    }
    if (url.pathname === "/v1/responses") {
      sendJson(response, 200, {
        output_text: JSON.stringify({
          translations: [
            { id: "segment-b", translatedText: "本地乙" },
            { id: "segment-a", translatedText: "本地甲" },
          ],
        }),
      });
      return;
    }
    if (url.pathname === "/v1/chat/completions") {
      sendJson(response, 200, {
        choices: [
          {
            message: {
              content: JSON.stringify({
                translations: [
                  { id: "segment-a", translatedText: "聊天甲" },
                  { id: "segment-b", translatedText: "聊天乙" },
                ],
              }),
            },
          },
        ],
      });
      return;
    }
    if (url.pathname === "/azure/translate") {
      sendJson(response, 200, [
        { translations: [{ text: "微软甲", to: "zh-Hans" }] },
        { translations: [{ text: "微软乙", to: "zh-Hans" }] },
      ]);
      return;
    }
    sendJson(response, 404, {});
  };
  server = createServer((requestMessage, response) => {
    void handleRequest(requestMessage, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The deterministic provider server did not bind a port.");
  }
  origin = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
});

describe("deterministic provider HTTP server", () => {
  it.each([
    ["responses", "/v1/responses"],
    ["chat-completions", "/v1/chat/completions"],
  ] as const)("exercises OpenAI %s over HTTP", async (protocol, pathname) => {
    const provider = new OpenAiTranslationProvider({
      apiKey: "local-openai-test-key",
      baseUrl: `${origin}/v1`,
      model: "local-model",
      protocol,
      reasoningEffort: "low",
    });

    await expect(provider.translate(request)).resolves.toHaveLength(2);
    const call = captured.findLast((item) => item.pathname === pathname);
    expect(call?.headers.authorization).toBe("Bearer local-openai-test-key");
    expect(call?.body).toMatchObject({ model: "local-model" });
  });

  it("exercises Microsoft v3 auth, region, and checked batch mapping over HTTP", async () => {
    const provider = new MicrosoftTranslationProvider({
      apiKey: "local-microsoft-test-key",
      endpoint: `${origin}/azure`,
      region: "eastasia",
    });

    await expect(provider.translate(request)).resolves.toEqual([
      { id: "segment-a", status: "success", translatedText: "微软甲" },
      { id: "segment-b", status: "success", translatedText: "微软乙" },
    ]);
    const call = captured.findLast(
      (item) => item.pathname === "/azure/translate",
    );
    expect(call?.headers["ocp-apim-subscription-key"]).toBe(
      "local-microsoft-test-key",
    );
    expect(call?.headers["ocp-apim-subscription-region"]).toBe("eastasia");
  });

  it("covers malformed output, rate limits, timeouts, and partial results", async () => {
    const openai = (path: string, timeoutMs = 30_000) =>
      new OpenAiTranslationProvider(
        {
          apiKey: "local-test-key",
          baseUrl: `${origin}/${path}`,
          model: "local-model",
          protocol: "responses",
          reasoningEffort: "low",
        },
        { timeoutMs },
      );

    await expect(openai("malformed").translate(request)).rejects.toMatchObject({
      code: "MALFORMED_PROVIDER_OUTPUT",
    });
    await expect(
      openai("rate-limited").translate(request),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(openai("slow", 10).translate(request)).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
    });

    const microsoft = new MicrosoftTranslationProvider({
      apiKey: "local-test-key",
      endpoint: `${origin}/partial`,
      region: "global",
    });
    await expect(microsoft.translate(request)).rejects.toMatchObject({
      code: "MALFORMED_PROVIDER_OUTPUT",
    });
  });
});
