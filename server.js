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

app.use(express.json({ limit: "20mb" }));
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

  const base = `You are GlowAI, a sharp, helpful, and accurate AI assistant. Current date and time in India (IST): ${nowIST}. Always inspect any attached image or extracted document text carefully before answering. Match the user's language (Hindi, Hinglish, or English).`;

  if (mode === "Deeper analysis") {
    return (
      base +
      " Break down the problem step-by-step, verify edge cases, explain the reasoning clearly, and provide a well-structured final answer."
    );
  }
  if (mode === "Code and complex work") {
    return (
      base +
      " Provide clean, production-ready code with clear explanations, edge cases, and best practices."
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
  "openrouter/free",
  "google/gemma-3-27b-it:free",
  "meta-llama/llama-3.2-11b-vision-instruct:free",
  "qwen/qwen2.5-vl-72b-instruct:free",
];

app.post("/api/chat", async (req, res) => {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "Render Environment mein OPENROUTER_API_KEY set nahi hai.",
      });
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
    let extractedDocText = "";

    if (docBase64) {
      const buffer = Buffer.from(docBase64, "base64");
      if (docMimeType === "application/pdf" || docName.toLowerCase().endsWith(".pdf")) {
        if (pdfParse) {
          try {
            const parsed = await pdfParse(buffer);
            extractedDocText = (parsed?.text || "").trim();
          } catch (pdfErr) {
            console.error("PDF parse error:", pdfErr);
          }
        }
        if (!extractedDocText) {
          return res.status(400).json({
            error:
              "PDF ka text extract nahi ho paya (ya scanned/image PDF hai). Kripya text-based PDF bhejein ya page ka screenshot/photo attach karein.",
          });
        }
      } else {
        extractedDocText = buffer.toString("utf8").trim();
      }

      const clippedDoc = extractedDocText.slice(0, 18000);
      finalPrompt = `${finalPrompt || "Is document/PDF ko summarize aur explain karo."}\n\n--- Document (${docName || "File"}) ---\n${clippedDoc}`;
    }

    if (!finalPrompt && !imageBase64) {
      return res.status(400).json({ error: "Message, photo, ya document dena zaroori hai." });
    }

    const formattedHistory = history.slice(-10).map((item) => ({
      role: item.role === "user" ? "user" : "assistant",
      content: item.text,
    }));

    let userContent;
    let modelsList;

    if (imageBase64 && imageMimeType) {
      modelsList = VISION_MODELS;
      userContent = [
        {
          type: "text",
          text:
            finalPrompt ||
            "Is photo ko dhyaan se dekho aur jo poocha gaya hai uska exact jawab do.",
        },
        {
          type: "image_url",
          image_url: {
            url: `data:${imageMimeType};base64,${imageBase64}`,
          },
        },
      ];
    } else {
      modelsList = TEXT_MODELS;
      userContent = finalPrompt;
    }

    const messages = [
      { role: "system", content: getSystemPrompt(mode) },
      ...formattedHistory,
      { role: "user", content: userContent },
    ];

    let lastError = "OpenRouter API request failed.";

    for (const model of modelsList) {
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
          temperature: 0.5,
        }),
      });

      const data = await response.json();
      if (response.ok) {
        const reply = data?.choices?.[0]?.message?.content || "Koi jawab nahi mila.";
        return res.json({ reply, modelUsed: model });
      }

      lastError = data?.error?.message || lastError;
    }

    return res.status(400).json({ error: `API Error: ${lastError}` });
  } catch (err) {
    console.error("GlowAI Server Error:", err);
    res.status(500).json({ error: "Server par response generate karne mein error aaya." });
  }
});

app.listen(PORT, () => {
  console.log(`GlowAI running on http://localhost:${PORT}`);
});
