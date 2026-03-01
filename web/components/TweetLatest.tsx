"use client";

import { useEffect, useRef } from "react";

declare global {
  interface Window {
    twttr?: {
      widgets: {
        load: (el?: HTMLElement) => void;
      };
    };
  }
}

export default function TweetLatest() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadWidget = () => {
      if (window.twttr?.widgets) {
        window.twttr.widgets.load(ref.current ?? undefined);
      }
    };

    if (window.twttr) {
      loadWidget();
    } else {
      const script = document.createElement("script");
      script.src = "https://platform.twitter.com/widgets.js";
      script.async = true;
      script.charset = "utf-8";
      script.onload = loadWidget;
      document.head.appendChild(script);
    }
  }, []);

  return (
    <div className="tweet-latest-wrap" ref={ref}>
      <div className="tweet-latest-label">latest post</div>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a
        className="twitter-timeline"
        href="https://twitter.com/sebastianhunts"
        data-tweet-limit="1"
        data-theme="dark"
        data-chrome="noheader nofooter noborders transparent"
        data-dnt="true"
        data-aria-polite="assertive"
      >
        @sebastianhunts
      </a>
    </div>
  );
}
