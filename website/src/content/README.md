# Content collections editorial guardrails

This directory backs two content collections (see `../content.config.ts`):
`comparisons` (`/vs/*`, sourced from `comparisons.data.js`) and `industries`
(`/enterprise/*`, sourced from `industries.data.js`).

## Verified-claims policy (`/vs/` comparisons)

Every claim about a competitor must be verifiable from their public website
or repo. When pricing or features change, update the copy AND the `VERIFIED`
date exported from `comparisons.data.js`. Keep the tone factual; the honest
"choose them if" section is deliberate: it's what makes the rest credible.

## Compliance wording policy (`/enterprise/` industries)

Compliance posture (deliberate, legal-reviewed): Steno is a local desktop app
with no cloud service, so it is NOT a certified/attested vendor and we never
claim it is. HIPAA/GDPR are framed as "supports / by design / aligned",
never "certified" or "compliant". SOC 2 is reframed honestly: it audits a
cloud vendor's controls, and Steno has no cloud, so that vendor-breach risk
isn't in the data path. Keep every claim defensible against a buyer's
security team reading the code.
