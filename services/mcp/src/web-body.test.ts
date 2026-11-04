import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readJson } from "./web-body.js";

describe("bounded web JSON bodies", () => {
  it("allows a 20 MiB attachment after base64 expansion in the attachment route", async () => {
    const content = Buffer.alloc(20 * 1024 * 1024).toString("base64");
    const chunks = Readable.from(['{"content":"', content, '"}']);
    expect((await readJson(chunks, 32 * 1024 * 1024)).content).toBe(content);
  });
  it("keeps the small default limit for administrative forms", async () => {
    await expect(readJson(Readable.from([JSON.stringify({ text: "x".repeat(17_000) })]))).rejects.toThrow("内容过大");
  });
  it("accepts bounded long requirement content without silently truncating it", async () => {
    const body = { rawText: "原文".repeat(30_000) };
    expect(await readJson(Readable.from([JSON.stringify(body)]), 1024 * 1024)).toEqual(body);
  });
  it("rejects chunked overflow and non-object JSON", async () => {
    await expect(readJson(Readable.from(['{"a":"', 'x'.repeat(200), '"}']), 100)).rejects.toThrow("内容过大");
    await expect(readJson(Readable.from(['[]']))).rejects.toThrow("格式无效");
  });
});
