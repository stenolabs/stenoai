// Data for the /vs/ comparison pages, loaded into the `comparisons` content
// collection (see ../content.config.ts). `metaTitle`/`metaDescription` ARE
// read at runtime now — src/pages/vs/[slug].astro uses them directly for
// <title>/<meta>. See src/content/README.md for the verified-claims policy.

export const VERIFIED = "July 2026";

// StenoAI's side of the table. Shared rows reuse these so the four pages
// can't drift out of sync about our own product.
const STENO = {
  price: { text: "Free — everything included", tone: "good" },
  openSource: { text: "Yes — MIT license", tone: "good" },
  transcription: { text: "100% on your device (Parakeet, Whisper)", tone: "good" },
  summaries: { text: "On your device — bundled local models, no setup", tone: "good" },
  audio: { text: "Never", tone: "good" },
  bot: { text: "No bot — captures system audio directly", tone: "good" },
  worksWith: { text: "Any meeting app, plus in-person", tone: "good" },
  limits: { text: "None — unlimited meetings and minutes", tone: "good" },
  account: { text: "No account, no sign-up", tone: "good" },
  platforms: { text: "macOS (Apple Silicon) · Windows (alpha)", tone: "neutral" },
};

const ROW = (label, steno, them) => ({ label, steno, them });

export const granola = {
  slug: "granola",
  name: "Granola",
  oneLiner: "The cloud notetaker without a bot — StenoAI does the same job without the cloud either.",
  metaTitle: "StenoAI vs Granola — Free, Fully Local Alternative to Granola",
  metaDescription:
    "Granola processes your meeting audio in the cloud and costs from $14/user/month. StenoAI does the same job — no bot, AI meeting notes — entirely on your device, free and open source.",
  eyebrow: "StenoAI vs Granola",
  h1: "Like Granola, but data never leaves your premises.",
  intro:
    "Granola popularised the bot-free meeting notetaker — it captures system audio instead of sending a bot into your call. StenoAI works the same way, with one structural difference: Granola transcribes and summarizes your audio on cloud servers, while StenoAI runs the entire pipeline on your own device. No audio upload, no account, no subscription.",
  rows: [
    ROW("Price", STENO.price, {
      text: "Free plan with limited meeting history; paid from $14/user/month",
      tone: "bad",
    }),
    ROW("Open source", STENO.openSource, { text: "No — proprietary", tone: "bad" }),
    ROW("Transcription", STENO.transcription, {
      text: "In the cloud — audio is streamed to Granola's servers",
      tone: "bad",
    }),
    ROW("AI summaries", STENO.summaries, {
      text: "Cloud LLMs run on your transcripts",
      tone: "bad",
    }),
    ROW("Audio leaves your device", STENO.audio, { text: "Yes — for cloud transcription", tone: "bad" }),
    ROW("Bot joins your meetings", STENO.bot, {
      text: "No bot — also captures system audio",
      tone: "good",
    }),
    ROW("Works with", STENO.worksWith, { text: "Any meeting app", tone: "good" }),
    ROW("Usage limits", STENO.limits, {
      text: "Free plan caps meeting history",
      tone: "bad",
    }),
    ROW("Account required", STENO.account, { text: "Yes", tone: "bad" }),
    ROW("Platforms", STENO.platforms, { text: "macOS, Windows, iOS", tone: "neutral" }),
  ],
  verdict:
    "Granola is a polished cloud notetaker without the bot. StenoAI is the same idea taken to its conclusion: if the notes can be made without a bot, they can be made without a server too. Everything — recording, transcription, summaries, chat — runs on your device, free.",
  chooseSteno: [
    "Your meetings involve confidential, legal, medical, or client material that shouldn't transit third-party servers",
    "You want unlimited meetings without a per-user subscription",
    "You need it to work offline — planes, secure sites, flaky Wi-Fi",
    "You (or your security team) want to audit the code that touches your audio",
  ],
  chooseThem: [
    "You want an iPhone app for in-person meetings on the go",
    "You rely on cloud sync across several devices",
    "Your team lives in its integrations — Notion, Slack, HubSpot, Zapier",
    "You're comfortable with cloud processing and want the most polished template ecosystem",
  ],
  faqs: [
    {
      q: "Is Granola private?",
      a: "Granola avoids the meeting bot, which is a real privacy improvement over Otter-style tools. But your audio is still streamed to cloud servers for transcription, and cloud LLMs process your transcripts. StenoAI removes that layer entirely: transcription and summarization run locally, and your recordings, transcripts, and notes never leave your device. (StenoAI makes no network calls with your meeting content; anonymous usage telemetry is on by default and can be switched off in Settings.)",
    },
    {
      q: "Does StenoAI work the same way as Granola — no bot in the call?",
      a: "Yes. StenoAI captures system audio and microphone simultaneously, so both sides of a Zoom, Teams, or Meet call are transcribed without anything joining the meeting. It also works for in-person conversations.",
    },
    {
      q: "How much does Granola cost compared to StenoAI?",
      a: "Granola's paid plans start at $14/user/month ($168/user/year), with a free plan that limits meeting history. StenoAI is free and open source (MIT) — there is no paid tier, and nothing is held back.",
    },
    {
      q: "Can I use StenoAI on my phone?",
      a: "No — StenoAI is a desktop app for macOS (Apple Silicon) and Windows (alpha). If phone-first capture matters more to you than on-device privacy, Granola's iPhone app is the better fit today.",
    },
    {
      q: "Are StenoAI's local summaries as good as Granola's cloud ones?",
      a: "StenoAI ships a lineup of open-weight models (up to GPT-OSS 20B) that run on your machine, and you can optionally plug in your own cloud API key if you want a frontier model. For meeting summaries and action items, well-prompted local models are strong — and you can verify the results because you keep the full transcript.",
    },
  ],
};

export const otter = {
  slug: "otter",
  name: "Otter.ai",
  oneLiner: "The incumbent: a bot in your calls, recordings on their servers, minute caps below Business.",
  metaTitle: "StenoAI vs Otter.ai — Private, Unlimited Alternative to Otter",
  metaDescription:
    "Otter sends a bot into your meetings, stores recordings in the cloud, and caps free transcription at 300 minutes a month. StenoAI transcribes unlimited meetings entirely on your device — free, no bot, no account.",
  eyebrow: "StenoAI vs Otter.ai",
  h1: "Everything Otter does, without the bot or the cloud.",
  intro:
    "Otter is the incumbent cloud transcription service: an OtterPilot bot joins your call as a participant, recordings live on Otter's servers, and every plan below Business has minute caps. StenoAI takes the opposite approach — it captures system audio on your own machine, transcribes and summarizes locally, and never uploads anything.",
  rows: [
    ROW("Price", STENO.price, {
      text: "Free: 300 min/month (30 min per conversation); Pro from $8.33/user/month billed annually; Business from $19.99",
      tone: "bad",
    }),
    ROW("Open source", STENO.openSource, { text: "No — proprietary", tone: "bad" }),
    ROW("Transcription", STENO.transcription, { text: "In the cloud", tone: "bad" }),
    ROW("AI summaries", STENO.summaries, { text: "In the cloud", tone: "bad" }),
    ROW("Audio leaves your device", STENO.audio, {
      text: "Yes — recordings are stored on Otter's servers",
      tone: "bad",
    }),
    ROW("Bot joins your meetings", STENO.bot, {
      text: "Yes — OtterPilot appears as a participant in your calls",
      tone: "bad",
    }),
    ROW("Works with", STENO.worksWith, {
      text: "Zoom, Meet, Teams via the bot; mobile recording",
      tone: "neutral",
    }),
    ROW("Usage limits", STENO.limits, {
      text: "Minute caps on every plan below Business",
      tone: "bad",
    }),
    ROW("Account required", STENO.account, { text: "Yes", tone: "bad" }),
    ROW("Platforms", STENO.platforms, { text: "Web browser, iOS, Android", tone: "neutral" }),
  ],
  verdict:
    "Otter charges a subscription to run your audio through its servers, with a bot sitting visibly in your meetings. StenoAI removes the bot, the server, the account, and the bill — the whole pipeline runs on hardware you already own.",
  chooseSteno: [
    "You don't want a bot appearing in client or internal calls",
    "Your recordings shouldn't live on a third party's servers",
    "You keep hitting minute caps — StenoAI has no limits at any length",
    "You record in-person conversations and don't want them uploaded",
  ],
  chooseThem: [
    "You need to record from a phone, or work entirely in a browser",
    "Your team collaborates inside a shared cloud workspace of transcripts",
    "You want Otter's live shared highlights during large webinars",
  ],
  faqs: [
    {
      q: "Does StenoAI need a bot like OtterPilot?",
      a: "No. StenoAI captures system audio and microphone on your machine, so both sides of any call are transcribed without a participant joining. Nothing announces itself in your meeting, because nothing enters the meeting.",
    },
    {
      q: "Is StenoAI really unlimited?",
      a: "Yes. Transcription and summarization run on your own hardware, so there's no metering — no monthly minutes, no per-conversation cap, no file-import quota. Otter's free plan allows 300 minutes a month with a 30-minute cap per conversation.",
    },
    {
      q: "Where do my recordings go?",
      a: "With Otter, recordings and transcripts are stored in Otter's cloud, under Otter's terms. With StenoAI, they're ordinary files in local app storage on your device — your meeting content is never uploaded. (StenoAI does make some network calls unrelated to your content: update checks, first-run model downloads, and anonymous usage telemetry that's on by default and can be switched off in Settings.)",
    },
    {
      q: "Is StenoAI's accuracy comparable to Otter's?",
      a: "StenoAI uses Parakeet TDT v3 for live transcription and Whisper for the long tail of 99 languages — current open models that benchmark competitively with commercial cloud ASR. As with any transcription, quiet rooms and decent microphones matter more than the engine.",
    },
    {
      q: "What's the catch — why is StenoAI free?",
      a: "There's no hosted infrastructure to pay for: your machine does the work. StenoAI is an open-source project (MIT), so you can read the code, build it yourself, and verify exactly what it does and doesn't send.",
    },
  ],
};

export const fireflies = {
  slug: "fireflies",
  name: "Fireflies.ai",
  oneLiner: "Team conversation intelligence in the cloud, metered by storage and AI credits.",
  metaTitle: "StenoAI vs Fireflies.ai — No-Bot, On-Device Alternative to Fireflies",
  metaDescription:
    "Fireflies sends its Fred bot into your calls and stores everything in its cloud, with AI-credit caps per tier. StenoAI keeps meetings on your device: unlimited local transcription and AI notes, free and open source.",
  eyebrow: "StenoAI vs Fireflies.ai",
  h1: "Meeting notes without Fred in the room.",
  intro:
    "Fireflies is a cloud conversation-intelligence platform: its bot (Fred) joins your calls, recordings are stored and analyzed in Fireflies' cloud, and plans are metered by storage and AI credits. StenoAI is the private counterpart — it records on your machine, transcribes and summarizes locally, and nothing is uploaded, metered, or credited.",
  rows: [
    ROW("Price", STENO.price, {
      text: "Free (400 min storage, AI-credit caps); Pro $10/seat/month billed annually; Business $19; Enterprise $39",
      tone: "bad",
    }),
    ROW("Open source", STENO.openSource, { text: "No — proprietary", tone: "bad" }),
    ROW("Transcription", STENO.transcription, { text: "In the cloud", tone: "bad" }),
    ROW("AI summaries", STENO.summaries, {
      text: "In the cloud, metered by AI credits",
      tone: "bad",
    }),
    ROW("Audio leaves your device", STENO.audio, {
      text: "Yes — stored in Fireflies' cloud",
      tone: "bad",
    }),
    ROW("Bot joins your meetings", STENO.bot, {
      text: "Yes — the Fireflies notetaker joins as a participant",
      tone: "bad",
    }),
    ROW("Works with", STENO.worksWith, {
      text: "Meeting platforms via the bot; uploads for other audio",
      tone: "neutral",
    }),
    ROW("Usage limits", STENO.limits, {
      text: "Storage minutes, AI credits, and recording-length caps per tier",
      tone: "bad",
    }),
    ROW("Account required", STENO.account, { text: "Yes", tone: "bad" }),
    ROW("Platforms", STENO.platforms, { text: "Web browser, iOS, Android", tone: "neutral" }),
  ],
  verdict:
    "Fireflies is built for teams that want a cloud archive of every call, analyzed and integrated with their CRM. If what you actually need is accurate, private notes from your own meetings, StenoAI does that with no bot, no credits, and no data leaving your machine.",
  chooseSteno: [
    "A bot in the participant list isn't acceptable for your calls",
    "Compliance or client confidentiality rules out cloud storage of recordings",
    "You'd rather not budget storage minutes and AI credits — StenoAI has neither",
    "You want notes from in-person meetings, not just scheduled video calls",
  ],
  chooseThem: [
    "You want conversation analytics across a whole sales or support team",
    "You need deep CRM integrations — Salesforce, HubSpot — fed automatically",
    "A searchable cloud archive shared across the team is the point",
  ],
  faqs: [
    {
      q: "How does StenoAI record without a bot?",
      a: "StenoAI captures system audio and your microphone directly on your machine, so both sides of a Zoom, Teams, or Meet call are transcribed without anything joining the meeting. It works for in-person conversations too.",
    },
    {
      q: "Does StenoAI have AI credits or storage limits like Fireflies?",
      a: "No. Everything runs on your own hardware, so nothing is metered. Unlimited meetings, unlimited length, unlimited summaries — the only resource used is your machine's disk and compute.",
    },
    {
      q: "Can my team share notes with StenoAI?",
      a: "StenoAI is built around local-first, per-person notes; you can copy and share summaries wherever your team works. If your core need is a shared, always-on cloud archive with CRM automation, Fireflies is honestly the better match — at the cost of every call living in its cloud.",
    },
    {
      q: "Is Fireflies' free plan enough?",
      a: "Fireflies' free tier caps storage at 400 minutes per team, limits AI credits, and holds back downloads and several AI features. StenoAI's free tier is the entire product — it's the only tier.",
    },
  ],
};

export const ALL = [granola, otter, fireflies];
