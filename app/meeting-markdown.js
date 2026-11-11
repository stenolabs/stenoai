'use strict';

// Extracted verbatim from main.js (RFC #327 phase 1). Pure: no electron, fs or module state.
const path = require('path');
const { normalizeMarkdownForParsing } = require('./note-sections');

// Mirrors simple_recorder._parse_meeting_markdown so the detail page (get-meeting)
// can render .md meetings without a Python round-trip. The two parsers MUST stay
// byte-for-byte equivalent on everything they surface into session_info / the
// meeting dict — they drift silently otherwise (see #346, and #313 for a prior
// drift). Any change here has to land in _parse_meeting_markdown too.
function parseMeetingMarkdown(content, mdPath) {
  // Split frontmatter
  const meta = {};
  let body = content;
  if (content.startsWith('---')) {
    const parts = content.split('---');
    // content.split('---', 2) in Python keeps the remainder; replicate by
    // re-joining everything after the second delimiter.
    if (parts.length >= 3) {
      const fmText = parts[1].trim();
      body = parts.slice(2).join('---').trim();
      for (const line of fmText.split('\n')) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        let value = line.slice(colon + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1).replace(/\\(.)/g, '$1');
        } else if (value.startsWith('[')) {
          try {
            value = JSON.parse(value);
          } catch (_) {
            value = [];
          }
        } else if (value === 'null') {
          value = null;
        } else if (value === 'true') {
          value = true;
        } else if (value === 'false') {
          value = false;
        } else if (/^-?\d+$/.test(value)) {
          value = parseInt(value, 10);
        }
        meta[key] = value;
      }
    }
  }

  body = normalizeMarkdownForParsing(body);

  // Parse markdown body into sections keyed by lowercased `## ` heading.
  const sections = {};
  let currentSection = null;
  let currentLines = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('## ')) {
      if (currentSection) sections[currentSection] = currentLines.join('\n').trim();
      currentSection = line.slice(3).trim().toLowerCase();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentSection) sections[currentSection] = currentLines.join('\n').trim();

  const participants = sections.participants
    ? sections.participants.split(',').map((p) => p.trim()).filter(Boolean)
    : [];

  const keyPoints = [];
  if (sections['key points']) {
    for (let line of sections['key points'].split('\n')) {
      line = line.trim();
      if (line.startsWith('- ')) keyPoints.push(line.slice(2));
    }
  }

  const actionItems = [];
  if (sections['action items']) {
    for (let line of sections['action items'].split('\n')) {
      line = line.trim();
      if (line.startsWith('- ')) actionItems.push(line.slice(2).replace('[ ] ', '').replace('[x] ', ''));
    }
  }

  const discussionAreas = [];
  if (sections['key topics']) {
    let currentTopic = null;
    let topicLines = [];
    for (const line of sections['key topics'].split('\n')) {
      if (line.startsWith('### ')) {
        if (currentTopic) {
          discussionAreas.push({ title: currentTopic, analysis: topicLines.join('\n').trim() });
        }
        currentTopic = line.slice(4).trim();
        topicLines = [];
      } else {
        topicLines.push(line);
      }
    }
    if (currentTopic) {
      discussionAreas.push({ title: currentTopic, analysis: topicLines.join('\n').trim() });
    }
  }

  const stem = path.basename(mdPath).replace(/\.md$/, '');
  const sessionInfo = {
    name: meta.title || stem,
    processed_at: meta.date || '',
    duration_seconds: meta.duration_seconds ?? null,
    summary_file: mdPath,
    output_language: meta.language ?? null,
  };
  if (meta.transcription_failed) {
    sessionInfo.transcription_failed = true;
    sessionInfo.reprocessable = Boolean(meta.reprocessable);
    if (meta.audio_file) sessionInfo.audio_file = meta.audio_file;
    if (meta.error) sessionInfo.error = meta.error;
  }
  if (meta.notes_generated === false) {
    sessionInfo.notes_generated = false;
  }
  // Mirror the Python list parser (_parse_meeting_markdown): the detail page
  // needs these markers too, or its Generate-notes CTA / processing affordance
  // never fires. notes_stale drives the floating "Generate notes" CTA after a
  // continue-recording append; is_live_transcript flags a live-sourced note;
  // processing is the instant-stop "finishing up" placeholder state.
  if (meta.notes_stale) {
    sessionInfo.notes_stale = true;
  }
  if (meta.is_live_transcript) {
    sessionInfo.is_live_transcript = true;
  }
  if (meta.processing) {
    sessionInfo.processing = true;
  }

  return {
    session_info: sessionInfo,
    summary: sections.summary || '',
    participants,
    discussion_areas: discussionAreas,
    key_points: keyPoints,
    action_items: actionItems,
    transcript: sections.transcript || '',
    is_diarised: meta.is_diarised || false,
    diarised_text: meta.is_diarised ? sections.transcript || '' : null,
    user_notes: sections['user notes'] ?? null,
    folders: meta.folders || [],
    continued_recordings: Array.isArray(meta.continued_recordings) ? meta.continued_recordings : [],
  };
}

module.exports = { parseMeetingMarkdown };
