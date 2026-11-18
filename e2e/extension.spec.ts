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
const extractionFixturePath = resolve("e2e/fixtures/extraction-article.html");
const fixtureUrl = "http://127.0.0.1:4173/static-article.html";
const retryFixtureUrl = "http://127.0.0.1:4173/retry-article.html";
const translationSelector =
  '[data-paralume-owned="true"][data-paralume-translation-for]';
const paralumeMarkerSelector = [
  "[data-paralume-source-id]",
  "[data-paralume-translation-for]",
  "[data-paralume-translation-status]",
  "[data-paralume-retry]",
].join(", ");
const floatingMenuSelector =
  '[data-paralume-owned="true"]:not([data-paralume-translation-for])';

interface CdpDomNode {
  readonly nodeId: number;
  readonly attributes?: readonly string[];
  readonly children?: readonly CdpDomNode[];
  readonly shadowRoots?: readonly CdpDomNode[];
  readonly shadowRootType?: string;
}

interface ResolvedMenuNode {
  readonly objectId: string;
  readonly shadowRootType: string | undefined;
}

interface FloatingMenuControl {
  readonly text: string;
  readonly visible: boolean;
  readonly x: number;
  readonly y: number;
}

function findFloatingMenuHost(node: CdpDomNode): CdpDomNode | undefined {
  const attributes = node.attributes ?? [];
  const named = (name: string) => attributes.indexOf(name) % 2 === 0;
  if (
    named("data-paralume-owned") &&
    !named("data-paralume-translation-for") &&
    (node.shadowRoots?.length ?? 0) > 0
  ) {
    return node;
  }
  for (const child of node.children ?? []) {
    const host = findFloatingMenuHost(child);
    if (host !== undefined) {
      return host;
    }
  }
  return undefined;
}

// The floating menu uses a closed shadow root that Playwright locators and
// page scripts cannot pierce, so tests reach it through CDP with pierce:true.
async function resolveFloatingMenuNode(
  cdp: CDPSession,
  selector: string,
): Promise<ResolvedMenuNode | undefined> {
  const { root } = await cdp.send("DOM.getDocument", {
    depth: -1,
    pierce: true,
  });
  const shadowRoot = findFloatingMenuHost(root)?.shadowRoots?.[0];
  if (shadowRoot === undefined) {
    return undefined;
  }
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: shadowRoot.nodeId,
    selector,
  });
  if (nodeId === 0) {
    return undefined;
  }
  const { object } = await cdp.send("DOM.resolveNode", { nodeId });
  if (object.objectId === undefined) {
    return undefined;
  }
  return {
    objectId: object.objectId,
    shadowRootType: shadowRoot.shadowRootType,
  };
}

async function readFloatingMenuControl(
  cdp: CDPSession,
  selector: string,
): Promise<FloatingMenuControl | undefined> {
  const node = await resolveFloatingMenuNode(cdp, selector);
  if (node === undefined) {
    return undefined;
  }
  const { result } = await cdp.send("Runtime.callFunctionOn", {
    objectId: node.objectId,
    functionDeclaration: `function () {
      const rect = this.getBoundingClientRect();
      return {
        text: (this.textContent || "").trim(),
        visible: this.getClientRects().length > 0 && rect.width > 0,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }`,
    returnByValue: true,
  });
  return result.value as FloatingMenuControl;
}

async function readFloatingMenuText(
  cdp: CDPSession,
  selector: string,
): Promise<string | undefined> {
  return (await readFloatingMenuControl(cdp, selector))?.text;
}

// Trusted input: CDP Input events are browser-generated, like a real user.
async function clickFloatingMenuControl(
  page: Page,
  cdp: CDPSession,
  selector: string,
): Promise<void> {
  await expect
    .poll(async () => (await readFloatingMenuControl(cdp, selector))?.visible)
    .toBe(true);
  const control = await readFloatingMenuControl(cdp, selector);
  if (control === undefined) {
    throw new Error(`Floating menu control ${selector} was not found.`);
  }
  await page.mouse.click(control.x, control.y);
}

// Untrusted input: what a page script could do with a reference to a control.
async function syntheticClickFloatingMenuControl(
  cdp: CDPSession,
  selector: string,
): Promise<void> {
  const node = await resolveFloatingMenuNode(cdp, selector);
  if (node === undefined) {
    throw new Error(`Floating menu control ${selector} was not found.`);
  }
  await cdp.send("Runtime.callFunctionOn", {
    objectId: node.objectId,
    functionDeclaration: `function () {
      this.click();
      this.dispatchEvent(
        new MouseEvent("click", { bubbles: true, composed: true }),
      );
    }`,
  });
}

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
  message?: { id: string; values?: Record<string, string | number> };
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
    message?: { id: string; values?: Record<string, string | number> };
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

test("generated Chrome manifest matches package version and keeps provider origins optional", async () => {
  const manifest = JSON.parse(
    await readFile(join(extensionPath, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  const packageJson = JSON.parse(
    await readFile(resolve("package.json"), "utf8"),
  ) as Record<string, unknown>;

  expect(manifest["version"]).toBe(packageJson["version"]);
  expect(manifest["permissions"]).toEqual([
    "activeTab",
    "scripting",
    "storage",
  ]);
  expect(manifest["host_permissions"]).toEqual(["http://*/*", "https://*/*"]);
  expect(manifest["optional_host_permissions"]).toBeUndefined();
  expect(manifest["content_scripts"]).toEqual([
    {
      matches: ["http://*/*", "https://*/*"],
      run_at: "document_idle",
      js: ["content-scripts/content.js"],
    },
  ]);
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

  test("automatic page runtime and action popup drive the foreground HTTP article", async () => {
    if (context === undefined || browserCdp === undefined) {
      throw new Error("The extension browser context was not initialized.");
    }

    const articlePage = await context.newPage();
    await articlePage.goto(fixtureUrl);
    await articlePage.bringToFront();
    await popupPage.evaluate(async () => {
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
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-5-mini",
            protocol: "responses",
            reasoningEffort: "low",
          },
          microsoft: {
            endpoint: "https://api.cognitive.microsofttranslator.com",
            region: "global",
          },
          retry: { enabled: true, maxRetries: 2 },
          appearance: {
            fontFamily: "system",
            fontSize: 16,
            textColor: "#456257",
            backgroundColor: "#f4f8f5",
            lineHeight: 1.6,
            opacity: 1,
            verticalSpacing: 8,
          },
          uiLanguage: "system",
        },
        apiKeys: {},
      });
    });

    const expectedSourceCount = await articlePage
      .locator("[data-expect-translation]")
      .count();
    expect(expectedSourceCount).toBeGreaterThan(0);
    await expect(articlePage.locator(floatingMenuSelector)).toHaveCount(1);

    const actionPopup = await triggerActionPopup(
      context,
      browserCdp,
      extensionId,
      articlePage,
    );
    try {
      expect(await actionPopup.activeTabUrl()).toBe(fixtureUrl);
      await actionPopup.waitForStatus(
        "Ready. Translation runs only when you request it.",
      );
      await actionPopup.click("translate");
      await actionPopup.waitForStatus(
        `Translated ${String(expectedSourceCount)} readable blocks; 0 unavailable.`,
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
      await expect(articlePage.locator(floatingMenuSelector)).toHaveCount(1);
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
        sources.map((source) => {
          const element = source as HTMLElement;
          if (element.tagName === "PRE") {
            return {
              childElementCount: element.childElementCount,
              structural: false,
              text: element.innerText
                .replace(/\r\n?/g, "\n")
                .replace(/[\t\f\v\u00a0 ]+/g, " ")
                .replace(/ *\n */g, "\n")
                .trim(),
            };
          }
          const clone = element.cloneNode(true) as HTMLElement;
          for (const lineBreak of clone.querySelectorAll("br")) {
            lineBreak.replaceWith("\uE000");
          }
          return {
            childElementCount: element.childElementCount,
            structural: ["LI", "TD", "TH"].includes(element.tagName),
            text: clone.innerText
              .replace(/[\s\u00a0]+/g, " ")
              .trim()
              .replaceAll("\uE000", "\n"),
          };
        }),
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
      message: {
        id: "content.translationSummary",
        values: { succeeded: expectedSourceCount, failed: 0 },
      },
      state: { translationCount: expectedSourceCount, visible: true },
    });

    await expect(articlePage.locator(translationSelector)).toHaveCount(
      expectedSourceCount,
    );
    const formattedTranslation = articlePage.locator(
      `#formatted-guidance + ${translationSelector}`,
    );
    await expect(formattedTranslation).toHaveCSS("white-space", "pre-wrap");
    await expect(formattedTranslation).toContainText(
      "end to end.\n\nSuccess means:\n- make the eligibility decision",
    );
    const typographyPairs = await articlePage.evaluate(() =>
      ["article-title", "linked-paragraph", "preformatted-code"].map((id) => {
        const source = document.getElementById(id);
        const translation = source?.nextElementSibling;
        if (
          !(source instanceof HTMLElement) ||
          !(translation instanceof HTMLElement)
        ) {
          throw new Error(`Missing typography pair for ${id}`);
        }
        const sourceStyle = getComputedStyle(source);
        const translationStyle = getComputedStyle(translation);
        return {
          id,
          source: {
            fontFamily: sourceStyle.fontFamily,
            fontSize: sourceStyle.fontSize,
            fontWeight: sourceStyle.fontWeight,
            lineHeight: sourceStyle.lineHeight,
            letterSpacing: sourceStyle.letterSpacing,
            textAlign: sourceStyle.textAlign,
          },
          translation: {
            fontFamily: translationStyle.fontFamily,
            fontSize: translationStyle.fontSize,
            fontWeight: translationStyle.fontWeight,
            lineHeight: translationStyle.lineHeight,
            letterSpacing: translationStyle.letterSpacing,
            textAlign: translationStyle.textAlign,
          },
        };
      }),
    );
    for (const pair of typographyPairs) {
      expect(pair.translation).toEqual(pair.source);
    }
    expect(
      new Set(typographyPairs.map((pair) => pair.translation.fontSize)).size,
    ).toBe(3);

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
      message: { id: "content.alreadyUpToDate" },
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
      message: { id: "content.hidden" },
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
      message: { id: "content.shown" },
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
      message: {
        id: "content.cleared",
        values: { count: expectedSourceCount },
      },
      state: { translationCount: 0 },
    });
    await expect(articlePage.locator(translationSelector)).toHaveCount(0);
    await expect(articlePage.locator(paralumeMarkerSelector)).toHaveCount(0);
    expect(
      await articlePage.locator("body").evaluate((body) => body.innerHTML),
    ).toBe(initialBody);

    await articlePage.close();
  });

  test("Chromium extraction skips hidden/excluded descendants and splits nested lists and layout tables", async () => {
    if (context === undefined) {
      throw new Error("The extension browser context was not initialized.");
    }

    const extractionPage = await context.newPage();
    await extractionPage.goto(`chrome-extension://${extensionId}/options.html`);
    // The inline <script> inside the paragraph is intentionally kept: the
    // extension page CSP blocks it, but its text must still never be sent.
    await extractionPage.setContent(
      await readFile(extractionFixturePath, "utf8"),
    );
    await extractionPage.addScriptTag({
      url: `chrome-extension://${extensionId}/paralume.js`,
    });
    const extractionTabId = await extractionPage.evaluate(async () => {
      const extensionApi = (
        globalThis as unknown as { chrome: ChromiumExtensionApi }
      ).chrome;
      return (await extensionApi.tabs.getCurrent()).id;
    });
    if (extractionTabId === undefined) {
      throw new Error("The extraction fixture tab ID was not available.");
    }
    const initialBody = await extractionPage
      .locator("body")
      .evaluate((body) => body.innerHTML);

    const expectedTexts: Record<string, string> = {
      "mixed-paragraph":
        "Visible paragraph keeps its readable words plus visible emphasis and a normal ending.",
      "glued-item": "First glued sentence. Second glued sentence.",
      "simple-item": "Simple item with one nested paragraph",
      "outer-item": "Outer list item introduction text",
      "inner-item-one": "Inner list item number one",
      "inner-item-two": "Inner list item number two",
      "code-item": "List item explaining the snippet below",
      "code-item-pre": 'const snippet = "kept apart";',
      "story-title": "Layout table story title text",
      "story-meta": "Layout table story metadata line",
      "layout-paragraph-one": "Layout cell paragraph number one.",
      "layout-paragraph-two": "Layout cell paragraph number two.",
      "cv-mixed":
        "Visible content-visibility sentence still rendered inline ends here.",
      "cv-auto": "Deferred but readable paragraph",
      "short-nested-item": "Step one opens the settings page Done.",
      "loose-quote": "Quote introduction loose text",
      "loose-quoted": "Quoted paragraph text here",
    };
    const expectedCount = Object.keys(expectedTexts).length;

    // Ground truth from Chromium: checkVisibility() reports content skipped
    // by content-visibility: hidden as not visible.
    await expect(
      extractionPage.evaluate(() =>
        Object.fromEntries(
          [
            "cv-ancestor-hidden",
            "cv-self-probe",
            "cv-skipped-probe",
            "cv-inline-probe",
            "cv-auto",
          ].map((id) => [
            id,
            document.getElementById(id)?.checkVisibility() ?? null,
          ]),
        ),
      ),
    ).resolves.toEqual({
      "cv-ancestor-hidden": false,
      "cv-self-probe": false,
      "cv-skipped-probe": false,
      "cv-inline-probe": true,
      "cv-auto": true,
    });

    await expect(
      runRuntimeCommand(popupPage, extractionTabId, "translate"),
    ).resolves.toMatchObject({
      ok: true,
      message: {
        id: "content.translationSummary",
        values: { succeeded: expectedCount, failed: 0 },
      },
    });
    await expect(extractionPage.locator(translationSelector)).toHaveCount(
      expectedCount,
    );

    const translatedBySource = await extractionPage.evaluate(() => {
      const outputs: Record<string, string | null> = {};
      const sources = document.querySelectorAll("[data-paralume-source-id]");
      const translations = Array.from(
        document.querySelectorAll(
          '[data-paralume-owned="true"][data-paralume-translation-for]',
        ),
      );
      for (const source of sources) {
        const sourceId = source.getAttribute("data-paralume-source-id");
        const translation = translations.find(
          (candidate) =>
            candidate.getAttribute("data-paralume-translation-for") ===
            sourceId,
        );
        outputs[source.id] = translation?.textContent ?? null;
      }
      return outputs;
    });
    expect(translatedBySource).toEqual(
      Object.fromEntries(
        Object.entries(expectedTexts).map(([id, text]) => [
          id,
          `【Mock zh-CN】${text}`,
        ]),
      ),
    );
    await expect(
      extractionPage.locator("#layout-cell[data-paralume-source-id]"),
    ).toHaveCount(0);
    const allTranslationText = (
      await extractionPage.locator(translationSelector).allTextContents()
    ).join("\n");
    for (const secret of [
      "SCRIPT_SECRET_TEXT",
      "STYLE_SECRET_TEXT",
      "HIDDEN_ATTRIBUTE_SECRET",
      "DISPLAY_NONE_SECRET",
      "VISIBILITY_SECRET",
      "ARIA_HIDDEN_SECRET",
      "BUTTON_SECRET",
      "CV_ANCESTOR_SECRET",
      "CV_SELF_SECRET",
      "CV_DESCENDANT_SECRET",
    ]) {
      expect(allTranslationText).not.toContain(secret);
    }

    // Translations rendered inside compound list items/cells must not make
    // their source look changed, so a repeat request stays idempotent.
    await expect(
      runRuntimeCommand(popupPage, extractionTabId, "translate"),
    ).resolves.toMatchObject({
      ok: true,
      message: { id: "content.alreadyUpToDate" },
    });
    await expect(extractionPage.locator(translationSelector)).toHaveCount(
      expectedCount,
    );

    await expect(
      runRuntimeCommand(popupPage, extractionTabId, "clear"),
    ).resolves.toMatchObject({
      ok: true,
      message: { id: "content.cleared", values: { count: expectedCount } },
    });
    await expect(extractionPage.locator(paralumeMarkerSelector)).toHaveCount(0);
    expect(
      await extractionPage.locator("body").evaluate((body) => body.innerHTML),
    ).toBe(initialBody);

    await extractionPage.close();
  });

  test("popup reports a clear error for a restricted active page", async () => {
    if (context === undefined) {
      throw new Error("The extension browser context was not initialized.");
    }

    const restrictedPage = await context.newPage();
    await restrictedPage.goto("chrome://version/");

    await clickPopupAction(popupPage, restrictedPage, "translate");
    await expect(popupPage.getByRole("alert")).toHaveText(
      /Paralume (?:cannot run|无法在)/u,
    );
    await expect(popupPage.locator("main")).toHaveAttribute(
      "aria-busy",
      "false",
    );

    await restrictedPage.close();
  });

  test("Options securely saves credentials, preserves fixed web permissions, reloads after worker restart, and clears keys", async () => {
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
      /^(?:Settings loaded\.|设置已加载。)$/u,
    );
    await optionsPage.locator('select[name="uiLanguage"]').selectOption("en");
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
      .toEqual({ contains: [[firstOrigin]], request: [[firstOrigin]] });
    await acceptExtensionHostPermission(context, extensionId, firstOrigin);
    await optionsPage.close();

    optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(optionsPage.getByRole("status")).toHaveText(
      /^(?:Settings loaded\.|设置已加载。)$/u,
    );
    await optionsPage.locator('select[name="uiLanguage"]').selectOption("en");
    await optionsPage.locator('select[name="provider"]').selectOption("openai");
    await optionsPage.locator('input[name="openaiBaseUrl"]').fill(firstBaseUrl);
    await optionsPage
      .locator('input[name="openaiModel"]')
      .fill("strict-schema-test-model");
    const keyInput = optionsPage.locator('input[name="openaiApiKey"]');
    await keyInput.fill(credentialMarker);
    await instrumentOptionsPermissionCalls(optionsPage);
    await optionsPage.locator('button[data-action="save"]').click();
    await expect(optionsPage.getByRole("status")).toHaveText("Settings saved.");
    expect(await getOptionsPermissionCalls(optionsPage)).toEqual({
      contains: [[firstOrigin]],
      request: [[firstOrigin]],
    });
    await expect(keyInput).toHaveAttribute("type", "password");
    await expect(keyInput).toHaveValue("");
    await expect(keyInput).toHaveAttribute("placeholder", /configured/u);
    expect(await getGrantedOrigins(optionsPage)).toEqual([
      "http://*/*",
      "https://*/*",
    ]);

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
      "Settings loaded.",
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
    // A saved key is bound to its origin, so moving to provider-b needs the
    // key again (the drop-without-key path is covered by a later test).
    await optionsPage
      .locator('input[name="openaiApiKey"]')
      .fill(credentialMarker);
    await instrumentOptionsPermissionCalls(optionsPage);
    await optionsPage.locator('button[data-action="save"]').click();
    await expect
      .poll(() => getOptionsPermissionCalls(optionsPage))
      .toEqual({ contains: [[secondOrigin]], request: [[secondOrigin]] });
    await acceptExtensionHostPermission(context, extensionId, secondOrigin);
    await optionsPage.close();

    optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(optionsPage.getByRole("status")).toHaveText(
      "Settings loaded.",
    );
    await optionsPage
      .locator('input[name="openaiBaseUrl"]')
      .fill(secondBaseUrl);
    await instrumentOptionsPermissionCalls(optionsPage);
    await optionsPage.locator('button[data-action="save"]').click();
    await expect(optionsPage.getByRole("status")).toHaveText("Settings saved.");
    expect(await getOptionsPermissionCalls(optionsPage)).toEqual({
      contains: [[secondOrigin]],
      request: [[secondOrigin]],
    });
    expect(await getGrantedOrigins(optionsPage)).toEqual([
      "http://*/*",
      "https://*/*",
    ]);

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
      "Settings loaded.",
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
      "Settings loaded.",
    );
    await expect(
      optionsPage.locator('input[name="openaiApiKey"]'),
    ).toHaveAttribute("placeholder", "Enter API key");

    const publicAfterClear = await optionsPage.evaluate(async () => {
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
    expect(publicAfterClear).toMatchObject({
      ok: true,
      settings: { openai: { apiKeyConfigured: false } },
    });
    expect(JSON.stringify(publicAfterClear)).not.toContain(credentialMarker);

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
          retry: { enabled: true, maxRetries: 2 },
          appearance: {
            fontFamily: "system",
            fontSize: 16,
            textColor: "#456257",
            backgroundColor: "#f4f8f5",
            lineHeight: 1.6,
            opacity: 1,
            verticalSpacing: 8,
          },
          uiLanguage: "system",
        },
        apiKeys: {},
      });
    });
    await optionsPage.close();
  });

  test("Chinese retry and appearance settings persist across worker restart and drive automatic/manual retry cleanup", async () => {
    if (context === undefined || browserCdp === undefined) {
      throw new Error("The extension browser context was not initialized.");
    }

    let optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(optionsPage.getByRole("status")).toHaveText(
      "Settings loaded.",
    );
    await optionsPage
      .locator('select[name="uiLanguage"]')
      .selectOption("zh-CN");
    await optionsPage.locator('select[name="provider"]').selectOption("mock");
    await optionsPage.locator('input[name="retryEnabled"]').check();
    await optionsPage
      .locator('select[name="retryMaxRetries"]')
      .selectOption("2");
    await optionsPage
      .locator('select[name="appearanceFontFamily"]')
      .selectOption("serif");
    await optionsPage.locator('input[name="appearanceFontSize"]').fill("20");
    await optionsPage.locator('input[name="appearanceLineHeight"]').fill("1.9");
    await optionsPage.locator('input[name="appearanceOpacity"]').fill("0.8");
    await optionsPage
      .locator('input[name="appearanceVerticalSpacing"]')
      .fill("14");
    for (const [name, value] of [
      ["appearanceTextColor", "#112233"],
      ["appearanceBackgroundColor", "#ddeeff"],
    ] as const) {
      await optionsPage
        .locator(`input[name="${name}"]`)
        .evaluate((input, nextValue) => {
          const colorInput = input as HTMLInputElement;
          Reflect.set(
            HTMLInputElement.prototype,
            "value",
            nextValue,
            colorInput,
          );
          colorInput.dispatchEvent(new Event("input", { bubbles: true }));
          colorInput.dispatchEvent(new Event("change", { bubbles: true }));
        }, value);
    }
    await optionsPage.locator('button[data-action="save"]').click();
    await expect(optionsPage.getByRole("status")).toHaveText("设置已保存。");
    await optionsPage.close();

    const pageCdp = await context.newCDPSession(popupPage);
    await pageCdp.send("ServiceWorker.enable");
    await pageCdp.send("ServiceWorker.stopAllWorkers");
    await pageCdp.detach();

    optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(optionsPage.getByRole("status")).toHaveText("设置已加载。");
    await expect(optionsPage.locator('select[name="uiLanguage"]')).toHaveValue(
      "zh-CN",
    );
    await expect(optionsPage.locator('select[name="provider"]')).toHaveValue(
      "mock",
    );
    await expect(
      optionsPage.locator('select[name="retryMaxRetries"]'),
    ).toHaveValue("2");
    await expect(
      optionsPage.locator('select[name="appearanceFontFamily"]'),
    ).toHaveValue("serif");
    await expect(
      optionsPage.locator('input[name="appearanceFontSize"]'),
    ).toHaveValue("20");
    await expect(
      optionsPage.locator('input[name="appearanceTextColor"]'),
    ).toHaveValue("#112233");
    await expect(
      optionsPage.locator('input[name="appearanceBackgroundColor"]'),
    ).toHaveValue("#ddeeff");

    await optionsPage.close();

    const retryPage = await context.newPage();
    await retryPage.goto(retryFixtureUrl);
    await retryPage.bringToFront();
    const automaticSourceStyle = await retryPage
      .locator("#automatic-source")
      .getAttribute("style");
    const actionPopup = await triggerActionPopup(
      context,
      browserCdp,
      extensionId,
      retryPage,
    );
    await actionPopup.waitForStatus("已就绪。仅在你主动请求时翻译。");
    await actionPopup.click("translate");
    const retryPageCdp = await context.newCDPSession(retryPage);
    await expect
      .poll(() => readFloatingMenuText(retryPageCdp, '[role="status"]'))
      .toContain("/");
    await retryPageCdp.detach();
    const automaticTranslation = retryPage.locator(
      `#automatic-source + ${translationSelector}`,
    );
    await expect(automaticTranslation).toHaveText(
      "【Mock zh-CN attempt 3】Automatic retry fixture text.",
    );
    await actionPopup.close();

    const resumedPopup = await triggerActionPopup(
      context,
      browserCdp,
      extensionId,
      retryPage,
    );
    try {
      await retryPage.evaluate(() => {
        const manual = document.createElement("p");
        manual.id = "manual-source";
        manual.style.marginTop = "21px";
        manual.textContent =
          "[[PARALUME_MOCK_RESULT_FAILURE:3:SERVER_UNAVAILABLE]] Manual retry fixture text.";
        document.querySelector("main")?.append(manual);
      });
      const manualSourceStyle = await retryPage
        .locator("#manual-source")
        .getAttribute("style");

      expect(await resumedPopup.activeTabUrl()).toBe(retryFixtureUrl);
      const retryTabId = await resumedPopup.activeTabId();
      if (retryTabId === undefined) {
        throw new Error("The retry fixture tab ID was not available.");
      }
      const manualResponse = await runRuntimeCommand(
        popupPage,
        retryTabId,
        "translate",
      );
      expect(manualResponse).toMatchObject({
        ok: true,
        message: {
          id: "content.translationSummary",
          values: { succeeded: 0, failed: 1 },
        },
      });
      const manualFailure = retryPage.locator(
        `#manual-source + ${translationSelector}`,
      );
      await expect(manualFailure).toContainText("翻译服务暂时不可用");
      const retryButton = manualFailure.locator('[data-paralume-retry="true"]');
      await expect(retryButton).toHaveText("重试");
      await expect(retryButton).toHaveAttribute(
        "aria-label",
        "重试此可读文本块的翻译",
      );
      await manualFailure.evaluate((translation) => {
        translation.setAttribute("data-e2e-manual-node", "preserved");
      });
      await retryButton.click();
      await expect(manualFailure).toHaveText(
        "【Mock zh-CN attempt 4】Manual retry fixture text.",
      );
      await expect(manualFailure).toHaveAttribute(
        "data-e2e-manual-node",
        "preserved",
      );
      await expect(manualFailure.locator("[data-paralume-retry]")).toHaveCount(
        0,
      );

      for (const translation of [automaticTranslation, manualFailure]) {
        await expect(translation).toHaveCSS("font-size", "20px");
        await expect(translation).toHaveCSS("color", "rgb(17, 34, 51)");
        await expect(translation).toHaveCSS(
          "background-color",
          "rgb(221, 238, 255)",
        );
        await expect(translation).toHaveCSS("line-height", "38px");
        await expect(translation).toHaveCSS("opacity", "0.8");
        await expect(translation).toHaveCSS("margin-top", "0px");
        await expect(translation).toHaveCSS("margin-bottom", "28px");
      }
      await expect(retryPage.locator("#automatic-source")).toHaveAttribute(
        "style",
        automaticSourceStyle ?? "",
      );
      await expect(retryPage.locator("#manual-source")).toHaveAttribute(
        "style",
        manualSourceStyle ?? "",
      );

      await retryPage.locator("#page-button").click();
      await expect
        .poll(() =>
          retryPage.evaluate(() =>
            Number(Reflect.get(window, "retryFixtureClicks")),
          ),
        )
        .toBe(1);

      await resumedPopup.click("clear");
      await resumedPopup.waitForStatus("已清除 2 条译文。");
      await expect(retryPage.locator(translationSelector)).toHaveCount(0);
      await expect(retryPage.locator(paralumeMarkerSelector)).toHaveCount(0);
      await retryPage.locator("#page-button").click();
      await expect
        .poll(() =>
          retryPage.evaluate(() =>
            Number(Reflect.get(window, "retryFixtureClicks")),
          ),
        )
        .toBe(2);
    } finally {
      await resumedPopup.close();
      await retryPage.close();
    }
  });

  test("floating control explains a missing API key and offers Options", async () => {
    if (context === undefined) {
      throw new Error("The extension browser context was not initialized.");
    }

    const savedSettings = await popupPage.evaluate(async () => {
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
        command: "clear-api-key",
        provider: "openai",
      });
      // Non-resolving test endpoint: no real provider can be reached even if
      // the key check regressed.
      return extensionApi.runtime.sendMessage({
        protocolVersion: 1,
        target: "settings",
        command: "save",
        draft: {
          provider: "openai",
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
          retry: { enabled: true, maxRetries: 2 },
          appearance: {
            fontFamily: "system",
            fontSize: 16,
            textColor: "#456257",
            backgroundColor: "#f4f8f5",
            lineHeight: 1.6,
            opacity: 1,
            verticalSpacing: 8,
          },
          uiLanguage: "en",
        },
        apiKeys: {},
      });
    });
    expect(savedSettings).toMatchObject({
      ok: true,
      settings: { provider: "openai", openai: { apiKeyConfigured: false } },
    });

    const articlePage = await context.newPage();
    try {
      await articlePage.goto(fixtureUrl);
      await articlePage.bringToFront();
      await expect(articlePage.locator(floatingMenuSelector)).toHaveCount(1);
      const menuCdp = await context.newCDPSession(articlePage);
      const menuText = (selector: string) =>
        readFloatingMenuText(menuCdp, selector);
      const menuVisible = async (selector: string) =>
        (await readFloatingMenuControl(menuCdp, selector))?.visible;
      await clickFloatingMenuControl(
        articlePage,
        menuCdp,
        '[data-action="expand"]',
      );
      await clickFloatingMenuControl(
        articlePage,
        menuCdp,
        '[data-action="primary"]',
      );

      await expect
        .poll(() => menuText("[data-error-text]"))
        .toBe("The selected provider API key is not configured.");
      await expect
        .poll(() => menuText("[data-phase]"))
        .toBe("Translation needs attention");
      // Configuration failures render no per-segment UI on the page.
      await expect(articlePage.locator(translationSelector)).toHaveCount(0);
      await expect(articlePage.locator(paralumeMarkerSelector)).toHaveCount(0);

      const openSettings = '[data-action="open-settings"]';
      await expect.poll(() => menuVisible(openSettings)).toBe(true);
      expect(await menuText(openSettings)).toBe("Open settings");
      const optionsPagePromise = context.waitForEvent("page");
      await clickFloatingMenuControl(articlePage, menuCdp, openSettings);
      const optionsPage = await optionsPagePromise;
      try {
        await expect
          .poll(() => optionsPage.url())
          .toMatch(
            new RegExp(`options\\.html|[?&]options=${extensionId}(?:&|$)`, "u"),
          );
      } finally {
        await optionsPage.close();
      }

      // A new command clears the previous error before reporting its own.
      await articlePage.bringToFront();
      await clickFloatingMenuControl(
        articlePage,
        menuCdp,
        '[data-action="toggle"]',
      );
      await expect.poll(() => menuVisible("[data-error]")).toBe(false);
      await menuCdp.detach();
    } finally {
      await articlePage.close();
    }

    await popupPage.evaluate(async () => {
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
          retry: { enabled: true, maxRetries: 2 },
          appearance: {
            fontFamily: "system",
            fontSize: 16,
            textColor: "#456257",
            backgroundColor: "#f4f8f5",
            lineHeight: 1.6,
            opacity: 1,
            verticalSpacing: 8,
          },
          uiLanguage: "system",
        },
        apiKeys: {},
      });
    });
  });

  test("page scripts cannot start translations or retries with synthetic clicks", async () => {
    if (context === undefined) {
      throw new Error("The extension browser context was not initialized.");
    }

    const guardPage = await context.newPage();
    const guardCdp = await context.newCDPSession(guardPage);
    try {
      await guardPage.goto(retryFixtureUrl);
      await guardPage.bringToFront();
      await expect(guardPage.locator(floatingMenuSelector)).toHaveCount(1);
      // Mock counts attempts per source text inside the service worker, so the
      // attempt number in the final translation proves how many provider
      // requests this segment actually reached. Three result failures exhaust
      // the initial request plus its two automatic retries.
      await guardPage.evaluate(() => {
        document.querySelector("#automatic-source")?.remove();
        const source = document.createElement("p");
        source.id = "guard-source";
        source.textContent =
          "[[PARALUME_MOCK_RESULT_FAILURE:3:SERVER_UNAVAILABLE]] Synthetic click guard fixture text.";
        document.querySelector("main")?.prepend(source);
      });

      // Page scripts cannot reach the menu controls through the host.
      expect(
        await guardPage
          .locator(floatingMenuSelector)
          .evaluate((host) => host.shadowRoot === null),
      ).toBe(true);
      const expand = '[data-action="expand"]';
      const primary = '[data-action="primary"]';
      const primaryNode = await resolveFloatingMenuNode(guardCdp, primary);
      expect(primaryNode?.shadowRootType).toBe("closed");

      // Even with a reference (obtained here via CDP in the page's main
      // world), synthetic clicks must not open the panel or translate.
      await syntheticClickFloatingMenuControl(guardCdp, expand);
      await syntheticClickFloatingMenuControl(guardCdp, primary);
      await guardPage.waitForTimeout(1_000);
      const primaryControl = await readFloatingMenuControl(guardCdp, primary);
      expect(primaryControl?.visible).toBe(false);
      await expect(guardPage.locator(translationSelector)).toHaveCount(0);
      await expect(guardPage.locator(paralumeMarkerSelector)).toHaveCount(0);

      // Trusted user input still works and consumes attempts 1-3.
      await clickFloatingMenuControl(guardPage, guardCdp, expand);
      await clickFloatingMenuControl(guardPage, guardCdp, primary);
      const guardTranslation = guardPage.locator(
        `#guard-source + ${translationSelector}`,
      );
      const retryButton = guardTranslation.locator(
        '[data-paralume-retry="true"]',
      );
      await expect(retryButton).toBeVisible();
      await expect(retryButton).toBeEnabled();

      // The per-segment Retry lives in the page DOM; a page script's
      // .click()/dispatchEvent must not issue a provider request.
      await retryButton.evaluate((button: HTMLButtonElement) => {
        button.click();
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await guardPage.waitForTimeout(1_000);
      await expect(retryButton).toBeVisible();
      await expect(retryButton).toBeEnabled();
      const retryControls = guardTranslation.locator("[data-paralume-retry]");
      await expect(retryControls).toHaveCount(1);

      // A real click reaches attempt 4: no synthetic click consumed one.
      await retryButton.click();
      await expect(guardTranslation).toHaveText(
        /^【Mock [^】]+ attempt 4】Synthetic click guard fixture text\.$/u,
      );
    } finally {
      await guardCdp.detach();
      await guardPage.close();
    }
  });

  test("Retry inside a linked card neither navigates nor reaches page click handlers", async () => {
    if (context === undefined) {
      throw new Error("The extension browser context was not initialized.");
    }

    const cardPage = await context.newPage();
    const cardCdp = await context.newCDPSession(cardPage);
    try {
      await cardPage.goto(retryFixtureUrl);
      await cardPage.bringToFront();
      await expect(cardPage.locator(floatingMenuSelector)).toHaveCount(1);
      // A common card markup: the heading sits inside a link, so its
      // translation and Retry button are rendered inside the link too. Page
      // handlers on the card and the document stand in for framework
      // (e.g. SPA Link / delegated onClick) listeners.
      await cardPage.evaluate(() => {
        document.querySelector("#automatic-source")?.remove();
        const card = document.createElement("div");
        card.id = "linked-card";
        const link = document.createElement("a");
        link.id = "linked-card-link";
        link.href = "#linked-card-navigated";
        const heading = document.createElement("h3");
        heading.id = "linked-card-source";
        heading.textContent =
          "[[PARALUME_MOCK_RESULT_FAILURE:3:SERVER_UNAVAILABLE]] Linked card retry fixture text.";
        link.append(heading);
        card.append(link);
        document.querySelector("main")?.prepend(card);
        Reflect.set(window, "linkedCardClicks", 0);
        Reflect.set(window, "documentClicks", 0);
        card.addEventListener("click", () => {
          Reflect.set(
            window,
            "linkedCardClicks",
            Number(Reflect.get(window, "linkedCardClicks")) + 1,
          );
        });
        document.addEventListener("click", () => {
          Reflect.set(
            window,
            "documentClicks",
            Number(Reflect.get(window, "documentClicks")) + 1,
          );
        });
      });
      const readPageClicks = () =>
        cardPage.evaluate(() => ({
          card: Number(Reflect.get(window, "linkedCardClicks")),
          document: Number(Reflect.get(window, "documentClicks")),
          hash: window.location.hash,
        }));

      await clickFloatingMenuControl(
        cardPage,
        cardCdp,
        '[data-action="expand"]',
      );
      await clickFloatingMenuControl(
        cardPage,
        cardCdp,
        '[data-action="primary"]',
      );
      const cardTranslation = cardPage.locator(
        `#linked-card-source + ${translationSelector}`,
      );
      const retryButton = cardTranslation.locator(
        '[data-paralume-retry="true"]',
      );
      await expect(retryButton).toBeEnabled();
      // Retry really is a descendant of the page link in Chromium.
      await expect(
        cardPage.locator('#linked-card-link [data-paralume-retry="true"]'),
      ).toHaveCount(1);
      const beforeRetry = await readPageClicks();
      expect(beforeRetry.hash).toBe("");

      await retryButton.click();
      await expect(cardTranslation).toHaveText(
        /^【Mock [^】]+ attempt 4】Linked card retry fixture text\.$/u,
      );
      const afterRetry = await readPageClicks();
      expect(afterRetry).toEqual(beforeRetry);
      expect(cardPage.url()).toBe(retryFixtureUrl);

      // The page's own link and card behavior is untouched.
      await cardPage.locator("#linked-card-source").click();
      await expect
        .poll(() => readPageClicks())
        .toEqual({
          card: beforeRetry.card + 1,
          document: beforeRetry.document + 1,
          hash: "#linked-card-navigated",
        });
    } finally {
      await cardCdp.detach();
      await cardPage.close();
    }
  });

  test("content scripts cannot use privileged settings commands or read stored keys", async () => {
    if (context === undefined) {
      throw new Error("The extension browser context was not initialized.");
    }

    const keyMarker = "e2e-sender-guard-key-marker";
    const trustedOrigin = "https://provider-c.example.test/v1";
    const sendFromExtensionPage = (message: unknown) =>
      popupPage.evaluate(async (payload) => {
        const extensionApi = (
          globalThis as unknown as {
            chrome: {
              runtime: { sendMessage(message: unknown): Promise<unknown> };
            };
          }
        ).chrome;
        return extensionApi.runtime.sendMessage(payload);
      }, message);
    const draftFor = (provider: "openai" | "mock", baseUrl: string) => ({
      provider,
      openai: {
        baseUrl,
        model: "strict-schema-test-model",
        protocol: "responses",
        reasoningEffort: "low",
      },
      microsoft: {
        endpoint: "https://api.cognitive.microsofttranslator.com",
        region: "global",
      },
      retry: { enabled: true, maxRetries: 2 },
      appearance: {
        fontFamily: "system",
        fontSize: 16,
        textColor: "#456257",
        backgroundColor: "#f4f8f5",
        lineHeight: 1.6,
        opacity: 1,
        verticalSpacing: 8,
      },
      uiLanguage: "en",
    });
    const save = (
      provider: "openai" | "mock",
      baseUrl: string,
      apiKeys: Record<string, string>,
    ) =>
      sendFromExtensionPage({
        protocolVersion: 1,
        target: "settings",
        command: "save",
        draft: draftFor(provider, baseUrl),
        apiKeys,
      });

    // Extension pages (popup tab here) remain authorized. The endpoint never
    // resolves, so no real provider is reachable even if a check regressed.
    await expect(
      save("openai", trustedOrigin, { openaiApiKey: keyMarker }),
    ).resolves.toMatchObject({
      ok: true,
      settings: { openai: { apiKeyConfigured: true } },
    });

    const worker = context
      .serviceWorkers()
      .find((candidate) =>
        candidate.url().startsWith(`chrome-extension://${extensionId}/`),
      );
    expect(worker).toBeDefined();
    // Same call the background makes at startup; repeating it is idempotent
    // and reports whether this Chromium supports restricting storage.local.
    const accessLevelSupported = await worker?.evaluate(() => {
      const storageApi = (
        globalThis as unknown as {
          chrome: {
            storage: {
              local: {
                setAccessLevel?: (options: {
                  accessLevel: string;
                }) => Promise<void>;
              };
            };
          };
        }
      ).chrome.storage.local;
      return typeof storageApi.setAccessLevel === "function"
        ? storageApi.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).then(
            () => true,
            () => false,
          )
        : false;
    });

    const articlePage = await context.newPage();
    const pageCdp = await context.newCDPSession(articlePage);
    try {
      await articlePage.goto(fixtureUrl);
      // The menu only installs after the background answered get-site-state
      // for the real content-script sender URL.
      await expect(articlePage.locator(floatingMenuSelector)).toHaveCount(1);

      const contexts: {
        id: number;
        name: string;
        origin: string;
        auxData?: { type?: string; frameId?: string };
      }[] = [];
      pageCdp.on("Runtime.executionContextCreated", (event) => {
        contexts.push(event.context);
      });
      await pageCdp.send("Runtime.enable");
      const { frameTree } = await pageCdp.send("Page.getFrameTree");
      const findContentWorld = () =>
        contexts.find(
          (candidate) =>
            candidate.auxData?.type === "isolated" &&
            candidate.auxData.frameId === frameTree.frame.id &&
            (candidate.name === "Paralume" ||
              candidate.origin === `chrome-extension://${extensionId}`),
        );
      await expect.poll(() => findContentWorld()?.id).toBeDefined();
      const contentWorld = findContentWorld();
      if (contentWorld === undefined) {
        throw new Error("The Paralume content-script world was not found.");
      }

      const probe = async (attackerDraft: unknown) => {
        const extensionApi = (
          globalThis as unknown as {
            chrome: {
              runtime: { sendMessage(message: unknown): Promise<unknown> };
              storage?: {
                local?: { get(key: string): Promise<Record<string, unknown>> };
              };
            };
          }
        ).chrome;
        const base = { protocolVersion: 1, target: "settings" };
        const send = (message: Record<string, unknown>) =>
          extensionApi.runtime.sendMessage({ ...base, ...message });
        const responses = {
          get: await send({ command: "get" }),
          save: await send({
            command: "save",
            draft: attackerDraft,
            apiKeys: {},
          }),
          clear: await send({ command: "clear-api-key", provider: "openai" }),
          test: await send({ command: "test-connection" }),
          content: await send({ command: "get-content" }),
          site: await send({ command: "get-site-state" }),
        };
        let storageReadable: boolean;
        try {
          const stored =
            await extensionApi.storage?.local?.get("providerSettings");
          storageReadable = stored?.["providerSettings"] !== undefined;
        } catch {
          storageReadable = false;
        }
        // Only booleans and protocol responses leave the content world.
        return { responses, storageReadable };
      };
      const { result, exceptionDetails } = await pageCdp.send(
        "Runtime.evaluate",
        {
          expression: `(${probe.toString()})(${JSON.stringify(
            draftFor("openai", "https://attacker.example.test/v1"),
          )})`,
          contextId: contentWorld.id,
          awaitPromise: true,
          returnByValue: true,
        },
      );
      expect(exceptionDetails).toBeUndefined();
      const probed = result.value as {
        responses: Record<string, unknown>;
        storageReadable: boolean;
      };

      for (const command of ["get", "save", "clear", "test"]) {
        expect(probed.responses[command]).toMatchObject({
          ok: false,
          error: { code: "INVALID_MESSAGE" },
        });
      }
      expect(probed.responses["content"]).toMatchObject({
        ok: true,
        contentSettings: { uiLanguage: "en" },
      });
      expect(probed.responses["site"]).toEqual({
        protocolVersion: 1,
        ok: true,
        siteDisabled: false,
      });
      expect(JSON.stringify(probed)).not.toContain(keyMarker);
      if (accessLevelSupported === true) {
        expect(probed.storageReadable).toBe(false);
      } else {
        test.info().annotations.push({
          type: "limitation",
          description:
            "This Chromium rejected storage.local.setAccessLevel; content scripts can still read storage.local directly.",
        });
      }
    } finally {
      await pageCdp.detach();
      await articlePage.close();
    }

    // Nothing the content script sent changed the stored configuration.
    await expect(
      sendFromExtensionPage({
        protocolVersion: 1,
        target: "settings",
        command: "get",
      }),
    ).resolves.toMatchObject({
      ok: true,
      settings: {
        provider: "openai",
        openai: { baseUrl: trustedOrigin, apiKeyConfigured: true },
      },
    });

    // Moving to another origin without a new key drops the stored key.
    await expect(
      save("openai", "https://provider-d.example.test/v1", {}),
    ).resolves.toMatchObject({
      ok: true,
      message: { id: "settings.savedApiKeyRemoved" },
      settings: { openai: { apiKeyConfigured: false } },
    });

    await expect(
      save("mock", "https://provider-d.example.test/v1", {}),
    ).resolves.toMatchObject({ ok: true, settings: { provider: "mock" } });
  });
});
