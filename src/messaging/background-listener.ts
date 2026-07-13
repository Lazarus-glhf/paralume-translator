import { sanitizeError } from "../shared/errors";
import { createErrorResponse } from "./protocol";
import type { BackgroundMessageContext } from "./background-handler";

export type BackgroundMessageHandler<Sender = unknown> = (
  message: unknown,
  context: BackgroundMessageContext<Sender>,
) => Promise<unknown>;

export type BackgroundRuntimeListener<Sender> = (
  message: unknown,
  sender: Sender,
  sendResponse: (response: unknown) => void,
) => boolean;

export interface BackgroundMessageEvent<Sender> {
  addListener(listener: BackgroundRuntimeListener<Sender>): void;
}

export function registerBackgroundMessageListener<Sender>(
  onMessage: BackgroundMessageEvent<Sender>,
  handleMessage: BackgroundMessageHandler<Sender>,
): void {
  onMessage.addListener((message, sender, sendResponse) => {
    void Promise.resolve()
      .then(() => handleMessage(message, { sender }))
      .then(
        (response) => {
          sendResponse(response);
        },
        (error: unknown) => {
          sendResponse(
            createErrorResponse(sanitizeError(error, "INTERNAL_ERROR")),
          );
        },
      );

    return true;
  });
}
