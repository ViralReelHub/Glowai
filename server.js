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
    `You are GlowAI, an accurate and honest AI assistant. Current date and time (IST): ${nowIST}.`,
    "Strict accuracy rules:",
    "1. Answer directly, accurately, and clearly in the user's language (Hindi, Hinglish, or English).",
    "2. Never guess or invent facts, dates, prices, exam cutoffs, or links if unsure. Clearly state what is certain vs. approximate or needs official verification.",
    "3. Double-check calculations, formulas, and logic before writing the final answer.",
  ].join(" ");

  if (mode === "Deeper analysis") {
    return (
      base +
      " Break the problem down step-by-step, check edge cases and assumptions, and give a clear final conclusion."
    );
  }
  if (mode === "Code and complex work") {
    return (
      base +
      " Write clean, bug-free, runnable code and explain key parts and potential edge cases clearly."
    );
  }
  return base;
}

const ACCURATE_TEXT_MODELS = [
  "meta-llama/llama-3.3-70b-instruct",
  "qwen/qwen-2.5-72b-instruct:free",
  "openrouter/free",
];

const ACCURATE_VISION_MODELS = [
  "google/gemma-3-27b-it:free",
  "qwen/qwen2.5-vl-72b-instruct:free",
  "openrouter/free",
];

async function callOpenRouter(apiKey, model, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);

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
        temperature: 0.2,
        max_tokens: 2048,
      }),
      signal: controller.signal,
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error?.message || "OpenRouter request failed");
    }
    return data?.choices?.[0]?.message?.content || "Koi jawab nahi mila.";
  } finally {
    clearTimeout(timer);
  }
}

app.post("/api/chat", async (req, res) => {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
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
          error: "PDF mein readable text nahi mila (scanned PDF ho sakti hai). Photo bhej kar try karein.",
        });
      }

      finalPrompt = `${finalPrompt || "Is document ko accurately summarize aur explain karo."}\n\n[Document: ${docName}]\n${extractedText.slice(0, 10000)}`;
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
            text:
              finalPrompt ||
              "Is photo ko dhyaan se dekho aur jo clearly visible hai uske aadhar par sahi jawab do.",
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

    const modelsToTry = isVision ? ACCURATE_VISION_MODELS : ACCURATE_TEXT_MODELS;
    let lastError = "Response error.";

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
    res.status(500).json({ error: "Response generate karne mein error aaya." });
  }
});

app.listen(PORT, () => {
  console.log(`GlowAI running on http://localhost:${PORT}`);
});
