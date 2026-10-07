// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const appEnv = vi.hoisted(() => ({ value: "production" as "production" | "test" }));
vi.mock("@/lib/env/app-env", () => ({
  get APP_ENV() {
    return appEnv.value;
  },
  isTestEnv: (env: string) => env !== "production",
}));

import { VIEW_BEACON_DELAY_MS, ViewBeacon, mayAnnounceView } from "./view-beacon";

const fetchMock = vi.fn();
let root: Root;
let counter = 0;

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}
function setWebdriver(value: boolean) {
  Object.defineProperty(navigator, "webdriver", { value, configurable: true });
}
async function mount(url: string) {
  await act(async () => {
    root.render(createElement(ViewBeacon, { viewUrl: url }));
  });
}
const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset().mockResolvedValue(new Response(null));
  vi.stubGlobal("fetch", fetchMock);
  setVisibility("visible");
  setWebdriver(false);
  appEnv.value = "production";
  root = createRoot(document.createElement("div"));
  counter += 1;
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mayAnnounceView", () => {
  it("un navegador automatizado solo cuenta en el entorno de pruebas", () => {
    expect(mayAnnounceView(false, false)).toBe(true);
    expect(mayAnnounceView(true, false)).toBe(false);
    expect(mayAnnounceView(true, true)).toBe(true);
  });
});

describe("ViewBeacon (H-030, menor 4)", () => {
  it("avisa una sola vez, tras unos 2 segundos con la pestaña visible", async () => {
    const url = `/v/${counter}`;
    await mount(url);
    await advance(VIEW_BEACON_DELAY_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(url);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("con la pestaña oculta no avisa hasta que se vea", async () => {
    setVisibility("hidden");
    await mount(`/v/${counter}`);
    await advance(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
    setVisibility("visible");
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await advance(VIEW_BEACON_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("si la pestaña se oculta antes de los 2 segundos, no avisa", async () => {
    await mount(`/v/${counter}`);
    await advance(1000);
    setVisibility("hidden");
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await advance(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("un navegador automatizado no avisa en producción", async () => {
    setWebdriver(true);
    await mount(`/v/${counter}`);
    await advance(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("en el entorno de pruebas, un navegador automatizado sí avisa (Playwright)", async () => {
    setWebdriver(true);
    appEnv.value = "test";
    await mount(`/v/${counter}`);
    await advance(VIEW_BEACON_DELAY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
