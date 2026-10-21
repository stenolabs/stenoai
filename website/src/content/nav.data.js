// Extended hover menus for the main navigation (desktop, 1100px and up).
// Each top-level link keeps its own href; its panel adds an overview card, the sections on that page and a
// short readout. Section ids match the pages: the homepage sections, MissionSectors/Deploy/Assurance/Editions
// on /enterprise/, and IndustryPage.astro on the sector pages (only sections that page renders are listed).
// Images live in /images/nav/ (illustrative scenes, no insignia); `img` is the file name without extension.

export const MEGA = {
  "/#how": {
    key: "platform",
    kicker: "Platform · How it works",
    title: "Record, transcribe and summarise on hardware you control.",
    overview: { label: "Platform overview", img: "gov-ministerial" },
    base: "/",
    items: [
      { id: "how", icon: "workflow", label: "The workflow", line: "Capture to brief, step by step", img: "gov-ministerial" },
      { id: "features", icon: "sparkles", label: "Capabilities", line: "Live transcript, summaries, ask your notes", img: "gov-committee" },
      { id: "sectors", icon: "landmark", label: "Sectors", line: "Government, defence, law enforcement", img: "gov-exterior" },
      { id: "deploy", icon: "server", label: "Deployment", line: "Your device or your infrastructure", img: "airgap" },
      { id: "security", icon: "shield-check", label: "Security & control", line: "Don’t take our word for it. Check it.", img: "le-tasking" },
      { id: "editions", icon: "layers", label: "Editions", line: "From one laptop to the organisation", img: "coalition-hq" },
    ],
    readouts: [["Processing", "On your device or infrastructure"], ["Meeting bots", "None"], ["Source", "Open, MIT licence"]],
  },
  "/enterprise/government/": {
    key: "gov",
    kicker: "Government · Public sector",
    title: "Meeting notes that never leave your perimeter.",
    overview: { label: "Government overview", img: "gov-exterior" },
    items: [
      { id: "use-cases", icon: "list-checks", label: "Where it is used", line: "Eight settings, room by room", img: "gov-ministerial" },
      { id: "why-now", icon: "trending-up", label: "Why now", line: "AI moving inside the perimeter", img: "gov-committee" },
      { id: "cloud", icon: "cloud-off", label: "Why cloud tools don’t fit", line: "Where the audio goes, on whose terms", img: "gov-crisis" },
      { id: "policy", icon: "scale", label: "The rules", line: "And what stays with you", img: "mega-gov-records" },
      { id: "case-files", icon: "file-warning", label: "Case files", line: "What happens when the data leaves", img: "gov-diplomacy" },
      { id: "faq", icon: "message-circle-question", label: "Questions", line: "What your security team will ask", img: "gov-interview" },
    ],
    readouts: [["Posture", "Device or your network"], ["Meeting content sent", "None, local mode"], ["Meeting bots", "None"]],
  },
  "/enterprise/defense/": {
    key: "def",
    kicker: "Defence · Forward to programme board",
    title: "Built for the discussions that can’t leave your boundary.",
    overview: { label: "Defence overview", img: "def-forward" },
    items: [
      { id: "use-cases", icon: "map", label: "Where it is used", line: "Planning, debriefs, forward operations", img: "def-planning" },
      { id: "why-now", icon: "book-open-text", label: "Why now", line: "Doctrine already assigns a recorder", img: "def-wargame" },
      { id: "cloud", icon: "cloud-off", label: "Why cloud tools don’t fit", line: "The problem with SaaS notetakers", img: "coalition-hq" },
      { id: "policy", icon: "scale", label: "Contracts and classification", line: "Clauses and rules, stated plainly", img: "mega-def-review" },
      { id: "case-files", icon: "file-warning", label: "Case files", line: "What happens when the data leaves", img: "intel-fusion" },
      { id: "postures", icon: "radar", label: "Deployment postures", line: "Single device to your own network", img: "airgap" },
    ],
    readouts: [["Network", "Not required in local mode"], ["Processing", "On-device or in your boundary"], ["Meeting bots", "None"]],
  },
  "/enterprise/law-enforcement/": {
    key: "le",
    kicker: "Law enforcement · Policing",
    title: "Notes that stay inside the force.",
    overview: { label: "Law enforcement overview", img: "le-briefing" },
    items: [
      { id: "use-cases", icon: "list-checks", label: "Where it is used", line: "Briefings, reviews, witness contact", img: "le-review" },
      { id: "not-for", icon: "ban", label: "What it is not for", line: "Not a PACE interview recorder", img: "le-notfor" },
      { id: "why-now", icon: "trending-up", label: "Why now", line: "Policing is adopting AI", img: "le-command" },
      { id: "policy", icon: "scale", label: "The law", line: "DPA Part 3, and what stays with you", img: "le-standards" },
      { id: "case-files", icon: "file-warning", label: "Case files", line: "When the record can’t be checked", img: "le-tasking" },
      { id: "cloud", icon: "cloud-off", label: "Why cloud tools don’t fit", line: "Where the audio goes", img: "le-records" },
    ],
    readouts: [["Posture", "Force laptop or force network"], ["Meeting content sent", "None, local mode"], ["Interview recorder", "No, use your PACE kit"]],
  },
  "/enterprise/": {
    key: "ent",
    kicker: "Enterprise · Institutional control",
    title: "Private intelligence. Institutional control.",
    overview: { label: "Enterprise overview", img: "coalition-hq" },
    items: [
      { id: "sectors", icon: "landmark", label: "Your sector", line: "Government, defence, law enforcement", img: "gov-exterior" },
      { id: "deploy", icon: "server", label: "Deployment", line: "Your device or your infrastructure", img: "airgap" },
      { id: "security", icon: "shield-check", label: "Assurance", line: "Open source you can inspect", img: "intel-fusion" },
      { id: "editions", icon: "layers", label: "Editions", line: "Community and Enterprise", img: "gov-committee" },
    ],
    readouts: [["Hosting", "Never on our servers"], ["Source", "Open, MIT licence"], ["Briefing", "On request"]],
  },
};
