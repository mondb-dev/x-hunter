import { NextRequest, NextResponse } from "next/server";
import { buildPersona, buildCoreContext, recallFromDB, recallFromFiles, getAccessToken, callGemini } from "@/lib/sebastianRespond";

// ── Rate limiting (in-memory, per IP) ───────────────────────────────────────
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 5;
const WHITELISTED_IPS = new Set(
  (process.env.ASK_WHITELISTED_IPS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
);
const ipWindows = new Map<string, { count: number; reset: number }>();

function checkRateLimit(ip: string): boolean {
  if (WHITELISTED_IPS.has(ip)) return true;
  const now = Date.now();
  const w = ipWindows.get(ip);
  if (!w || now > w.reset) {
    ipWindows.set(ip, { count: 1, reset: now + RATE_WINDOW_MS });
    return true;
  }
  if (w.count >= RATE_LIMIT) return false;
  w.count++;
  return true;
}

// ── POST /api/ask ────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";

  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again in a minute." },
      { status: 429 }
    );
  }

  let question: string;
  try {
    const body = await req.json();
    question = (body.question ?? "").trim().slice(0, 500);
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!question) {
    return NextResponse.json({ error: "question is required." }, { status: 400 });
  }

  const coreContext = buildCoreContext({
    maxAxes:           8,
    journalCount:      3,
    journalChars:      800,
    includeCheckpoint: true,
    checkpointChars:   1200,
    includeClaims:     true,
  });

  // Recall — prefer Postgres FTS, fall back to file keyword search
  const hits = (await recallFromDB(question, 6)) ?? recallFromFiles(question, 6);
  const recallBlock = hits.length
    ? `## Recalled observations (keyword match on your question)\n` +
      hits.map((h) => `[${h.type} · ${h.source}]: ${h.excerpt}`).join("\n\n")
    : "";

  const context = [coreContext, recallBlock].filter(Boolean).join("\n\n");

  const systemInstruction = buildPersona("public");

  try {
    const token = await getAccessToken();

    const vertexRes = await callGemini({
      token,
      systemInstruction,
      contents: [{ role: "user", parts: [{ text: `${context}\n\n---\n\nQuestion: ${question}` }] }],
      stream:      true,
      maxTokens:   1500,
      temperature: 0.4,
    }) as Response;

    // Stream SSE chunks → text/plain to client
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const reader = (vertexRes as Response).body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;
              try {
                const chunk = JSON.parse(data);
                const text: string =
                  chunk?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
                if (text) controller.enqueue(encoder.encode(text));
              } catch { /* malformed chunk */ }
            }
          }
        } finally {
          controller.close();
          reader.releaseLock();
        }
      },
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    console.error("[ask] error:", err);
    const msg = err instanceof Error ? err.message : "Server error.";
    if (msg.includes("Gemini")) {
      return NextResponse.json({ error: "Inference service unavailable." }, { status: 502 });
    }
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
