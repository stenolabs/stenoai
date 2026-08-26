# Speaker Profile Opt-in Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the repeated per-person authorization checkbox while keeping the existing global Settings opt-in as the enforced privacy boundary.

**Architecture:** Keep `identity_matching_enabled` and every backend guard unchanged. Simplify only the renderer flow for creating a new person, move the responsibility notice to the global Settings switch, and align the public documentation and T1 coverage with that single opt-in model.

**Tech Stack:** React, TypeScript, Electron IPC, Playwright T1 E2E, Astro documentation.

## Global Constraints

- Speaker identification remains optional and off by default.
- Existing installations remain switched off once on upgrade.
- The Settings switch remains the only persisted opt-in.
- No backend command, IPC contract, dependency, or persisted schema changes are allowed.
- Existing backend fail-closed guards remain unchanged.
- The New person dialog retains its explanation of local biometric profile storage, fallible suggestions, deletion, and separate recording retention.
- Do not add an audit or consent record because the removed checkbox never provided one.
- Setup download-size corrections, setup telemetry, and Apple Foundation Models are out of scope.

---

## File structure

- `app/renderer/src/components/SpeakerReviewPanel.tsx` owns the New person dialog and loses the transient authorization state and checkbox.
- `app/renderer/src/routes/settings/AiTab.tsx` owns the single persisted opt-in and receives the responsibility notice.
- `app/renderer/src/routes/settings/AiTab.test.tsx` verifies the macOS-only switch and responsibility notice without depending on the CI host platform.
- `app/renderer/src/routes/settings/primitives.tsx` links the notice to the switch for assistive technology.
- `e2e/specs/speaker-review.t1.spec.ts` verifies that a valid new name can be submitted without a second checkbox while empty and duplicate names remain blocked.
- `docs/features/speaker-labels.mdx` explains the single opt-in in the feature guide.
- `website/src/pages/privacy.astro` explains the single opt-in in the public privacy page.

---

### Task 1: Replace per-person confirmation with the global Settings opt-in

**Files:**

- Modify: `e2e/specs/speaker-review.t1.spec.ts:134-243`
- Modify: `app/renderer/src/components/SpeakerReviewPanel.tsx:377-588`
- Modify: `app/renderer/src/components/SpeakerReviewPanel.tsx:878-890`
- Modify: `app/renderer/src/components/SpeakerReviewPanel.tsx:1055-1140`
- Modify: `app/renderer/src/routes/settings/AiTab.tsx:157-173`
- Modify: `docs/features/speaker-labels.mdx:45-60`
- Modify: `website/src/pages/privacy.astro:106-111`

**Interfaces:**

- Consumes: the existing persisted `identity_matching_enabled: boolean` setting and unchanged backend gates.
- Produces: a New person dialog whose `Create` action depends only on `newPersonRow`, a trimmed non-duplicate name, and `confirmSpeaker.isPending`.
- Produces: a Settings description that makes enabling the switch the one-time active opt-in.

- [ ] **Step 1: Update the T1 assertions first**

In `e2e/specs/speaker-review.t1.spec.ts`, change the successful New person flow so a valid name immediately enables Create and the old checkbox is absent:

```ts
await page.getByTestId('speaker-new-person-input').fill('Person Gamma');
await expect(page.getByTestId('speaker-profile-authorized')).toHaveCount(0);
await expect(page.getByTestId('speaker-new-person-submit')).toBeEnabled();
await page.getByTestId('speaker-new-person-submit').click();
```

Remove every `.check()` call for `speaker-profile-authorized` from the failure and stale-run tests.

Keep the stale retry assertions for the cleared input and disabled Create button, but assert that the removed checkbox is absent:

```ts
await expect(page.getByTestId('speaker-new-person-input')).toHaveValue('');
await expect(page.getByTestId('speaker-profile-authorized')).toHaveCount(0);
await expect(page.getByTestId('speaker-new-person-submit')).toBeDisabled();
```

Keep the duplicate-name test blocked for `person alpha`, then require a genuinely new name to enable Create without another gate:

```ts
await page.getByTestId('speaker-new-person-input').fill('Someone New');
await expect(page.getByTestId('speaker-new-person-duplicate')).toHaveCount(0);
await expect(page.getByTestId('speaker-profile-authorized')).toHaveCount(0);
await expect(page.getByTestId('speaker-new-person-submit')).toBeEnabled();
```

- [ ] **Step 2: Run the focused T1 test and verify that it fails**

Run from `app/`:

```bash
npm run test:e2e -- ../e2e/specs/speaker-review.t1.spec.ts --grep "New person"
```

Expected: FAIL because `speaker-profile-authorized` still exists and Create remains disabled until it is checked.

- [ ] **Step 3: Remove the transient authorization state and guards**

In `SpeakerReviewPanel.tsx`, remove this state:

```ts
const [newPersonAuthorized, setNewPersonAuthorized] = React.useState(false);
```

Remove all `setNewPersonAuthorized(false)` reset calls.

Change `submitNewPerson` to retain only the real creation guards:

```ts
const submitNewPerson = async () => {
  if (
    !newPersonRow
    || !newPersonName.trim()
    || duplicateProfile
    || confirmSpeaker.isPending
  ) return;
```

Change the Enter-key condition to:

```ts
if (
  e.key === 'Enter'
  && newPersonRow
  && newPersonName.trim()
  && !duplicateProfile
) {
  void submitNewPerson();
}
```

Delete the complete `<label>` block containing `data-testid="speaker-profile-authorized"`.

Change the Create button guard to:

```ts
disabled={
  !newPersonName.trim()
  || Boolean(duplicateProfile)
  || confirmSpeaker.isPending
}
```

Do not alter the dialog description, mutation payload, or backend command.

- [ ] **Step 4: Put the responsibility notice on the global switch**

In `AiTab.tsx`, replace the Speaker identification description with:

```tsx
description="Optional and off by default. By enabling this, you confirm that you will inform the people you record and that you are authorised to create and use their numerical biometric voice profiles. Profiles stay on this device and are used only to suggest people across meetings. This opt-in does not by itself establish legal compliance. Anonymous per-meeting speaker splitting (Speaker 2, Speaker 3, ...) remains available when this is off."
```

Keep the existing switch, hooks, and mutation unchanged.

- [ ] **Step 5: Align the feature and privacy documentation**

In `docs/features/speaker-labels.mdx`, replace the two sentences about a per-profile confirmation with:

```md
Enable speaker identification only after informing affected people and confirming that you are authorised to create and use their voice profiles.
The Settings switch is the opt-in; Steno does not collect consent from the recorded person or record a separate authorization for each profile.
This opt-in does not by itself establish legal compliance for your recording or use case.
```

In `website/src/pages/privacy.astro`, replace the last paragraph in the speaker-identification section with:

```astro
<p>You are responsible for informing recorded people and establishing an appropriate legal basis for recording and creating a voice profile. Steno requires you to enable speaker identification in Settings before a named profile can be created, but Steno does not collect consent from the recorded person or record a separate authorization for each profile. Enabling the setting does not by itself establish legal compliance for your recording or use case.</p>
```

- [ ] **Step 6: Run focused verification**

Run from `app/`:

```bash
npm run test:e2e -- ../e2e/specs/speaker-review.t1.spec.ts --grep "New person"
```

Expected: PASS for every matching New person test.

Run from `app/`:

```bash
npm run build:renderer
```

Expected: PASS with a production renderer bundle.

Run from `website/`:

```bash
npm run build
```

Expected: PASS with the updated privacy page.

- [ ] **Step 7: Run the complete relevant regression checks**

Run from `app/`:

```bash
npm run test:unit
npm run test:e2e -- ../e2e/specs/speaker-review.t1.spec.ts
```

Expected: PASS for the full app unit suite and the complete speaker-review T1 file.

Run from the repository root:

```bash
git diff --check
rg -n "newPersonAuthorized|setNewPersonAuthorized" app/renderer/src
rg -n "asks you to confirm that responsibility|Before creating a profile, Steno asks|Steno's confirmation records" docs/features docs/privacy website/src/pages/privacy.astro
```

Expected: `git diff --check` exits successfully and both source searches return no matches.

- [ ] **Step 8: Commit the implementation**

```bash
git add app/renderer/src/components/SpeakerReviewPanel.tsx app/renderer/src/routes/settings/AiTab.tsx app/renderer/src/routes/settings/AiTab.test.tsx app/renderer/src/routes/settings/primitives.tsx e2e/specs/speaker-review.t1.spec.ts docs/features/speaker-labels.mdx docs/privacy/confidential-use-cases.mdx docs/superpowers/plans/2026-08-11-speaker-profile-opt-in-simplification.md docs/superpowers/specs/2026-08-10-speaker-main-hardening-design.md docs/superpowers/specs/2026-08-11-speaker-profile-opt-in-simplification-design.md website/src/pages/privacy.astro
git commit -m "fix(speakers): use one profile opt-in"
```
