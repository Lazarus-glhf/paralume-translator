import type { BrowserContext, CDPSession, Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ActionPopup {
  activeTabId(): Promise<number | undefined>;
  activeTabUrl(): Promise<string | undefined>;
  click(action: "translate" | "toggle" | "clear"): Promise<void>;
  close(): Promise<void>;
  statusText(): Promise<string | undefined>;
  waitForStatus(expected: string): Promise<void>;
}

interface CdpResponseMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

interface RuntimeEvaluationResult {
  exceptionDetails?: { text?: string };
  result?: { value?: unknown };
}

class ActionPopupTarget implements ActionPopup {
  private nextMessageId = 1;
  private readonly pendingMessages = new Map<
    number,
    {
      reject: (reason: Error) => void;
      resolve: (value: unknown) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  private readonly handleTargetMessage = ({
    message,
    sessionId,
  }: {
    message: string;
    sessionId: string;
  }) => {
    if (sessionId !== this.sessionId) {
      return;
    }

    const response = JSON.parse(message) as CdpResponseMessage;
    if (response.id === undefined) {
      return;
    }

    const pending = this.pendingMessages.get(response.id);
    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingMessages.delete(response.id);

    if (response.error !== undefined) {
      pending.reject(
        new Error(response.error.message ?? "The popup CDP command failed."),
      );
      return;
    }

    pending.resolve(response.result);
  };

  constructor(
    private readonly cdp: CDPSession,
    private readonly sessionId: string,
    private readonly targetId: string,
  ) {
    this.cdp.on("Target.receivedMessageFromTarget", this.handleTargetMessage);
  }

  async initialize(): Promise<void> {
    await this.send("Runtime.enable");
    await this.waitFor(
      `document.readyState !== "loading" && document.querySelector("#popup-title")?.textContent === "Paralume"`,
    );
  }

  async activeTabUrl(): Promise<string | undefined> {
    return (await this.evaluate(`(async () => {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      return activeTab?.url;
    })()`)) as string | undefined;
  }

  async activeTabId(): Promise<number | undefined> {
    return (await this.evaluate(`(async () => {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      return activeTab?.id;
    })()`)) as number | undefined;
  }

  async click(action: "translate" | "toggle" | "clear"): Promise<void> {
    await this.waitFor(`(() => {
      const button = document.querySelector('[data-action="${action}"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    })()`);
    await this.evaluate(`(() => {
      const button = document.querySelector('[data-action="${action}"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('The ${action} popup button was not found.');
      }
      if (button.disabled) {
        throw new Error('The ${action} popup button is disabled.');
      }
      button.click();
    })()`);
  }

  async statusText(): Promise<string | undefined> {
    return (await this.evaluate(
      `document.querySelector('[role="status"]')?.textContent?.trim()`,
    )) as string | undefined;
  }

  async waitForStatus(expected: string): Promise<void> {
    await this.waitFor(
      `document.querySelector('[role="status"]')?.textContent?.trim() === ${JSON.stringify(expected)}`,
    );
  }

  async close(): Promise<void> {
    this.cdp.off("Target.receivedMessageFromTarget", this.handleTargetMessage);
    await this.cdp.send("Target.closeTarget", { targetId: this.targetId });
    await this.cdp.detach();
  }

  private async evaluate(expression: string): Promise<unknown> {
    const response = (await this.send("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true,
    })) as RuntimeEvaluationResult;

    if (response.exceptionDetails !== undefined) {
      throw new Error(
        response.exceptionDetails.text ?? "Popup evaluation failed.",
      );
    }

    return response.result?.value;
  }

  private async waitFor(expression: string): Promise<void> {
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      if ((await this.evaluate(expression)) === true) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(`Timed out waiting for popup condition: ${expression}`);
  }

  private async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const id = this.nextMessageId;
    this.nextMessageId += 1;

    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingMessages.delete(id);
        reject(new Error(`Timed out sending ${method} to the action popup.`));
      }, 10_000);
      this.pendingMessages.set(id, { reject, resolve, timeout });
    });

    try {
      await this.cdp.send("Target.sendMessageToTarget", {
        message: JSON.stringify({ id, method, params }),
        sessionId: this.sessionId,
      });
    } catch (error) {
      const pending = this.pendingMessages.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timeout);
        this.pendingMessages.delete(id);
      }
      throw error;
    }

    return response;
  }
}

export async function waitForDevToolsEndpoint(
  userDataDir: string,
): Promise<string> {
  const activePortPath = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    try {
      const [port, browserPath] = (
        await readFile(activePortPath, "utf8")
      ).split("\n");
      if (port !== undefined && browserPath !== undefined) {
        return `ws://127.0.0.1:${port}${browserPath}`;
      }
    } catch {
      // Chromium creates DevToolsActivePort asynchronously after launch.
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Chromium did not expose a DevTools endpoint.");
}

export async function triggerActionPopup(
  context: BrowserContext,
  browserCdp: CDPSession,
  extensionId: string,
  activePage: Page,
): Promise<ActionPopup> {
  const popupCdp = await context.newCDPSession(activePage);
  const targetsBeforeOpen = await popupCdp.send("Target.getTargets");
  const existingTargetIds = new Set(
    targetsBeforeOpen.targetInfos.map(({ targetId }) => targetId),
  );
  const tabTargets = await browserCdp.send("Target.getTargets", {
    filter: [{ type: "tab" }],
  });
  const activeTabTarget = tabTargets.targetInfos.find(
    (target) => target.url === activePage.url(),
  );

  if (activeTabTarget === undefined) {
    await popupCdp.detach();
    throw new Error(`Could not find the tab target for ${activePage.url()}.`);
  }

  await browserCdp.send("Target.activateTarget", {
    targetId: activeTabTarget.targetId,
  });

  // This browser-level command invokes the real default action on the chosen
  // tab, including Chrome's activeTab grant, instead of merely loading popup.html.
  await browserCdp.send("Extensions.triggerAction", {
    id: extensionId,
    targetId: activeTabTarget.targetId,
  });

  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  const deadline = Date.now() + 10_000;
  let popupTargetId: string | undefined;

  while (Date.now() < deadline && popupTargetId === undefined) {
    const targets = await popupCdp.send("Target.getTargets");
    popupTargetId = targets.targetInfos.find(
      (target) =>
        target.url === popupUrl && !existingTargetIds.has(target.targetId),
    )?.targetId;

    if (popupTargetId === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  if (popupTargetId === undefined) {
    await popupCdp.detach();
    throw new Error("Chromium did not create an action popup target.");
  }

  // Toolbar popups are CDP targets but are intentionally absent from
  // BrowserContext.pages(), so attach to the target and drive its real DOM.
  const { sessionId } = await popupCdp.send("Target.attachToTarget", {
    flatten: false,
    targetId: popupTargetId,
  });
  const popup = new ActionPopupTarget(popupCdp, sessionId, popupTargetId);
  await popup.initialize();
  return popup;
}
