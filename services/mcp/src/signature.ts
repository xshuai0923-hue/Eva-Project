/**
 * Who wrote an entry in a requirement's history, and through what.
 *
 * Every write reaches OpenProject through the one account whose API token this service
 * holds, so OpenProject's journal names that account on every entry, and it has no field
 * for the agent at all. The history could not tell a Claude session from a Codex one from
 * Brian typing on the page (Brian 2026-09-23: 「能否 user+agent 署名」). So the service
 * signs what it writes: the last line of the entry's note names the Eva-Project identity
 * and the channel. It is plain text on purpose — OpenProject's own activity view shows it
 * too, which keeps the record honest wherever it is read.
 *
 * The line carries the identity's id, not a name. A name written into a note is frozen
 * there, and a name was corrected on this very day; the id is resolved to the account's
 * current name whenever the history is read.
 */

const PREFIX = "— 署名：";
const SIGNATURE = /^— 署名：([A-Za-z0-9][A-Za-z0-9._-]{0,63}) · ([^\n]{1,64})$/;

function displayAgent(name: string): string {
  if (/^claude(?:$|[\s._-])/i.test(name)) return "Claude";
  if (/^codex(?:$|[\s._-])/i.test(name)) return "Codex";
  if (/^mila(?:$|[\s._-])/i.test(name)) return "Mila";
  return name;
}

/** Optional bridge metadata is a display label, never an authorization identity. */
export function channelFromRequest(userAgent: string | undefined, encodedAgent: string | undefined): string {
  if (encodedAgent) {
    try {
      const name = decodeURIComponent(encodedAgent).trim();
      if (name && name.length <= 64 && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(name)) return displayAgent(name);
    } catch { /* Older/direct clients still use their User-Agent below. */ }
  }
  return channelFromUserAgent(userAgent);
}

/** The channel a write came through when it came from the pool page itself. */
export const WEB_CHANNEL = "网页";

/**
 * The agent behind an MCP request, from its User-Agent.
 *
 * Measured on 2026-09-23: Claude Code sends `claude-code/<version> (…)` and Codex sends
 * `codex-mcp-client/<version>` on every request, so no tool needs an extra parameter and
 * no caller can forget one. The value is self-reported and used for display only. A
 * client that is not recognised is shown by the name it gives, not guessed at.
 */
export function channelFromUserAgent(userAgent: string | undefined): string {
  let value = (userAgent ?? "").trim();
  // Released bridges placed their own product first, followed by MCP clientInfo.name.
  // Unwrap only that known format; unrelated header suffixes are not agent identities.
  if (/^EvaProjectPlugin(?:\/[^\s]+)?(?:\s|$)/i.test(value)) {
    value = value.replace(/^EvaProjectPlugin(?:\/[^\s]+)?\s*/i, "").trim();
    if (!value || value.toLowerCase() === "client") return "未知 Agent";
    const forwardedName = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").slice(0, 64).trim();
    return forwardedName ? displayAgent(forwardedName) : "未知 Agent";
  }
  const product = (value.split(/[\s/]/, 1)[0] ?? "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
  return product ? displayAgent(product) : "未知 Agent";
}

export function signatureLine(userId: string, channel: string): string {
  return `${PREFIX}${userId} · ${channel}`;
}

/** A note with the signature as its last line, or the signature alone. */
export function signed(note: string, userId: string, channel: string): string {
  const text = note.trim();
  const line = signatureLine(userId, channel);
  return text ? `${text}\n\n${line}` : line;
}

/**
 * Splits a note into what was said and who signed it. An unsigned note — everything
 * written before signing began, and anything written in OpenProject's own screens — comes
 * back whole, with no signature: its channel is not known and is not made up.
 */
export function parseSignature(raw: string): { text: string; userId: string | null; channel: string | null } {
  const trimmed = raw.trimEnd();
  const cut = trimmed.lastIndexOf("\n");
  const last = trimmed.slice(cut + 1);
  const match = SIGNATURE.exec(last);
  if (!match) return { text: raw, userId: null, channel: null };
  return { text: trimmed.slice(0, Math.max(cut, 0)).trimEnd(), userId: match[1]!, channel: match[2]! };
}
