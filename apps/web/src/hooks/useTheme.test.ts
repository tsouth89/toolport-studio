import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme failure handling", () => {
  it("preserves exact storage causes and operation context", async () => {
    const readCause = new Error("storage read blocked");
    const writeCause = new Error("storage quota exceeded");
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw readCause;
        },
        setItem: () => {
          throw writeCause;
        },
      }),
    });

    const { readThemePreference, ThemeStorageError, writeThemePreference } =
      await import("./useTheme");

    try {
      readThemePreference();
      expect.unreachable("expected the theme read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "read",
        storageKey: "toolport-studio:theme",
        cause: readCause,
      });
    }

    try {
      writeThemePreference("dark");
      expect.unreachable("expected the theme write to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "write",
        storageKey: "toolport-studio:theme",
        theme: "dark",
        cause: writeCause,
      });
    }
  });

  it("falls back during initial theme application and logs only safe attributes", async () => {
    const cause = new Error("private browsing storage failure");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw cause;
        },
      }),
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal("document", {
      documentElement: {
        classList: { toggle: vi.fn() },
      },
    });

    await expect(import("./useTheme")).resolves.toBeDefined();

    expect(errorLog).toHaveBeenCalledWith(
      "Failed to read theme preference for toolport-studio:theme.",
      expect.objectContaining({
        operation: "read",
        storageKey: "toolport-studio:theme",
        errorTag: "ThemeStorageError",
      }),
    );
    const attributes = errorLog.mock.calls[0]?.[1];
    expect(attributes).not.toHaveProperty("cause");
    expect(JSON.stringify(attributes)).not.toContain(cause.message);
  });

  it("retries a failed storage read only after a relevant storage event", async () => {
    const cause = new Error("persistent storage failure");
    const themeGetItem = vi.fn((): string | null => {
      throw cause;
    });
    const getItem = vi.fn((key: string) =>
      key === "toolport-studio:theme" ? themeGetItem() : null,
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let readSnapshot: (() => unknown) | undefined;
    let subscribeToTheme: ((listener: () => void) => () => void) | undefined;
    let storageHandler: ((event: StorageEvent) => void) | undefined;
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => {
        subscribeToTheme = subscribe;
        readSnapshot = getSnapshot;
        return getSnapshot();
      },
    }));
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === "storage") storageHandler = listener;
      },
      localStorage: createStorage({ getItem }),
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });

    const { useTheme } = await import("./useTheme");
    useTheme();
    readSnapshot?.();
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);

    const unsubscribe = subscribeToTheme?.(() => undefined);
    storageHandler?.({ key: "toolport-studio:theme" } as StorageEvent);
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledTimes(2);
    unsubscribe?.();
  });

  it("refreshes an active custom palette and falls back when it is removed", async () => {
    const storage = createStorage();
    storage.setItem("toolport-studio:theme", "aurora");
    storage.setItem("toolport-studio:theme-appearance-mode", "light");
    storage.setItem(
      "toolport-studio:themes:v1",
      JSON.stringify([
        {
          id: "aurora",
          label: "Aurora",
          appearance: "light",
          colors: { canvas: "#f8fbff", accent: "#5b6cff" },
        },
      ]),
    );
    const variables = new Map<string, string>();
    const root = {
      classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
      dataset: {} as Record<string, string>,
      offsetHeight: 0,
      style: {
        backgroundColor: "",
        removeProperty: (name: string) => variables.delete(name),
        setProperty: (name: string, value: string) => variables.set(name, value),
      },
    };
    const body = { style: { backgroundColor: "" } };
    let readSnapshot: (() => { theme: string }) | undefined;
    let subscribeToTheme: ((listener: () => void) => () => void) | undefined;
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => { theme: string },
      ) => {
        subscribeToTheme = subscribe;
        readSnapshot = getSnapshot;
        return getSnapshot();
      },
    }));
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      localStorage: storage,
      matchMedia: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("document", {
      body,
      createElement: () => ({ name: "", setAttribute: vi.fn() }),
      documentElement: root,
      head: { append: vi.fn() },
      querySelector: (selector: string) => (selector.startsWith("meta") ? null : body),
      querySelectorAll: () => [],
    });
    vi.stubGlobal("getComputedStyle", () => ({
      backgroundColor: "#ffffff",
      getPropertyValue: (name: string) => variables.get(name) ?? "",
    }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    const { useTheme } = await import("./useTheme");
    const { getCustomThemes, getThemeColorVariable, removeCustomTheme, updateCustomTheme } =
      await import("../themePalette");
    useTheme();
    const listener = vi.fn();
    const unsubscribe = subscribeToTheme?.(listener);
    const current = getCustomThemes()[0]!;
    updateCustomTheme({
      ...current,
      colors: { ...current.colors, canvas: "#eef2ff" },
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(variables.get(getThemeColorVariable("canvas"))).toBe("#eef2ff");
    expect(readSnapshot?.().theme).toBe("aurora");

    removeCustomTheme("aurora");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(readSnapshot?.().theme).toBe("system");
    expect(root.dataset.themeId).toBeUndefined();
    unsubscribe?.();
  });

  it("preserves desktop sync causes and retries after a failed cosmetic sync", async () => {
    const cause = new Error("desktop IPC unavailable");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const setTheme = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("window", { desktopBridge: { setTheme } });

    const { DesktopThemeSyncError, syncDesktopTheme, syncDesktopThemePreference } =
      await import("./useTheme");

    const error = await syncDesktopThemePreference({ setTheme }, "dark").then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(DesktopThemeSyncError);
    expect(error).toMatchObject({ theme: "dark", cause });

    setTheme.mockClear();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();

    expect(setTheme).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledWith(
      "Failed to sync the dark theme to the desktop shell.",
      expect.objectContaining({
        theme: "dark",
        errorTag: "DesktopThemeSyncError",
      }),
    );
    for (const [, attributes] of errorLog.mock.calls) {
      expect(attributes).not.toHaveProperty("cause");
      expect(JSON.stringify(attributes)).not.toContain(cause.message);
    }
  });
});
