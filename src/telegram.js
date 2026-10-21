const API = "https://api.telegram.org";
const MAX_LEN = 4000; // Telegram hard limit is 4096; keep headroom for entity expansion

export function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function call(token, method, payload) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`telegram: ${json.description || res.status}`);
  return json.result;
}

/**
 * Send one HTML message. Returns the Telegram message_id.
 */
export async function sendTelegram(html, { token, chatId, disablePreview = true } = {}) {
  const t = token || process.env.TELEGRAM_BOT_TOKEN;
  const c = chatId || process.env.TELEGRAM_CHAT_ID;
  if (!t || !c) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");

  const result = await call(t, "sendMessage", {
    chat_id: c,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: disablePreview,
  });
  return result.message_id;
}

/**
 * Send pre-rendered HTML blocks, packing as many as fit into each message.
 * Blocks are never split, so a pool entry always stays intact.
 * Returns the list of message ids.
 */
export async function sendTelegramBlocks(blocks, { token, chatId, disablePreview = true, header = null } = {}) {
  const t = token || process.env.TELEGRAM_BOT_TOKEN;
  const c = chatId || process.env.TELEGRAM_CHAT_ID;
  if (!t || !c) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");

  const chunks = [];
  let cur = "";
  for (const b of blocks) {
    const candidate = cur ? `${cur}\n\n${b}` : b;
    if (candidate.length > MAX_LEN && cur) {
      chunks.push(cur);
      cur = b;
    } else {
      cur = candidate;
    }
  }
  if (cur) chunks.push(cur);

  const ids = [];
  for (let i = 0; i < chunks.length; i++) {
    let text = chunks[i];
    if (chunks.length > 1 && header) text = `${header} (${i + 1}/${chunks.length})\n\n${text}`;
    const r = await call(t, "sendMessage", {
      chat_id: c,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: disablePreview,
    });
    ids.push(r.message_id);
  }
  return ids;
}

/**
 * Delete one message the bot itself sent.
 * Returns "deleted" | "already-gone" | "forbidden" | "too-old" | "failed".
 */
export async function deleteTelegramMessage(messageId, { token, chatId } = {}) {
  const t = token || process.env.TELEGRAM_BOT_TOKEN;
  const c = chatId || process.env.TELEGRAM_CHAT_ID;
  if (!t || !c) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");

  const res = await fetch(`${API}/bot${t}/deleteMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: c, message_id: messageId }),
  });
  const json = await res.json().catch(() => ({}));
  if (json.ok) return "deleted";

  const desc = String(json.description || "");
  // "message to delete not found" -> already gone (manual delete, chat cleared)
  if (/not found/i.test(desc)) return "already-gone";
  // bots may only delete their own messages, and only within 48h in groups/channels
  if (/can't be deleted|message can't be deleted|too old/i.test(desc)) return "too-old";
  if (/not enough rights|forbidden|chat not found/i.test(desc)) return "forbidden";
  return `failed: ${desc || res.status}`;
}
