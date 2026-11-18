import { describe, expect, it } from "vitest";

import {
  createSitePreferenceStore,
  DISABLED_SITES_STORAGE_KEY,
} from "../src/settings/site-preferences";

/**
 * Asynchronous storage like chrome.storage.local: `get` snapshots the value
 * when called and resolves on a later macrotask, so interleaved
 * read-modify-write sequences can observe the same stale snapshot.
 */
function createAsyncStorage(options: { failSetCalls?: Set<number> } = {}) {
  const values: Record<string, unknown> = {};
  let setCalls = 0;
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    values,
    async get(key: string): Promise<Record<string, unknown>> {
      const snapshot = structuredClone(values[key]);
      await tick();
      return snapshot === undefined ? {} : { [key]: snapshot };
    },
    async set(items: Record<string, unknown>): Promise<void> {
      setCalls += 1;
      const call = setCalls;
      await tick();
      if (options.failSetCalls?.has(call) === true) {
        throw new Error("Storage write failed.");
      }
      Object.assign(values, structuredClone(items));
    },
  };
}

describe("site preference store", () => {
  it("keeps every site when several sites are disabled concurrently", async () => {
    const storage = createAsyncStorage();
    const store = createSitePreferenceStore(storage);

    await Promise.all([
      store.disable("a.example"),
      store.disable("b.example"),
      store.disable("c.example"),
    ]);

    expect(storage.values[DISABLED_SITES_STORAGE_KEY]).toEqual([
      "a.example",
      "b.example",
      "c.example",
    ]);
    for (const site of ["a.example", "b.example", "c.example"]) {
      await expect(store.isDisabled(site)).resolves.toBe(true);
    }
  });

  it("rejects only the failed write and keeps processing later disables", async () => {
    const storage = createAsyncStorage({ failSetCalls: new Set([1]) });
    const store = createSitePreferenceStore(storage);

    const results = await Promise.allSettled([
      store.disable("a.example"),
      store.disable("b.example"),
    ]);

    expect(results[0]).toMatchObject({ status: "rejected" });
    expect(results[1]).toEqual({ status: "fulfilled", value: undefined });
    expect(storage.values[DISABLED_SITES_STORAGE_KEY]).toEqual(["b.example"]);

    await store.disable("c.example");
    await store.disable("a.example");
    expect(storage.values[DISABLED_SITES_STORAGE_KEY]).toEqual([
      "a.example",
      "b.example",
      "c.example",
    ]);
  });

  it("does not rewrite storage when the site is already disabled", async () => {
    const storage = createAsyncStorage({ failSetCalls: new Set([2]) });
    const store = createSitePreferenceStore(storage);

    await store.disable("a.example");
    // A second write would fail (call 2); an idempotent disable never makes it.
    await expect(store.disable("a.example")).resolves.toBeUndefined();
    expect(storage.values[DISABLED_SITES_STORAGE_KEY]).toEqual(["a.example"]);
  });
});
