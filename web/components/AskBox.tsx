"use client";

import { useState, useRef, useCallback } from "react";

export default function AskBox() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const submit = useCallback(async () => {
    const q = question.trim();
    if (!q || loading) return;

    setAnswer("");
    setError("");
    setLoading(true);

    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError((json as { error?: string }).error ?? `Error ${res.status}`);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) { setError("No response stream."); return; }

      const decoder = new TextDecoder();
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setAnswer(acc);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError("Request failed. Try again.");
      }
    } finally {
      setLoading(false);
    }
  }, [question, loading]);

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="ask-box">
      <div className="ask-input-row">
        <textarea
          className="ask-textarea"
          placeholder="Ask Sebastian about his findings, beliefs, or what he's been observing..."
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleKey}
          maxLength={500}
          rows={3}
          disabled={loading}
        />
        <button
          className="ask-btn"
          onClick={submit}
          disabled={loading || !question.trim()}
          aria-label="Ask"
        >
          {loading ? <span className="ask-spinner" /> : "Ask"}
        </button>
      </div>
      <div className="ask-hint">
        Cmd+Enter to submit · 5 requests/min · answers drawn from Sebastian&apos;s actual observations
      </div>

      {error && <div className="ask-error">{error}</div>}

      {(answer || loading) && (
        <div className="ask-answer" aria-live="polite">
          {answer}
          {loading && !answer && <span className="ask-cursor" />}
        </div>
      )}
    </div>
  );
}
