import {
  expect,
  test,
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { triggerActionPopup, waitForDevToolsEndpoint } from "./action-popup";

const extensionPath = resolve(".output/chrome-mv3");
const fixturePath = resolve("e2e/fixtures/static-article.html");
const fixtureUrl = "http://127.0.0.1:4173/static-article.html";
const translationSelector =
  '[data-paralume-owned="true"][data-paralume-translation-for]';
const paralumeMarkerSelector = [
  "[data-paralume-source-id]",
  "[data-paralume-owned]",
  "[data-paralume-translation-for]",
  "[data-paralume-translation-status]",
].join(", ");

interface ChromiumExtensionApi {
  tabs: {
    getCurrent(): Promise<{ id?: number }>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
}

async function getGrantedOrigins(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const extensionApi = (
      globalThis as unknown as {
        chrome: {
          permissions: { getAll(): Promise<{ origins?: string[] }> };
        };
      }
    ).chrome;
    return (await extensionApi.permissions.getAll()).origins ?? [];
  });
}

async function acceptExtensionHostPermission(
  context: BrowserContext,
  extensionId: string,
  origin: string,
): Promise<void> {
  const permissionsPage = await context.newPage();
  try {
    await permissionsPage.goto("chrome://extensions/");
    await permissionsPage.evaluate(
      async ({ extensionId, origin }) => {
        const extensionApi = (
          globalThis as unknown as {
            chrome: {
              developerPrivate: {
                addHostPermission(
                  targetExtensionId: string,
                  host: string,
                ): Promise<void>;
              };
            };
          }
        ).chrome;
        await extensionApi.developerPrivate.addHostPermission(
          extensionId,
          origin,
        );
      },
      { extensionId, origin },
    );
  } finally {
    await permissionsPage.close();
  }
}

async function instrumentOptionsPermissionCalls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const extensionApi = (
      globalThis as unknown as {
        chrome: {
          permissions: {
            contains(permission: { origins: string[] }): Promise<boolean>;
            request(permission: { origins: string[] }): Promise<boolean>;
          };
        };
        __paralumePermissionCalls?: {
          contains: string[][];
          request: string[][];
        };
      }
    ).chrome;
    const callState = { contains: [] as string[][], request: [] as string[][] };
    Reflect.set(globalThis, "__paralumePermissionCalls", callState);
    const originalContains = extensionApi.permissions.contains.bind(
      extensionApi.permissions,
    );
    const originalRequest = extensionApi.permissions.request.bind(
      extensionApi.permissions,
    );
    extensionApi.permissions.contains = (permission) => {
      callState.contains.push([...permission.origins]);
      return originalContains(permission);
    };
    extensionApi.permissions.request = (permission) => {
      callState.request.push([...permission.origins]);
      return originalRequest(permission);
    };
  });
}

async function getOptionsPermissionCalls(page: Page): Promise<{
  contains: string[][];
  request: string[][];
}> {
  return page.evaluate(() => {
    const callState = (
      globalThis as unknown as {
        __paralumePermissionCalls?: {
          contains: string[][];
          request: string[][];
        };
      }
    ).__paralumePermissionCalls;
    return callState ?? { contains: [], request: [] };
  });
}

async function clickPopupAction(
  popupPage: Page,
  activePage: Page,
  action: "translate" | "toggle" | "clear",
): Promise<void> {
  await activePage.bringToFront();
  await popupPage
    .locator(`[data-action="${action}"]`)
    .evaluate((button: HTMLButtonElement) => {
      button.click();
    });
}

async function runRuntimeCommand(
  popupPage: Page,
  targetTabId: number,
  command: "translate" | "toggle" | "clear",
): Promise<{
  ok: boolean;
  message?: string;
  state?: { translationCount: number; failureCount: number; visible: boolean };
}> {
  return popupPage.evaluate(
    ({ command, targetTabId }) => {
      const extensionApi = (
        globalThis as unknown as { chrome: ChromiumExtensionApi }
      ).chrome;
      return extensionApi.tabs.sendMessage(targetTabId, {
        protocolVersion: 1,
        target: "content",
        command,
      });
    },
    { command, targetTabId },
  ) as Promise<{
    ok: boolean;
    message?: string;
    state?: {
      translationCount: number;
      failureCount: number;
      visible: boolean;
    };
  }>;
}

test("local fixture server exposes the deterministic article", async ({
  request,
}) => {
  const response = await request.get(fixtureUrl);
  const html = await response.text();

  expect(response.ok()).toBe(true);
  expect(html).toContain('id="linked-paragraph"');
  expect(html).toContain('id="preformatted-code"');
  expect(html).toContain('id="table-row-two-detail"');
  expect(html).toContain('contenteditable="true"');
  expect(html).toMatch(/&lt;img\s+id="mock-output-node"/u);
});

test("generated Chrome manifest keeps provider origins optional and runtime-granted", async () => {
  const manifest = JSON.parse(
    await readFile(join(extensionPath, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;

  expect(manifest["permissions"]).toEqual([
    "activeTab",
    "scripting",
    "storage",
  ]);
  expect(manifest["optional_host_permissions"]).toEqual(["https://*/*"]);
  expect(Object.hasOwn(manifest, "host_permissions")).toBe(false);
  expect(Object.hasOwn(manifest, "content_scripts")).toBe(false);
});

test.describe("unpacked Chromium extension", () => {
  test.describe.configure({ mode: "serial" });

  let context: BrowserContext | undefined;
  let cdpBrowser: Browser;
  let browserCdp: CDPSession | undefined;
  let extensionId: string;
  let popupPage: Page;
  let userDataDir: string;

  test.beforeAll(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), "paralume-playwright-"));
    const launchedContext = await chromium.launchPersistentContext(
      userDataDir,
      {
        channel: "chromium",
        headless: true,
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
          "--remote-debugging-port=0",
        ],
      },
    );

    context = launchedContext;
    cdpBrowser = await chromium.connectOverCDP(
      await waitForDevToolsEndpoint(userDataDir),
    );
    browserCdp = await cdpBrowser.newBrowserCDPSession();

    let [serviceWorker] = launchedContext.serviceWorkers();
    serviceWorker ??= await launchedContext.waitForEvent("serviceworker");
    extensionId = new URL(serviceWorker.url()).host;

    popupPage = await launchedContext.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(
      popupPage.getByRole("heading", { name: "Paralume" }),
    ).toBeVisible();
  });

  test.afterAll(async () => {
    await browserCdp?.detach();
    await context?.close();
    await rm(userDataDir, { force: true, recursive: true });
  });

  test("action popup drives the foreground HTTP article through activeTab and scripting", async () => {
    if (context === undefined || browserCdp === undefined) {
      throw new Error("The extension browser context was not initialized.");
    }

    const articlePage = await context.newPage();
    await articlePage.goto(fixtureUrl);
    await articlePage.bringToFront();

    const expectedSourceCount = await articlePage
      .locator("[data-expect-translation]")
      .count();
    expect(expectedSourceCount).toBeGreaterThan(0);

    const actionPopup = await triggerActionPopup(
      context,
      browserCdp,
      extensionId,
      articlePage,
    );
    try {
      expect(await actionPopup.activeTabUrl()).toBe(fixtureUrl);

      await actionPopup.click("translate");
      await actionPopup.waitForStatus(
        `Translated ${String(expectedSourceCount)} readable blocks.`,
      );
      await expect(articlePage.locator(translationSelector)).toHaveCount(
        expectedSourceCount,
      );

      await actionPopup.click("translate");
      await actionPopup.waitForStatus("Translations are already up to date.");
      await expect(articlePage.locator(translationSelector)).toHaveCount(
        expectedSourceCount,
      );

      await actionPopup.click("toggle");
      await actionPopup.waitForStatus("Translations hidden.");
      expect(
        await articlePage
          .locator(translationSelector)
          .evaluateAll((translations) =>
            translations.every(
              (translation) => (translation as HTMLElement).hidden,
            ),
          ),
      ).toBe(true);

      await actionPopup.click("toggle");
      await actionPopup.waitForStatus("Translations shown.");
      expect(
        await articlePage
          .locator(translationSelector)
          .evaluateAll((translations) =>
            translations.every(
              (translation) => !(translation as HTMLElement).hidden,
            ),
          ),
      ).toBe(true);

      await actionPopup.click("clear");
      await actionPopup.waitForStatus(
        `Cleared ${String(expectedSourceCount)} translations.`,
      );
      await expect(articlePage.locator(translationSelector)).toHaveCount(0);
      await expect(articlePage.locator(paralumeMarkerSelector)).toHaveCount(0);
    } finally {
      await actionPopup.close();
    }

    await articlePage.close();
  });

  test("lower-level content-runtime integration covers safe interleaving without exercising activeTab", async () => {
    if (context === undefined) {
      throw new Error("The extension browser context was not initialized.");
    }

    const articlePage = await context.newPage();
    await articlePage.goto(`chrome-extension://${extensionId}/options.html`);
    const fixtureHtml = (await readFile(fixturePath, "utf8")).replace(
      /<script>[\s\S]*?<\/script>/u,
      "",
    );
    await articlePage.setContent(fixtureHtml);
    await articlePage.evaluate(() => {
      const fixtureLink = document.querySelector("#inline-link");
      if (!(fixtureLink instanceof HTMLAnchorElement)) {
        throw new Error("The fixture link was not created.");
      }
      Reflect.set(window, "fixtureOriginalLink", fixtureLink);
      Reflect.set(window, "fixtureLinkClicks", 0);
      fixtureLink.addEventListener("click", (event) => {
        event.preventDefault();
        const clicks = Number(Reflect.get(window, "fixtureLinkClicks"));
        Reflect.set(window, "fixtureLinkClicks", clicks + 1);
      });
      const displayNone =
        document.querySelector<HTMLElement>("#display-none-copy");
      if (displayNone !== null) {
        displayNone.style.display = "none";
      }
    });
    await articlePage.addScriptTag({
      url: `chrome-extension://${extensionId}/paralume.js`,
    });
    await articlePage.addScriptTag({
      url: `chrome-extension://${extensionId}/paralume.js`,
    });
    const articleTabId = await articlePage.evaluate(async () => {
      const extensionApi = (
        globalThis as unknown as { chrome: ChromiumExtensionApi }
      ).chrome;
      return (await extensionApi.tabs.getCurrent()).id;
    });
    if (articleTabId === undefined) {
      throw new Error("The extension fixture tab ID was not available.");
    }

    const initialBody = await articlePage
      .locator("body")
      .evaluate((body) => body.innerHTML);
    const expectedSourceCount = await articlePage
      .locator("[data-expect-translation]")
      .count();
    const sourceSnapshots = await articlePage
      .locator("[data-expect-translation]")
      .evaluateAll((sources) =>
        sources.map((source) => ({
          childElementCount: source.childElementCount,
          structural: ["LI", "TD", "TH"].includes(source.tagName),
          text: (source as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
        })),
      );
    const listItemCount = await articlePage.locator("ul > li").count();
    const tableCellCount = await articlePage
      .locator("tr > th, tr > td")
      .count();
    expect(expectedSourceCount).toBeGreaterThan(0);

    const translated = await runRuntimeCommand(
      popupPage,
      articleTabId,
      "translate",
    );
    expect(translated).toMatchObject({
      ok: true,
      message: `Translated ${String(expectedSourceCount)} readable blocks.`,
      state: { translationCount: expectedSourceCount, visible: true },
    });

    await expect(articlePage.locator(translationSelector)).toHaveCount(
      expectedSourceCount,
    );
    const interleaved = await articlePage
      .locator("[data-expect-translation]")
      .evaluateAll((sources) =>
        sources.map((source) => {
          const sourceId = source.getAttribute("data-paralume-source-id");
          const structural = ["LI", "TD", "TH"].includes(source.tagName);
          const translation = structural
            ? source.lastElementChild
            : source.nextElementSibling;
          const matchingTranslations = Array.from(
            document.querySelectorAll(
              '[data-paralume-owned="true"][data-paralume-translation-for]',
            ),
          ).filter(
            (candidate) =>
              candidate.getAttribute("data-paralume-translation-for") ===
              sourceId,
          );

          return {
            sourceId,
            childElementCount: source.childElementCount,
            matchingCount: matchingTranslations.length,
            isInternalLastChild:
              translation !== null &&
              translation.parentElement === source &&
              source.lastElementChild === translation,
            isImmediateSibling:
              translation !== null &&
              translation.previousElementSibling === source &&
              translation.getAttribute("data-paralume-owned") === "true" &&
              translation.getAttribute("data-paralume-translation-for") ===
                sourceId,
            output: translation?.textContent,
            structural,
          };
        }),
      );

    for (const [index, result] of interleaved.entries()) {
      const snapshot = sourceSnapshots[index];
      if (snapshot === undefined) {
        throw new Error("Source snapshot was not captured.");
      }
      expect(result.sourceId).toBeTruthy();
      expect(result.matchingCount).toBe(1);
      expect(result.structural).toBe(snapshot.structural);
      if (result.structural) {
        expect(result.isInternalLastChild).toBe(true);
        expect(result.childElementCount).toBe(snapshot.childElementCount + 1);
      } else {
        expect(result.isImmediateSibling).toBe(true);
        expect(result.childElementCount).toBe(snapshot.childElementCount);
      }
      expect(result.output).toBe(`【Mock zh-CN】${snapshot.text}`);
    }
    await expect(articlePage.locator("ul > li")).toHaveCount(listItemCount);
    await expect(articlePage.locator("tr > th, tr > td")).toHaveCount(
      tableCellCount,
    );

    const htmlLookingTranslation = articlePage.locator(
      `#html-looking + ${translationSelector}`,
    );
    await expect(htmlLookingTranslation).toContainText(
      '<img id="mock-output-node" src="x"',
    );
    await expect(
      htmlLookingTranslation.locator("#mock-output-node"),
    ).toHaveCount(0);
    await expect(articlePage.locator("body")).not.toHaveAttribute(
      "data-compromised",
      "true",
    );

    await expect(articlePage.locator("#linked-paragraph")).toHaveAttribute(
      "data-page-marker",
      "preserve-me",
    );
    expect(
      await articlePage
        .locator("#linked-paragraph")
        .evaluate((paragraph) => paragraph.innerHTML),
    ).toContain('<a id="inline-link" href="/linked-target.html#details">');
    expect(
      await articlePage
        .locator("#inline-link")
        .evaluate(
          (link) => link === Reflect.get(window, "fixtureOriginalLink"),
        ),
    ).toBe(true);
    await articlePage.locator("#inline-link").click();
    expect(
      await articlePage.evaluate(() =>
        Number(Reflect.get(window, "fixtureLinkClicks")),
      ),
    ).toBe(1);

    const excluded = articlePage.locator("[data-expect-excluded]");
    expect(
      await excluded.evaluateAll((elements) =>
        elements.every(
          (element) =>
            !element.hasAttribute("data-paralume-source-id") &&
            element.nextElementSibling?.getAttribute("data-paralume-owned") !==
              "true",
        ),
      ),
    ).toBe(true);
    const excludedText = await excluded.evaluateAll((elements) =>
      elements.map((element) =>
        element.textContent.replace(/\s+/g, " ").trim(),
      ),
    );
    const allTranslationText = await articlePage
      .locator(translationSelector)
      .allTextContents();
    for (const text of excludedText) {
      expect(allTranslationText).not.toContain(text);
    }

    await articlePage
      .locator(translationSelector)
      .evaluateAll((translations) => {
        translations.forEach((translation, index) => {
          translation.setAttribute(
            "data-e2e-node-token",
            `translation-${String(index)}`,
          );
        });
      });
    const originalTranslations = await articlePage
      .locator(translationSelector)
      .evaluateAll((translations) =>
        translations.map((translation) => ({
          token: translation.getAttribute("data-e2e-node-token"),
          text: translation.textContent,
        })),
      );

    await expect(
      runRuntimeCommand(popupPage, articleTabId, "translate"),
    ).resolves.toMatchObject({
      ok: true,
      message: "Translations are already up to date.",
    });
    await expect(articlePage.locator(translationSelector)).toHaveCount(
      expectedSourceCount,
    );
    expect(
      await articlePage
        .locator(translationSelector)
        .evaluateAll((translations) =>
          translations.map((translation) => ({
            token: translation.getAttribute("data-e2e-node-token"),
            text: translation.textContent,
          })),
        ),
    ).toEqual(originalTranslations);

    await expect(
      runRuntimeCommand(popupPage, articleTabId, "toggle"),
    ).resolves.toMatchObject({
      ok: true,
      message: "Translations hidden.",
      state: { visible: false },
    });
    expect(
      await articlePage
        .locator(translationSelector)
        .evaluateAll((translations) =>
          translations.every(
            (translation) =>
              (translation as HTMLElement).hidden &&
              getComputedStyle(translation).display === "none",
          ),
        ),
    ).toBe(true);

    await expect(
      runRuntimeCommand(popupPage, articleTabId, "toggle"),
    ).resolves.toMatchObject({
      ok: true,
      message: "Translations shown.",
      state: { visible: true },
    });
    expect(
      await articlePage
        .locator(translationSelector)
        .evaluateAll((translations) =>
          translations.every(
            (translation) =>
              !(translation as HTMLElement).hidden &&
              getComputedStyle(translation).display !== "none",
          ),
        ),
    ).toBe(true);
    expect(
      await articlePage
        .locator(translationSelector)
        .evaluateAll((translations) =>
          translations.map((translation) => ({
            token: translation.getAttribute("data-e2e-node-token"),
            text: translation.textContent,
          })),
        ),
    ).toEqual(originalTranslations);

    await expect(
      runRuntimeCommand(popupPage, articleTabId, "clear"),
    ).resolves.toMatchObject({
      ok: true,
      message: `Cleared ${String(expectedSourceCount)} translations.`,
      state: { translationCount: 0 },
    });
    await expect(articlePage.locator(translationSelector)).toHaveCount(0);
    await expect(articlePage.locator(paralumeMarkerSelector)).toHaveCount(0);
    expect(
      await articlePage.locator("body").evaluate((body) => body.innerHTML),
    ).toBe(initialBody);

    await articlePage.close();
  });

  test("popup reports a clear error for a restricted active page", async () => {
    if (context === undefined) {
      throw new Error("The extension browser context was not initialized.");
    }

    const restrictedPage = await context.newPage();
    await restrictedPage.goto("chrome://version/");

    await clickPopupAction(popupPage, restrictedPage, "translate");
    await expect(popupPage.getByRole("alert")).toHaveText(
      "Paralume cannot run on browser-internal, extension, or other restricted pages. Open a regular webpage and try again.",
    );
    await expect(popupPage.locator("main")).toHaveAttribute(
      "aria-busy",
      "false",
    );

    await restrictedPage.close();
  });

  test("Options securely saves credentials, rotates exact origins after reopen, reloads after worker restart, and blocks revoked access", async () => {
    if (context === undefined || browserCdp === undefined) {
      throw new Error("The extension browser context was not initialized.");
    }

    const firstBaseUrl = "https://provider-a.example.test/v1";
    const firstOrigin = "https://provider-a.example.test/*";
    const secondBaseUrl = "https://provider-b.example.test/openai/v1";
    const secondOrigin = "https://provider-b.example.test/*";
    const credentialMarker = "e2e-ui-credential-marker";
    let optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(optionsPage.getByRole("status")).toHaveText(
      "Provider settings loaded.",
    );
    await optionsPage.locator('select[name="provider"]').selectOption("openai");
    await optionsPage.locator('input[name="openaiBaseUrl"]').fill(firstBaseUrl);
    await optionsPage
      .locator('input[name="openaiModel"]')
      .fill("strict-schema-test-model");
    await optionsPage
      .locator('input[name="openaiApiKey"]')
      .fill(credentialMarker);
    await instrumentOptionsPermissionCalls(optionsPage);
    await optionsPage.locator('button[data-action="save"]').click();
    await expect
      .poll(() => getOptionsPermissionCalls(optionsPage))
      .toEqual({ contains: [], request: [[firstOrigin]] });
    await acceptExtensionHostPermission(context, extensionId, firstOrigin);
    await optionsPage.close();

    optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(optionsPage.getByRole("status")).toHaveText(
      "Provider settings loaded.",
    );
    await optionsPage.locator('select[name="provider"]').selectOption("openai");
    await optionsPage.locator('input[name="openaiBaseUrl"]').fill(firstBaseUrl);
    await optionsPage
      .locator('input[name="openaiModel"]')
      .fill("strict-schema-test-model");
    const keyInput = optionsPage.locator('input[name="openaiApiKey"]');
    await keyInput.fill(credentialMarker);
    await instrumentOptionsPermissionCalls(optionsPage);
    await optionsPage.locator('button[data-action="save"]').click();
    await expect(optionsPage.getByRole("status")).toHaveText(
      "Provider settings saved.",
    );
    expect(await getOptionsPermissionCalls(optionsPage)).toEqual({
      contains: [],
      request: [[firstOrigin]],
    });
    await expect(keyInput).toHaveAttribute("type", "password");
    await expect(keyInput).toHaveValue("");
    await expect(keyInput).toHaveAttribute("placeholder", /configured/u);
    expect(await getGrantedOrigins(optionsPage)).toContain(firstOrigin);
    expect(await getGrantedOrigins(optionsPage)).not.toContain("https://*/*");

    const publicResponse = await optionsPage.evaluate(async () => {
      const extensionApi = (
        globalThis as unknown as {
          chrome: {
            runtime: { sendMessage(message: unknown): Promise<unknown> };
          };
        }
      ).chrome;
      return extensionApi.runtime.sendMessage({
        protocolVersion: 1,
        target: "settings",
        command: "get",
      });
    });
    expect(publicResponse).toMatchObject({
      ok: true,
      settings: { openai: { apiKeyConfigured: true } },
    });
    expect(JSON.stringify(publicResponse)).not.toContain(credentialMarker);
    expect(JSON.stringify(publicResponse)).not.toContain('"apiKey"');
    expect(
      await optionsPage.evaluate(() => document.documentElement.outerHTML),
    ).not.toContain(credentialMarker);

    await optionsPage.close();
    optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(optionsPage.getByRole("status")).toHaveText(
      "Provider settings loaded.",
    );
    await expect(optionsPage.locator('input[name="openaiApiKey"]')).toHaveValue(
      "",
    );
    await expect(
      optionsPage.locator('input[name="openaiApiKey"]'),
    ).toHaveAttribute("placeholder", /configured/u);

    await optionsPage
      .locator('input[name="openaiBaseUrl"]')
      .fill(secondBaseUrl);
    await instrumentOptionsPermissionCalls(optionsPage);
    await optionsPage.locator('button[data-action="save"]').click();
    await expect
      .poll(() => getOptionsPermissionCalls(optionsPage))
      .toEqual({ contains: [], request: [[secondOrigin]] });
    await acceptExtensionHostPermission(context, extensionId, secondOrigin);
    await optionsPage.close();

    optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(optionsPage.getByRole("status")).toHaveText(
      "Provider settings loaded.",
    );
    await optionsPage
      .locator('input[name="openaiBaseUrl"]')
      .fill(secondBaseUrl);
    await instrumentOptionsPermissionCalls(optionsPage);
    await optionsPage.locator('button[data-action="save"]').click();
    await expect(optionsPage.getByRole("status")).toHaveText(
      "Provider settings saved.",
    );
    expect(await getOptionsPermissionCalls(optionsPage)).toEqual({
      contains: [],
      request: [[secondOrigin]],
    });
    await expect
      .poll(() => getGrantedOrigins(optionsPage))
      .toContain(secondOrigin);
    await expect
      .poll(() => getGrantedOrigins(optionsPage))
      .not.toContain(firstOrigin);

    const runningWorker = context
      .serviceWorkers()
      .find((worker) =>
        worker.url().startsWith(`chrome-extension://${extensionId}/`),
      );
    expect(runningWorker).toBeDefined();
    await runningWorker?.evaluate(() => {
      Reflect.set(globalThis, "__paralumeE2eWorkerMarker", "before-restart");
    });
    await optionsPage.close();
    const pageCdp = await context.newCDPSession(popupPage);
    await pageCdp.send("ServiceWorker.enable");
    await pageCdp.send("ServiceWorker.stopAllWorkers");
    await pageCdp.detach();

    optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(optionsPage.getByRole("status")).toHaveText(
      "Provider settings loaded.",
    );
    await expect(
      optionsPage.locator('input[name="openaiBaseUrl"]'),
    ).toHaveValue(secondBaseUrl);
    await expect(
      optionsPage.locator('input[name="openaiApiKey"]'),
    ).toHaveAttribute("placeholder", /configured/u);
    const restartedWorker = context
      .serviceWorkers()
      .find((worker) =>
        worker.url().startsWith(`chrome-extension://${extensionId}/`),
      );
    expect(restartedWorker).toBeDefined();
    await expect(
      restartedWorker?.evaluate(
        () =>
          (
            globalThis as unknown as {
              __paralumeE2eWorkerMarker?: string;
            }
          ).__paralumeE2eWorkerMarker,
      ),
    ).resolves.toBeUndefined();

    await optionsPage.locator('button[data-action="clear-openai-key"]').click();
    await expect(optionsPage.getByRole("status")).toHaveText(
      "OpenAI-compatible API key cleared.",
    );
    await optionsPage.close();

    optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(optionsPage.getByRole("status")).toHaveText(
      "Provider settings loaded.",
    );
    await expect(
      optionsPage.locator('input[name="openaiApiKey"]'),
    ).toHaveAttribute("placeholder", "Enter API key");

    const revoked = await optionsPage.evaluate(async (origin) => {
      const extensionApi = (
        globalThis as unknown as {
          chrome: {
            permissions: {
              remove(permission: { origins: string[] }): Promise<boolean>;
            };
          };
        }
      ).chrome;
      return extensionApi.permissions.remove({ origins: [origin] });
    }, secondOrigin);
    expect(revoked).toBe(true);
    expect(await getGrantedOrigins(optionsPage)).not.toContain(secondOrigin);

    const blocked = await optionsPage.evaluate(async () => {
      const extensionApi = (
        globalThis as unknown as {
          chrome: {
            runtime: { sendMessage(message: unknown): Promise<unknown> };
          };
        }
      ).chrome;
      return extensionApi.runtime.sendMessage({
        protocolVersion: 1,
        target: "background",
        command: "translate",
        request: {
          sourceLanguage: "auto",
          targetLanguage: "zh-CN",
          segments: [
            {
              id: "revoked-permission-segment",
              text: "LEAK_PAGE_TEXT_revoked_permission",
            },
          ],
        },
      });
    });
    expect(blocked).toEqual({
      protocolVersion: 1,
      ok: false,
      error: {
        code: "PERMISSION_MISSING",
        message:
          "Access to the configured provider origin is not granted. Save the provider settings again.",
        retryable: false,
      },
    });
    expect(JSON.stringify(blocked)).not.toMatch(
      /provider-b|credential-marker|LEAK_PAGE_TEXT/u,
    );

    await optionsPage.evaluate(async () => {
      const extensionApi = (
        globalThis as unknown as {
          chrome: {
            runtime: { sendMessage(message: unknown): Promise<unknown> };
          };
        }
      ).chrome;
      await extensionApi.runtime.sendMessage({
        protocolVersion: 1,
        target: "settings",
        command: "save",
        draft: {
          provider: "mock",
          openai: {
            baseUrl: "https://provider-b.example.test/openai/v1",
            model: "strict-schema-test-model",
            protocol: "responses",
            reasoningEffort: "low",
          },
          microsoft: {
            endpoint: "https://api.cognitive.microsofttranslator.com",
            region: "global",
          },
        },
        apiKeys: {},
      });
    });
    await optionsPage.close();
  });
});
