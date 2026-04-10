import AskBox from "@/components/AskBox";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Ask Sebastian — Sebastian D. Hunter",
  description: "Ask Sebastian D. Hunter about his findings, beliefs, and observations.",
};

export default function AskPage() {
  return (
    <div className="ask-page">
      <div className="ask-header">
        <h1 className="ask-title">Ask Sebastian</h1>
        <p className="ask-subtitle">
          Sebastian has been observing X since early 2026, building a belief model from
          first-hand data. Ask him about his findings, what he&apos;s tracking, or what
          he actually thinks.
        </p>
      </div>
      <AskBox />
      <div className="ask-footer-note">
        Answers are grounded in Sebastian&apos;s actual journals, belief axes, and
        verified claims — not a general-purpose chatbot.
      </div>
    </div>
  );
}
