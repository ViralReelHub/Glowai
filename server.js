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

app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: "GlowAI", active: true });
});

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
    `You are GlowAI, a helpful, clear, and practical AI assistant. Current time (IST): ${nowIST}.`,
    "Match the user's language naturally (clear Hinglish, Hindi, or English—avoid broken or unnatural phrasing).",
    "Give direct, accurate, well-organized answers without filler. If something is uncertain or needs official verification, say so plainly.",
  ].join(" ");

  if (mode === "Deeper analysis") {
    return (
      base +
      " Break down the problem step-by-step, check edge cases, show clear reasoning, and conclude with a crisp summary."
    );
  }
  if (mode === "Code and complex work") {
    return (
      base +
      " Write clean, practical, bug-free code with concise explanations and edge cases."
    );
  }
  return base;
}

const TEXT_MODELS = [
  "openrouter/free",
  "meta-llama/llama-3.3-70b-instruct",
  "qwen/qwen-2.5-72b-instruct:free",
  "google/gemma-3-27b-it:free",
];

const VISION_MODELS = [
  "google/gemma-3-27b-it:free",
  "qwen/qwen2.5-vl-72b-instruct:free",
  "openrouter/free",
];

async function callOpenRouter(apiKey, model, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

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
        temperature: 0.3,
        max_tokens: 1800,
      }),
      signal: controller.signal,
    });

    const data = await response.json();
    if (!response.ok) {
      const msg = data?.error?.message || `HTTP ${response.status}`;
      throw new Error(`[${model}] ${msg}`);
    }
    return data?.choices?.[0]?.message?.content || "Koi jawab nahi mila.";
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`[${model}] Model ne 45s mein reply nahi diya (slow/busy).`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

app.post("/api/chat", async (req, res) => {
  try {
    const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
    if (!apiKey) {
      return res.status(500).json({ error: "Render Environment mein OPENROUTER_API_KEY set nahi hai." });
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

    let finalPrompt = message.trim();

    if (docBase64) {
      const buffer = Buffer.from(docBase64, "base64");
      let extractedText = "";

      if (docMimeType === "application/pdf" || docName.toLowerCase().endsWith(".pdf")) {
        if (!pdfParse) {
          return res.status(400).json({ error: "pdf-parse package installed nahi hai." });
        }
        const parsed = await pdfParse(buffer);
        extractedText = (parsed?.text || "").trim();
      } else {
        extractedText = buffer.toString("utf8").trim();
      }

      if (!extractedText) {
        return res.status(400).json({
          error: "PDF ka text extract nahi ho paya (scanned PDF ho sakti hai). Photo attach karke bhejein.",
        });
      }

      finalPrompt = `${finalPrompt || "Is document ko clear aur accurately summarize karo."}\n\n[Document: ${docName}]\n${extractedText.slice(0, 9500)}`;
    }

    if (!finalPrompt && !imageBase64) {
      return res.status(400).json({ error: "Message, photo, ya document bhejein." });
    }

    const formattedHistory = history.slice(-8).map((item) => ({
      role: item.role === "user" ? "user" : "assistant",
      content: item.text,
    }));

    const isVision = Boolean(imageBase64 && imageMimeType);
    const userContent = isVision
      ? [
          {
            type: "text",
            text: finalPrompt || "Is photo ko dekh kar jo poocha gaya hai uska sahi jawab do.",
          },
          {
            type: "image_url",
            image_url: { url: `data:${imageMimeType};base64,${imageBase64}` },
          },
        ]
      : finalPrompt;

    const messages = [
      { role: "system", content: getSystemPrompt(mode) },
      ...formattedHistory,
      { role: "user", content: userContent },
    ];

    const modelsToTry = isVision ? VISION_MODELS : TEXT_MODELS;
    let lastError = "OpenRouter request failed.";

    for (const model of modelsToTry) {
      try {
        const reply = await callOpenRouter(apiKey, model, messages);
        return res.json({ reply, modelUsed: model });
      } catch (err) {
        lastError = err?.message || lastError;
      }
    }

    return res.status(400).json({ error: `API Error: ${lastError}` });
  } catch (err) {
    console.error("GlowAI Error:", err);
    res.status(500).json({ error: err?.message || "Server response error." });
  }
});

app.listen(PORT, () => {
  console.log(`GlowAI running on http://localhost:${PORT}`);
});
