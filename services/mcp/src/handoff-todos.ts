// Handoff todo lines live in the `## 待办` section of a handoff description, where
// both agents and people edit them. Parsing is deliberately lenient and
// serialization deliberately canonical, so editor drift is healed on the next write
// instead of accumulating. Nothing that fails to parse is ever dropped.

export const TODO_STATUSES = ["进行中", "已实现待提交", "待验证", "已完成"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export type TodoItem = {
  id: string;
  done: boolean;
  text: string;
  status: string | null;
  requirement: string | null;
  commit: string | null;
  blockedBy: string[];
  note: string | null;
  /** Segments whose key is not part of the grammar, preserved verbatim. */
  extras: string[];
};

/** A line in the section that is not a todo: prose, blank lines, or malformed entries. */
export type TodoPassthrough = {
  kind: "passthrough";
  raw: string;
};

export type TodoEntry = ({ kind: "todo" } & TodoItem) | TodoPassthrough;

const CHECKBOX = /^[\s>]*[-*+]\s*\[([ xX])\]\s*(.*)$/;
const ID_PREFIX = /^[（(]\s*([A-Za-z][A-Za-z0-9_-]*)\s*[）)]\s*(.*)$/;
// Middle dot variants an editor or input method may substitute for `·`.
const SEPARATOR = /\s*[·‧・]\s*/;
const KEY_VALUE = /^([^:：]{1,12})[:：]\s*(.*)$/s;

const KEYS = {
  需求: "requirement",
  状态: "status",
  提交: "commit",
  依赖: "blockedBy",
  说明: "note"
} as const;

type KeyName = keyof typeof KEYS;

function isKey(value: string): value is KeyName {
  return Object.hasOwn(KEYS, value);
}

/**
 * Reads a `## 待办` section. Lines that do not match the grammar are returned as
 * passthrough entries in their original position so a later write cannot lose them.
 */
export function parseTodoSection(section: string): TodoEntry[] {
  return section.split("\n").map<TodoEntry>(line => {
    const checkbox = CHECKBOX.exec(line);
    if (!checkbox) return { kind: "passthrough", raw: line };

    const done = checkbox[1] !== " ";
    const identified = ID_PREFIX.exec(checkbox[2] ?? "");
    const body = identified ? identified[2] ?? "" : checkbox[2] ?? "";

    const segments = body.split(SEPARATOR);
    const item: TodoItem = {
      id: identified?.[1]?.toUpperCase() ?? "",
      done,
      text: (segments.shift() ?? "").trim(),
      status: null,
      requirement: null,
      commit: null,
      blockedBy: [],
      note: null,
      extras: []
    };

    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed) continue;
      const pair = KEY_VALUE.exec(trimmed);
      const key = pair?.[1]?.trim();
      const value = pair?.[2]?.trim();
      if (!pair || !key || !isKey(key) || !value) {
        item.extras.push(trimmed);
        continue;
      }
      if (key === "依赖") {
        item.blockedBy = value.split(/[,，、]/).map(part => part.trim().toUpperCase()).filter(Boolean);
      } else {
        item[KEYS[key]] = value;
      }
    }

    return { kind: "todo", ...item };
  });
}

/**
 * Gives every todo a unique id, keeping ids that are already present and unique.
 * Ids are assigned in reading order so a renumbered list stays readable.
 */
export function assignIds(entries: TodoEntry[]): TodoEntry[] {
  const taken = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "todo" && entry.id && !taken.has(entry.id)) taken.add(entry.id);
  }
  let next = 1;
  const seen = new Set<string>();
  return entries.map(entry => {
    if (entry.kind !== "todo") return entry;
    if (entry.id && !seen.has(entry.id)) {
      seen.add(entry.id);
      return entry;
    }
    while (taken.has(`T${next}`)) next += 1;
    const id = `T${next}`;
    taken.add(id);
    seen.add(id);
    return { ...entry, id };
  });
}

function line(item: TodoItem): string {
  const parts = [
    item.requirement ? `需求:${item.requirement}` : null,
    item.status ? `状态:${item.status}` : null,
    item.commit ? `提交:${item.commit}` : null,
    item.blockedBy.length > 0 ? `依赖:${item.blockedBy.join(",")}` : null,
    item.note ? `说明:${item.note}` : null,
    ...item.extras
  ].filter((part): part is string => Boolean(part));
  const head = `- [${item.done ? "x" : " "}] (${item.id}) ${item.text}`.trimEnd();
  return parts.length > 0 ? `${head} · ${parts.join(" · ")}` : head;
}

/** Writes the canonical form. Passthrough lines keep their original text and position. */
export function serializeTodoSection(entries: TodoEntry[]): string {
  return assignIds(entries)
    .map(entry => (entry.kind === "todo" ? line(entry) : entry.raw))
    .join("\n")
    .trim();
}

export function todoItems(entries: TodoEntry[]): TodoItem[] {
  return entries.filter((entry): entry is { kind: "todo" } & TodoItem => entry.kind === "todo");
}

/** Server-side recount; callers never report their own totals. */
export function countTodos(entries: TodoEntry[]): { total: number; done: number } {
  const items = todoItems(entries);
  return { total: items.length, done: items.filter(item => item.done).length };
}

/**
 * `null` means not comparable, which is not the same as a mismatch: an item without
 * both a requirement pointer and a status has no two ends to compare. A todo's
 * 待验证 is the requirement state 待验证/验收.
 */
export function alignment(item: TodoItem, requirementState: string | null): boolean | null {
  if (!item.requirement || !item.status || !requirementState) return null;
  const expected = item.status === "待验证" ? "待验证/验收" : item.status;
  return expected === requirementState;
}
