import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// 24/7 Keep-Alive Health Check Route
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", service: "GlowAI", active: true });
});

function getSystemPrompt(mode = "Auto") {
  const base =
    "You are GlowAI, a sharp, helpful, and accurate AI assistant. Give clear, structured, well-reasoned answers. Match the user's language (Hindi, Hinglish, or English).";

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

app.post("/api/chat", async (req, res) => {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "Render Environment mein OPENROUTER_API_KEY set nahi hai.",
      });
    }

    const { message = "", history = [], mode = "Auto" } = req.body;
    if (!message.trim()) {
      return res.status(400).json({ error: "Message khali nahi hona chahiye." });
    }

    const messages = [
      { role: "system", content: getSystemPrompt(mode) },
      ...history.slice(-10).map((item) => ({
        role: item.role === "user" ? "user" : "assistant",
        content: item.text,
      })),
      { role: "user", content: message.trim() },
    ];

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://glowai-dzs8.onrender.com",
        "X-Title": "GlowAI",
      },
      body: JSON.stringify({
        model: "meta-llama/llama-3.3-70b-instruct:free",
        messages,
        temperature: 0.6,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      const errMsg = data?.error?.message || "OpenRouter API request failed.";
      return res.status(response.status).json({ error: `API Error: ${errMsg}` });
    }

    const reply = data?.choices?.[0]?.message?.content || "Koi jawab nahi mila.";
    res.json({ reply });
  } catch (err) {
    console.error("GlowAI Server Error:", err);
    res.status(500).json({ error: "Server par response generate karne mein error aaya." });
  }
});

app.listen(PORT, () => {
  console.log(`GlowAI running on http://localhost:${PORT}`);
});
