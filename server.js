import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/chat", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Render Environment mein GEMINI_API_KEY missing hai." });
    }

    const { message, history = [] } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message khali nahi hona chahiye." });
    }

    const contents = [
      ...history.slice(-12).map((m) => ({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: m.text }],
      })),
      { role: "user", parts: [{ text: message }] },
    ];

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents,
    });

    res.json({ reply: response.text || "Koi jawab nahi mila." });
  } catch (err) {
    console.error("Gemini API Error:", err);
    const details = err?.message || "API request failed";
    res.status(500).json({ error: `API Error: ${details}` });
  }
});

app.listen(PORT, () => {
  console.log(`GlowAI running on http://localhost:${PORT}`);
});
