import fs from "fs";
import path from "path";
import { DATA_ROOT } from "./dataRoot";

export interface LandmarkEvent {
  id: string;
  date: string;
  dateStr: string;
  headline: string;
  lead: string;
  signalCount: number;
  signalGate: number;
  topKeywords: string[];
  axesImpacted: string[];
  postCount: number;
  hasEditorial: boolean;
}

const LANDMARKS_DIR = path.join(DATA_ROOT, "landmarks");

function extractLead(editorialHtml: string): string {
  const m = editorialHtml.match(/<p class="lead">([\s\S]*?)<\/p>/);
  if (!m) return "";
  // strip any inner tags
  return m[1].replace(/<[^>]+>/g, "").trim();
}

export function getAllLandmarks(): LandmarkEvent[] {
  if (!fs.existsSync(LANDMARKS_DIR)) return [];

  const entries = fs
    .readdirSync(LANDMARKS_DIR)
    .filter((name) => {
      const evPath = path.join(LANDMARKS_DIR, name, "event.json");
      return fs.existsSync(evPath);
    })
    .sort() // landmark_1, landmark_2, ... — sort ascending, reverse for newest
    .reverse();

  return entries.map((name) => {
    const evPath = path.join(LANDMARKS_DIR, name, "event.json");
    const editorialPath = path.join(LANDMARKS_DIR, name, "editorial.html");

    const ev = JSON.parse(fs.readFileSync(evPath, "utf-8"));

    let lead = "";
    if (fs.existsSync(editorialPath)) {
      lead = extractLead(fs.readFileSync(editorialPath, "utf-8"));
    }

    return {
      id: name,
      date: ev.dateStr?.slice(0, 10) ?? ev.date?.slice(0, 10) ?? "",
      dateStr: ev.dateStr ?? "",
      headline: ev.headline ?? "",
      lead,
      signalCount: ev.signalCount ?? 0,
      signalGate: ev.signalGate ?? 3,
      topKeywords: ev.topKeywords ?? [],
      axesImpacted: ev.stats?.axesImpacted ?? [],
      postCount: ev.postCount ?? 0,
      hasEditorial: fs.existsSync(editorialPath),
    };
  });
}

export function getLatestLandmark(): LandmarkEvent | null {
  const all = getAllLandmarks();
  return all[0] ?? null;
}
