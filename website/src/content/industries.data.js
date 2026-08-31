// Data for the /enterprise/ industry pages, loaded into the `industries`
// content collection (see ../content.config.ts). See src/content/README.md
// for the compliance-wording policy behind these claims.

// Shared compliance paragraph — one source of truth so the pages can't drift
// into overclaiming. Rendered on every industry page's "Compliance" block.
export const COMPLIANCE_BODY =
  "Steno runs entirely on your device. Your meeting recordings, transcripts, and summaries never reach our servers — there is no third-party processor handling your meeting data, which addresses a meaningful part of HIPAA, GDPR, and data-residency exposure. (Those frameworks also cover safeguards, agreements, and processes that remain your responsibility — no tool hands you compliance.) Steno itself isn't a certified cloud service, because there is no cloud service handling your meetings to certify — and that's the point: the vendor-breach risk that frameworks such as SOC 2 exist to assure against isn't in that path.";

// Short, honest compliance chips shown on industry pages. "-aligned" / "by
// design" / "-friendly" are load-bearing hedges — do not upgrade them to
// "certified" or "compliant".
const CHIPS = {
  gdpr: "GDPR-aligned",
  dataResidency: "Nothing leaves the device",
  airGapped: "Runs air-gapped / offline",
};

const CTA_MAILTO =
  "mailto:chantelle@stenoai.co?subject=Steno%20demo%20request&body=Hi%20Steno%20team%2C%0A%0AWe%27d%20like%20to%20see%20a%20demo.%0A%0AOrganisation%3A%20%0ATeam%20size%3A%20%0AUse%20case%3A%20%0A%0AThanks%2C";

export const government = {
  slug: "government",
  name: "Government",
  metaTitle: "Steno for Government — On-Device Meeting Notes, No Cloud",
  metaDescription:
    "On-device meeting transcription and summaries for government teams — data never leaves your perimeter, runs air-gapped, supports data-residency obligations by architecture. Open source.",
  eyebrow: "Steno for Government",
  h1: "Meeting notes that never leave your perimeter.",
  intro:
    "Briefings, policy discussions, and internal reviews carry information that can't be handed to a cloud vendor. Steno records, transcribes, and summarizes entirely on the device — no third-party processor, no data crossing a border, no records leaving the machine they were captured on.",
  chips: [CHIPS.dataResidency, CHIPS.airGapped, CHIPS.gdpr],
  pains: [
    "Cloud meeting tools route audio through servers outside your control — and often outside your jurisdiction.",
    "A bot joining the call is a participant you can't fully account for in a sensitive briefing.",
    "Retention and access to recordings sit under a vendor's terms, not your records policy.",
  ],
  points: [
    { h: "Data sovereignty", b: "Everything is processed and stored on the device. Nothing transits an external server, so residency and sovereignty obligations are supported by architecture, not a vendor promise." },
    { h: "Works air-gapped", b: "After first-run setup, Steno needs no network. It runs on isolated and offline networks where cloud tools simply can't operate." },
    { h: "No bot in the room", b: "Steno captures system and microphone audio directly — nothing joins the meeting as a participant." },
    { h: "Auditable by design", b: "It's open source. Your security team can read exactly what touches the audio and confirm the no-network claim themselves." },
  ],
  faqs: [
    { q: "Does Steno meet data-residency requirements?", a: "Because processing and storage happen on the device and nothing is uploaded, your data never leaves the machine — or the jurisdiction it's in. There is no cloud region to configure and no cross-border transfer to account for." },
    { q: "Can it run on an isolated or air-gapped network?", a: "Yes. Once the models are downloaded during first-run setup, recording, transcription, and summarization all run offline. Steno makes no network requests with your meeting content." },
    { q: "How do we verify what it does?", a: "Steno is open source (MIT). Your team can audit the code, build it from source, and confirm exactly what it does and doesn't send before deploying." },
  ],
};

export const defense = {
  slug: "defense",
  name: "Defence",
  metaTitle: "Steno for Defence — Air-Gapped, On-Device Meeting Notes",
  metaDescription:
    "Meeting transcription and summaries that run fully offline and air-gapped on your own hardware. Nothing transits an external server — designed for air-gapped, local-only deployments. Open source.",
  eyebrow: "Steno for Defence",
  h1: "Built for the discussions that can't touch a cloud.",
  intro:
    "Operational planning and sensitive discussions run on hardware you control, on networks you control. Steno does the entire pipeline — capture, transcription, summary — on the device, offline, with nothing transiting an external server. It's designed for air-gapped, local-only deployments — the environment cloud notetakers structurally can't serve. (Accreditation for any specific classified environment is a function of your own deployment and authorization process, not the app alone.)",
  chips: [CHIPS.airGapped, CHIPS.dataResidency],
  pains: [
    "Cloud transcription is a non-starter when the audio can't leave the enclave.",
    "SaaS meeting assistants require connectivity and a vendor relationship you can't extend to classified work.",
    "A meeting bot is an external participant — unacceptable in an operational context.",
  ],
  points: [
    { h: "Fully offline", b: "No network dependency after setup. Steno runs on air-gapped and disconnected systems where SaaS tools cannot." },
    { h: "Nothing leaves the device", b: "Audio, transcripts, and summaries stay on the machine. There is no upload path and no vendor in the data flow." },
    { h: "On-device models", b: "Transcription (Parakeet, Whisper) and summarization run locally on your hardware — no external inference service is ever called." },
    { h: "Open and inspectable", b: "MIT-licensed source your security authority can review and build in a controlled environment." },
  ],
  faqs: [
    { q: "Can Steno run in an air-gapped environment?", a: "Yes — that's a primary design target. After the one-time model download, everything runs with no network connection at all." },
    { q: "Is any data ever sent to Steno's servers?", a: "No. Steno makes no network calls with your meeting content. Recordings, transcripts, and summaries are ordinary files in local storage on your device." },
    { q: "Can we review and control the build?", a: "Yes. It's open source, so it can be audited and built from source in your own environment before deployment." },
  ],
};

export const ALL = [government, defense];
export { CTA_MAILTO };
