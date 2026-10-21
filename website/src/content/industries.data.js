// Data for the /enterprise/ industry pages, loaded into the `industries`
// content collection (see ../content.config.ts). See src/content/README.md
// for the compliance-wording policy behind these claims.

// Shared compliance paragraph — one source of truth so the pages can't drift
// into overclaiming. Rendered on every industry page's "Compliance" block.
export const COMPLIANCE_BODY =
  "In local mode, StenoAI runs entirely on your device. Your meeting recordings, transcripts, and summaries never reach our servers — there is no third-party processor handling your meeting data, which addresses a meaningful part of HIPAA, GDPR, and data-residency exposure. (Those frameworks also cover safeguards, agreements, and processes that remain your responsibility — no tool hands you compliance.) StenoAI itself isn't a certified cloud service, because there is no cloud service handling your meetings to certify — and that's the point: the vendor-breach risk that frameworks such as SOC 2 exist to assure against isn't in that path.";

// Short, honest compliance chips shown on industry pages. "-aligned" / "by
// design" / "-friendly" are load-bearing hedges — do not upgrade them to
// "certified" or "compliant".
const CHIPS = {
  gdpr: "GDPR-aligned",
  dataResidency: "Stays inside your boundary",
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
//   - `why` must state what StenoAI's architecture actually removes, and must
//     not imply it removes risks it doesn't (see the SolarWinds entry, which
//     says so explicitly). A buyer's security team will read these.
export const BREACHES_VERIFIED = "September 2026";

const BREACH_INTRO_GOV =
  "None of these were careless organisations. In each case the data was lost somewhere outside the walls of the organisation that owned it — at a cloud provider, at a processor, or inside a tool that quietly took a copy.";

const BREACH_INTRO_DEF =
  "The pattern is consistent: the compromise happens at a link in the chain that isn't yours. A contractor's system, a vendor's build server, a file that left the enclave and couldn't be recalled.";

// Every "Request a briefing" button opens /briefing/, which composes this email and offers the mail app, Gmail,
// Outlook or copy-and-paste. A bare mailto: link does nothing on devices with no default mail app (most managed
// and webmail-only machines), so the buttons appeared dead there.
export const BRIEFING_EMAIL = "chantelle@stenoai.co";
export const CTA_BRIEFING = "/briefing/";
const CTA_MAILTO =
  "mailto:chantelle@stenoai.co?subject=StenoAI%20demo%20request&body=Hi%20StenoAI%20team%2C%0A%0AWe%27d%20like%20to%20see%20a%20demo.%0A%0AOrganisation%3A%20%0ATeam%20size%3A%20%0AUse%20case%3A%20%0A%0AThanks%2C";

export const government = {
  slug: "government",
  name: "Government",
  metaTitle: "StenoAI for Government — On-Device Meeting Notes, No Cloud",
  metaDescription:
    "On-device meeting transcription and summaries for government teams — data stays on your device or your infrastructure, supports data-residency obligations by architecture. Open source.",
  eyebrow: "StenoAI for Government",
  lede: "Briefings, policy discussions and internal reviews carry information that belongs within your perimeter. Turn those conversations into a clear record, processed on your device or on infrastructure you control.",
  image: "government",
  imageAlt: "People outside a lit office building at dusk",
  h1: "Meeting notes that never leave your perimeter.",
  intro:
    "Briefings, policy discussions, and internal reviews carry information that can't be handed to a cloud vendor. StenoAI records, transcribes, and summarizes entirely on the device — no third-party processor, no data crossing a border, no records leaving the machine they were captured on.",
  chips: [CHIPS.dataResidency, CHIPS.airGapped, CHIPS.gdpr],
  pains: [
    "Cloud meeting tools route audio through servers outside your control — and often outside your jurisdiction.",
    "A bot joining the call is a participant you can't fully account for in a sensitive briefing.",
    "Retention and access to recordings sit under a vendor's terms, not your records policy.",
  ],
  points: [
    { h: "Data sovereignty", b: "Everything is processed and stored on the device, or on infrastructure you run inside your own boundary. Nothing transits a vendor's server, so residency and sovereignty obligations are supported by architecture, not a vendor promise." },
    { h: "Your device or your infrastructure", b: "Run it on the laptop in the room, or on a model server or cloud tenancy you control. It also works on isolated networks, where cloud tools can't operate." },
    { h: "No bot in the room", b: "StenoAI captures system and microphone audio directly — nothing joins the meeting as a participant." },
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
        why: "No tenant setting would have stopped this. The affected departments did nothing wrong — the compromise was inside the provider holding their mail. StenoAI removes that dependency for meeting content: there is no provider account, no key and no server holding your transcripts to be compromised.",
        source: {
          label: "Cyber Safety Review Board report (CISA, 2024)",
          href: "https://www.cisa.gov/sites/default/files/2025-03/CSRBReviewOfTheSummer2023MEOIntrusion508.pdf",
        },
      },
      {
        title: "One file-transfer product, 2,500 organisations",
        meta: "MOVEit Transfer · 2023",
        what: "From 27 May 2023 the CL0P group exploited a zero-day in Progress Software's MOVEit Transfer to steal data from every instance it could reach. More than 2,500 organisations were affected, among them multiple US federal agencies — the Department of Energy confirmed two of its entities were caught in it.",
        why: "Most of those organisations would not have named MOVEit if you had asked them to list their data path. Meeting recordings and transcripts are exactly the kind of data that accumulates in that sort of intermediary. StenoAI's pipeline has no intermediary: capture, transcription and summarisation all happen on the machine.",
        source: {
          label: "CISA advisory AA23-158A",
          href: "https://www.cisa.gov/news-events/cybersecurity-advisories/aa23-158a",
        },
      },
      {
        title: "The notetaker itself became the exposure",
        meta: "Otter.ai litigation · 2025",
        what: "Class actions consolidated as In re Otter.AI Privacy Litigation in the Northern District of California allege that the AI notetaker joined Zoom, Teams and Google Meet calls and recorded participants who were not its customers, transmitted call content to its servers, and used those conversations to train its models — without the consent of everyone in the room. The claims are unproven and Otter.ai disputes them.",
        why: "Whatever the outcome, the exposure is structural: once a notetaker sends audio off the device, consent, retention and model-training become somebody else's policy. StenoAI never sends the audio anywhere, so those questions stay yours to answer.",
        source: {
          label: "NPR, August 2025",
          href: "https://www.npr.org/2025/08/15/g-s1-83087/otter-ai-transcription-class-action-lawsuit",
        },
      },
    ],
  },
  faqs: [
    { q: "Does StenoAI meet data-residency requirements?", a: "Because processing and storage happen on the device and nothing is uploaded, your data never leaves the machine — or the jurisdiction it's in. There is no cloud region to configure and no cross-border transfer to account for." },
    { q: "Can it run on our own infrastructure, or on an isolated network?", a: "Yes, either. Summaries can run on a model server in your network or in your own cloud tenancy. In local mode, once the models are downloaded, recording, transcription and summarisation all run with no network at all." },
    { q: "How do we verify what it does?", a: "StenoAI is open source (MIT). Your team can audit the code, build it from source, and confirm exactly what it does and doesn't send before deploying." },
  ],
};

export const defense = {
  slug: "defense",
  name: "Defence",
  metaTitle: "StenoAI for Defence — Meeting Notes on Your Device or Your Infrastructure",
  metaDescription:
    "Meeting transcription and summaries on your own device or your own infrastructure, from connected HQs to air-gapped enclaves. Nothing transits a vendor's server. Open source.",
  eyebrow: "StenoAI for Defence",
  lede: "Planning sessions, programme reviews and sensitive debriefs. Capture, transcribe and summarise on the device in the room, or on servers inside your own boundary. Local mode keeps working when the network is unavailable.",
  image: "defence",
  imageAlt: "Personnel gathered around a planning table",
  h1: "Built for the discussions that can't leave your boundary.",
  intro:
    "Operational planning and sensitive discussions run on hardware you control, on networks you control. StenoAI does the pipeline — capture, transcription, summary — on the device or on servers inside your boundary, with nothing transiting a vendor's server. The same app runs from a connected headquarters to an air-gapped enclave. (Accreditation for any specific classified environment is a function of your own deployment and authorization process, not the app alone.)",
  chips: [CHIPS.airGapped, CHIPS.dataResidency],
  pains: [
    "Cloud transcription is a non-starter when the audio can't leave the enclave.",
    "SaaS meeting assistants require connectivity and a vendor relationship you can't extend to classified work.",
    "A meeting bot is an external participant — unacceptable in an operational context.",
  ],
  points: [
    { h: "Your device or your infrastructure", b: "Run it on one laptop, on a model server inside your network, or in your own cloud tenancy. Local mode also works on air-gapped and disconnected systems." },
    { h: "Nothing leaves your boundary", b: "Audio stays on the machine. Transcripts and summaries stay on it too in local mode, or go only to a model server you run inside the enclave. There is no vendor in the data flow." },
    { h: "On-device models", b: "In local mode, transcription (Parakeet, Whisper) and summarisation run on your hardware, with no external inference service in the path." },
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
        why: "Nothing was hacked. A copy was made and sent, and it could not be recalled. StenoAI cannot stop a person emailing a file, and doesn't claim to — but it adds no copies of its own: no vendor-side duplicate, no automatic sync, no export step in the pipeline. Recordings, transcripts and summaries are ordinary local files, held under whatever controls you already run on that machine.",
        source: {
          label: "House of Commons Defence Committee report",
          href: "https://publications.parliament.uk/pa/cm5902/cmselect/cmdfence/69/report.html",
        },
      },
      {
        title: "The contractor was the way in",
        meta: "UK MoD payroll provider · 2024",
        what: "Disclosed to Parliament in May 2024: an external payroll system operated by contractor Shared Services Connected Ltd was accessed by what the Defence Secretary called a malign actor, exposing names and bank details of up to around 270,000 serving personnel, reservists and veterans. The MoD's own networks were not the entry point — the third party's system was.",
        why: "Defence security is bounded by the least-defended system holding the data, and that system frequently belongs to someone else. Every SaaS notetaker adds one. StenoAI adds none: there is no vendor holding your meeting content, so there is no vendor to breach.",
        source: {
          label: "AP / SecurityWeek, May 2024",
          href: "https://www.securityweek.com/the-uk-says-a-huge-payroll-data-breach-by-a-malign-actor-has-exposed-details-of-military-personnel/",
        },
      },
      {
        title: "A trusted update carried the attacker in",
        meta: "SolarWinds Orion · 2020",
        what: "An actor the US government attributed to Russia's SVR compromised SolarWinds' build process and planted a backdoor in signed Orion updates shipped between March and June 2020. CISA issued Emergency Directive 21-01 ordering federal civilian agencies to disconnect the product; agencies including Treasury, Commerce and DHS were breached through it.",
        why: "StenoAI does not make supply-chain risk disappear — no software does, and any vendor claiming otherwise is selling you something. What it removes is the standing data flow a compromise could ride: StenoAI makes no network calls with your meeting content, so there is no established channel out. And it is MIT-licensed, so your security authority can review the source and build it themselves rather than trusting a binary.",
        source: {
          label: "CISA advisory AA20-352A",
          href: "https://www.cisa.gov/news-events/cybersecurity-advisories/aa20-352a",
        },
      },
    ],
  },
  faqs: [
    { q: "Can it run on our own infrastructure, or air-gapped?", a: "Both. Summaries can run on a model server inside your network or in your own cloud tenancy, with transcription on the device by default. In local mode, after the one-time model download, everything runs with no network connection at all." },
    { q: "Is any data ever sent to StenoAI's servers?", a: "No. StenoAI runs no server that receives meeting content. In local mode recordings, transcripts and summaries stay as files on your device; if you configure a model server, content goes only to the endpoint you run or choose." },
    { q: "Can we review and control the build?", a: "Yes. It's open source, so it can be audited and built from source in your own environment before deployment." },
  ],
};

const BREACH_INTRO_LE =
  "Neither policing case below was a hack. In one, a force leaned on an assistant's output it could not check; in the other, a file carried more than anyone meant it to. Both are about where the record lives and what it can be checked against.";

export const lawEnforcement = {
  slug: "law-enforcement",
  name: "Law enforcement",
  metaTitle: "StenoAI for Law Enforcement — On-Device Meeting Notes for Policing",
  metaDescription:
    "Meeting transcription and summaries for police briefings, reviews and command meetings — processed on the device or on force infrastructure, with no third-party processor in the audio path. Open source.",
  eyebrow: "StenoAI for Law Enforcement",
  h1: "Notes that stay inside the force.",
  lede: "Briefings, investigation reviews, witness contact and command meetings carry personal data your force is accountable for under Part 3 of the Data Protection Act 2018. StenoAI records, transcribes and summarises on the laptop in the room, or on infrastructure the force controls. It is not an interview recorder and never replaces your authorised PACE equipment.",
  image: "law-enforcement",
  imageAlt: "Officers in a briefing room",
  intro:
    "Policing is adopting AI, and the question every DPO asks first is where the data goes. StenoAI keeps the answer simple: on the device, or on force infrastructure — with a full transcript behind every summary.",
  chips: [CHIPS.dataResidency, CHIPS.airGapped],
  pains: [
    "Cloud notetakers route audio through servers you must name in a DPIA and cannot inspect.",
    "A bot on the call is a participant you cannot account for in a command or safeguarding meeting.",
    "Recordings and drafts held under a vendor's terms sit outside your CPIA retention and disclosure rules.",
  ],
  points: [
    { h: "No processor in the audio path", b: "In local mode, capture, transcription and summarisation run on the device. There is no vendor system holding the audio, so there is no processor contract to manage for it." },
    { h: "A transcript behind every summary", b: "Summaries are drafts. The verbatim transcript is kept alongside, so every decision log entry can be checked against what was actually said." },
    { h: "Your retention, your disclosure", b: "Recordings, transcripts and summaries are ordinary local files your disclosure officer can retain, schedule and reveal under your own rules." },
    { h: "Built to be scrutinised", b: "Open source. Force IT and information security can read the code, build it themselves and test it before deployment." },
  ],
  notFor: [
    { h: "Suspect interviews under PACE", b: "Interviews with suspects use your authorised recording device under Code E. StenoAI is not that device." },
    { h: "Covert material", b: "Not for product obtained under covert powers." },
    { h: "Body-worn video", b: "It does not analyse or transcribe body-worn footage." },
    { h: "Sole basis for a decision", b: "Summaries are drafts. A person decides, on the transcript and the evidence." },
  ],
  breaches: {
    heading: "What happens when the record can't be checked",
    intro: BREACH_INTRO_LE,
    items: [
      {
        title: "A chatbot's fixture that never happened",
        meta: "West Midlands Police · 2025–2026",
        what: "West Midlands Police relied in part on Microsoft Copilot output describing a football match that had never taken place, in advice that fed a decision to ban away fans from a fixture. After the error came to light, the Chief Constable retired and the assistant was switched off across the force.",
        why: "Any language model can get things wrong, including the one StenoAI runs. The difference is what the output can be checked against: StenoAI summarises only what was said in the meeting, and keeps the verbatim transcript next to every summary, so a claim in the notes can be traced to the words behind it — or found to have none.",
        source: {
          label: "The Register, February 2026",
          href: "https://www.theregister.com/2026/02/24/west_midlands_police_copilot/",
        },
      },
      {
        title: "A hidden tab in an FOI response",
        meta: "Police Service of Northern Ireland · 2023, fined 2024",
        what: "In August 2023 PSNI published a spreadsheet in response to a Freedom of Information request. A hidden tab held the surnames, initials, ranks and roles of all 9,483 officers and staff. The Information Commissioner fined the service £750,000 in October 2024.",
        why: "No software stops a person releasing the wrong file, and StenoAI doesn't claim to. What it avoids is adding copies: no vendor-side duplicate of your meetings, no automatic sync, no export in the pipeline. The notes sit on a device under the controls you already run.",
        source: {
          label: "ICO, October 2024",
          href: "https://ico.org.uk/about-the-ico/media-centre/news-and-blogs/2024/10/what-price-privacy-poor-psni-procedures-culminate-in-750k-fine/",
        },
      },
      {
        title: "The notetaker itself became the exposure",
        meta: "Otter.ai litigation · 2025",
        what: "Class actions consolidated as In re Otter.AI Privacy Litigation in the Northern District of California allege that the AI notetaker joined calls and recorded participants who were not its customers, transmitted call content to its servers, and used those conversations to train its models. The claims are unproven and Otter.ai disputes them.",
        why: "Once a notetaker sends audio off the device, consent, retention and model training become somebody else's policy. In local mode StenoAI never sends the audio anywhere, so those questions stay with the force.",
        source: {
          label: "NPR, August 2025",
          href: "https://www.npr.org/2025/08/15/g-s1-83087/otter-ai-transcription-class-action-lawsuit",
        },
      },
    ],
  },
  faqs: [
    { q: "Can StenoAI be used to record suspect interviews?", a: "No. Interviews with suspects under caution must be recorded on your authorised recording device under PACE Code E. StenoAI is for the work around an investigation — briefings, reviews, command and partner meetings — under your force policy." },
    { q: "Does it add a data processor under Part 3 of the DPA 2018?", a: "In local mode there is no processor in the audio path: recording, transcription and summarisation happen on the device. If you configure a model server, it is one your force operates or contracts for. Your DPIA, records of processing and endpoint security remain your responsibility." },
    { q: "Can it run on force infrastructure rather than individual laptops?", a: "Yes. Transcription runs on the device by default, and summaries can run on a model server on the force network or in the force's own cloud tenancy. It also runs fully offline on an isolated machine." },
    { q: "How do we evaluate it?", a: "Download the open-source app for a single-officer evaluation, have your information security team review and build the source, or request a briefing to discuss a force deployment." },
  ],
};

// ─── Sector-page detail ─────────────────────────────────────────────────────
// Use cases are illustrative settings, not customers. Every `whyNow` and
// `policy` item carries a source that was opened and checked against the
// wording here (SECTOR_VERIFIED). Same rules as the breaches above: if a
// detail can't be checked from the linked source, it doesn't ship. Policy
// cards say what the rule says, what the design changes, and what stays the
// buyer's responsibility — never that StenoAI makes anyone compliant.
export const SECTOR_VERIFIED = "October 2026";

const SRC = {
  gdpr28: { label: "UK GDPR Art. 28", href: "https://www.legislation.gov.uk/eur/2016/679/article/28" },
  gdpr25: { label: "UK GDPR Art. 25", href: "https://www.legislation.gov.uk/eur/2016/679/article/25" },
  gdpr32: { label: "UK GDPR Art. 32", href: "https://www.legislation.gov.uk/eur/2016/679/article/32" },
  gsc: { label: "Government Security Classifications (Cabinet Office)", href: "https://www.gov.uk/government/publications/government-security-classifications" },
};

Object.assign(government, {
  useCases: [
    { code: "GOV-01", title: "Ministerial and senior briefings", outcome: "Minutes and actions before the room empties.", for: "Private offices, senior officials, special advisers", env: "Your network", outputs: ["Note of meeting", "Decision log", "Actions"] },
    { code: "GOV-02", title: "Policy development and drafting", outcome: "Every option discussed, captured without a vendor.", for: "Policy teams, legal advisers, analysts", env: "Your cloud tenancy", outputs: ["Options summary", "Open questions", "Ask across sessions"] },
    { code: "GOV-03", title: "Committees, boards and inquiries", outcome: "An accurate record of each deliberation.", for: "Clerks, secretariats, board members", env: "Your network", outputs: ["Transcript", "Draft minutes", "Follow-ups"] },
    { code: "GOV-04", title: "Diplomatic and multilingual meetings", outcome: "25 European languages live, 99 after the recording.", for: "Embassies, delegations, negotiating teams", env: "Your device", outputs: ["Multilingual transcript", "Summary", "Actions"] },
    { code: "GOV-05", title: "Crisis and emergency coordination", outcome: "A running record when the network goes down.", for: "Crisis cells, resilience and civil contingency teams", env: "Your device · offline", outputs: ["Situation log", "Decisions", "Taskings"] },
    { code: "GOV-06", title: "Investigative and regulatory interviews", outcome: "Interview notes that never touch a third-party server.", for: "Investigators, inspectors, regulators", env: "Your device", outputs: ["Transcript", "Summary", "Search"] },
    { code: "GOV-07", title: "Procurement and evaluation panels", outcome: "Commercially sensitive deliberations stay off the cloud.", for: "Commercial teams, evaluation boards", env: "Your network", outputs: ["Panel minutes", "Rationale record", "Actions"] },
    { code: "GOV-08", title: "Analysis and assessment sessions", outcome: "Ask across every session, on a machine you control.", for: "Analytic and assessment staffs", env: "Your device · offline", outputs: ["Local archive", "Themes", "Questions and answers"] },
  ],
  whyNow: {
    heading: "Governments are moving AI inside the perimeter.",
    intro: "This isn't a retreat from AI. Legislatures and ministries are restricting cloud AI tools because of where the data goes, and keeping sensitive work inside their own boundary.",
    items: [
      { date: "2024", place: "US House of Representatives", title: "Copilot barred on House devices", body: "The House Office of Cybersecurity deemed Microsoft Copilot a risk because of the threat of leaking House data to non-House approved cloud services.", source: { label: "The Register, April 2024", href: "https://www.theregister.com/2024/04/01/us_house_copilot_ban/" } },
      { date: "May 2025", place: "UK", title: "Government's own AI minute-taker", body: "The government-built Minute tool was trialled by 25 councils. Its published source shows it transcribes through cloud services, including Azure Speech-to-Text and AWS Transcribe.", source: { label: "PublicTechnology, 29 May 2025", href: "https://www.publictechnology.net/2025/05/29/education-and-skills/government-ai-note-taking-trialled-by-25-councils/" }, extra: { label: "Minute source (GitHub mirror)", href: "https://github.com/uk-gov-mirror/i-dot-ai.minute" } },
      { date: "June 2025", place: "French Senate", title: "No guarantee, under oath", body: "Asked whether data could be handed over to US authorities without the explicit agreement of the French authorities, Microsoft France's director of public and legal affairs said he could not guarantee it.", source: { label: "Sénat, 10 June 2025 (French)", href: "https://www.senat.fr/compte-rendu-commissions/20250609/ce_commande_publique.html" } },
      { date: "Feb 2026", place: "European Parliament", title: "Built-in AI switched off", body: "AI features on lawmakers' corporate devices were disabled because IT could not guarantee data security while the extent of data shared with providers was assessed.", source: { label: "The Register, February 2026", href: "https://www.theregister.com/2026/02/17/european_parliament_bars_lawmakers_from/" } },
    ],
  },
  policy: {
    heading: "The rules, and what stays with you.",
    intro: "None of this is legal advice, and no tool hands you compliance. These are the rules a data protection officer and security lead will test the design against, and where the design helps.",
    cards: [
      { law: "UK GDPR · Art. 28", says: "A controller may use only processors that provide sufficient guarantees to implement appropriate technical and organisational measures.", so: "In local mode there is no processor in the meeting data path: capture, transcription and summaries happen on the device.", yours: "If you configure a model server or cloud tenancy, that provider's contract and guarantees.", sources: [SRC.gdpr28] },
      { law: "UK GDPR · Art. 25 and 32", says: "Data protection by design and by default, and security appropriate to the risk, including encryption where appropriate.", so: "Local processing keeps meeting content on hardware you already secure, with no vendor copy to protect.", yours: "Full-disk encryption, access control, retention and your records of processing.", sources: [SRC.gdpr25, SRC.gdpr32] },
      { law: "Government Security Classifications", says: "Cabinet Office policy on how government classifies information assets so they are appropriately protected.", so: "Meeting content stays on the device, or on infrastructure you choose to suit the classification.", yours: "Deciding which classifications it may be used at, and approving the device for that use.", sources: [SRC.gsc] },
      { law: "US CLOUD Act · 18 U.S.C. §2713", says: "US providers must disclose data in their possession, custody or control, whether it is located within or outside the United States.", so: "In local mode there is no provider holding your meeting content to be compelled.", yours: "Where you choose to run summaries, if not on the device.", sources: [{ label: "Cornell LII", href: "https://www.law.cornell.edu/uscode/text/18/2713" }] },
    ],
  },
});

Object.assign(defense, {
  useCases: [
    { code: "DEF-01", title: "Operational planning", outcome: "Planning conversations that never touch a vendor's cloud.", for: "Staff officers, planning groups, HQ cells", env: "Your network", outputs: ["Decision log", "Taskings", "Brief-back summary"] },
    { code: "DEF-02", title: "Debriefs and after-action reviews", outcome: "A first AAR draft straight from the debrief.", for: "Aircrew, unit commanders, exercise staff", env: "Your device", outputs: ["AAR draft", "Lessons", "Actions"] },
    { code: "DEF-03", title: "Forward and disconnected operations", outcome: "Works when there is no network at all.", for: "Deployed headquarters, forward teams", env: "Your device · offline", outputs: ["Offline transcript", "Summary", "Taskings"] },
    { code: "DEF-04", title: "Maritime and at sea", outcome: "No bandwidth needed once you sail.", for: "Ships' companies, embarked staffs", env: "Your device", outputs: ["Brief summaries", "Handover notes", "Actions"] },
    { code: "DEF-05", title: "Wargaming and red-teaming", outcome: "Every move, and the reasoning behind it.", for: "Staff colleges, wargame and red cells", env: "Your network", outputs: ["Turn log", "Rationale", "Insights"] },
    { code: "DEF-06", title: "Coalition and multinational meetings", outcome: "Multilingual rooms, one record you hold.", for: "Liaison officers, multinational headquarters", env: "Your network", outputs: ["Multilingual transcript", "Summary", "Actions"] },
    { code: "DEF-07", title: "Acquisition and programme reviews", outcome: "Programme reviews stay on hardware you control.", for: "Programme offices, industry partners", env: "Your cloud tenancy", outputs: ["Minutes", "Risk register notes", "Actions"] },
    { code: "DEF-08", title: "Secure-enclave working", outcome: "Runs fully local, with no content egress.", for: "Security authorities, IT and accreditation teams", env: "Air-gapped", outputs: ["Build from source", "Offline models", "No content egress (local mode)"] },
  ],
  whyNow: {
    heading: "Doctrine already assigns a recorder.",
    intro: "Planning doctrine expects someone to keep the record. Experimentation assumes the network will fail. And the costliest losses happen when a copy leaves the system it belongs in.",
    items: [
      { date: "Nov 2024", place: "US Army FM 5-0", title: "“The use of recorders is particularly important.”", body: "Planning doctrine has recorders capture coordinating instructions, subunit tasks and the information needed to synchronise an operation. A disconnected laptop can be a second recorder; the human recorder keeps the pen.", source: { label: "FM 5-0, para 5-165 (PDF)", href: "https://armypubs.army.mil/epubs/DR_pubs/DR_a/ARN44590-FM_5-0-001-WEB-3.pdf" } },
      { date: "Mar 2026", place: "US Army experimentation", title: "The network is expected to degrade", body: "Army experimentation replicated jamming, signal interference and limited bandwidth expected against a peer threat. Once models are installed, StenoAI's local pipeline needs no network at all.", source: { label: "army.mil, 27 March 2026", href: "https://www.army.mil/article/291397/cdf_cfwe_tackles_ddil_interoperability_to_execute_fires" } },
      { date: "Jul 2025", place: "UK Ministry of Defence", title: "A file emailed outside authorised systems", body: "The Defence Secretary told Parliament that a Defence official had emailed an ARAP caseworking file outside authorised government systems in February 2022.", source: { label: "Oral statement, 15 July 2025", href: "https://www.gov.uk/government/speeches/oral-statement-on-afghan-data-breach" } },
    ],
  },
  policy: {
    heading: "Contract clauses and classification rules.",
    intro: "Where controlled data may go is decided by contract and policy, not by the tool. These are the clauses a security authority will check, and where the design helps.",
    cards: [
      { law: "DFARS 252.204-7012 · (b)(2)(ii)(D)", says: "A contractor using an external cloud service for covered defence information must ensure it meets security requirements equivalent to the FedRAMP Moderate baseline.", so: "In local mode a design review adds no cloud provider to that scope.", yours: "Your NIST SP 800-171 controls on the laptop, and any provider you configure.", sources: [{ label: "acquisition.gov", href: "https://www.acquisition.gov/dfars/252.204-7012-safeguarding-covered-defense-information-and-cyber-incident-reporting." }] },
      { law: "Government Security Classifications", says: "Cabinet Office policy on how government classifies information assets so they are appropriately protected.", so: "Local mode keeps meeting content on the device; a self-hosted model server keeps text inside your network.", yours: "Approval of the device and audio capture for any classified space, by your accrediting authority.", sources: [SRC.gsc] },
      { law: "UK GDPR · Art. 28", says: "A controller may use only processors that provide sufficient guarantees to implement appropriate technical and organisational measures.", so: "For personnel and business meetings, local mode adds no processor to the data path.", yours: "Your records of processing, and contracts for any model server or cloud tenancy you configure.", sources: [SRC.gdpr28] },
    ],
  },
  postures: [
    { name: "Single device", title: "One laptop, no network.", body: "The whole pipeline runs on one managed laptop.", steps: ["Install the app and download models while connected", "Disconnect: local mode needs no network after setup", "Switch usage analytics off in Settings", "Block the update check at your firewall or through device management"], holds: "In local mode, meeting content never leaves the device." },
    { name: "Isolated network", title: "Your model server, inside your boundary.", body: "Endpoints record and transcribe locally. Transcript text, never audio, goes to a model server you run on the same network, such as Ollama or an OpenAI-compatible endpoint, so larger models can run on your GPUs.", steps: ["Review the MIT-licensed source and build it in a controlled environment if required", "Run the model server on the isolated network", "Point summaries at it in the app's AI settings", "Restrict access: Ollama has no authentication by default"], holds: "Audio stays on the device. Transcript text stays on your network." },
    { name: "Connected", title: "Your cloud tenancy, your keys.", body: "Where the classification allows, summaries run in your organisation's own cloud account, such as AWS Bedrock or your OpenAI or Anthropic agreement, or through your organisation's gateway so desktops never hold provider keys.", steps: ["Choose a provider approved for the information involved", "Configure it centrally through your organisation", "Keep transcription on the device (the default)"], holds: "StenoAI runs no server that receives meeting content." },
  ],
});

Object.assign(lawEnforcement, {
  useCases: [
    { code: "LE-01", title: "Witness and victim first accounts", outcome: "A verbatim record before the statement is drafted.", for: "Investigators, statement takers, victim liaison", env: "Your device", outputs: ["Verbatim transcript", "Statement outline", "Actions"] },
    { code: "LE-02", title: "Investigation reviews and SIO briefings", outcome: "Decisions and rationale, ready for the policy file.", for: "Senior investigating officers, review teams, disclosure officers", env: "Force network", outputs: ["Decision log", "Policy-file entries", "Actions"] },
    { code: "LE-03", title: "Gold, silver and bronze command", outcome: "A decision log grounded in what was said.", for: "Command teams, public order and event planners", env: "Your device", outputs: ["Decision log", "Rationale record", "Taskings"] },
    { code: "LE-04", title: "Professional standards and misconduct meetings", outcome: "Sensitive personnel data kept off vendor servers.", for: "Professional standards departments, HR, staff associations", env: "Your device", outputs: ["Transcript", "Meeting note", "Actions"] },
    { code: "LE-05", title: "Multi-agency safeguarding meetings", outcome: "One record for the room, held by the chair.", for: "MASH teams, MARAC and MAPPA coordinators", env: "Your cloud tenancy", outputs: ["Draft minutes", "Actions by agency", "Risk notes"] },
    { code: "LE-06", title: "Intelligence and tasking meetings", outcome: "Ask across every meeting, inside the force boundary.", for: "Intelligence units, tasking and coordination groups", env: "Force network", outputs: ["Local archive", "Tasking log", "Questions and answers"] },
    { code: "LE-07", title: "Debriefs and training", outcome: "Learning captured while it is fresh.", for: "Public order trainers, incident debrief leads", env: "Your device", outputs: ["Debrief note", "Learning points", "Actions"] },
    { code: "LE-08", title: "Force IT and secure deployment", outcome: "Review the source, build it, stage it.", for: "Force IT, information security, DPOs", env: "Force network", outputs: ["Build from source", "Offline models", "No content egress (local mode)"] },
  ],
  whyNow: {
    heading: "Policing is adopting AI, and asking where the data goes.",
    intro: "Government is funding AI across policing, and note taking is named among the priorities. The covenant every chief signed says a human decides. Both point the same way: transcript first, inside the force.",
    items: [
      { date: "Sep 2023", place: "NPCC", title: "A human is the ultimate decision-maker", body: "The NPCC Covenant for Using AI in Policing, endorsed by all members on 28 September 2023, says all AI that affects the public must have a human as the ultimate decision-maker.", source: { label: "NPCC AI Covenant v1.1 (PDF)", href: "https://science.police.uk/site/assets/files/4682/ai_principles_1_1_1.pdf" } },
      { date: "Mar 2025", place: "Surrey and Sussex", title: "Forces are buying transcription", body: "The Police and Crime Commissioner for Sussex published a planned procurement for an automated transcription solution for Surrey and Sussex Police, estimated at £100,000 excluding VAT.", source: { label: "Find a Tender 2025/S 000-010469", href: "https://www.find-tender.service.gov.uk/Notice/010469-2025" } },
      { date: "Jun 2026", place: "Home Office", title: "Note taking named as a priority use", body: "The Home Office factsheet lists note taking and transcribing witness statements among back-office uses, and says police AI deployments must be lawful, ethical and transparent.", source: { label: "GOV.UK factsheet, 9 June 2026", href: "https://www.gov.uk/government/publications/police-use-of-artificial-intelligence-ai-factsheet/police-use-of-artificial-intelligence-ai-factsheet-accessible" } },
      { date: "Jun 2026", place: "Home Office", title: "£75 million for PoliceAI", body: "PoliceAI is backed by £75 million over three years, with large-scale pilots in up to 10 forces over 2026-27 before scaling to all forces.", source: { label: "GOV.UK, 10 June 2026", href: "https://www.gov.uk/government/news/policeai-to-speed-up-investigations-and-fight-crime" } },
    ],
  },
  policy: {
    heading: "The law, and what stays with you.",
    intro: "None of this is legal advice, and no tool hands you compliance. These are the rules a police DPO, disclosure officer and information security lead will test the design against.",
    cards: [
      { law: "DPA 2018 · Part 3 · ss. 59, 62, 64, 66", says: "Controllers may use only processors giving sufficient guarantees (s.59); automated systems keep logs of collection, consultation, disclosure and erasure (s.62); high-risk processing needs a DPIA (s.64); security must match the risk (s.66).", so: "In local mode there is no processor in the audio path and no vendor system holding meeting content.", yours: "Your DPIA, logging on the systems you move notes into, and endpoint security.", sources: [{ label: "DPA 2018 Part 3", href: "https://www.legislation.gov.uk/ukpga/2018/12/part/3" }, { label: "s.59", href: "https://www.legislation.gov.uk/ukpga/2018/12/section/59" }, { label: "s.62", href: "https://www.legislation.gov.uk/ukpga/2018/12/section/62" }, { label: "s.64", href: "https://www.legislation.gov.uk/ukpga/2018/12/section/64" }, { label: "s.66", href: "https://www.legislation.gov.uk/ukpga/2018/12/section/66" }] },
      { law: "UK GDPR · Art. 25, 28, 32", says: "For general processing such as HR and partner meetings: data protection by design, processors with sufficient guarantees, and security appropriate to the risk.", so: "Local mode adds no processor and no transfer to your records of processing.", yours: "Full-disk encryption, access control, retention and your Article 30 records.", sources: [SRC.gdpr25, SRC.gdpr28, SRC.gdpr32] },
      { law: "PACE 1984 · Code E", says: "An authorised recording device, if available, must be used to record a suspect interview.", so: "StenoAI is not that device and is never presented as one.", yours: "Deciding, with legal and professional standards, which non-interview settings it may be used in.", sources: [{ label: "GOV.UK: PACE Code E", href: "https://www.gov.uk/government/publications/pace-codes-e-and-f-2018/pace-code-e-2018-accessible" }] },
      { law: "CPIA 1996 · Code of Practice para 5.4", says: "Material to retain includes notes by an investigator relating to contact with suspects, victims or witnesses, and records of interviews with potential witnesses.", so: "Recordings, transcripts and summaries are ordinary local files your disclosure officer can retain and schedule. No vendor holds or deletes them.", yours: "Applying retention periods and revealing material to the prosecutor.", sources: [{ label: "CPIA Code of Practice (PDF)", href: "https://assets.publishing.service.gov.uk/media/5f9af5e6d3bf7f1e3a29321b/Criminal-procedure-and-investigations-act-1996.pdf" }] },
    ],
  },
});

export const ALL = [government, defense, lawEnforcement];
export { CTA_MAILTO };
