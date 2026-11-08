import { describe, expect, it } from "vitest";
import { InvalidItemUrlError, parseItemNumber, parseItemUrl } from "../src/costcoUrl";

describe("parseItemUrl()", () => {
  it("parses and normalizes a product URL", () => {
    expect(parseItemUrl(" https://www.costco.com/p/-/la-mer-cream-34-oz/100511846?langId=-1#reviews ")).toEqual({
      itemNumber: "100511846",
      url: "https://www.costco.com/p/-/la-mer-cream-34-oz/100511846",
    });
  });

  it("accepts costco.com without www and a trailing slash", () => {
    expect(parseItemUrl("https://costco.com/p/-/tv/4201001045/").itemNumber).toBe("4201001045");
  });

  it.each([
    ["not a url", /valid URL/],
    ["https://www.amazon.com/p/-/x/123", /costco\.com/],
    ["https://www.costco.com/", /product page/],
    ["https://www.costco.com/s?keyword=tv", /product page/],
    ["https://www.costco.com/p/-/name/abc", /product page/],
  ])("rejects %s", (input, message) => {
    expect(() => parseItemUrl(input)).toThrow(InvalidItemUrlError);
    expect(() => parseItemUrl(input)).toThrow(message);
  });
});

describe("parseItemNumber()", () => {
  it("returns null for non-product URLs", () => {
    expect(parseItemNumber("https://www.costco.com/")).toBeNull();
    expect(parseItemNumber("garbage")).toBeNull();
  });
});
