# Enterprise website direction

Implemented in the `feat/website-enterprise-defence` worktree. The Astro site
continues to build to static files and uses the existing GitHub Pages workflow.

## Design

- Wide, atmospheric imagery, generous type and fine technical rules take cues
  from https://www.anduril.com/ without reusing its artwork or identity.
- The supplied Steno design at
  https://stenographai-preview.wakkyshazz.workers.dev/ informed the emphasis on
  sensitive conversations, local processing and sector-specific entry points.
- Steno's existing dragonfly mark, Ovo wordmark and paper-and-ink colours remain.
- The homepage and enterprise hub share sector, architecture and briefing
  components. Government and defence pages retain their URLs and source-backed
  editorial content, with new introductions and photography.
- Briefing CTAs use the existing contact address from `industries.data.js`.
  Downloads still use the existing download page. The walkthrough is labelled
  illustrative; all four stages can be selected with pointer or keyboard.
- Deployment copy leads with "your device or your infrastructure": local mode,
  a self-hosted model server, or the customer's own cloud tenancy. StenoAI runs
  no server that receives meeting content in any mode. No procurement
  accreditation or institutional endorsement is implied by the new imagery.

## Image provenance

The homepage hero is a looping film of the desktop app recording in a briefing
room (`public/video/briefing-room.mp4`, poster `briefing-room.webp`), cut from the
designer preview's app film: the preview's end card is replaced with the StenoAI
mark, and the cuts are slowed 1.6x.

The two sector images are reused from the user-supplied designer preview, stored
locally so the production page does not depend on that preview host:

- `public/images/enterprise/government.webp`: `/img/gov-exterior-sm.webp`
- `public/images/enterprise/defence.webp`: `/img/def-planning.webp`

They illustrate use cases and are not evidence of customers or deployments.

- `public/images/enterprise/law-enforcement.webp`: `/img/le-briefing.webp`
- `public/images/enterprise/briefing-room.webp`: `/video/appfilm-hero-loop-poster.webp`
- `public/video/briefing-room.mp4`: re-cut from `/video/appfilm-hero-loop-v12.mp4`
  (about 4 MB; pauses out of view and holds the poster under reduced motion). The
  app screen in the footage shows "StenoAI", the website brand; the desktop app
  itself is named "Steno".
