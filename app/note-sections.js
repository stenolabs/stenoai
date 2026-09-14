// Pure, section-scoped transforms over the BODY of a meeting note (.md) -
// everything after the closing frontmatter '---'. Every function replaces
// exactly one '## ' section and leaves the CONTENT of every other section
// intact, with one deliberate exception: joinSections trims the tail of the
// whole body, so trailing whitespace on the last line of the LAST section is
// dropped even when that section was not the one edited. That trim is what
// stops blank lines accreting across repeated edits, and it costs nothing -
// both parsers trim each line on the way in. This is the same contract
// upsertUserNotesSection (main.js) already proves for User Notes; this module
// generalises it so the note editor can patch the other sections.
//
// The canonical order is the one simple_recorder.py writes: the model's
// markdown (Summary, Key Topics, Key Points, Action Items), then Transcript,
// then User Notes. A section that does not exist yet is inserted at its
// canonical position so the file keeps the shape a user recognises.
//
// Section headings are matched case-insensitively because parseMeetingMarkdown
// lowercases them; they are WRITTEN in canonical casing.

const SECTION_ORDER = [
  'Summary',
  'Key Topics',
  'Key Points',
  'Action Items',
  'Participants',
  'Transcript',
  'User Notes',
];

// A line that would create or close a markdown section if it reached the file.
// Leading whitespace counts: parseMeetingMarkdown trims nothing on the way in,
// but a pasted "  ## Transcript" is still a user trying to forge structure.
const STRUCTURAL_LINE = /^\s*#{1,6}\s/m;

function containsStructuralLine(text) {
  return STRUCTURAL_LINE.test(String(text ?? ''));
}

function canonicalRank(heading) {
  const i = SECTION_ORDER.findIndex(
    (h) => h.toLowerCase() === String(heading).trim().toLowerCase(),
  );
  // An unknown section sorts last so a future section we do not know about is
  // never re-ordered ahead of Transcript.
  return i === -1 ? SECTION_ORDER.length : i;
}

// Split the body into ordered blocks. The first block carries any preamble
// before the first '## ' heading and has heading === null.
function splitSections(body) {
  const blocks = [{ heading: null, lines: [] }];
  for (const line of String(body ?? '').split('\n')) {
    // '### Topic' does NOT match: index 2 is '#', not a space. Same rule as
    // parseMeetingMarkdown, so topics stay inside their parent section.
    if (line.startsWith('## ')) {
      blocks.push({ heading: line.slice(3).trim(), lines: [] });
    } else {
      blocks[blocks.length - 1].lines.push(line);
    }
  }
  return blocks;
}

function joinSections(blocks) {
  const out = [];
  for (const block of blocks) {
    if (block.heading !== null) out.push(`## ${block.heading}`);
    out.push(...block.lines);
  }
  // Trim the tail so repeated edits cannot accrete blank lines, then restore
  // exactly one terminating newline.
  return `${out.join('\n').replace(/\s+$/, '')}\n`;
}

// The body lines of a section: one blank line after the heading, the content,
// one blank line before whatever follows.
function sectionLines(content) {
  return ['', ...String(content).split('\n'), ''];
}

// Replace (or insert, or with empty content remove) exactly one '## ' section.
// Every other section keeps its heading, its position and its text; the one
// thing not preserved is trailing whitespace at the very end of the body, which
// joinSections trims (see above). Say it precisely rather than promising
// byte-for-byte identity the trim does not deliver.
function setSection(body, heading, content) {
  const blocks = splitSections(body);
  const trimmed = String(content ?? '').replace(/\s+$/, '');
  const matches = [];
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i].heading !== null && blocks[i].heading.toLowerCase() === heading.toLowerCase()) {
      matches.push(i);
    }
  }

  if (matches.length > 0) {
    if (!trimmed) {
      // An empty value removes the section, matching upsertUserNotesSection.
      // Remove EVERY matching block, not just the last: parseMeetingMarkdown
      // (main.js) walks the body and keeps overwriting sections[currentSection]
      // as it goes, so it would still read a stale earlier duplicate as the
      // section's content if we left one behind - resurrecting text the user
      // just cleared. Splice from the highest index down so earlier removals
      // don't shift the indices still queued for removal.
      for (let i = matches.length - 1; i >= 0; i -= 1) {
        blocks.splice(matches[i], 1);
      }
      return joinSections(blocks);
    }
    // parseMeetingMarkdown's parse loop keeps overwriting
    // sections[currentSection] on every '## ' heading it walks past, so when a
    // heading repeats, the LAST occurrence is the one that survives into the
    // parsed sections object - not the first. Write the edit at that same
    // last position, then drop every earlier duplicate, so a later read
    // through the parser sees exactly the value just written here. Do not
    // "simplify" this to first-wins; that reintroduces the drift class
    // that bit #346 and #313.
    const last = matches[matches.length - 1];
    blocks[last].lines = sectionLines(trimmed);
    for (let i = matches.length - 2; i >= 0; i -= 1) {
      blocks.splice(matches[i], 1);
    }
    return joinSections(blocks);
  }

  if (!trimmed) return joinSections(blocks);

  const rank = canonicalRank(heading);
  let insertAt = blocks.length;
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i].heading !== null && canonicalRank(blocks[i].heading) > rank) {
      insertAt = i;
      break;
    }
  }
  blocks.splice(insertAt, 0, { heading, lines: sectionLines(trimmed) });
  return joinSections(blocks);
}

function renderBulletList(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => String(item).trim())
    .filter(Boolean)
    .map((item) => `- ${item}`)
    .join('\n');
}

function renderTopics(areas) {
  return (Array.isArray(areas) ? areas : [])
    .map((area) => {
      const title = String(area && area.title ? area.title : '').trim();
      if (!title) return '';
      const analysis = String(area && area.analysis ? area.analysis : '').trim();
      return analysis ? `### ${title}\n\n${analysis}` : `### ${title}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

const setSummary = (body, text) => setSection(body, 'Summary', String(text ?? '').trim());
const setKeyPoints = (body, items) => setSection(body, 'Key Points', renderBulletList(items));
const setActionItems = (body, items) => setSection(body, 'Action Items', renderBulletList(items));
const setDiscussionAreas = (body, areas) => setSection(body, 'Key Topics', renderTopics(areas));

module.exports = {
  SECTION_ORDER,
  containsStructuralLine,
  setSection,
  setSummary,
  setKeyPoints,
  setActionItems,
  setDiscussionAreas,
};
