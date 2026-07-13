import { describe, expect, it, vi } from "vitest";

import {
  getProviderOriginPattern,
  hasProviderOriginPermission,
  requestProviderOriginPermission,
  removeStaleProviderOriginPermission,
  type ProviderPermissionsApi,
} from "../src/settings/permissions";
import { DEFAULT_PROVIDER_SETTINGS } from "../src/settings/repository";

function settings(provider: "mock" | "openai" | "microsoft") {
  return {
    ...DEFAULT_PROVIDER_SETTINGS,
    provider,
    openai: {
      ...DEFAULT_PROVIDER_SETTINGS.openai,
      baseUrl: "https://api.example.com:8443/v1",
    },
    microsoft: {
      ...DEFAULT_PROVIDER_SETTINGS.microsoft,
      endpoint: "https://translator.example.net/custom/path",
    },
  };
}

function permissionsApi(
  contains: boolean,
  request: boolean,
): ProviderPermissionsApi {
  return {
    contains: vi.fn(() => Promise.resolve(contains)),
    request: vi.fn(() => Promise.resolve(request)),
    remove: vi.fn(() => Promise.resolve(true)),
  };
}

describe("provider origin permissions", () => {
  it("derives only the selected provider's exact HTTPS origin", () => {
    expect(getProviderOriginPattern(settings("mock"))).toBeUndefined();
    expect(getProviderOriginPattern(settings("openai"))).toBe(
      "https://api.example.com:8443/*",
    );
    expect(getProviderOriginPattern(settings("microsoft"))).toBe(
      "https://translator.example.net/*",
    );
  });

  it("requests one exact origin directly without a preceding contains call", async () => {
    const permissions = permissionsApi(true, true);

    await expect(
      requestProviderOriginPermission(settings("openai"), permissions),
    ).resolves.toBeUndefined();
    expect(permissions.request).toHaveBeenCalledWith({
      origins: ["https://api.example.com:8443/*"],
    });
    expect(permissions.contains).not.toHaveBeenCalled();
  });

  it("fails with a fixed safe error when the user denies the exact origin", async () => {
    const permissions = permissionsApi(false, false);

    await expect(
      requestProviderOriginPermission(settings("microsoft"), permissions),
    ).rejects.toMatchObject({ code: "PERMISSION_MISSING" });
    expect(permissions.request).toHaveBeenCalledWith({
      origins: ["https://translator.example.net/*"],
    });
  });

  it("detects a revoked permission without re-requesting it", async () => {
    const permissions = permissionsApi(false, true);

    await expect(
      hasProviderOriginPermission(settings("openai"), permissions),
    ).resolves.toBe(false);
    expect(permissions.request).not.toHaveBeenCalled();
  });

  it("removes the previous exact origin after an endpoint change", async () => {
    const permissions = permissionsApi(true, true);
    const previous = settings("openai");
    const next = {
      ...previous,
      openai: { ...previous.openai, baseUrl: "https://new.example.com/v1" },
    };

    await expect(
      removeStaleProviderOriginPermission(previous, next, permissions),
    ).resolves.toBe("removed");

    expect(permissions.remove).toHaveBeenCalledWith({
      origins: ["https://api.example.com:8443/*"],
    });
  });

  it.each([false, "reject"] as const)(
    "reports stale-origin cleanup failure without throwing: %s",
    async (outcome) => {
      const previous = settings("openai");
      const next = {
        ...previous,
        openai: { ...previous.openai, baseUrl: "https://new.example.com/v1" },
      };
      const permissions = permissionsApi(true, true);
      const remove = permissions.remove;
      if (remove === undefined) {
        throw new Error("The permissions test requires remove().");
      }
      vi.mocked(remove).mockImplementation(() =>
        outcome === "reject"
          ? Promise.reject(new Error("LEAK_REMOVE_DETAIL"))
          : Promise.resolve(false),
      );

      await expect(
        removeStaleProviderOriginPermission(previous, next, permissions),
      ).resolves.toBe("failed");
    },
  );
});
