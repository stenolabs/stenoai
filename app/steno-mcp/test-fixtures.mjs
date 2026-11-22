// Seeds a temp Steno storage dir in the on-disk shapes the app writes, for the
// steno-mcp unit tests. Shapes mirror simple_recorder (_render_frontmatter,
// _write_transcript_file), src/folders.py (folders.json, `folders:` frontmatter)
// and the legacy _summary.json documents.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeTempDir(prefix = 'steno-mcp-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function writeConfig(dir, cfg) {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
}

export function writeFolders(dir, folders) {
  fs.writeFileSync(path.join(dir, 'folders.json'), JSON.stringify({ folders }, null, 2));
}

export function writeNote(dir, stem, { title, date, folders = [], sections = {}, transcript = '' }) {
  const out = path.join(dir, 'output');
  fs.mkdirSync(out, { recursive: true });
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = ['---', `title: "${esc(title)}"`, `date: "${date}"`, 'duration_seconds: 1800', 'language: "en"'];
  if (folders.length) lines.push(`folders: ${JSON.stringify(folders)}`);
  lines.push('---', '');
  for (const [heading, text] of Object.entries(sections)) lines.push(`## ${heading}`, '', text, '');
  if (transcript) lines.push('## Transcript', '', transcript, '');
  const file = path.join(out, `${stem}_summary.md`);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

export function writeTranscript(dir, stem, body) {
  const t = path.join(dir, 'transcripts');
  fs.mkdirSync(t, { recursive: true });
  fs.writeFileSync(
    path.join(t, `${stem}_transcript.txt`),
    `Session: ${stem}\nFile: ${stem}.webm\nDate: 2026-01-01 00:00:00\n\n${'='.repeat(60)}\n\n${body}\n`,
  );
}

export function writeJsonSummary(dir, stem, doc) {
  const out = path.join(dir, 'output');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${stem}_summary.json`), JSON.stringify(doc, null, 2));
}

/** A small, varied store: two folders, three .md notes, one legacy JSON note. */
export function seedStore(dir) {
  writeFolders(dir, [
    { id: 'f-sales', name: 'Sales', color: '#000', icon: 'folder', order: 0 },
    { id: 'f-eng', name: 'Engineering', color: '#000', icon: 'folder', order: 1 },
  ]);
  writeNote(dir, 'acme-kickoff', {
    title: 'Acme kickoff',
    date: '2026-11-02T10:00:00',
    folders: ['f-sales'],
    sections: {
      Summary: 'Kicked off the Acme pilot. Pricing agreed at the team tier.',
      Participants: 'Alice, Bob',
      'Key Points': '- Pilot starts in December\n- Pricing: team tier',
      'Action Items': '- [ ] **Alice** to send the order form\n- [x] Bob to share the deck',
      'User Notes': 'Ask about SSO.',
    },
    transcript: '[00:01] [You] inline copy that should be superseded by the transcript file',
  });
  writeTranscript(dir, 'acme-kickoff', '[00:01] [You] Welcome everyone.\n\n[00:09] [Speaker 2] The budget is approved.');
  writeNote(dir, 'eng-standup', {
    title: 'Engineering standup',
    date: '2026-11-10T09:00:00',
    folders: ['f-eng'],
    sections: {
      Summary: 'Release train on track. Flaky e2e test under investigation.',
      'Action Items': '- [ ] Carol to fix the flaky test',
    },
    transcript: '[00:01] [You] The release is Friday.',
  });
  writeNote(dir, 'one-on-one', {
    title: 'Personal 1:1',
    date: '2026-11-15T15:00:00',
    sections: { Summary: 'Career chat. Confidential.', 'Action Items': '- [ ] Alice to book training' },
  });
  writeJsonSummary(dir, 'legacy-review', {
    session_info: { name: 'Legacy quarterly review', processed_at: '2026-10-01T12:00:00' },
    summary: 'Quarterly numbers reviewed.',
    participants: ['Dana'],
    key_points: ['Revenue up'],
    action_items: ['Dana to circulate the deck'],
    transcript: 'Dana: revenue is up this quarter.',
    folders: ['f-sales'],
  });
}
