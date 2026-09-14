import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { parseOcrScore } from "../src/modules/ocr/ocr.service";

const GM = window.GM;

describe("parseOcrScore — German & European Localization", () => {
  it("correctly parses German \"T\" / \"Tsd\" (Tausend = 1,000) with comma decimal", () => {
    // Exact values from screenshot:
    // Rank 24: [PAIN]SPtheUtopian -> 67,4T
    expect(parseOcrScore(0, "67,4T")).toBe(67400);
    // Rank 25: [PAIN]Sumdac -> 24,98T
    expect(parseOcrScore(0, "24,98T")).toBe(24980);
    // Rank 26: [PAIN]Gawronik -> 12,55T
    expect(parseOcrScore(0, "12,55T")).toBe(12550);
  });

  it("correctly parses European period thousands separator without suffix", () => {
    // Rank 27: [PAIN]HolyKnightKal -> 5.663
    expect(parseOcrScore(0, "5.663")).toBe(5663);
    expect(parseOcrScore(0, "12.550")).toBe(12550);
    expect(parseOcrScore(0, "5,663")).toBe(5663);
  });

  it("handles variations with spaces and Tsd suffix", () => {
    expect(parseOcrScore(0, "67,4 T")).toBe(67400);
    expect(parseOcrScore(0, "67,4 Tsd")).toBe(67400);
    expect(parseOcrScore(0, "500T")).toBe(500000);
    expect(parseOcrScore(0, "~67,4T")).toBe(67400);
    expect(parseOcrScore(0, "> 24,98T")).toBe(24980);
  });

  it("handles compound numbers with both thousands and decimal separators", () => {
    // European style: 1.234,5T = 1,234.5 * 1000 = 1,234,500
    expect(parseOcrScore(0, "1.234,5T")).toBe(1234500);
    // US style: 1,234.5T = 1,234.5 * 1000 = 1,234,500
    expect(parseOcrScore(0, "1,234.5T")).toBe(1234500);
  });

  it("correctly parses standard K, M, Mio, B, Mrd formats", () => {
    expect(parseOcrScore(0, "500K")).toBe(500000);
    expect(parseOcrScore(0, "145.2M")).toBe(145200000);
    expect(parseOcrScore(0, "145,2M")).toBe(145200000);
    expect(parseOcrScore(0, "1,2 Mio")).toBe(1200000);
    expect(parseOcrScore(0, "2.16B")).toBe(2160000000);
    expect(parseOcrScore(0, "2,16 Mrd")).toBe(2160000000);
    expect(parseOcrScore(0, "12,400,000")).toBe(12400000);
    expect(parseOcrScore(0, "12.400.000")).toBe(12400000);
  });

  it("correctly handles rawScore when passed as a string in the first argument", () => {
    expect(parseOcrScore("67,4T")).toBe(67400);
    expect(parseOcrScore("24,98T")).toBe(24980);
    expect(parseOcrScore("5.663")).toBe(5663);
  });

  it("protects against runaway trillion/billion multiplier inflation from Gemini", () => {
    // If Gemini mistakenly multiplies 67.4 by 10^12 (thinking T is Trillion)
    expect(parseOcrScore(67400000000000, null)).toBe(67400);
    expect(parseOcrScore(24980000000000, null)).toBe(24980);
    // If Gemini mistakenly multiplies 67.4 by 10^9
    expect(parseOcrScore(67400000000, null)).toBe(67400);
    // When raw_score is provided alongside an inflated score, raw_score takes precedence
    expect(parseOcrScore(67400000000000, "67,4T")).toBe(67400);
  });

  it("preserves valid numerical scores under FGF maximum", () => {
    expect(parseOcrScore(12400000, null)).toBe(12400000);
    expect(parseOcrScore(5663, null)).toBe(5663);
    expect(parseOcrScore(0, null)).toBe(0);
    expect(parseOcrScore(-50, null)).toBe(0);
  });
});

describe("OCR Window.GM bridge integration", () => {
  it("exposes parseOcrScore on window.GM", () => {
    expect(typeof GM.parseOcrScore).toBe("function");
    expect(GM.parseOcrScore(0, "67,4T")).toBe(67400);
    expect(GM.parseOcrScore(0, "24,98T")).toBe(24980);
    expect(GM.parseOcrScore(0, "5.663")).toBe(5663);
  });
});

describe("ocr-guild-members Edge Function — German Localizations & Security", () => {
  const fnPath = path.resolve(__dirname, "../supabase/functions/ocr-guild-members/index.ts");
  const fnContent = fs.readFileSync(fnPath, "utf-8");

  it("includes explicit German / European number guidelines in SYSTEM_INSTRUCTION", () => {
    expect(fnContent).toContain("Number Formatting, Multipliers & European/German Localizations");
    expect(fnContent).toContain("CRITICAL: In Foundation Galactic Frontier (FGF), player scores and powers NEVER reach trillions");
    expect(fnContent).toContain("T\" / \"Tsd\" suffix");
    expect(fnContent).toContain("TAUSEND (THOUSAND = 1,000 / 10^3), NOT Trillion");
    expect(fnContent).toContain("\"67,4T\" -> 67400");
    expect(fnContent).toContain("\"24,98T\" -> 24980");
    expect(fnContent).toContain("\"5.663\"");
    expect(fnContent).toContain("NEVER treat \"T\" as trillion (10^12)! \"T\" ALWAYS means thousand");
    expect(fnContent).toContain("Leaderboard Coherence");
  });

  it("adds raw_score to the Gemini JSON response schema", () => {
    expect(fnContent).toContain("raw_score: { type: \"STRING\", nullable: true }");
  });

  it("extracts raw_score and maps players with parseOcrScore", () => {
    expect(fnContent).toContain("const val = parseOcrScore(rawScore, rawText);");
    expect(fnContent).toContain("raw_score: rawText || (typeof rawScore === \"string\" ? rawScore : String(val))");
  });

  it("maintains strict Prompt Injection defense without template interpolation", () => {
    const sysMatch = fnContent.match(/const\s+SYSTEM_INSTRUCTION\s*=\s*`([^`]*)`/);
    expect(sysMatch).not.toBeNull();
    expect(sysMatch[1]).not.toContain("${");
  });
});
