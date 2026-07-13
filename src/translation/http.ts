export type TranslationFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpProviderDependencies {
  fetch?: TranslationFetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

export async function fetchProviderJson(
  _serviceName: string,
  url: string,
  init: RequestInit,
  dependencies: HttpProviderDependencies,
): Promise<unknown> {
  const fetchRequest = dependencies.fetch ?? defaultFetch;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetchRequest(url, { ...init, signal: controller.signal });
  } catch {
    if (controller.signal.aborted) {
      throw new UserFacingError("REQUEST_TIMEOUT");
    }
    throw new UserFacingError("NETWORK_ERROR");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    switch (response.status) {
      case 401:
      case 403:
        throw new UserFacingError("AUTHENTICATION_FAILED");
      case 429:
        throw new UserFacingError("RATE_LIMITED");
      case 408:
        throw new UserFacingError("REQUEST_TIMEOUT");
      default:
        if (response.status >= 500) {
          throw new UserFacingError("SERVER_UNAVAILABLE");
        }
        throw new UserFacingError("VALIDATION_ERROR");
    }
  }

  try {
    return (await response.json()) as unknown;
  } catch {
    throw new UserFacingError("MALFORMED_JSON");
  }
}
import { UserFacingError } from "../shared/errors";
