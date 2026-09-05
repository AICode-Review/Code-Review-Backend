import { describe, expect, it } from "vitest";
import type { CompleteRequest, LlmRouter } from "../llm/types.js";
import { conventionalTestPath, generateTestFile, validateGeneratedTestFile } from "./testGen.js";

function capturingRouter(fileContent: string | null): { router: LlmRouter; calls: CompleteRequest<unknown>[] } {
  const calls: CompleteRequest<unknown>[] = [];
  const router: LlmRouter = {
    async complete(req) {
      calls.push(req as CompleteRequest<unknown>);
      const parsed = fileContent === null ? { success: false as const } : req.schema.safeParse({ fileContent });
      return {
        data: parsed.success ? parsed.data : null,
        inputTokens: 20,
        outputTokens: 10,
        costUsd: 0.004,
        model: "fake-model",
        provider: "anthropic",
      };
    },
  };
  return { router, calls };
}

const FINDING = {
  title: "Discount applied after tax, can go negative",
  bodyMd: "A 100% coupon can drive the total negative.",
  whyItMatters: "Customers could be paid instead of charged.",
  impact: "Financial loss.",
};

describe("conventionalTestPath", () => {
  it("uses <base>.test.<ext> for JS/TS family languages", () => {
    for (const ext of ["ts", "tsx", "js", "jsx", "mjs", "cjs"]) {
      const result = conventionalTestPath(`src/api/checkout.${ext}`);
      expect(result).toEqual({ ok: true, testFilePath: `src/api/checkout.test.${ext}` });
    }
  });

  it("uses test_<base>.py for Python", () => {
    expect(conventionalTestPath("src/services/billing.py")).toEqual({ ok: true, testFilePath: "src/services/test_billing.py" });
  });

  it("uses <base>_test.go for Go", () => {
    expect(conventionalTestPath("cmd/provision/main.go")).toEqual({ ok: true, testFilePath: "cmd/provision/main_test.go" });
  });

  it("uses <Base>Test.java for Java", () => {
    expect(conventionalTestPath("src/main/java/Checkout.java")).toEqual({ ok: true, testFilePath: "src/main/java/CheckoutTest.java" });
  });

  it("uses <Base>Test.kt for Kotlin and <Base>Tests.swift for Swift", () => {
    expect(conventionalTestPath("app/Checkout.kt")).toEqual({ ok: true, testFilePath: "app/CheckoutTest.kt" });
    expect(conventionalTestPath("App/Checkout.swift")).toEqual({ ok: true, testFilePath: "App/CheckoutTests.swift" });
  });

  it("handles a root-level file with no directory", () => {
    expect(conventionalTestPath("index.ts")).toEqual({ ok: true, testFilePath: "index.test.ts" });
  });

  it("rejects Rust — idiomatic tests live inline in the same file, not a separate one", () => {
    const result = conventionalTestPath("src/lib.rs");
    expect(result.ok).toBe(false);
  });

  it("rejects an unrecognized extension rather than guessing a convention", () => {
    const result = conventionalTestPath("infra/main.tf");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/isn't supported/);
  });
});

describe("generateTestFile", () => {
  it("sends the source content, target path, and 'does not exist yet' note when there's no existing test file", async () => {
    const { router, calls } = capturingRouter("test('adds', () => { expect(add(1,2)).toBe(3); });");
    const result = await generateTestFile(router, "src/lib/math.ts", "export function add(a,b){return a+b;}", "src/lib/math.test.ts", null, FINDING);

    expect(result?.fileContent).toContain("expect(add(1,2)).toBe(3)");
    expect(result?.costUsd).toBe(0.004);

    const userMessage = calls[0]?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMessage).toContain("src/lib/math.ts");
    expect(userMessage).toContain("export function add(a,b){return a+b;}");
    expect(userMessage).toContain("src/lib/math.test.ts");
    expect(userMessage).toContain("does not exist yet");
  });

  it("shows the existing test file's content and asks to add to it when one already exists", async () => {
    const { router, calls } = capturingRouter("updated file content");
    await generateTestFile(router, "src/lib/math.ts", "source", "src/lib/math.test.ts", "test('existing', () => {});", FINDING);

    const userMessage = calls[0]?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMessage).toContain("already exists");
    expect(userMessage).toContain("test('existing', () => {});");
  });

  it("includes the original suggestedFix sketch when one is given", async () => {
    const { router, calls } = capturingRouter("content");
    await generateTestFile(router, "src/lib/math.ts", "source", "src/lib/math.test.ts", null, { ...FINDING, suggestedFix: "expect(add(1,-1)).toBe(0);" });

    const userMessage = calls[0]?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMessage).toContain("expect(add(1,-1)).toBe(0);");
  });

  it("returns null (never throws) when the LLM call is dropped", async () => {
    const { router } = capturingRouter(null);
    const result = await generateTestFile(router, "src/lib/math.ts", "source", "src/lib/math.test.ts", null, FINDING);
    expect(result).toBeNull();
  });
});

describe("validateGeneratedTestFile", () => {
  it("rejects empty content", async () => {
    const result = await validateGeneratedTestFile("src/lib/math.test.ts", "   ");
    expect(result).toEqual({ valid: false, reason: expect.stringMatching(/empty/) });
  });

  it("rejects content with a placeholder marker", async () => {
    const result = await validateGeneratedTestFile("src/lib/math.test.ts", "test('todo', () => { // TODO: finish this });");
    expect(result.valid).toBe(false);
  });

  it("rejects syntactically broken generated content for a language with a tree-sitter grammar", async () => {
    const broken = "function add(a, b) { return a + b;"; // missing closing brace
    const result = await validateGeneratedTestFile("src/lib/math.test.js", broken);
    expect(result).toEqual({ valid: false, reason: expect.stringMatching(/syntax error/) });
  });

  it("accepts well-formed, concrete generated content", async () => {
    const good = "test('adds', () => { expect(1 + 2).toBe(3); });";
    const result = await validateGeneratedTestFile("src/lib/math.test.js", good);
    expect(result).toEqual({ valid: true });
  });

  it("skips the syntax check (but still applies the other checks) for an extension with no tree-sitter grammar", async () => {
    const result = await validateGeneratedTestFile("src/lib/math_test.rb", "it 'adds' do\n  expect(1 + 2).to eq(3)\nend");
    expect(result).toEqual({ valid: true });
  });
});
