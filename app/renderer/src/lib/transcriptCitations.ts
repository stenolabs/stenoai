/**
 * Deterministic transcript citation resolver.
 *
 * Given a bullet or summary point and a transcript (as lines or raw text),
 * resolves the best-matching line index in the transcript, or returns null if
 * no line/window clears the confidence threshold.
 *
 * Features:
 *  - English stopword filtering and case-folding
 *  - CJK character-bigram overlap for Traditional Chinese (zh-Hant)
 *  - Strips timestamp/speaker prefixes ([MM:SS - MM:SS] Speaker:) when scoring
 *  - Windowing across 1-3 consecutive lines for multi-turn points
 *  - Inverted-index preprocessing for fast O(1) lookups across long transcripts
 */

export interface CitationMatch {
  lineIndex: number;
  score: number;
  lineText?: string;
}

export interface CitationOptions {
  /** Minimum score (0..1) required to accept a match. Default: 0.35 */
  threshold?: number;
}

export interface TranscriptWindow {
  startLineIndex: number;
  size: number;
  tokens: Set<string>;
  tokenCount: number;
}

export interface ProcessedTranscript {
  lines: string[];
  cleanLines: string[];
  lineTokens: Set<string>[];
  windows: TranscriptWindow[];
  /** token -> list of window indices */
  tokenToWindows: Map<string, number[]>;
}

const DEFAULT_THRESHOLD = 0.35;

export const ENGLISH_STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
  'any', 'are', 'aren', 'as', 'at', 'be', 'because', 'been', 'before', 'being',
  'below', 'between', 'both', 'but', 'by', 'can', 'cannot', 'could', 'did',
  'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from',
  'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers',
  'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is',
  'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my', 'myself', 'no',
  'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
  'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should',
  'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them',
  'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with',
  'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
]);

/**
 * Strips leading speaker tags and timestamps from a transcript line so they do
 * not artificially inflate or skew keyword scoring.
 * Examples:
 *   "[00:00 - 00:05] Alice: Hello" -> "Hello"
 *   "[00:03] [You] We ship Friday." -> "We ship Friday."
 *   "[Others] I will prep notes." -> "I will prep notes."
 *   "Alice: We ship Friday." -> "We ship Friday."
 */
export function stripTranscriptPrefix(line: string): string {
  let s = line.trim();
  // Strip [00:00 - 00:05] or [00:03] or [01:23:45]
  s = s.replace(/^\[\d{1,3}:\d{2}(?::\d{2})?(?:\s*-\s*\d{1,3}:\d{2}(?::\d{2})?)?\]\s*/, '');
  // Strip [You], [Others], [Speaker 1], etc.
  s = s.replace(/^\[[^\]]+\]\s*/, '');
  // Strip Speaker: or Alice:
  s = s.replace(/^[A-Za-z0-9_\u4e00-\u9fff\s]{1,30}:\s*/, '');
  return s.trim();
}

/**
 * Tokenises text into a set of lowercased content words and CJK character-bigrams.
 */
export function extractTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  if (!text) return tokens;

  const clean = stripTranscriptPrefix(text).toLowerCase();

  // 1. Space/punctuation delimited word tokens (non-CJK)
  const words = clean.split(/[^a-z0-9\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/);
  for (const word of words) {
    const trimmed = word.trim();
    if (!trimmed) continue;
    // Check if it's pure Latin/numeric
    if (/^[a-z0-9]+$/.test(trimmed)) {
      if (trimmed.length >= 2 && !ENGLISH_STOPWORDS.has(trimmed)) {
        tokens.add(trimmed);
      }
    }
  }

  // 2. CJK character bigrams (and unigrams for short segments)
  const cjkMatches = clean.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g);
  if (cjkMatches) {
    for (const segment of cjkMatches) {
      if (segment.length === 1) {
        tokens.add(segment);
      } else {
        for (let i = 0; i < segment.length - 1; i++) {
          tokens.add(segment.slice(i, i + 2));
        }
      }
    }
  }

  return tokens;
}

export function splitTranscriptLines(transcript: string): string[] {
  return transcript.split(/\r?\n/);
}

/**
 * Pre-processes a transcript in a single pass:
 *  - extracts tokens for each line
 *  - builds sliding windows of size 1, 2, and 3
 *  - indexes tokens into an inverted index
 */
export function preprocessTranscript(transcript: string | string[]): ProcessedTranscript {
  const lines = Array.isArray(transcript) ? transcript : splitTranscriptLines(transcript);
  const cleanLines = lines.map(stripTranscriptPrefix);
  const lineTokens = cleanLines.map((l) => extractTokens(l));

  const windows: TranscriptWindow[] = [];
  const tokenToWindows = new Map<string, number[]>();

  const n = lines.length;

  for (let i = 0; i < n; i++) {
    // 1-line window
    const win1Tokens = new Set(lineTokens[i]);
    const win1Index = windows.length;
    windows.push({
      startLineIndex: i,
      size: 1,
      tokens: win1Tokens,
      tokenCount: win1Tokens.size,
    });
    for (const t of win1Tokens) {
      let arr = tokenToWindows.get(t);
      if (!arr) {
        arr = [];
        tokenToWindows.set(t, arr);
      }
      arr.push(win1Index);
    }

    // 2-line window
    if (i + 1 < n) {
      const win2Tokens = new Set<string>();
      for (const t of lineTokens[i]) win2Tokens.add(t);
      for (const t of lineTokens[i + 1]) win2Tokens.add(t);
      const win2Index = windows.length;
      windows.push({
        startLineIndex: i,
        size: 2,
        tokens: win2Tokens,
        tokenCount: win2Tokens.size,
      });
      for (const t of win2Tokens) {
        let arr = tokenToWindows.get(t);
        if (!arr) {
          arr = [];
          tokenToWindows.set(t, arr);
        }
        arr.push(win2Index);
      }
    }

    // 3-line window
    if (i + 2 < n) {
      const win3Tokens = new Set<string>();
      for (const t of lineTokens[i]) win3Tokens.add(t);
      for (const t of lineTokens[i + 1]) win3Tokens.add(t);
      for (const t of lineTokens[i + 2]) win3Tokens.add(t);
      const win3Index = windows.length;
      windows.push({
        startLineIndex: i,
        size: 3,
        tokens: win3Tokens,
        tokenCount: win3Tokens.size,
      });
      for (const t of win3Tokens) {
        let arr = tokenToWindows.get(t);
        if (!arr) {
          arr = [];
          tokenToWindows.set(t, arr);
        }
        arr.push(win3Index);
      }
    }
  }

  return {
    lines,
    cleanLines,
    lineTokens,
    windows,
    tokenToWindows,
  };
}

function isProcessedTranscript(t: unknown): t is ProcessedTranscript {
  return typeof t === 'object' && t !== null && 'tokenToWindows' in t && 'windows' in t;
}

/**
 * Finds the best-matching citation for a single bullet string.
 */
export function findCitation(
  bullet: string,
  transcript: string | string[] | ProcessedTranscript,
  options?: CitationOptions,
): CitationMatch | null {
  const processed = isProcessedTranscript(transcript)
    ? transcript
    : preprocessTranscript(transcript);

  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const bulletTokens = extractTokens(bullet);

  if (bulletTokens.size === 0 || processed.windows.length === 0) {
    return null;
  }

  // Count matching tokens per window using inverted index
  const matchCounts = new Map<number, number>();
  for (const token of bulletTokens) {
    const windowIndices = processed.tokenToWindows.get(token);
    if (windowIndices) {
      for (const wIdx of windowIndices) {
        matchCounts.set(wIdx, (matchCounts.get(wIdx) ?? 0) + 1);
      }
    }
  }

  if (matchCounts.size === 0) {
    return null;
  }

  let bestWindowIndex = -1;
  let bestScore = 0;
  let bestMatchedCount = 0;
  let bestWindowSize = 999;

  for (const [wIdx, matchedCount] of matchCounts.entries()) {
    const window = processed.windows[wIdx];
    const score = matchedCount / bulletTokens.size;

    // Confidence gating:
    // - For short bullets (<=2 tokens), require 100% match
    // - For longer bullets (>=3 tokens), require at least 2 distinct matching tokens and score >= threshold
    if (bulletTokens.size <= 2) {
      if (matchedCount < bulletTokens.size) continue;
    } else {
      if (matchedCount < 2) continue;
    }

    if (score < threshold) continue;

    // Tie-breaking:
    // 1. Higher score
    // 2. More matched tokens
    // 3. Smaller window size (preference for precision)
    // 4. Earlier line index
    if (
      score > bestScore ||
      (Math.abs(score - bestScore) < 1e-6 &&
        (matchedCount > bestMatchedCount ||
          (matchedCount === bestMatchedCount && window.size < bestWindowSize)))
    ) {
      bestScore = score;
      bestMatchedCount = matchedCount;
      bestWindowSize = window.size;
      bestWindowIndex = wIdx;
    }
  }

  if (bestWindowIndex === -1) {
    return null;
  }

  const bestWindow = processed.windows[bestWindowIndex];
  return {
    lineIndex: bestWindow.startLineIndex,
    score: bestScore,
    lineText: processed.lines[bestWindow.startLineIndex],
  };
}

/**
 * Resolves citations for multiple bullets in one pass over the transcript.
 */
export function findCitationsBatch(
  bullets: string[],
  transcript: string | string[] | ProcessedTranscript,
  options?: CitationOptions,
): (CitationMatch | null)[] {
  const processed = isProcessedTranscript(transcript)
    ? transcript
    : preprocessTranscript(transcript);

  return bullets.map((bullet) => findCitation(bullet, processed, options));
}
