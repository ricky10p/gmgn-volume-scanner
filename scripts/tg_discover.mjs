#!/usr/bin/env node
// Loads .env, calls getMe and getUpdates. Prints bot identity + discovered chats.
// Never prints the token.
import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(".env");
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trim().startsWith("#")) process.env[m[1]] = m[2];
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("no token in .env");
  process.exit(1);
}

const api = (m) => `https://api.telegram.org/bot${token}/${m}`;

const me = await (await fetch(api("getMe"))).json();
console.log("getMe:", me.ok ? `@${me.result.username} (id ${me.result.id})` : JSON.stringify(me));

const up = await (await fetch(api("getUpdates"))).json();
if (!up.ok) {
  console.log("getUpdates failed:", up.description);
} else if (!up.result.length) {
  console.log("getUpdates: no messages yet — bot needs a /start from Kovak first");
} else {
  const chats = new Map();
  for (const u of up.result) {
    const c = u.message?.chat || u.my_chat_member?.chat || u.channel_post?.chat;
    if (c) chats.set(c.id, `${c.type} | ${c.first_name || c.title || ""} | @${c.username || "-"}`);
  }
  console.log("chats found:");
  for (const [id, desc] of chats) console.log(`  ${id}  ${desc}`);
}
