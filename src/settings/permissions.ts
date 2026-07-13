import type { ProviderSettings } from "./types";
import { deriveHttpsOriginPattern } from "./validation";
import { UserFacingError } from "../shared/errors";

export interface OriginPermissionRequest {
  origins: string[];
}

export interface ProviderPermissionsApi {
  contains: (permission: OriginPermissionRequest) => Promise<boolean>;
  request: (permission: OriginPermissionRequest) => Promise<boolean>;
  remove?: (permission: OriginPermissionRequest) => Promise<boolean>;
}

export function getProviderOriginPattern(
  settings: ProviderSettings,
): string | undefined {
  switch (settings.provider) {
    case "mock":
      return undefined;
    case "openai":
      return deriveHttpsOriginPattern(settings.openai.baseUrl);
    case "microsoft":
      return deriveHttpsOriginPattern(settings.microsoft.endpoint);
  }
}

export async function hasProviderOriginPermission(
  settings: ProviderSettings,
  permissions: ProviderPermissionsApi,
): Promise<boolean> {
  const origin = getProviderOriginPattern(settings);
  return origin === undefined
    ? true
    : permissions.contains({ origins: [origin] });
}

export async function requestProviderOriginPermission(
  settings: ProviderSettings,
  permissions: ProviderPermissionsApi,
): Promise<void> {
  const origin = getProviderOriginPattern(settings);
  if (origin === undefined) {
    return;
  }

  if (!(await permissions.request({ origins: [origin] }))) {
    throw new UserFacingError("PERMISSION_MISSING");
  }
}

export type StalePermissionRemoval = "not-needed" | "removed" | "failed";

export async function removeStaleProviderOriginPermission(
  previous: ProviderSettings,
  next: ProviderSettings,
  permissions: ProviderPermissionsApi,
): Promise<StalePermissionRemoval> {
  const previousOrigin = getProviderOriginPattern(previous);
  const nextOrigin = getProviderOriginPattern(next);
  if (previousOrigin === undefined || previousOrigin === nextOrigin) {
    return "not-needed";
  }
  if (permissions.remove === undefined) {
    return "failed";
  }
  try {
    return (await permissions.remove({ origins: [previousOrigin] }))
      ? "removed"
      : "failed";
  } catch {
    return "failed";
  }
}
