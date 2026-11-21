---
version: 1.0
name: Steno-design-system
description: >-
  Paper + ink. A calm, editorial desktop interface for Steno — a local meeting
  recorder/transcriber. The system anchors on a warm cream "paper" canvas with
  deep "ink" text and, deliberately, NO chromatic brand accent: focus rings,
  active states, toggles and links all use the foreground ink itself, so the
  whole UI reads as one neutral paper+ink palette. The only non-neutral colors
  are reserved status hues (danger red, success green, recording red). Type is a
  humanist sans (Inter) for UI, a calligraphic serif (Ovo) for the two
  largest display headings only, and JetBrains Mono for transcripts/code. Depth
  comes from soft shadows and surface tints, not borders (borders are rare —
  whitespace is preferred). Full light + dark parity is mandatory. macOS-only
  window chrome (traffic-light insets) is gated behind html.is-mac.
  Source of truth: app/renderer/src/globals.css. This file is the binding
  reference for the `sanji` design-review skill.

colors:
  # Raw neutrals — paper (warm cream) ascending to ink (warm near-black)
  paper-0: "#FAF9F5"   # page / default surface
  paper-1: "#F5F3EC"   # sunken / hover
  paper-2: "#EFEBE1"   # active
  paper-3: "#E5DFD1"   # strongest cream
  ink-900: "#1B1B19"   # primary text + the accent
  ink-700: "#3D3D39"   # primary hover (buttons darken to this)
  ink-500: "#6B6B66"   # secondary text
  ink-300: "#A8A8A0"   # muted text
  ink-100: "#D6D4CB"   # faintest ink
  # Semantic surfaces (light)
  page: "#FAF9F5"
  surface: "#FAF9F5"
  surface-raised: "#FFFFFF"
  surface-sunken: "#F5F3EC"
  surface-hover: "#F5F3EC"
  surface-active: "#EFEBE1"
  surface-translucent: "rgba(250, 249, 245, 0.82)"
  # Text (light)
  fg-1: "#1B1B19"      # primary
  fg-2: "#6B6B66"      # secondary
  fg-muted: "#A8A8A0"  # muted
  fg-inverse: "#FAF9F5"
  # The accent IS the ink. There is no separate brand hue.
  accent: "#1B1B19"
  primary-hover: "#3D3D39"
  primary-fg: "#FAF9F5"
  focus-ring: "rgba(27, 27, 25, 0.35)"
  # Borders — rare; prefer whitespace
  border-subtle: "rgba(27, 27, 25, 0.06)"
  border-strong: "rgba(27, 27, 25, 0.22)"
  # Status — the ONLY non-neutral colors, reserved for status meaning
  danger: "#B84A3A"
  danger-bg: "#F5E3DE"
  success: "#4F7A5B"
  success-bg: "#E0EAE0"
  recording: "#B84A3A"

colors-dark:
  page: "#1A1A18"
  surface: "#1A1A18"
  surface-raised: "#24241F"
  surface-sunken: "#14140F"
  surface-hover: "#242420"
  surface-active: "#2E2E28"
  surface-translucent: "rgba(26, 26, 24, 0.78)"
  fg-1: "#EDEAE0"
  fg-2: "#9A968A"
  fg-muted: "#5D5A52"
  fg-inverse: "#1B1B19"
  accent: "#EDEAE0"
  primary-hover: "#FFFFFF"
  primary-fg: "#1A1A18"
  focus-ring: "rgba(237, 234, 224, 0.45)"
  border-subtle: "rgba(237, 234, 224, 0.06)"
  border-strong: "rgba(237, 234, 224, 0.20)"
  danger: "#D17563"
  danger-bg: "rgba(209, 117, 99, 0.14)"
  success: "#7DA088"
  success-bg: "rgba(125, 160, 136, 0.14)"
  recording: "#D17563"

typography:
  # Display (serif — Ovo — used ONLY for h1/h2)
  display-xl:
    fontFamily: "Ovo, Georgia, serif"
    fontSize: 44px
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: -0.02em
  display-lg:
    fontFamily: "Ovo, Georgia, serif"
    fontSize: 30px
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: -0.01em
  # Titles & body (sans — Inter)
  title:
    fontFamily: "Inter, -apple-system, 'Segoe UI', sans-serif"
    fontSize: 22px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: 0
  body-lg:
    fontFamily: "Inter, -apple-system, 'Segoe UI', sans-serif"
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0
  body:
    fontFamily: "Inter, -apple-system, 'Segoe UI', sans-serif"
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0
  body-sm:
    fontFamily: "Inter, -apple-system, 'Segoe UI', sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  caption:
    fontFamily: "Inter, -apple-system, 'Segoe UI', sans-serif"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0
  button:
    fontFamily: "Inter, -apple-system, 'Segoe UI', sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1
    letterSpacing: 0
  mono:
    fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0

rounded:
  xs: 4px
  sm: 6px
  md: 10px
  lg: 14px
  xl: 20px
  full: 9999px

spacing:
  sp-1: 4px
  sp-2: 8px
  sp-3: 12px
  sp-4: 16px
  sp-5: 24px
  sp-6: 32px
  sp-7: 48px
  sp-8: 64px

elevation:
  shadow-sm: "0 1px 2px rgba(27, 27, 25, 0.05)"
  shadow-md: "0 8px 24px -8px rgba(27, 27, 25, 0.14), 0 2px 4px -2px rgba(27, 27, 25, 0.06)"
  shadow-lg: "0 24px 48px -16px rgba(27, 27, 25, 0.22), 0 4px 8px -4px rgba(27, 27, 25, 0.08)"

motion:
  ease: "cubic-bezier(0.2, 0, 0, 1)"
  dur-fast: 120ms
  dur: 200ms
  dur-slow: 320ms

components:
  button-primary:
    backgroundColor: "{colors.accent}"        # ink
    textColor: "{colors.primary-fg}"
    typography: "{typography.button}"
    rounded: "{rounded.lg}"
    padding: 0 16px
    height: 36px
    hover: "darken to {colors.primary-hover} (ink-700); dark mode -> #FFFFFF"
    disabled: "opacity 0.5"
    focus: "2px ring {colors.focus-ring}"
  button-outline:
    backgroundColor: transparent
    textColor: "{colors.fg-1}"
    border: "1px {colors.border-subtle}"
    rounded: "{rounded.lg}"
    height: 36px
    hover: "{colors.surface-hover}"
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.fg-1}"
    rounded: "{rounded.lg}"
    hover: "{colors.surface-hover}"
  button-destructive:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.fg-inverse}"
    rounded: "{rounded.lg}"
    hover: "opacity 0.9"
  button-link:
    backgroundColor: transparent
    textColor: "{colors.fg-1}"          # ink, NOT a colored link
    decoration: "underline on hover, offset 4px, {colors.border-subtle}"
  button-sizes:
    sm: "height 32px, padding 0 12px, 12px text"
    default: "height 36px, padding 0 16px, 14px text"
    lg: "height 44px, padding 0 24px, 16px text"
    icon: "36x36px square"
  card:
    backgroundColor: "{colors.surface-raised}"
    rounded: "{rounded.lg}"
    border: "1px {colors.border-subtle} (only on the bordered variant)"
    shadow: "{elevation.shadow-sm} (bordered variant only)"
    padding: 24px
    variants: "bordered (border+bg+shadow) | flat (transparent, no border)"
  input:
    backgroundColor: transparent
    textColor: "{colors.fg-1}"
    placeholder: "{colors.fg-muted}"
    border: "1px {colors.border-subtle}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 0 12px
    focus: "2px ring {colors.focus-ring}, outline none"
    disabled: "opacity 0.5, cursor not-allowed"
    variants: "default (bordered) | sunken (no border, bg {colors.surface-sunken}) | seamless (no chrome, inherits type)"
  chip:
    backgroundColor: transparent
    textColor: "{colors.fg-1}"
    border: "1px {colors.border-subtle}"
    rounded: "{rounded.full}"
    padding: 2px 10px
    typography: "{typography.caption}"
    variants: "default (outline) | muted (bg {colors.surface-hover}, fg-2) | destructive (bg danger/10, fg danger)"
  dialog:
    backgroundColor: "{colors.surface-raised}"
    rounded: "{rounded.lg}"
    shadow: "{elevation.shadow-lg}"
    overlay: "ink scrim at low alpha"
    padding: 24px
  recording-indicator:
    color: "{colors.recording}"
    animation: "record-pulse — expanding ring, ~1.5s, the ONLY persistent color motion"
---

## Overview

Steno is a desktop meeting-notes app (Electron shell + Python backend). Its
interface is **paper + ink**: a warm cream canvas (`{colors.paper-0}` — #FAF9F5)
carrying warm near-black ink text (`{colors.ink-900}` — #1B1B19). The defining
brand decision is a **deliberate absence of any chromatic accent**. Where most
apps reach for a blue/purple primary, Steno uses the *ink itself* as the accent —
primary buttons are ink, focus rings are ink at low alpha, active tabs and
toggles are ink. The result reads as a single calm, editorial, neutral surface,
closer to a well-set page than a SaaS dashboard.

The only non-neutral colors in the system are **status hues** — danger red,
success green, and the recording red — and they are reserved strictly for
conveying status, never decoration.

Steno surfaces a lot of **asynchronous backend work** (recording, transcription,
summarization, model downloads). Because of that, *loading / empty / error*
states are first-class design surfaces here, not afterthoughts — every async
view needs all three.

**Key characteristics:**
- Warm cream canvas (`{colors.paper-0}`) + warm ink text (`{colors.ink-900}`).
  Never pure white, never pure black — both are warmed.
- **No chromatic brand accent.** The accent is the foreground ink
  (`{colors.accent}` == `{colors.ink-900}` light / `#EDEAE0` dark).
- Status colors only: `{colors.danger}`, `{colors.success}`, `{colors.recording}`.
- Humanist sans (Inter) for everything UI; calligraphic serif (Ovo) for the
  two largest headings only (h1/h2); JetBrains Mono for transcripts + code.
- **Depth via soft shadows + surface tints, not borders.** Borders are rare and
  faint (`{colors.border-subtle}`); whitespace does the separating.
- Full **light + dark parity** is mandatory — every surface/text/state has a
  dark value.
- 8px spacing grid; hierarchical radii (`{rounded.md}` 10px inputs,
  `{rounded.lg}` 14px buttons/cards).
- macOS-only window chrome (traffic-light insets, the 82px `sb-top` offset) is
  gated behind `html.is-mac` and must never leak to Windows.

## Colors

### The accent rule (most important)
There is exactly one accent and it is the ink. `--accent-primary` resolves to the
same value as `--fg-1`. Focus rings (`{colors.focus-ring}`), active tab
underlines, selected toggles, and markdown links all use ink. **Do not introduce
a blue/indigo/teal "primary".** If a new element needs emphasis, it gets ink fill,
ink ring, or more weight/size — not a new hue.

### Surfaces (light → dark parity)
- **Page / surface** `{colors.paper-0}` / dark `#1A1A18` — the app floor.
- **Raised** `{colors.surface-raised}` (#FFFFFF) / dark `#24241F` — cards,
  popovers, dialogs that sit above the page.
- **Sunken** `{colors.surface-sunken}` (#F5F3EC) / dark `#14140F` — wells,
  search fields, inset panels.
- **Hover** `{colors.surface-hover}` / **Active** `{colors.surface-active}` —
  interaction tints applied on top of any surface.
- **Translucent** `{colors.surface-translucent}` — for blurred floating bars
  (the bottom dock / AskBar) over scrolling content.

### Text
- **Primary** `{colors.fg-1}` — body + headings.
- **Secondary** `{colors.fg-2}` (#6B6B66) — supporting text, metadata, timestamps.
- **Muted** `{colors.fg-muted}` (#A8A8A0) — placeholders, disabled labels, the
  faintest tier.
- **Inverse** `{colors.fg-inverse}` — text on ink fills (e.g. primary buttons).

### Status (reserved)
- **Danger / Recording** `{colors.danger}` (#B84A3A light / #D17563 dark) with
  tinted background `{colors.danger-bg}`. Destructive actions, errors, the live
  recording dot/pulse.
- **Success** `{colors.success}` (#4F7A5B / #7DA088) with `{colors.success-bg}` —
  completion, "saved", healthy status.
Status colors are never used for navigation, emphasis, or decoration.

## Typography

### Families
- **Inter** (`{typography.body}`) — all UI: body, labels, buttons, nav, inputs.
  Weights in use: 400 / 450 / 500 / 600. Body runs `font-feature-settings:
  'ss01','cv11'`.
- **Ovo** (`{typography.display-xl}` / `display-lg`) — serif, used **only**
  for `h1` and `h2` (and the `.serif` class). Weight 400 (Ovo ships one weight —
  never fake-bold it), negative tracking (-0.02em / -0.01em). This restrained
  serif is the editorial signature; do not extend it to body or buttons.
- **JetBrains Mono** (`{typography.mono}`) — transcripts, code, anything
  monospaced (`code`, `pre`, `.mono`).

### Scale
| Token | Size | Weight | Line | Use |
|---|---|---|---|---|
| `{typography.display-xl}` | 44px | 400 | 1.1 | `h1` — page hero title (Ovo serif) |
| `{typography.display-lg}` | 30px | 400 | 1.25 | `h2` — section heading (Ovo serif) |
| `{typography.title}` | 22px | 500 | 1.3 | `h3`, card/panel titles (Inter) |
| `{typography.body-lg}` | 17px | 400 | 1.55 | lead paragraphs |
| `{typography.body}` | 15px | 400 | 1.55 | default running text |
| `{typography.body-sm}` | 14px | 400 | 1.5 | dense lists, secondary rows |
| `{typography.caption}` | 12px | 500 | 1.4 | chips, badges, metadata labels |
| `{typography.button}` | 14px | 500 | 1.0 | button labels |
| `{typography.mono}` | 14px | 400 | 1.6 | transcripts, code blocks |

### Principles
- Serif is reserved for h1/h2 only — never bold it (stays 400) and keep the
  negative tracking.
- Body weight 400; labels/emphasis 500; 600 is the heaviest — there is no 700.
- Code blocks and raw logs use mono; conversational transcript bubbles (`TranscriptPanel` / `LiveTranscriptBar`) are an explicit exception and use `--font-sans` for long-form dialogue readability.

## Layout

### Spacing — 8px grid
Base unit 8px (with a 4px half-step). Tokens: `{spacing.sp-1}` 4 · `{spacing.sp-2}`
8 · `{spacing.sp-3}` 12 · `{spacing.sp-4}` 16 · `{spacing.sp-5}` 24 ·
`{spacing.sp-6}` 32 · `{spacing.sp-7}` 48 · `{spacing.sp-8}` 64. All padding,
gaps, and margins should resolve to these steps. Card interiors use 24px;
section gaps use 24–32px.

### App shell
- A persistent left **sidebar** (navigation + search, ⌘K to focus search) and a
  main content column.
- A shared **bottom dock** anchor that swaps between the live recording pill,
  the processing dock, and the floating AskBar — only one occupies the slot at a
  time; it floats on `{colors.surface-translucent}`.
- macOS: the window is frameless with `titleBarStyle: hiddenInset`; the sidebar
  top reserves an 82px `sb-top` inset for the traffic lights, applied only under
  `html.is-mac`.

### Whitespace philosophy
Separation comes from space and surface tint, not lines. Reach for a border
(`{colors.border-subtle}`) only when whitespace genuinely can't carry the
grouping. Cards default to the **flat** variant; promote to bordered+shadow only
when a card must visibly lift off the page.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| Flat | No shadow, no border | Default — most content, flat cards |
| Tinted | Surface tint only (sunken/hover/active) | Wells, hover/active states |
| Raised | `{colors.surface-raised}` + `{elevation.shadow-sm}` | Bordered cards, small popovers |
| Floating | `{elevation.shadow-md}` | Dropdowns, the bottom dock |
| Modal | `{elevation.shadow-lg}` + scrim | Dialogs |

Depth is color-and-shadow first; borders last. Dark-mode shadows are deeper
(black at higher alpha) to remain visible on dark surfaces.

## Shapes

| Token | Value | Use |
|---|---|---|
| `{rounded.xs}` | 4px | inner chips, tiny accents |
| `{rounded.sm}` | 6px | small controls, menu items |
| `{rounded.md}` | 10px | inputs, selects, textareas |
| `{rounded.lg}` | 14px | buttons, cards, dialogs (the default radius) |
| `{rounded.xl}` | 20px | large feature panels, hero containers |
| `{rounded.full}` | 9999px | chips, pills, the recording dot, avatars |

## Components

### Buttons
**`button-primary`** — Ink fill (`{colors.accent}`), inverse text, `{rounded.lg}`,
36px tall, 16px horizontal padding, label `{typography.button}`. Hover darkens to
`{colors.primary-hover}` (ink-700; dark mode brightens to white). Focus shows a
2px `{colors.focus-ring}`. Disabled = opacity 0.5. Sizes: sm 32px, default 36px,
lg 44px, icon 36×36.

**`button-outline` / `button-ghost`** — Transparent with ink text; hover paints
`{colors.surface-hover}`. Outline adds a faint `{colors.border-subtle}` edge.

**`button-destructive`** — `{colors.danger}` fill, inverse text. The only
colored button; reserved for destructive/irreversible actions.

**`button-link`** — Inline text button in **ink** (not a colored link),
underline on hover. Steno links are ink — never blue.

### Cards & containers
**`card`** — `{rounded.lg}`. Two variants: **flat** (transparent, no border — the
default) and **bordered** (`{colors.surface-raised}` + 1px `{colors.border-subtle}`
+ `{elevation.shadow-sm}`). Padded interior is 24px; header `pb 16px`, footer
`pt 16px`.

### Inputs & forms
**`input`** — Transparent, 1px `{colors.border-subtle}`, `{rounded.md}`, 36px tall,
12px padding, `{typography.body-sm}`. Placeholder `{colors.fg-muted}`. Focus =
2px `{colors.focus-ring}`, no outline. Variants: **default** (bordered),
**sunken** (no border, `{colors.surface-sunken}` fill), **seamless** (no chrome,
inherits surrounding type — used for inline-edit fields). Textarea min height
36px.

### Chips / badges
**`chip`** — `{rounded.full}`, 1px border, `2px 10px` padding, `{typography.caption}`.
Variants: **default** (outline), **muted** (`{colors.surface-hover}` fill, fg-2),
**destructive** (danger at 10% fill, danger text).

### Dialogs
**`dialog`** — `{colors.surface-raised}`, `{rounded.lg}`, `{elevation.shadow-lg}`,
ink scrim overlay, 24px padding.

### Recording indicator
The live state uses `{colors.recording}` with the `record-pulse` keyframe (an
expanding ring, ~1.5s). This is the one place persistent colored motion is
correct, because it signals an active, ongoing capture.

## Async states (first-class in Steno)
Every view that waits on the backend must define all three:
- **Loading** — prefer skeletons or a subtle pulse over spinners; keep layout
  stable so content doesn't jump in. Existing keyframes: `thinkingBounce`,
  `lnv-wait` (thinking dots), `wave` (audio bars).
- **Empty** — a calm, centered message + the primary next action (e.g. "No
  notes yet — start a recording"). Never a blank panel.
- **Error** — honest and specific, in `{colors.danger}` with a recovery action
  (retry / reprocess). Match the backend's honest-failure model (e.g.
  transcription-failed surfaces a reprocess path, not a silent empty note).

## Do's and Don'ts

### Do
- Anchor on the cream paper canvas with warm ink text.
- Use **ink** for every accent: primary fills, focus rings, active states, links.
- Reserve color for status only (`{colors.danger}`, `{colors.success}`,
  `{colors.recording}`).
- Reach for whitespace and surface tint before a border.
- Use semantic tokens (`{colors.fg-1}`, `{colors.surface-raised}`,
  `{colors.accent}`) — never inline hex.
- Ship light AND dark values for every new surface, text, and state.
- Define loading + empty + error for every async view.
- Gate macOS-only chrome behind `html.is-mac`; keep Windows clean.
- Snap spacing to the 8px grid; use `{rounded.lg}` for buttons/cards,
  `{rounded.md}` for inputs.

### Don't
- Don't introduce a chromatic brand accent (blue/indigo/teal "primary"). Ink is
  the accent.
- Don't use pure white or pure black — both are warmed in this system.
- Don't color links; Steno links are ink with underline-on-hover.
- Don't set the display serif (Ovo) on body, buttons, or anything past h2,
  and don't bold it.
- Don't set transcripts in the sans face; transcripts are JetBrains Mono.
- Don't lean on borders to separate content when space will do.
- Don't ship a light-only (or dark-only) treatment.
- Don't leave an async view with no empty/error state.
- Don't let a macOS-only inset/role/style apply on Windows.

## Responsive / window behavior
Steno is a resizable desktop window, not a responsive marketing page. Design for
a comfortable minimum width with the sidebar + main column, and let the main
column reflow. Floating elements (bottom dock, AskBar, transcript bar) stay
pinned and use the translucent surface so content scrolls beneath them. Touch is
not a target; pointer hit areas should still be a comfortable ~32–36px minimum.

## Motion
Transitions use `{motion.ease}` (`cubic-bezier(0.2,0,0,1)`) at `{motion.dur-fast}`
(120ms) for hovers/state changes and `{motion.dur}` (200ms) for larger moves.
Honor `prefers-reduced-motion` — disable non-essential animation (pulse, waves,
bounces) when the user requests reduced motion. Don't animate beyond what the
tokens encode; motion is functional (state feedback, recording liveness), not
decorative.

## Iteration guide
1. Work one component/surface at a time; reference its YAML key.
2. Use `{token.refs}` everywhere — never inline hex.
3. Every change ships light + dark together.
4. Every async surface ships loading + empty + error together.
5. Emphasis order: ink fill → ink ring → more weight/size. Never a new hue.
6. When unsure, choose the calmer, more editorial option.

## Known gaps / documented exceptions
- **Text selection** uses a tinted indigo (`rgba(99,102,241,.22)` light /
  `rgba(129,140,248,.32)` dark) — the single intentional non-ink color, chosen so
  selection stays visible over near-paper search fields where an ink highlight
  vanished. Treat as a deliberate exception, not license for chromatic accents.
- Shadcn primitives carry their own HSL token mirror (`--background`,
  `--primary`, `--ring`, …) in `globals.css`; they point at this same palette so
  shadcn components inherit paper+ink automatically. Keep the two in sync.
- Per-route layouts (Home, MeetingDetail, Chat, Settings, Setup) compose these
  primitives but aren't enumerated here; read the route + its components for
  specifics.
- This document tracks `app/renderer/src/globals.css`. If tokens change there,
  update here (and the CLAUDE.md "Brand Colors" summary).
