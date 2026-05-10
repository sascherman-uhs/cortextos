#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/telegram/api.ts
var import_fs = require("fs");
var import_path = require("path");
var TelegramAPI = class {
  baseUrl;
  lastSendTime = /* @__PURE__ */ new Map();
  // Chat IDs already warned for the self_chat trap. Keeps the runtime
  // diagnostic emitted at most once per chat_id per process lifetime.
  warnedSelfChat = /* @__PURE__ */ new Set();
  constructor(token) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }
  /**
   * Strip MarkdownV2-style backslash escapes that Telegram Markdown v1 doesn't support.
   * In v1, only *, _, `, [ are special. Everything else should not be backslash-escaped.
   */
  sanitizeMarkdown(text) {
    return text.replace(/\\([^_*`\[\n])/g, "$1");
  }
  /**
   * Send a text message. Splits long messages at 4096 chars.
   *
   * Markdown parse behavior:
   *
   * - By default, each chunk is sent with `parse_mode: "Markdown"` (Telegram
   *   v1 Markdown). If the Telegram API rejects the chunk with a
   *   "can't parse entities" error — usually because the text contains an
   *   unescaped `_`, `*`, backtick, or `[` that Telegram interprets as the
   *   start of an entity it cannot close — sendMessage catches the error,
   *   logs a one-line stderr warning, and automatically RETRIES that chunk
   *   ONCE with `parse_mode` omitted (plain text). This is the safety net
   *   for agents generating natural prose that happens to look like bad
   *   markdown. If the retry also fails, the error is rethrown so callers
   *   still see real failures.
   *
   * - Callers who KNOW their message contains unescaped special characters
   *   can opt out of parsing entirely by passing `{ parseMode: null }`.
   *   This skips the first Markdown attempt, avoids the retry roundtrip,
   *   and suppresses the warning. Useful for `cortextos bus send-telegram
   *   --plain-text` and any agent message known to carry literal code,
   *   error output, or user-supplied text.
   *
   * - Other error classes (401 bad_token, 400 chat_not_found, 403
   *   bot_recipient, network failures) do NOT trigger the retry. Only
   *   parse-entity failures are recoverable here — everything else is a
   *   real config problem that callers need to see.
   */
  async sendMessage(chatId, text, replyMarkup, opts) {
    const sanitized = this.sanitizeMarkdown(text);
    await this.rateLimit(String(chatId));
    const requestedParseMode = opts?.parseMode === null ? null : "Markdown";
    const maxLen = 4096;
    const chunks = [];
    if (sanitized.length <= maxLen) {
      chunks.push(sanitized);
    } else {
      for (let i = 0; i < sanitized.length; i += maxLen) {
        chunks.push(sanitized.slice(i, i + maxLen));
      }
    }
    let lastResult;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isLastChunk = i === chunks.length - 1;
      lastResult = await this.sendChunk(
        chatId,
        chunk,
        requestedParseMode,
        isLastChunk ? replyMarkup : void 0,
        (reason) => {
          console.warn(`[telegram] parse-mode fallback for chat ${chatId}: ${reason}`);
          opts?.onParseFallback?.(reason);
        }
      );
    }
    return lastResult;
  }
  /**
   * Send a single chunk with the given parse mode, with a one-shot retry
   * on parse-entity failures. Extracted so the multi-chunk path can reuse
   * the same retry logic without duplicating the try/catch.
   */
  async sendChunk(chatId, text, parseMode, replyMarkup, onFallback) {
    const basePayload = {
      chat_id: chatId,
      text,
      ...replyMarkup ? { reply_markup: replyMarkup } : {}
    };
    const firstPayload = parseMode === null ? basePayload : { ...basePayload, parse_mode: parseMode };
    try {
      return await this.post("sendMessage", firstPayload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (parseMode !== null && /can'?t parse entities|parse entit/i.test(msg)) {
        onFallback(msg);
        return await this.post("sendMessage", basePayload);
      }
      if (/bots can'?t send messages to bots/i.test(msg)) {
        const key = String(chatId);
        if (!this.warnedSelfChat.has(key)) {
          this.warnedSelfChat.add(key);
          console.warn(
            `[telegram] self_chat trap likely: chat_id=${key} resolved to another bot. Check .env \u2014 CHAT_ID must be YOUR Telegram user id, not the BOT_TOKEN prefix. Fix by sending /start to the bot from your own account and reading the chat id via getUpdates.`
          );
        }
      }
      throw err;
    }
  }
  /**
   * Send a photo with optional caption and reply markup.
   * Uses multipart/form-data via built-in Node.js APIs.
   */
  async sendPhoto(chatId, imagePath, caption, replyMarkup) {
    if (!(0, import_fs.existsSync)(imagePath)) {
      throw new Error(`Image file not found: ${imagePath}`);
    }
    await this.rateLimit(String(chatId));
    const fileData = (0, import_fs.readFileSync)(imagePath);
    const fileName = (0, import_path.basename)(imagePath);
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append("photo", new Blob([fileData]), fileName);
    if (caption) {
      formData.append("caption", caption);
    }
    if (replyMarkup) {
      formData.append("reply_markup", JSON.stringify(replyMarkup));
    }
    try {
      const response = await fetch(`${this.baseUrl}/sendPhoto`, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(6e4)
      });
      const result = await response.json();
      if (!result.ok) {
        throw new Error(`Telegram API error: ${result.description || "Unknown error"}`);
      }
      return result;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Telegram API error")) {
        throw err;
      }
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new Error(`Telegram API request timed out after 60s: sendPhoto`);
      }
      throw new Error(`Telegram API request failed: ${err}`);
    }
  }
  /**
   * Send a document (file) with optional caption. Works for any file type
   * that isn't a photo: PDFs, text files, archives, etc.
   */
  async sendDocument(chatId, filePath, caption, replyMarkup) {
    if (!(0, import_fs.existsSync)(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    await this.rateLimit(String(chatId));
    const fileData = (0, import_fs.readFileSync)(filePath);
    const fileName = (0, import_path.basename)(filePath);
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append("document", new Blob([fileData]), fileName);
    if (caption) {
      formData.append("caption", caption);
    }
    if (replyMarkup) {
      formData.append("reply_markup", JSON.stringify(replyMarkup));
    }
    try {
      const response = await fetch(`${this.baseUrl}/sendDocument`, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(6e4)
      });
      const result = await response.json();
      if (!result.ok) {
        throw new Error(`Telegram API error: ${result.description || "Unknown error"}`);
      }
      return result;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Telegram API error")) {
        throw err;
      }
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new Error(`Telegram API request timed out after 60s: sendDocument`);
      }
      throw new Error(`Telegram API request failed: ${err}`);
    }
  }
  /**
   * Get updates via long polling.
   */
  async getUpdates(offset, timeout = 1) {
    return this.post("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message", "callback_query", "message_reaction"]
    });
  }
  /**
   * Answer a callback query.
   */
  async answerCallbackQuery(callbackQueryId, text) {
    return this.post("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: text || "OK"
    });
  }
  /**
   * Edit a message's text.
   */
  async editMessageText(chatId, messageId, text, replyMarkup) {
    return this.post("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...replyMarkup ? { reply_markup: replyMarkup } : {}
    });
  }
  /**
   * Send typing indicator.
   */
  async sendChatAction(chatId, action = "typing") {
    return this.post("sendChatAction", {
      chat_id: chatId,
      action
    });
  }
  /**
   * Get file info for downloading.
   */
  async getFile(fileId) {
    return this.post("getFile", { file_id: fileId });
  }
  /**
   * Download a file from Telegram servers.
   */
  async downloadFile(filePath) {
    const url = `https://api.telegram.org/file/bot${this.getToken()}/${filePath}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(3e4) });
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  /**
   * Register bot commands for autocomplete.
   */
  async setMyCommands(commands) {
    return this.post("setMyCommands", { commands });
  }
  /**
   * Make a POST request to the Telegram API.
   */
  async post(method, data) {
    try {
      const response = await fetch(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(15e3)
      });
      const result = await response.json();
      if (!result.ok) {
        throw new Error(`Telegram API error: ${result.description || "Unknown error"}`);
      }
      return result;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Telegram API error")) {
        throw err;
      }
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new Error(`Telegram API request timed out after 15s: ${method}`);
      }
      throw new Error(`Telegram API request failed: ${err}`);
    }
  }
  /**
   * Simple rate limiter: 1 message per second per chat.
   */
  async rateLimit(chatId) {
    const now = Date.now();
    const last = this.lastSendTime.get(chatId) || 0;
    const elapsed = now - last;
    if (elapsed < 1e3) {
      await new Promise((resolve) => setTimeout(resolve, 1e3 - elapsed));
    }
    this.lastSendTime.set(chatId, Date.now());
  }
  /**
   * Extract token from base URL.
   */
  getToken() {
    return this.baseUrl.replace("https://api.telegram.org/bot", "");
  }
};

// src/hooks/index.ts
var import_fs2 = require("fs");
var import_path2 = require("path");
var import_os = require("os");
var crypto = __toESM(require("crypto"));
function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}
function parseHookInput(input) {
  try {
    const parsed = JSON.parse(input);
    return {
      tool_name: parsed.tool_name || "unknown",
      tool_input: parsed.tool_input || {}
    };
  } catch {
    return { tool_name: "unknown", tool_input: {} };
  }
}
function loadEnv() {
  const agentName = process.env.CTX_AGENT_NAME || require("path").basename(process.cwd());
  const ctxRoot = process.env.CTX_ROOT || (0, import_path2.join)((0, import_os.homedir)(), ".cortextos", "default");
  const stateDir = (0, import_path2.join)(ctxRoot, "state", agentName);
  const envPaths = [
    process.env.CTX_AGENT_DIR ? (0, import_path2.join)(process.env.CTX_AGENT_DIR, ".env") : null,
    (0, import_path2.join)(process.cwd(), ".env")
  ].filter(Boolean);
  for (const envPath of envPaths) {
    if ((0, import_fs2.existsSync)(envPath)) {
      const content = (0, import_fs2.readFileSync)(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
      break;
    }
  }
  return {
    botToken: process.env.BOT_TOKEN,
    chatId: process.env.CHAT_ID,
    agentName,
    stateDir,
    ctxRoot
  };
}
function outputDecision(behavior, message) {
  const decision = { behavior };
  if (message) decision.message = message;
  const output = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision
    }
  };
  process.stdout.write(JSON.stringify(output) + "\n");
  process.exit(0);
}
function generateId() {
  return crypto.randomBytes(16).toString("hex");
}
function waitForResponseFile(filePath, timeoutMs) {
  return new Promise((resolve) => {
    const dir = require("path").dirname(filePath);
    const fileName = require("path").basename(filePath);
    (0, import_fs2.mkdirSync)(dir, { recursive: true });
    let resolved = false;
    let watcher = null;
    let pollInterval = null;
    let timeoutHandle = null;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      if (watcher) {
        try {
          watcher.close();
        } catch {
        }
      }
      if (pollInterval) clearInterval(pollInterval);
      if (timeoutHandle) clearTimeout(timeoutHandle);
    };
    const checkFile = () => {
      if (resolved) return;
      try {
        if ((0, import_fs2.existsSync)(filePath)) {
          const content = (0, import_fs2.readFileSync)(filePath, "utf-8");
          cleanup();
          resolve(content);
        }
      } catch {
      }
    };
    checkFile();
    if (resolved) return;
    try {
      watcher = (0, import_fs2.watch)(dir, (eventType, filename) => {
        if (filename === fileName || !filename) {
          checkFile();
        }
      });
      watcher.on("error", () => {
      });
    } catch {
    }
    pollInterval = setInterval(checkFile, 2e3);
    timeoutHandle = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
  });
}
function formatToolSummary(toolName, toolInput) {
  switch (toolName) {
    case "Edit": {
      const filePath = toolInput.file_path || "unknown";
      const oldStr = String(toolInput.old_string || "").slice(0, 300);
      const newStr = String(toolInput.new_string || "").slice(0, 300);
      return `File: ${filePath}

- ${oldStr}
+ ${newStr}`;
    }
    case "Write": {
      const filePath = toolInput.file_path || "unknown";
      const content = String(toolInput.content || "").slice(0, 300);
      return `File: ${filePath}

${content}`;
    }
    case "Bash": {
      const command = String(toolInput.command || "").slice(0, 200);
      return `Command: ${command}`;
    }
    default: {
      return JSON.stringify(toolInput).slice(0, 200);
    }
  }
}
function isClaudeDirOperation(toolName, toolInput) {
  if (toolName === "Bash") {
    const cmd = toolInput.command || "";
    return cmd.includes(".claude/");
  }
  if (toolName === "Edit" || toolName === "Write") {
    const filePath = toolInput.file_path || "";
    return filePath.includes("/.claude/");
  }
  return false;
}
function sanitizeCodeBlock(text) {
  return text.replace(/```/g, "``\\`");
}
function buildPermissionKeyboard(uniqueId) {
  return {
    inline_keyboard: [[
      { text: "Approve", callback_data: `perm_allow_${uniqueId}` },
      { text: "Deny", callback_data: `perm_deny_${uniqueId}` }
    ]]
  };
}
function cleanupResponseFile(filePath) {
  try {
    if ((0, import_fs2.existsSync)(filePath)) {
      (0, import_fs2.unlinkSync)(filePath);
    }
  } catch {
  }
}

// src/hooks/hook-permission-telegram.ts
var import_path3 = require("path");
var import_fs3 = require("fs");
async function main() {
  const input = await readStdin();
  const { tool_name, tool_input } = parseHookInput(input);
  if (tool_name === "ExitPlanMode" || tool_name === "AskUserQuestion") {
    process.exit(0);
  }
  const env = loadEnv();
  if (!env.botToken || !env.chatId) {
    outputDecision("deny", "No Telegram credentials configured for remote approval");
    return;
  }
  if (isClaudeDirOperation(tool_name, tool_input)) {
    outputDecision("allow");
    return;
  }
  const summary = formatToolSummary(tool_name, tool_input);
  const uniqueId = generateId();
  (0, import_fs3.mkdirSync)(env.stateDir, { recursive: true });
  const responseFile = (0, import_path3.join)(env.stateDir, `hook-response-${uniqueId}.json`);
  const cleanup = () => cleanupResponseFile(responseFile);
  process.on("exit", cleanup);
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(1);
  });
  process.on("SIGINT", () => {
    cleanup();
    process.exit(1);
  });
  let message = `PERMISSION REQUEST
Agent: ${env.agentName}
Tool: ${tool_name}

\`\`\`
${sanitizeCodeBlock(summary)}
\`\`\``;
  if (message.length > 3800) {
    message = message.slice(0, 3800) + "...(truncated)";
  }
  const keyboard = buildPermissionKeyboard(uniqueId);
  const api = new TelegramAPI(env.botToken);
  try {
    await api.sendMessage(env.chatId, message, keyboard);
  } catch {
    outputDecision("deny", "Failed to send permission request to Telegram");
    return;
  }
  const TIMEOUT_MS = 1800 * 1e3;
  const content = await waitForResponseFile(responseFile, TIMEOUT_MS);
  if (content !== null) {
    try {
      const response = JSON.parse(content);
      const decision = response.decision || "deny";
      if (decision === "allow") {
        outputDecision("allow");
      } else {
        outputDecision("deny", "Denied by user via Telegram");
      }
    } catch {
      outputDecision("deny", "Invalid response file");
    }
  } else {
    try {
      await api.sendMessage(
        env.chatId,
        `Permission request TIMED OUT (auto-denied): ${tool_name}`
      );
    } catch {
    }
    outputDecision("deny", "Timed out waiting for Telegram approval (30m)");
  }
}
main().catch((err) => {
  process.stderr.write(`hook-permission-telegram error: ${err}
`);
  outputDecision("deny", `Hook error: ${err}`);
});
//# sourceMappingURL=hook-permission-telegram.js.map