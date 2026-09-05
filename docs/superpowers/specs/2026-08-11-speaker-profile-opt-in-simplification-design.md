# Speaker Profile Opt-in Simplification

**Status:** Approved.

## Goal

Use one explicit global opt-in in Settings for named speaker identification and remove the repeated authorization checkbox shown whenever a new person is created.

The result should keep the privacy boundary strong while reducing repeated friction during speaker review.

## Product behaviour

Speaker identification remains optional and off by default.

The switch in Settings > AI remains the only control that enables creation, storage, and matching of numerical biometric voice profiles.

Its description explains that profiles remain on the device and that the user confirms they will inform affected people and are authorised to create and use the profiles.

The opt-in does not by itself establish legal compliance for the recording or use case.

Turning on that switch is the active opt-in.

The New person dialog continues to explain what Steno stores, where it stays, that suggestions can be wrong, and how profiles can be deleted.

The dialog no longer contains a separate authorization checkbox.

A valid, non-duplicate name is sufficient to enable Create after the global setting has already enabled speaker identification.

Assigning an existing person remains unchanged.

## Enforcement and data flow

The persisted `identity_matching_enabled` configuration value remains the source of truth.

Existing backend checks continue to reject profile creation, suggestions, matching, and embedding backfills when the setting is disabled.

The migration that switches existing installations off once remains unchanged.

No consent or authorization record is added to the profile schema.

The removed checkbox was transient renderer state and was neither sent to the backend nor persisted, so removing it does not weaken an audit trail because no such audit trail existed.

Configuration write failures continue to fail closed through the existing Settings mutation and backend error handling.

## Code changes

`app/renderer/src/components/SpeakerReviewPanel.tsx` removes `newPersonAuthorized`, its reset paths, the checkbox, and the submit guards tied to it.

`app/renderer/src/routes/settings/AiTab.tsx` updates the global setting description with the one-time responsibility notice.

No backend command, IPC contract, or persisted schema changes are required.

## Documentation

Documentation must describe the Settings opt-in as the gate and must not claim that Steno asks for a separate confirmation before every named profile.

The affected public statements are in `docs/features/speaker-labels.mdx` and `website/src/pages/privacy.astro`.

General guidance that users should inform affected people and establish an appropriate legal basis remains valid.

## Verification

The existing speaker-review T1 flow is updated to create people without looking for or checking the removed checkbox.

The E2E flow still starts with speaker identification enabled through its isolated test configuration, so it continues to verify the real global gate rather than bypassing it.

Focused renderer tests and the relevant speaker-review E2E test must pass.

The full relevant unit suite must pass before the implementation is committed.

## Acceptance criteria

- Speaker identification is off on a fresh or migrated installation.
- Enabling it in Settings persists the choice.
- A new person can be created without a second authorization checkbox.
- Disabling the setting still prevents profile creation and matching at the backend boundary.
- The New person dialog still explains local biometric profile storage and deletion.
- Public documentation no longer describes a per-person confirmation step.

## Deferred follow-ups

Setup download-size corrections and privacy-safe setup-stage telemetry belong in a separate small pull request.

Apple Foundation Models as a macOS 26 fast-start provider requires a separate benchmark-backed design and is not part of this change.
