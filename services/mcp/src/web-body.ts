/** Keep ordinary admin forms small while allowing bounded descriptions and attachments. */
export async function readJson(request: AsyncIterable<Buffer | string>, maxBytes = 16_384): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) throw new Error("请求内容过大");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求格式无效");
  return value as Record<string, unknown>;
}
