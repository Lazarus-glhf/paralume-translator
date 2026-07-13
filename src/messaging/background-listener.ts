import { createError, messageFromUnknown } from "../shared/errors";
import { createErrorResponse, type TranslationResponse } from "./protocol";

export type BackgroundMessageHandler = (
  message: unknown,
) => Promise<TranslationResponse>;

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
  handleMessage: BackgroundMessageHandler,
): void {
  onMessage.addListener((message, _sender, sendResponse) => {
    void Promise.resolve()
      .then(() => handleMessage(message))
      .then(
        (response) => {
          sendResponse(response);
        },
        (error: unknown) => {
          sendResponse(
            createErrorResponse(
              createError(
                "INTERNAL_ERROR",
                `The background listener could not process the message: ${messageFromUnknown(error)}`,
                true,
              ),
            ),
          );
        },
      );

    return true;
  });
}
