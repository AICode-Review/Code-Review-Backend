import { describe, expect, it } from "vitest";
import { extractSymbols } from "./symbols.js";

describe("extractSymbols", () => {
  it("extracts functions, classes, and methods from TypeScript via tree-sitter", async () => {
    const code = `function foo(x: number): number { return x; }\nclass Bar {\n  method(a: string) {}\n}\n`;
    const symbols = await extractSymbols("src/foo.ts", code);
    const names = symbols.map((s) => s.name);
    expect(names).toContain("foo");
    expect(names).toContain("Bar");
    expect(names).toContain("method");
  });

  it("extracts functions and classes from Python via tree-sitter", async () => {
    const code = `def foo(x):\n    return x\n\nclass Bar:\n    def method(self, a):\n        pass\n`;
    const symbols = await extractSymbols("app/foo.py", code);
    const names = symbols.map((s) => s.name);
    expect(names).toContain("foo");
    expect(names).toContain("Bar");
    expect(names).toContain("method");
  });

  it("records correct 1-indexed line ranges", async () => {
    const code = `function foo() {\n  return 1;\n}\n`;
    const symbols = await extractSymbols("src/foo.ts", code);
    const foo = symbols.find((s) => s.name === "foo");
    expect(foo?.startLine).toBe(1);
    expect(foo?.endLine).toBe(3);
  });

  it("extracts functions, structs, and methods from Go via tree-sitter", async () => {
    const code = `package main\nfunc Foo(x int) int { return x }\ntype Bar struct { A int }\nfunc (b Bar) Method(a string) {}\n`;
    const symbols = await extractSymbols("main.go", code);
    const names = symbols.map((s) => s.name);
    expect(names).toContain("Foo");
    expect(names).toContain("Bar");
    expect(names).toContain("Method");
  });

  it("extracts functions, structs, impls, and traits from Rust via tree-sitter", async () => {
    const code = `fn foo(x: i32) -> i32 { x }\nstruct Bar { a: i32 }\nimpl Bar { fn method(&self) {} }\ntrait Baz {}\n`;
    const symbols = await extractSymbols("main.rs", code);
    const names = symbols.map((s) => s.name);
    expect(names).toContain("foo");
    expect(names).toContain("Bar");
    expect(names).toContain("Baz");
  });

  it("extracts classes, interfaces, and methods from Java via tree-sitter", async () => {
    const code = `class Bar {\n  int method(String a) { return 0; }\n}\ninterface Baz {}\n`;
    const symbols = await extractSymbols("Bar.java", code);
    const names = symbols.map((s) => s.name);
    expect(names).toContain("Bar");
    expect(names).toContain("method");
    expect(names).toContain("Baz");
  });

  it("extracts functions, classes, and objects from Kotlin via tree-sitter", async () => {
    const code = `fun foo(x: Int): Int {\n    return x\n}\n\nclass Bar {\n    fun method(a: String) {}\n}\n\nobject Baz {\n    fun qux() {}\n}\n`;
    const symbols = await extractSymbols("Main.kt", code);
    const names = symbols.map((s) => s.name);
    expect(names).toContain("foo");
    expect(names).toContain("Bar");
    expect(names).toContain("method");
    expect(names).toContain("Baz");
  });

  it("extracts functions, classes, and protocols from Swift via tree-sitter", async () => {
    const code = `func foo(x: Int) -> Int {\n    return x\n}\n\nclass Bar {\n    func method(a: String) {}\n}\n\nprotocol Baz {}\n`;
    const symbols = await extractSymbols("main.swift", code);
    const names = symbols.map((s) => s.name);
    expect(names).toContain("foo");
    expect(names).toContain("Bar");
    expect(names).toContain("method");
    expect(names).toContain("Baz");
  });

  it("falls back to regex extraction for Dart (grammar ABI mismatch in the pinned tree-sitter runtime) — catches the class, not the keyword-less function declaration", async () => {
    const code = `int foo(int x) {\n  return x;\n}\n\nclass Bar {\n  void method(String a) {}\n}\n`;
    const symbols = await extractSymbols("main.dart", code);
    const names = symbols.map((s) => s.name);
    expect(names).toContain("Bar"); // regex fallback matches `class X` fine
    expect(names).not.toContain("foo"); // but not Dart's `ReturnType name(...)` syntax with no leading keyword — a known, honest gap versus real tree-sitter parsing
  });

  it("falls back to regex extraction for a language without a tree-sitter query", async () => {
    const symbols = await extractSymbols("script.unknownlang", `function foo() {}\nclass Bar {}\n`);
    expect(symbols.map((s) => s.name)).toEqual(expect.arrayContaining(["foo", "Bar"]));
  });

  it("never throws on unparseable content", async () => {
    await expect(extractSymbols("src/foo.ts", "{{{ not valid typescript at all ((( ")).resolves.toBeDefined();
  });
});
