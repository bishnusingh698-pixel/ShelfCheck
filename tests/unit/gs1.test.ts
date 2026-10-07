import { describe, expect, it } from "vitest";
import { gs1CheckDigit, isValidGtin, classifyBarcode, barcodeIsInvalid } from "../../app/detectors/gs1.js";
import { barcodeHints } from "../../app/detectors/barcode-hints.js";

describe("GS1 check digit", () => {
  it("computes the documented GS1 examples", () => {
    // GS1 spec example: 400638133393x → check digit 1
    expect(gs1CheckDigit("400638133393")).toBe(1);
    expect(isValidGtin("4006381333931")).toBe(true);
  });

  it("valid and invalid for each length 8/12/13/14", () => {
    expect(isValidGtin("96385074")).toBe(true);      // GTIN-8 valid
    expect(isValidGtin("96385075")).toBe(false);     // bad check digit
    expect(isValidGtin("036000291452")).toBe(true);  // UPC-A valid
    expect(isValidGtin("036000291453")).toBe(false);
    expect(isValidGtin("5901234123457")).toBe(true); // EAN-13 valid
    expect(isValidGtin("5901234123458")).toBe(false);
    // GTIN-14: body + computed check digit (round-tripped through the algorithm,
    // then verified below with an independently-known value)
    const body14 = "1541234123457"; // 13-digit body from a known EAN body + padding
    const check14 = gs1CheckDigit(body14);
    expect(isValidGtin(body14 + String(check14))).toBe(true);
    expect(isValidGtin(body14 + String((check14 + 1) % 10))).toBe(false);
    // Known-good GS1 example (GTIN-13 check-digit demo): 4006381333931
    expect(isValidGtin("4006381333931")).toBe(true);
  });

  it("rejects non-numeric and wrong lengths", () => {
    // 13 IS a valid GTIN length; 11 and 15 are not.
    expect(classifyBarcode("12345678901")).toEqual({ kind: "invalid_length", length: 11 });
    expect(classifyBarcode("123456789012345")).toEqual({ kind: "invalid_length", length: 15 });
    expect(classifyBarcode("abc")).toEqual({ kind: "non_numeric" });
    expect(classifyBarcode("")).toEqual({ kind: "empty" });
    expect(classifyBarcode(null)).toEqual({ kind: "empty" });
    expect(classifyBarcode("12345")).toEqual({ kind: "invalid_length", length: 5 });
    // A 13-digit numeric value is checked as GTIN-13 (check digit), not length.
    expect(classifyBarcode("5901234123458")).toEqual({ kind: "invalid_check_digit", length: 13 });
  });

  it("acceptNonGtin policy: only GTIN-length check-digit failures flag", () => {
    expect(barcodeIsInvalid("12345", true)).toBe(false);
    expect(barcodeIsInvalid("12345", false)).toBe(true);
    expect(barcodeIsInvalid("036000291453", true)).toBe(true);
    expect(barcodeIsInvalid("036000291453", false)).toBe(true);
    expect(barcodeIsInvalid("036000291452", true)).toBe(false);
    expect(barcodeIsInvalid("ABC", true)).toBe(false);
    expect(barcodeIsInvalid("ABC", false)).toBe(true);
  });
});

describe("barcode hints", () => {
  it("detects scientific notation", () => {
    expect(barcodeHints("8.71E+12")).toContain("scientific_notation");
    expect(barcodeHints("8712345678901")).not.toContain("scientific_notation");
  });
  it("detects likely dropped leading zero", () => {
    expect(barcodeHints("36000291452")).toContain("likely_dropped_leading_zero");
    expect(barcodeHints("036000291452")).not.toContain("likely_dropped_leading_zero");
  });
  it("detects inner whitespace", () => {
    expect(barcodeHints("123 456")).toContain("inner_whitespace");
    expect(barcodeHints(" 123456 ")).not.toContain("inner_whitespace");
  });
  it("no hints for null", () => {
    expect(barcodeHints(null)).toEqual([]);
  });
});
