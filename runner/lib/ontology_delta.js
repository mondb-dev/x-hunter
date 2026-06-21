"use strict";

function stripCodeFences(raw) {
  return String(raw)
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function extractOutermostObject(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return raw;
  return raw.slice(start, end + 1);
}

function stripTrailingCommas(raw) {
  return raw.replace(/,\s*([}\]])/g, "$1");
}

function dropInvalidEscapes(raw) {
  return raw.replace(/\\([^"\\/bfnrtu])/g, "$1");
}

function decodeLooseString(value) {
  return String(value)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n|\\r|\\t/g, " ")
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/\\\//g, "/")
    .replace(/\\\\/g, "\\")
    .replace(/\\([^"\\/bfnrtu])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value) {
  return value == null ? "" : String(value).replace(/\s+/g, " ").trim();
}

function normalizeEvidenceEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const pole = normalizeText(entry.pole_alignment).toLowerCase();
  return {
    axis_id: normalizeText(entry.axis_id),
    source: normalizeText(entry.source),
    content: normalizeText(entry.content),
    timestamp: normalizeText(entry.timestamp),
    pole_alignment: pole,
  };
}

function normalizeNewAxis(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    id: normalizeText(entry.id),
    label: normalizeText(entry.label),
    left_pole: normalizeText(entry.left_pole),
    right_pole: normalizeText(entry.right_pole),
  };
}

function normalizeDelta(parsed) {
  const evidence = Array.isArray(parsed?.evidence)
    ? parsed.evidence.map(normalizeEvidenceEntry).filter(Boolean)
    : [];
  const newAxes = Array.isArray(parsed?.new_axes)
    ? parsed.new_axes.map(normalizeNewAxis).filter(Boolean)
    : [];
  return { evidence, new_axes: newAxes };
}

function skipWhitespace(raw, index) {
  let i = index;
  while (i < raw.length && /\s/.test(raw[i])) i += 1;
  return i;
}

function readJsonKey(raw, index) {
  let i = skipWhitespace(raw, index);
  if (raw[i] !== "\"") return null;
  i += 1;
  let out = "";
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\\") {
      if (i + 1 < raw.length) {
        out += raw[i + 1];
        i += 2;
        continue;
      }
      break;
    }
    if (ch === "\"") return { value: out, end: i + 1 };
    out += ch;
    i += 1;
  }
  return null;
}

function readLooseString(raw, index) {
  let i = index + 1;
  let out = "";
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\\") {
      if (i + 1 >= raw.length) break;
      const next = raw[i + 1];
      if (next === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) {
        out += raw.slice(i, i + 6);
        i += 6;
        continue;
      }
      out += `\\${next}`;
      i += 2;
      continue;
    }
    if (ch === "\"") {
      const next = skipWhitespace(raw, i + 1);
      if (next >= raw.length || raw[next] === "," || raw[next] === "}" || raw[next] === "]") {
        return { value: decodeLooseString(out), end: i + 1 };
      }
      out += "\"";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r" || ch === "\t") {
      out += " ";
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { value: decodeLooseString(out), end: i };
}

function readLooseBareValue(raw, index) {
  let i = index;
  while (i < raw.length && !/[,\]}]/.test(raw[i])) i += 1;
  const token = raw.slice(index, i).trim();
  if (token === "null") return { value: "", end: i };
  if (token === "true") return { value: "true", end: i };
  if (token === "false") return { value: "false", end: i };
  return { value: normalizeText(token), end: i };
}

function readLooseValue(raw, index) {
  const i = skipWhitespace(raw, index);
  if (raw[i] === "\"") return readLooseString(raw, i);
  return readLooseBareValue(raw, i);
}

function parseLooseObject(raw, start) {
  let i = skipWhitespace(raw, start);
  if (raw[i] !== "{") return null;
  i += 1;
  const obj = {};

  while (i < raw.length) {
    i = skipWhitespace(raw, i);
    if (raw[i] === "}") return { value: obj, end: i + 1 };

    const key = readJsonKey(raw, i);
    if (!key) return null;
    i = skipWhitespace(raw, key.end);
    if (raw[i] !== ":") return null;
    i += 1;

    const value = readLooseValue(raw, i);
    obj[key.value] = value.value;
    i = skipWhitespace(raw, value.end);

    if (raw[i] === ",") {
      i += 1;
      continue;
    }
    if (raw[i] === "}") return { value: obj, end: i + 1 };
  }

  return null;
}

function findArrayStart(raw, keyName) {
  const keyIndex = raw.indexOf(`"${keyName}"`);
  if (keyIndex === -1) return -1;
  const colonIndex = raw.indexOf(":", keyIndex);
  if (colonIndex === -1) return -1;
  return raw.indexOf("[", colonIndex);
}

function salvageArray(raw, keyName, normalizer) {
  const start = findArrayStart(raw, keyName);
  if (start === -1) return [];

  const out = [];
  let i = start + 1;
  while (i < raw.length) {
    i = skipWhitespace(raw, i);
    if (raw[i] === "]") break;
    if (raw[i] === "{") {
      const parsed = parseLooseObject(raw, i);
      if (!parsed) break;
      const normalized = normalizer(parsed.value);
      if (normalized) out.push(normalized);
      i = parsed.end;
      if (raw[i] === ",") i += 1;
      continue;
    }
    i += 1;
  }
  return out;
}

function buildErrorWithContext(raw, error) {
  const message = error?.message || String(error);
  const match = message.match(/position (\d+)/);
  if (!match) return new Error(message);
  const pos = Number(match[1]);
  const start = Math.max(0, pos - 80);
  const end = Math.min(raw.length, pos + 80);
  const snippet = raw.slice(start, end).replace(/\s+/g, " ");
  return new Error(`${message} near: ${snippet}`);
}

function parseOntologyDelta(rawInput) {
  const raw = String(rawInput || "").replace(/^\uFEFF/, "").trim();
  const candidates = [];
  const seen = new Set();

  function pushCandidate(value) {
    const candidate = String(value || "").trim();
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  }

  pushCandidate(raw);
  pushCandidate(stripCodeFences(raw));
  pushCandidate(extractOutermostObject(stripCodeFences(raw)));

  for (const candidate of [...candidates]) {
    pushCandidate(stripTrailingCommas(candidate));
    pushCandidate(dropInvalidEscapes(candidate));
    pushCandidate(stripTrailingCommas(dropInvalidEscapes(candidate)));
  }

  let lastError = new Error("ontology delta was empty");
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return {
        delta: normalizeDelta(parsed),
        repaired: candidate !== raw,
        method: candidate === raw ? "strict-json" : "json-repair",
      };
    } catch (error) {
      lastError = buildErrorWithContext(candidate, error);
    }
  }

  const salvageSource = extractOutermostObject(stripCodeFences(raw));
  const salvaged = {
    evidence: salvageArray(salvageSource, "evidence", normalizeEvidenceEntry),
    new_axes: salvageArray(salvageSource, "new_axes", normalizeNewAxis),
  };
  if (salvaged.evidence.length || salvaged.new_axes.length) {
    return {
      delta: salvaged,
      repaired: true,
      method: "tolerant-salvage",
    };
  }

  throw lastError;
}

module.exports = {
  parseOntologyDelta,
};
