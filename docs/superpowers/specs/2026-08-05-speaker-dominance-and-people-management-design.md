# Speaker Dominance and People Management Design

## Goal

Keep sustained secondary speakers visible and labelable in long recordings while retaining the existing protection against short diarization blips.
Move global person-profile deletion into Settings and keep large profile libraries usable from the meeting review picker.

## Dominance classification

`CHANNEL_DOMINANCE_THRESHOLD` remains `0.92`.
The ratio gate continues to collapse ordinary single-speaker channels whose secondary clusters are only short diarization artifacts.

Add an absolute floor of 15 seconds and reuse the validated 1.55-second minimum average turn length for a non-dominant cluster.
When a channel is at least 92 percent dominant but one or more minority clusters clear both gates, those sustained clusters remain distinct speakers.
Minority clusters below either floor inherit the dominant cluster's transcript label and do not become separate `Speaker N` entries.

The label planner must also return the cluster IDs eligible for self-voiceprint matching.
This prevents a short folded blip from matching the owner's voiceprint and re-anchoring the entire mic channel.
If a sustained minority cluster matches the owner, folded blips continue to inherit the previous dominant cluster's replacement label rather than becoming their own speaker.

## Review panel availability

`is_diarised` describes whether the saved transcript contains more than one label.
The review panel's data source is the speaker sidecar, so that frontmatter flag is not sufficient to decide whether the panel has useful work.

The panel queries speaker suggestions whenever it has a meeting stem.
Electron forwards each non-empty stem to the CLI, which reports a missing sidecar as a successful empty result.
The panel remains visible when the sidecar has at least one row for a diarised transcript or more than one row for a non-diarised transcript.
Zero-row results and non-diarised meetings with only one row show no review panel.

## People management

The existing `People` Settings tab remains the only UI location for deleting a person profile.
Deletion keeps the existing global-warning text because it removes recognition evidence across all meetings.
The meeting picker contains assignment actions only.

The picker displays a search field at eight profiles or more.
Search remains substring-based, case-insensitive, and diacritic-insensitive while preserving the existing meeting-first ordering.
The list stays height-limited and scrollable.

Deleting a profile invalidates the complete speaker query tree.
A meeting row that loses its assigned person becomes an unidentified filtered row and stays reachable through the existing filtered-row toggle after remounting.

## Verification

Python unit tests cover the sustained-minority case, the short-blip case, the fragmented-artifact case, the 1:1 regression shape, and self-voiceprint behavior with a folded blip.
A T1 test covers a non-diarised meeting whose sidecar still has multiple clusters.
A CLI test and a T2 test prove that a missing sidecar is an expected empty result rather than a backend failure.
A T1 test covers the large-library picker search and the absence of deletion controls there.
The existing deletion T1 flow moves through Settings and still proves that the meeting row no longer points at the deleted profile.
A T1 test covers accessible delete-button names and visible recovery from a failed deletion.
A model-free T2 test creates profiles through the real backend bridge, opens the People tab, checks the global warning, deletes a profile, and verifies `config.json` on disk.

No test reads or writes the real user-data directory.
No production dependency is added.
