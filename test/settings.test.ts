import { describe, expect, it } from "vitest";
import { RUN_TAB_MARK, isValidServiceUrl, shouldCloseTab } from "../extension/src/settings";

describe("shouldCloseTab", () => {
  it("closes a run tab once its price is saved (or was already saved)", () => {
    expect(shouldCloseTab(true, true, "saved", true)).toBe(true);
    expect(shouldCloseTab(true, true, "duplicate", true)).toBe(true);
  });
  it("never closes a tab you opened yourself", () => {
    expect(shouldCloseTab(false, true, "saved", true)).toBe(false);
  });
  it("keeps the tab open when no price was found, so you can see why", () => {
    expect(shouldCloseTab(true, false, "saved", true)).toBe(false);
  });
  it("keeps it open when the price couldn't be delivered, or the option is off", () => {
    expect(shouldCloseTab(true, true, "queued", true)).toBe(false);
    expect(shouldCloseTab(true, true, "rejected", true)).toBe(false);
    expect(shouldCloseTab(true, true, "unwatched", true)).toBe(false);
    expect(shouldCloseTab(true, true, "saved", false)).toBe(false);
  });
});

describe("run tab mark", () => {
  it("matches the fragment the service adds", () => {
    expect(RUN_TAB_MARK.test("#cpw-run=20261108T195744-9025da")).toBe(true);
    expect(RUN_TAB_MARK.test("#reviews&cpw-run=abc")).toBe(true);
    expect(RUN_TAB_MARK.test("#reviews")).toBe(false);
    expect(RUN_TAB_MARK.test("")).toBe(false);
  });
});

describe("isValidServiceUrl", () => {
  it("allows only this Mac", () => {
    expect(isValidServiceUrl("http://127.0.0.1:4000")).toBe(true);
    expect(isValidServiceUrl("http://localhost:4000/")).toBe(true);
    expect(isValidServiceUrl("http://example.com:4000")).toBe(false);
  });
});
