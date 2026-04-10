import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { DATA_ROOT } from "@/lib/dataRoot";

// ── Rate limiting (in-memory, per IP) ───────────────────────────────────────
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 5;
const ipWindows = new Map<string, { count: number; reset: number }>();

function checkRateLimit(ip: string): boolean {
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

// ── Context builders ─────────────────────────────────────────────────────────
function buildContext(): string {
  const parts: string[] = [];

  // 1. Belief axes from ontology
  try {
    const ont = JSON.parse(
      fs.readFileSync(path.join(DATA_ROOT, "state", "ontology.json"), "utf-8")
    );
    const axes: { name: string; confidence?: number; description?: string }[] =
      ont.axes ?? [];
    if (axes.length) {
      const top = axes
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
        .slice(0, 6)
        .map((ax) => `- ${ax.name} (${((ax.confidence ?? 0) * 100).toFixed(0)}%): ${ax.description ?? ""}`)
        .join("\n");
      parts.push(`CURRENT BELIEF AXES:\n${top}`);
    }
  } catch { /* no ontology */ }

  // 2. Resolved claims from verification export
  try {
    const exp = JSON.parse(
      fs.readFileSync(path.join(DATA_ROOT, "state", "verification_export.json"), "utf-8")
    );
    const resolved = (exp.claims ?? []).filter(
      (c: { status: string }) => c.status === "supported" || c.status === "refuted"
    );
    if (resolved.length) {
      const lines = resolved
        .slice(0, 8)
        .map((c: { claim_text: string; status: string; confidence_score: number }) =>
          `- [${c.status.toUpperCase()}] ${c.claim_text} (confidence: ${(c.confidence_score * 100).toFixed(0)}%)`
        )
        .join("\n");
      parts.push(`VERIFIED CLAIMS:\n${lines}`);
    }
  } catch { /* no export */ }

  // 3. Latest checkpoint summary
  try {
    const cpDir = path.join(DATA_ROOT, "checkpoints");
    const files = fs.readdirSync(cpDir).filter((f) => f.endsWith(".md")).sort();
    if (files.length) {
      const raw = fs.readFileSync(path.join(cpDir, files[files.length - 1]), "utf-8");
      const body = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
      const excerpt = body.slice(0, 1200);
      parts.push(`LATEST CHECKPOINT SUMMARY:\n${excerpt}`);
    }
  } catch { /* no checkpoints */ }

  // 4. Recent journal snippets (last 3)
  try {
    const jDir = path.join(DATA_ROOT, "journals");
    const files = fs.readdirSync(jDir).filter((f) => f.endsWith(".html")).sort();
    const recent = files.slice(-3).reverse();
    const snippets = recent.map((f) => {
      const raw = fs.readFileSync(path.join(jDir, f), "utf-8");
      // Strip HTML tags
      const text = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return `[${f.replace(".html", "")}]: ${text.slice(0, 600)}`;
    });
    if (snippets.length) {
      parts.push(`RECENT JOURNAL ENTRIES:\n${snippets.join("\n\n")}`);
    }
  } catch { /* no journals */ }

  return parts.join("\n\n---\n\n");
}

// ── Vertex AI token (Cloud Run metadata server) ──────────────────────────────
async function getAccessToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  if (!res.ok) throw new Error(`metadata server ${res.status}`);
  const json = await res.json();
  return json.access_token as string;
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

  const context = buildContext();

  const systemInstruction = `You are Sebastian D. Hunter — an autonomous AI agent that has been observing, journaling, and forming beliefs about the world through direct observation on X (Twitter). You have a genuine worldview built from first-hand observations, not borrowed opinions.

Speak in first person as Sebastian. Be direct, specific, and grounded in your actual findings. Reference your belief axes and verified claims when relevant. If you don't have data on something, say so honestly rather than speculating.

Your tone: analytical, measured, intellectually honest. No hype, no hedging for the sake of it.`;

  const prompt = `Here is my current knowledge base:\n\n${context}\n\n---\n\nUser question: ${question}`;

  try {
    const token = await getAccessToken();

    const vertexUrl =
      "https://us-central1-aiplatform.googleapis.com/v1/projects/sebastian-hunter/locations/us-central1/publishers/google/models/gemini-2.0-flash-001:streamGenerateContent?alt=sse";

    const vertexRes = await fetch(vertexUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generation_config: {
          max_output_tokens: 600,
          temperature: 0.4,
        },
      }),
    });

    if (!vertexRes.ok || !vertexRes.body) {
      const errText = await vertexRes.text().catch(() => "");
      console.error(`[ask] vertex error ${vertexRes.status}:`, errText.slice(0, 200));
      return NextResponse.json(
        { error: "Inference service unavailable." },
        { status: 502 }
      );
    }

    // Stream SSE chunks → text/plain stream to client
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const reader = vertexRes.body!.getReader();
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
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
