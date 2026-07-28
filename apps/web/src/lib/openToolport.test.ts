import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const openExternal = vi.fn();

vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    shell: { openExternal },
  }),
  ensureLocalApi: () => ({
    shell: { openExternal },
  }),
}));

import { openToolportApp, TOOLPORT_APP_DEEP_LINK, TOOLPORT_WEB_FALLBACK } from "./openToolport";

describe("openToolportApp", () => {
  beforeEach(() => {
    openExternal.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("opens the Toolport deep link when the OS accepts it", async () => {
    openExternal.mockResolvedValue(undefined);
    await expect(openToolportApp()).resolves.toBe("app");
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(TOOLPORT_APP_DEEP_LINK);
  });

  it("falls back to the web app when the deep link fails", async () => {
    openExternal
      .mockRejectedValueOnce(new Error("Unable to open link."))
      .mockResolvedValueOnce(undefined);
    await expect(openToolportApp()).resolves.toBe("web");
    expect(openExternal.mock.calls).toEqual([[TOOLPORT_APP_DEEP_LINK], [TOOLPORT_WEB_FALLBACK]]);
  });

  it("returns failed when neither deep link nor web open works", async () => {
    openExternal.mockRejectedValue(new Error("blocked"));
    await expect(openToolportApp()).resolves.toBe("failed");
  });
});
