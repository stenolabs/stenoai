# Steno meeting packages

On macOS, Steno can exchange `.stenomeeting` files with the Swift Steno app.

## Receive a meeting

Choose **Import Steno package…** in the recording options menu, drop a package
onto Steno, or use Finder's **Open With → Steno**. Opening a package also works
when Steno is closed. Confirm the title and included content before importing.
Packages received through AirDrop use the same file-opening path.

Imported notes appear under **My notes**. Transcripts retain their structured
timing, speaker labels and language provenance for subsequent export. Importing
the same package again opens the existing meeting and preserves local edits.
A changed package with the same source meeting ID produces a conflict instead
of overwriting the existing meeting.

## Send a meeting

Open a saved meeting, then choose **Share Steno package…** in its **More options**
menu. The package includes the saved summary, personal notes and transcript.
Select **Include audio** if the recipient should also receive the recording;
audio is excluded by default.

Choose **Save and share…**, select a new file location, then choose **AirDrop**
in the macOS sharing menu. **Save…** creates the package without opening that
menu. The saved file remains at the selected location after sharing. Packages
are not encrypted, so store and share them with the same care as the meeting.

Recording or processing must finish before importing or exporting. Unsaved
editor changes are not part of the export.

## Compatibility and limits

- The format is version 1 of Swift Steno's uncompressed AppleArchive `AA01`
  contract, with `org.steno.meeting-transfer` as its document type.
- Meeting title, creation date, notes, transcript segments, word timings,
  speaker display labels, and explicit/estimated language provenance are
  preserved where present. Plain legacy transcripts remain plain text; export
  does not invent speaker identities or word timings.
- Optional audio supports interleaved, uncompressed PCM CAF. Existing local
  recordings are converted to Float32 CAF using the bundled ffmpeg. Compressed
  CAF codecs are currently rejected with an unsupported-audio message.
  Imported tracks are retained for package export; the maintenance command
  `full-reprocess` rejects imported meetings to protect their source media.
  Normal note generation from an imported transcript remains available.
- Voice embeddings, enrolled speaker profiles, credentials, attachments and
  report history are not included. The current saved summary is included as
  text in the notes payload.
- Archive limits include 32 entries, 24 GiB total payload, 16 GiB per audio
  track, 16 MiB notes and 64 MiB transcript JSON. The mapped local meeting must
  also fit the 100 MiB document limit. Imports and exports reserve 2 GB free
  space in addition to their destination data.
- Hashes, schema, entry names, sizes and audio metadata are validated before a
  meeting becomes visible. Existing destination files are never overwritten.
  Failed imports remove their staging files. Deleting an imported meeting
  retains audio during Undo and removes its owned tracks when deletion commits.
- The transfer UI and macOS document integration are gated to macOS. Windows
  and Linux retain their existing import and export behavior.

## Tests

The checked-in [Swift fixture](../tests/fixtures/swift-meeting-v1.md) was generated
by the unmodified Swift writer and contains only synthetic data. Unit tests
exercise that independent fixture, archive validation, deduplication, atomic
publication, storage limits and IPC lifecycle. The matching T1 and T2 specs
cover the UI and real application bridge, including audio, Undo and reimport.

```sh
cd app
node --test meeting-transfer-codec.test.js meeting-transfer-store.test.js meeting-transfer-ipc.test.js
npm run test:e2e -- --project=t1 meeting-transfer
npm run test:e2e -- --project=t2 meeting-transfer
```

The T2 tests use isolated user data and the bundled backend. Native share-menu
availability and receiving on a second physical device require a separate
macOS/device check; a successful file export alone does not prove delivery.
