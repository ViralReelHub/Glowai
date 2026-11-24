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

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", active: true });
});

function getSystemPrompt(mode = "Auto") {
  const nowIST = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const base = `You are GlowAI. Current IST: ${nowIST}. Reply directly, clearly, and accurately in the user's language (Hindi, Hinglish, or English).`;
  if (mode === "Deeper analysis") return base + " Give step-by-step reasoning and a clear final answer.";
  if (mode === "Code and complex work") return base + " Provide clean, working code with brief explanation.";
  return base;
}

const TEXT_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemma-3-27b-it:free",
  "qwen/qwen-2.5-72b-instruct:free",
  "openrouter/free",
];

const VISION_MODELS = [
  "google/gemma-3-27b-it:free",
  "qwen/qwen2.5-vl-72b-instruct:free",
  "openrouter/free",
];

async function queryModel(apiKey, model, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
        temperature: 0.4,
        max_tokens: 1600,
      }),
      signal: controller.signal,
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error?.message || `HTTP ${response.status}`);
    }

    const msg = data?.choices?.[0]?.message;
    const text = (msg?.content || msg?.reasoning || "").trim();
    if (!text) {
      throw new Error("Empty model output");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

app.post("/api/chat", async (req, res) => {
  try {
    const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
    if (!apiKey) {
      return res.status(500).json({ error: "OPENROUTER_API_KEY set nahi hai." });
    }

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
      promptText = `${promptText || "Is document ko summarize karo."}\n\n${docText.slice(0, 7000)}`;
    }

    if (!promptText && !imageBase64) {
      return res.status(400).json({ error: "Message ya file bhejein." });
    }

    const isVision = Boolean(imageBase64 && imageMimeType);
    const messages = [
      { role: "system", content: getSystemPrompt(mode) },
      ...history.slice(-4).map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.text,
      })),
      {
        role: "user",
        content: isVision
          ? [
              { type: "text", text: promptText || "Is photo ke baare mein batao." },
              { type: "image_url", image_url: { url: `data:${imageMimeType};base64,${imageBase64}` } },
            ]
          : promptText,
      },
    ];

    const models = isVision ? VISION_MODELS : TEXT_MODELS;
    let lastError = "Model response failed.";

    for (const model of models) {
      try {
        const reply = await queryModel(apiKey, model, messages);
        return res.json({ reply });
      } catch (err) {
        lastError = err?.message || lastError;
      }
    }

    return res.status(400).json({ error: `API Error: ${lastError}` });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Server error." });
  }
});

app.listen(PORT, () => {
  console.log(`GlowAI running on http://localhost:${PORT}`);
});
