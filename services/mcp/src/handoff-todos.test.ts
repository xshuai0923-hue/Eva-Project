import { describe, expect, it } from "vitest";

import {
  alignment,
  countTodos,
  parseTodoSection,
  serializeTodoSection,
  todoItems
} from "./handoff-todos.js";

const CANONICAL = [
  "- [x] (T1) 重新生成 field-map 并核对键名 · 状态:已完成 · 提交:f8a9227",
  "- [x] (T2) 表头筛选按 schema 出条件 · 需求:EVAPROJECT-REQ-20260919-001 · 状态:待验证 · 提交:fe8d243",
  "- [ ] (T3) 多用户可见性做重启自启验证 · 需求:EVAPROJECT-REQ-20260919-001 · 状态:进行中 · 说明:需要真机重启",
  "- [ ] (T4) 把探针置为取消 · 说明:临时事项，无对应需求"
].join("\n");

describe("todo parsing", () => {
  it("round-trips the canonical form unchanged", () => {
    expect(serializeTodoSection(parseTodoSection(CANONICAL))).toBe(CANONICAL);
  });

  it("reads every field of a full line", () => {
    const [item] = todoItems(parseTodoSection(
      "- [x] (T7) 做完某事 · 需求:REQ-1 · 状态:待验证 · 提交:abc1234 · 依赖:T1,T2 · 说明:注意这里"
    ));
    expect(item).toMatchObject({
      id: "T7",
      done: true,
      text: "做完某事",
      requirement: "REQ-1",
      status: "待验证",
      commit: "abc1234",
      blockedBy: ["T1", "T2"],
      note: "注意这里"
    });
  });

  it("treats having a requirement as independent of being done", () => {
    const items = todoItems(parseTodoSection(CANONICAL));
    expect(items.map(item => [item.done, item.requirement !== null])).toEqual([
      [true, false],
      [true, true],
      [false, true],
      [false, false]
    ]);
  });
});

describe("lenient reading", () => {
  it.each([
    ["uppercase mark", "- [X] (T1) 文本"],
    ["asterisk bullet", "* [x] (T1) 文本"],
    ["plus bullet", "+ [x] (T1) 文本"],
    ["leading indent", "    - [x] (T1) 文本"],
    ["blockquote prefix", "> - [x] (T1) 文本"],
    ["extra spaces", "-   [x]   (T1)   文本"],
    ["lowercase id", "- [x] (t1) 文本"],
    ["fullwidth parens", "- [x] （T1） 文本"]
  ])("accepts %s", (_label, input) => {
    expect(todoItems(parseTodoSection(input))[0]).toMatchObject({ id: "T1", done: true, text: "文本" });
  });

  it.each([
    ["middle dot", "·"],
    ["hyphenation point", "‧"],
    ["katakana middle dot", "・"]
  ])("accepts %s as a separator", (_label, separator) => {
    const [item] = todoItems(parseTodoSection(`- [ ] (T1) 文本 ${separator} 状态:进行中`));
    expect(item?.status).toBe("进行中");
  });

  it("accepts a fullwidth colon after a key", () => {
    const [item] = todoItems(parseTodoSection("- [ ] (T1) 文本 · 说明：中文冒号"));
    expect(item?.note).toBe("中文冒号");
  });

  it.each([["，"], ["、"], [","]])("splits dependencies on %s", separator => {
    const [item] = todoItems(parseTodoSection(`- [ ] (T1) 文本 · 依赖:T2${separator}T3`));
    expect(item?.blockedBy).toEqual(["T2", "T3"]);
  });

  it("keeps a colon inside a value", () => {
    const [item] = todoItems(parseTodoSection("- [ ] (T1) 文本 · 说明:见 http://example.com:8080/x"));
    expect(item?.note).toBe("见 http://example.com:8080/x");
  });
});

describe("nothing is discarded", () => {
  it("preserves prose and blank lines in place", () => {
    const input = ["说明段落。", "", "- [ ] (T1) 文本", "", "结尾。"].join("\n");
    expect(serializeTodoSection(parseTodoSection(input))).toBe(input);
  });

  it("preserves a segment whose key is not in the grammar", () => {
    const input = "- [ ] (T1) 文本 · 未知键:某值 · 状态:进行中";
    const [item] = todoItems(parseTodoSection(input));
    expect(item?.extras).toEqual(["未知键:某值"]);
    expect(serializeTodoSection(parseTodoSection(input)))
      .toBe("- [ ] (T1) 文本 · 状态:进行中 · 未知键:某值");
  });

  it("keeps a malformed checkbox line verbatim rather than dropping it", () => {
    const input = "- [z] (T1) 这不是合法勾选态";
    expect(todoItems(parseTodoSection(input))).toHaveLength(0);
    expect(serializeTodoSection(parseTodoSection(input))).toBe(input);
  });
});

describe("canonical writing", () => {
  it("normalizes a drifted line to the canonical form", () => {
    const drifted = "*   [X]   （t1）   文本   ・   状态：进行中   ・   依赖:t2、t3";
    expect(serializeTodoSection(parseTodoSection(drifted)))
      .toBe("- [x] (T1) 文本 · 状态:进行中 · 依赖:T2,T3");
  });

  it("emits keys in a fixed order regardless of input order", () => {
    const input = "- [ ] (T1) 文本 · 说明:n · 依赖:T2 · 提交:c · 状态:进行中 · 需求:R";
    expect(serializeTodoSection(parseTodoSection(input)))
      .toBe("- [ ] (T1) 文本 · 需求:R · 状态:进行中 · 提交:c · 依赖:T2 · 说明:n");
  });

  it("assigns ids to items that have none without colliding with existing ids", () => {
    const input = ["- [ ] 没有编号", "- [ ] (T1) 有编号", "- [ ] 也没有编号"].join("\n");
    expect(todoItems(parseTodoSection(input)).map(item => item.id)).toEqual(["", "T1", ""]);
    expect(serializeTodoSection(parseTodoSection(input))).toBe(
      ["- [ ] (T2) 没有编号", "- [ ] (T1) 有编号", "- [ ] (T3) 也没有编号"].join("\n")
    );
  });

  it("renumbers a duplicate id instead of keeping two items with one id", () => {
    const input = ["- [ ] (T1) 第一条", "- [ ] (T1) 第二条"].join("\n");
    expect(serializeTodoSection(parseTodoSection(input)))
      .toBe(["- [ ] (T1) 第一条", "- [ ] (T2) 第二条"].join("\n"));
  });
});

describe("counting", () => {
  it("counts only todo lines, recomputed from the list", () => {
    expect(countTodos(parseTodoSection(CANONICAL))).toEqual({ total: 4, done: 2 });
  });

  it("ignores prose when counting", () => {
    expect(countTodos(parseTodoSection("一段说明\n\n- [x] (T1) 做完了"))).toEqual({ total: 1, done: 1 });
  });
});

describe("alignment with the requirement pool", () => {
  const item = (overrides: Partial<ReturnType<typeof todoItems>[number]>) =>
    ({ ...todoItems(parseTodoSection("- [ ] (T1) 文本"))[0]!, ...overrides });

  it("reports a mismatch when the handoff and the requirement disagree", () => {
    expect(alignment(item({ requirement: "REQ-1", status: "待验证" }), "进行中")).toBe(false);
  });

  it("reports agreement when both sides say the same thing", () => {
    expect(alignment(item({ requirement: "REQ-1", status: "进行中" }), "进行中")).toBe(true);
  });

  it("reads a todo's 待验证 as the requirement state 待验证/验收", () => {
    expect(alignment(item({ requirement: "REQ-1", status: "待验证" }), "待验证/验收")).toBe(true);
  });

  it.each([
    ["no requirement pointer", { requirement: null, status: "进行中" }],
    ["no status", { requirement: "REQ-1", status: null }]
  ])("returns null, not false, when there is %s", (_label, overrides) => {
    expect(alignment(item(overrides), "进行中")).toBeNull();
  });

  it("returns null when the requirement state cannot be read", () => {
    expect(alignment(item({ requirement: "REQ-1", status: "进行中" }), null)).toBeNull();
  });
});
