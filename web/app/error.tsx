"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[error boundary]", error);
  }, [error]);

  return (
    <div style={{ padding: "2rem", fontFamily: "monospace" }}>
      <h2 style={{ marginBottom: "1rem" }}>Something went wrong</h2>
      <p style={{ marginBottom: "1rem", color: "#888" }}>
        {error.digest ? `Error ID: ${error.digest}` : "An unexpected error occurred."}
      </p>
      <button
        onClick={reset}
        style={{ padding: "0.5rem 1rem", cursor: "pointer" }}
      >
        Try again
      </button>
    </div>
  );
}
