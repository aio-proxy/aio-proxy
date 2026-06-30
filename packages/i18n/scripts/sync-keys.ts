import { readFileSync, writeFileSync } from "node:fs";

const enPath = new URL("../messages/en.json", import.meta.url);
const zhPath = new URL("../messages/zh-CN.json", import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMessages(path: URL): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error("invalid_message_catalog");
  }

  const messages: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error("invalid_message_value");
    }
    messages[key] = value;
  }
  return messages;
}

const en = readMessages(enPath);
const zh = readMessages(zhPath);

for (const [key, value] of Object.entries(en)) {
  if (zh[key] === undefined) {
    zh[key] = `TODO: ${value}`;
  }
}

writeFileSync(zhPath, `${JSON.stringify(zh, null, 2)}\n`);
