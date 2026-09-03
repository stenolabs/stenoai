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

// Every incident below is a matter of public record and each one carries a
// link to a primary or first-tier source (CISA, the CSRB, a parliamentary
// committee, or wire reporting). Same rule as the /vs/ pages: if a detail
// can't be checked from the linked source, it doesn't ship. Update
// BREACHES_VERIFIED whenever these are re-checked.
//
// Wording rules, in addition to the compliance policy above:
//   - Ongoing litigation is described as "alleges", never as fact.
//   - `why` must state what Steno's architecture actually removes, and must
//     not imply it removes risks it doesn't (see the SolarWinds entry, which
//     says so explicitly). A buyer's security team will read these.
export const BREACHES_VERIFIED = "September 2026";

const BREACH_INTRO_GOV =
  "None of these were careless organisations. In each case the data was lost somewhere outside the walls of the organisation that owned it — at a cloud provider, at a processor, or inside a tool that quietly took a copy.";

const BREACH_INTRO_DEF =
  "The pattern is consistent: the compromise happens at a link in the chain that isn't yours. A contractor's system, a vendor's build server, a file that left the enclave and couldn't be recalled.";

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
  breaches: {
    heading: "What happens when the data leaves",
    intro: BREACH_INTRO_GOV,
    items: [
      {
        title: "A stolen signing key opened government mailboxes",
        meta: "Microsoft Exchange Online · 2023",
        what: "A China-linked actor, tracked as Storm-0558, used a stolen Microsoft consumer signing key to forge authentication tokens and read Exchange Online mailboxes belonging to 22 organisations and more than 500 individuals, including officials at the US State and Commerce Departments. Roughly 60,000 State Department emails were taken. The Cyber Safety Review Board concluded in 2024 that the intrusion was preventable and traced it to a cascade of avoidable failures at Microsoft.",
        why: "No tenant setting would have stopped this. The affected departments did nothing wrong — the compromise was inside the provider holding their mail. Steno removes that dependency for meeting content: there is no provider account, no key and no server holding your transcripts to be compromised.",
        source: {
          label: "Cyber Safety Review Board report (CISA, 2024)",
          href: "https://www.cisa.gov/sites/default/files/2025-03/CSRBReviewOfTheSummer2023MEOIntrusion508.pdf",
        },
      },
      {
        title: "One file-transfer product, 2,500 organisations",
        meta: "MOVEit Transfer · 2023",
        what: "From 27 May 2023 the CL0P group exploited a zero-day in Progress Software's MOVEit Transfer to steal data from every instance it could reach. More than 2,500 organisations were affected, among them multiple US federal agencies — the Department of Energy confirmed two of its entities were caught in it.",
        why: "Most of those organisations would not have named MOVEit if you had asked them to list their data path. Meeting recordings and transcripts are exactly the kind of data that accumulates in that sort of intermediary. Steno's pipeline has no intermediary: capture, transcription and summarisation all happen on the machine.",
        source: {
          label: "CISA advisory AA23-158A",
          href: "https://www.cisa.gov/news-events/cybersecurity-advisories/aa23-158a",
        },
      },
      {
        title: "The notetaker itself became the exposure",
        meta: "Otter.ai litigation · 2025",
        what: "Class actions consolidated as In re Otter.AI Privacy Litigation in the Northern District of California allege that the AI notetaker joined Zoom, Teams and Google Meet calls and recorded participants who were not its customers, transmitted call content to its servers, and used those conversations to train its models — without the consent of everyone in the room. The claims are unproven and Otter.ai disputes them.",
        why: "Whatever the outcome, the exposure is structural: once a notetaker sends audio off the device, consent, retention and model-training become somebody else's policy. Steno never sends the audio anywhere, so those questions stay yours to answer.",
        source: {
          label: "NPR, August 2025",
          href: "https://www.npr.org/2025/08/15/g-s1-83087/otter-ai-transcription-class-action-lawsuit",
        },
      },
    ],
  },
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
  breaches: {
    heading: "What happens when the data leaves",
    intro: BREACH_INTRO_DEF,
    items: [
      {
        title: "A spreadsheet that left the building",
        meta: "UK Ministry of Defence, Afghan relocations · 2022, disclosed 2025",
        what: "In February 2022 a member of staff at UK Special Forces headquarters emailed out a dataset holding the names and details of roughly 19,000 Afghans who had applied for relocation under ARAP. It was not discovered until August 2023, when part of it surfaced in a Facebook group. The government obtained an unprecedented superinjunction that kept the breach — and a secret resettlement scheme built in response — out of public view until July 2025.",
        why: "Nothing was hacked. A copy was made and sent, and it could not be recalled. Steno cannot stop a person emailing a file, and doesn't claim to — but it adds no copies of its own: no vendor-side duplicate, no automatic sync, no export step in the pipeline. Recordings, transcripts and summaries are ordinary local files, held under whatever controls you already run on that machine.",
        source: {
          label: "House of Commons Defence Committee report",
          href: "https://publications.parliament.uk/pa/cm5902/cmselect/cmdfence/69/report.html",
        },
      },
      {
        title: "The contractor was the way in",
        meta: "UK MoD payroll provider · 2024",
        what: "Disclosed to Parliament in May 2024: an external payroll system operated by contractor Shared Services Connected Ltd was accessed by what the Defence Secretary called a malign actor, exposing names and bank details of up to around 270,000 serving personnel, reservists and veterans. The MoD's own networks were not the entry point — the third party's system was.",
        why: "Defence security is bounded by the least-defended system holding the data, and that system frequently belongs to someone else. Every SaaS notetaker adds one. Steno adds none: there is no vendor holding your meeting content, so there is no vendor to breach.",
        source: {
          label: "AP / SecurityWeek, May 2024",
          href: "https://www.securityweek.com/the-uk-says-a-huge-payroll-data-breach-by-a-malign-actor-has-exposed-details-of-military-personnel/",
        },
      },
      {
        title: "A trusted update carried the attacker in",
        meta: "SolarWinds Orion · 2020",
        what: "An actor the US government attributed to Russia's SVR compromised SolarWinds' build process and planted a backdoor in signed Orion updates shipped between March and June 2020. CISA issued Emergency Directive 21-01 ordering federal civilian agencies to disconnect the product; agencies including Treasury, Commerce and DHS were breached through it.",
        why: "Steno does not make supply-chain risk disappear — no software does, and any vendor claiming otherwise is selling you something. What it removes is the standing data flow a compromise could ride: Steno makes no network calls with your meeting content, so there is no established channel out. And it is MIT-licensed, so your security authority can review the source and build it themselves rather than trusting a binary.",
        source: {
          label: "CISA advisory AA20-352A",
          href: "https://www.cisa.gov/news-events/cybersecurity-advisories/aa20-352a",
        },
      },
    ],
  },
  faqs: [
    { q: "Can Steno run in an air-gapped environment?", a: "Yes — that's a primary design target. After the one-time model download, everything runs with no network connection at all." },
    { q: "Is any data ever sent to Steno's servers?", a: "No. Steno makes no network calls with your meeting content. Recordings, transcripts, and summaries are ordinary files in local storage on your device." },
    { q: "Can we review and control the build?", a: "Yes. It's open source, so it can be audited and built from source in your own environment before deployment." },
  ],
};

export const ALL = [government, defense];
export { CTA_MAILTO };
