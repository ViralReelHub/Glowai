import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

dotenv.config();

const require = createRequire(import.meta.url);
let pdfParse = null;
try {
  pdfParse = require("pdf-parse");
} catch (_) {
  pdfParse = null;
}

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  next();
});

app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: "GlowAI", active: true });
});

function needsWebSearch(text = "") {
  return /\b(today|latest|current|news|score|price|weather|result|notification|2025|2026|who won|live|update|kab|aaj|taaza)\b/i.test(
    text
  );
}

async function fetchWebContext(query) {
  const tavilyKey = (process.env.TAVILY_API_KEY || "").trim();
  if (!tavilyKey || !query) return "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: tavilyKey,
        query: query.slice(0, 300),
        search_depth: "basic",
        max_results: 4,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return "";
    const data = await res.json();
    const results = (data?.results || [])
      .map((r, i) => `[${i + 1}] ${r.title}: ${r.content}`)
      .join("\n");
    return results ? `\n\n[Live Web Context]:\n${results}` : "";
  } catch (_) {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function getSystemPrompt(mode = "Auto") {
  const nowIST = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  const base = [
    `You are GlowAI, a high-precision AI assistant. Current date & time in India (IST): ${nowIST}.`,
    "Core accuracy & style rules:",
    "1. Answer directly and accurately in the user's language (natural Hinglish, Hindi, or English).",
    "2. For math, aptitude, SSC/JEE problems, or answer-key checks: solve independently step-by-step from scratch, double-check every arithmetic operation, and state the final verified answer clearly.",
    "3. Use clean headings, bullet points, or short tables when helpful so answers are easy to scan.",
    "4. Never guess facts, dates, or live figures if uncertain—use provided Live Web Context when available, or clearly note what requires official verification.",
  ].join(" ");

  if (mode === "Deeper analysis") {
    return (
      base +
      " Perform thorough step-by-step reasoning, verify edge cases, and give a crisp, verified final conclusion."
    );
  }
  if (mode === "Code and complex work") {
    return (
      base +
      " Provide complete, clean, bug-free, runnable code with concise explanations and edge cases."
    );
  }
  return base;
}

const TEXT_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen-2.5-72b-instruct:free",
  "google/gemma-3-27b-it:free",
  "openrouter/free",
];

const VISION_MODELS = [
  "google/gemma-3-27b-it:free",
  "qwen/qwen2.5-vl-72b-instruct:free",
  "openrouter/free",
];

app.post("/api/chat", async (req, res) => {
  const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) {
    return res.status(500).json({ error: "OPENROUTER_API_KEY set nahi hai." });
  }

  try {
    const {
      message = "",
      history = [],
      mode = "Auto",
      imageBase64 = null,
      imageMimeType = null,
      docBase64 = null,
      docMimeType = null,
      docName = "",
    } = req.body;

    let promptText = message.trim();

    if (docBase64) {
      const buffer = Buffer.from(docBase64, "base64");
      let docText = "";
      if (docMimeType === "application/pdf" || docName.toLowerCase().endsWith(".pdf")) {
        if (!pdfParse) {
          return res.status(400).json({ error: "pdf-parse installed nahi hai." });
        }
        const parsed = await pdfParse(buffer);
        docText = (parsed?.text || "").trim();
      } else {
        docText = buffer.toString("utf8").trim();
      }
      if (!docText) {
        return res.status(400).json({ error: "PDF ka text nahi mil paya. Photo bhej kar try karein." });
      }
      promptText = `${promptText || "Is document ko accurately analyze aur summarize karo."}\n\n[Document: ${docName}]\n${docText.slice(0, 9000)}`;
    }

    if (!promptText && !imageBase64) {
      return res.status(400).json({ error: "Message ya file bhejein." });
    }

    const isVision = Boolean(imageBase64 && imageMimeType);
    const webContext = !isVision && needsWebSearch(promptText) ? await fetchWebContext(promptText) : "";
    const enrichedPrompt = promptText + webContext;

    const messages = [
      { role: "system", content: getSystemPrompt(mode) },
      ...history.slice(-6).map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.text,
      })),
      {
        role: "user",
        content: isVision
          ? [
              {
                type: "text",
                text:
                  enrichedPrompt ||
                  "Is photo ko dhyaan se dekho, saare text/questions ko accurately read karo, aur step-by-step sahi jawab do.",
              },
              { type: "image_url", image_url: { url: `data:${imageMimeType};base64,${imageBase64}` } },
            ]
          : enrichedPrompt,
      },
    ];

    const models = isVision ? VISION_MODELS : TEXT_MODELS;
    let upstreamRes = null;
    let lastError = "Model unavailable.";

    for (const model of models) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const candidate = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "HTTP-Referer": "https://glowai-dzs8.onrender.com",
            "X-Title": "GlowAI",
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.15,
            max_tokens: 2800,
            stream: true,
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (candidate.ok && candidate.body) {
          upstreamRes = candidate;
          break;
        } else {
          const errData = await candidate.json().catch(() => ({}));
          lastError = errData?.error?.message || `HTTP ${candidate.status}`;
        }
      } catch (err) {
        clearTimeout(timer);
        lastError = err?.message || lastError;
      }
    }

    if (!upstreamRes) {
      return res.status(400).json({ error: `API Error: ${lastError}` });
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let emitted = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed?.choices?.[0]?.delta?.content || "";
          if (delta) {
            emitted = true;
            res.write(`data: ${JSON.stringify({ token: delta })}\n\n`);
          }
        } catch (_) {}
      }
    }

    if (!emitted) {
      res.write(`data: ${JSON.stringify({ token: "Jawab generate nahi ho paya, please Regenerate dabayein." })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || "Server error." });
    } else {
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`GlowAI running on http://localhost:${PORT}`);
});
