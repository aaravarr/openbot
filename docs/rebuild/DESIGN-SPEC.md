# OpenBot Web UI — Design Specification

> Phase 3 of the frontend rebuild. Input: `docs/rebuild/PRD.md` (product requirements),
> `DESIGN.md` (getdesign "Cursor" visual baseline), `design-system/openbot/MASTER.md`
> (ui-ux-pro-max generated system). Output: the normative design contract for the rebuilt
> console, plus the static prototype in `docs/rebuild/prototype/`.
>
> **Hard constraints honored:** the rejected old UI is not referenced. Cursor Orange
> (`#f54e00`) appears only on primary save CTAs. No drop shadows on flat surfaces. No emojis
> — inline Lucide SVG only. Dark-first with full light parity (PRD §6).

---

## 1. Reconciliation note — getdesign Cursor baseline × ui-ux-pro-max MASTER

Two design inputs were merged. Where they disagree, the resolution below is normative.

### 1.1 What each source contributes

| Source | Adopted | Rejected / adapted |
|---|---|---|
| **getdesign / Cursor** (`DESIGN.md`, locked by `AGENTS.md`) | Warm cream canvas `#f7f7f4`, warm ink `#26251e`, hairline-only depth, no drop shadows, Cursor Orange `#f54e00` reserved for the single primary action, JetBrains Mono on every data/code surface, radius scale (4/6/8/12/pill), 4 px spacing base | 80 px marketing section rhythm (console uses 16/24/32 rhythm); 40/44 px marketing control heights (console density requires 28–36 px); display type at 72 px weight-400 editorial voice (a console has no editorial hero — display scale is truncated to ≤ 24 px); timeline pastel palette (scoped to Cursor's agent timeline, irrelevant here) |
| **ui-ux-pro-max MASTER** (`design-system/openbot/MASTER.md`) | Design dials: **Density 8/10** (dense dashboard spacing scale), **Motion 3/10** (subtle 150–300 ms micro-interactions only), **Variance 3/10** (centered, minimal); Inter as the (open) sans; the anti-pattern checklist (no emoji icons, visible focus, 150–300 ms transitions, cursor:pointer, contrast ≥ 4.5:1) | Entire color palette (slate `#0F172A` + green `#22C55E` CTA) — conflicts with the locked Cursor identity; box-shadow elevation scale (`--shadow-sm…xl`) — conflicts with hairline-only depth; "Exaggerated Minimalism" style + single-column marketing page pattern — wrong product type; 12/16 px base font sizing — PRD §6 fixes 13–14 px for a dense console |

### 1.2 Conflicts and resolutions

1. **Theme polarity.** MASTER says "dark mode default" and ships a slate palette; Cursor baseline is light-only cream. PRD §6 resolves: *dark-first with full light parity*. Resolution: the **light theme is the Cursor palette verbatim** (with two AA corrections, §6.1); the **dark theme is a hue-preserving inversion of the same warm ramp** (cream → warm near-black), not MASTER's blue slate. Brand continuity stays intact in both themes.
2. **Accent color.** MASTER's green CTA is rejected. Cursor Orange `#f54e00` is the only accent, and only on the **primary save CTA** of each mutation surface (wizard "Wrap host and activate", dialog "Save", key "Save key"). Non-save strong actions (Send, Activate-tunnel) use the ink-solid button, not orange.
3. **Depth model.** MASTER's shadows rejected on flat surfaces per `AGENTS.md` ("Do not add drop shadows"). A single small shadow is permitted **only on overlays** (dialog, drawer, toast, tooltip) to separate them from the scrim — this is elevation, not decoration.
4. **Density.** MASTER's 8/10 density dial wins over Cursor's editorial whitespace: base font 13 px, table rows 34 px, controls 28–32 px, section gaps 16–24 px. Interactive targets stay ≥ 28 px (PRD §6).
5. **Typography family.** CursorGothic is licensed; per `DESIGN.md`'s own note the substitute is **Inter** (400/500/600). JetBrains Mono carries all identifiers, URLs, latencies, token counts. Display weights stay ≤ 600; the magazine 400-with-negative-tracking voice is not used because a console has no display copy.
6. **Motion.** MASTER 3/10 + PRD: transform+opacity only, 150–300 ms, ease-out enter / ease-in exit, reduced-motion honored. The GSAP page-transition snippet in MASTER is not used (hash SPA; transitions are CSS-only).

---

## 2. Design tokens (paste-ready CSS)

This block is the single source of truth; the prototype embeds it verbatim.

```css
/* ============ OpenBot design tokens ============ */
:root {
  /* type */
  --font-sans: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace;
  --text-xs: 11px;  --text-sm: 12px;  --text-base: 13px; --text-md: 14px;
  --text-lg: 16px;  --text-xl: 20px;  --text-2xl: 24px;
  --lh-tight: 1.25; --lh-base: 1.45;
  --tracking-caps: 0.07em;

  /* spacing — 4px base unit */
  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
  --sp-5: 20px; --sp-6: 24px; --sp-8: 32px; --sp-12: 48px;

  /* radii */
  --r-xs: 4px; --r-sm: 6px; --r-md: 8px; --r-lg: 12px; --r-pill: 9999px;

  /* z-index layers */
  --z-sticky: 40; --z-drawer: 60; --z-dialog: 70; --z-toast: 80; --z-tooltip: 100;

  /* motion */
  --dur-1: 120ms;              /* hover / color fades        */
  --dur-2: 180ms;              /* micro state changes        */
  --dur-3: 240ms;              /* overlay enter              */
  --dur-exit: 140ms;           /* overlay exit (faster)      */
  --ease-enter: cubic-bezier(0.16, 1, 0.3, 1);   /* ease-out   */
  --ease-exit: cubic-bezier(0.7, 0, 0.84, 0);    /* ease-in    */
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);

  /* constants shared by both themes */
  --primary: #f54e00;          /* Cursor Orange — primary save CTA only */
  --primary-active: #d04200;
  --on-primary: #ffffff;
  --danger-solid: #cf2d56;     /* filled destructive button */
  --danger-solid-hover: #b8234a;
  --shadow-overlay: 0 8px 24px rgba(0, 0, 0, 0.18);  /* overlays only */
}

/* ---- light theme (Cursor baseline, AA-corrected) ---- */
:root[data-theme="light"] {
  color-scheme: light;
  --canvas: #f7f7f4;
  --canvas-soft: #fafaf7;      /* inset panes            */
  --surface: #ffffff;          /* cards                  */
  --surface-2: #fafaf7;        /* recessed areas in cards */
  --surface-3: #efeee8;        /* hover / selected fill  */
  --ink: #26251e;              /* primary text           */
  --body: #5a5852;             /* secondary text         */
  --muted: #6e6b60;            /* tertiary text (AA 4.97) */
  --faint: #8f8b7e;            /* placeholder/disabled only */
  --hairline: #e6e5e0;
  --hairline-soft: #efeee8;
  --hairline-strong: #cfcdc4;
  --primary-hover: #e04600;
  --primary-strong: #c24400;   /* orange as *text* (AA 4.75) */
  --success: #177152;
  --warning: #8a6100;
  --danger: #cf2d56;           /* danger text/icons on plain surfaces */
  --danger-strong: #b02347;    /* danger text on danger-tint */
  --info: #2a61a8;
  --success-tint: #e0f0e9;  --warning-tint: #f4ebd6;
  --danger-tint: #f9e6ec;   --info-tint: #eaf1fb;
  --accent-tint: #fbe3d4;   --neutral-tint: #efeee8;
  --scrim: rgba(38, 37, 30, 0.44);
  --focus-ring: #f54e00;
}

/* ---- dark theme (hue-preserving inversion of the cream ramp) ---- */
:root[data-theme="dark"] {
  color-scheme: dark;
  --canvas: #161511;
  --canvas-soft: #12110d;
  --surface: #1e1d17;
  --surface-2: #1a1913;
  --surface-3: #292820;
  --ink: #edece3;
  --body: #c0beb2;
  --muted: #918e7f;
  --faint: #6f6c5f;
  --hairline: #2c2b23;
  --hairline-soft: #24231c;
  --hairline-strong: #3d3c31;
  --primary-hover: #ff5f0f;
  --primary-strong: #ff7a33;   /* orange as text on dark (AA 6.5+) */
  --success: #4cc399;
  --warning: #d9a03f;
  --danger: #e5617f;
  --danger-strong: #e5617f;
  --info: #7aa8e8;
  --success-tint: #1c2f27;  --warning-tint: #322815;
  --danger-tint: #38202a;   --info-tint: #1c2a3d;
  --accent-tint: #38220f;   --neutral-tint: #2a2921;
  --scrim: rgba(0, 0, 0, 0.55);
  --focus-ring: #f54e00;
  --shadow-overlay: 0 8px 24px rgba(0, 0, 0, 0.45);
}
```

### 2.1 Token rules

- **Orange discipline.** `--primary` fills exactly one button per mutation surface. As *text*
  (links, active chip, mode-pill label) use `--primary-strong`, never `--primary` (light-theme
  `#f54e00` text is only 3.28:1 — fails AA for text).
- **Semantic color is always paired with an icon or word** (PRD §6): a status is dot + label,
  a badge is icon/label, never color alone.
- **Tints** (`*-tint`) are badge/banner fills; their text is the matching semantic color
  (`--danger-strong` on `--danger-tint`, etc.). All pairs verified ≥ 4.5:1 (§6.1).
- **Hairlines carry all structure.** 1 px `--hairline` between rows, `--hairline-strong` around
  interactive outlines. No shadows below the overlay tier.
- **Monospace** for: model ids/slugs, provider origins, URLs, endpoints, latencies, token
  counts, pids, timestamps, log bodies, key masks.

---

## 3. Component specifications

Measurements are px; heights are outer box heights. All interactive elements expose
`:focus-visible` = `outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius`
preserved. Disabled = `opacity: 0.5; cursor: not-allowed;` plus the semantic `disabled`
attribute. Every clickable element has `cursor: pointer`.

### 3.1 Buttons

| Variant | Size (h / pad-x / radius / font) | Colors | Hover | Active | Loading |
|---|---|---|---|---|---|
| **Primary (save CTA)** | 32 / 14 / `--r-md` / 13·600 | bg `--primary`, text `--on-primary` | bg `--primary-hover` | bg `--primary-active`, translateY(0) | spinner (Loader2, spin 1 s) replaces label icon; button disabled, width locked |
| **Primary large** (wizard only) | 36 / 18 / `--r-md` / 14·600 | same | same | same | same |
| **Secondary** | 32 / 12 / `--r-md` / 13·500 | bg `--surface`, text `--ink`, 1 px `--hairline-strong` | bg `--surface-3` | bg `--surface-3` + inner border | same spinner rule |
| **Secondary small** | 28 / 10 / `--r-sm` / 12·500 | same | same | same | — |
| **Ink solid** (strong non-save: Send, Start tunnel) | 32 / 14 / `--r-md` / 13·600 | bg `--ink`, text `--canvas` | 90% opacity | 85% opacity | spinner |
| **Danger solid** (inside confirm dialogs only) | 32 / 14 / `--r-md` / 13·600 | bg `--danger-solid`, text #fff | `--danger-solid-hover` | darker | spinner |
| **Ghost** | 32 / 10 / `--r-md` / 13·500 | transparent, text `--body` | bg `--surface-3`, text `--ink` | — | — |
| **Ghost small** (table/header action groups) | 28 / 10 / `--r-sm` / 12·500 | transparent, text `--body`, 1 px `--hairline` | bg `--surface-3`, text `--ink` | — | — |
| **Ghost danger** (destructive *entry points*) | 32 / 10 / `--r-md` / 13·500 | transparent, text `--danger` | bg `--danger-tint` | — | — |
| **Ghost danger small** | 28 / 10 / `--r-sm` / 12·500 | transparent, text `--danger`, 1 px `--hairline` | bg `--danger-tint` | — | — |
| **Icon button** | 28×28 / — / `--r-sm` / 16 px icon | transparent, icon `--muted` | bg `--surface-3`, icon `--ink` | — | spin |

Rules: one `--primary` button per view. Destructive actions are never inline solid red — the
entry point is **ghost danger**, the red solid button lives inside the confirm dialog
(PRD §6 "no double-click hazards"). Press feedback is color shift only (no scale — avoids
layout shift per anti-pattern list). Focus ring always visible, incl. on orange (ring sits on
2 px offset over the adjacent surface).

### 3.2 Text inputs & fields

- **Field**: label 12·500 `--body` + 4 px gap + control; helper text 12 `--muted` 4 px below;
  error text 12 `--danger` with CircleAlert icon, replaces helper, `aria-live="polite"`.
- **Input**: h 32, pad-x 10, radius `--r-md`, bg `--surface`, 1 px `--hairline-strong`,
  text 13 `--ink`; placeholder `--faint`.
  - hover: border `--muted`·40%. focus: border `--primary` + `0 0 0 3px` ring at 15% orange
    (light) / 25% (dark); no outline removal.
  - error: border `--danger`, ring danger-tint; error text below; validate on blur, not keystroke.
  - disabled: bg `--surface-2`, text `--faint`.
- **Password/key input**: same + 28×28 eye/eye-off icon button inset right (toggles the *draft*
  only). After save the field is replaced by the **key badge** ("Key saved •••••") — secrets
  are never re-rendered (PRD §6, FR-24).
- **Mono input** (origins, model ids, token limits): `--font-mono` 12.5 px.
- Wizard steps use the relaxed variant: h 36, pad-x 12.

### 3.3 Listbox (custom dropdown) — the ONLY model/provider picker

**No native `<select>` is used anywhere in the product.** Every model/provider picker — the
Dashboard quick model switcher, the Logs model filter, any provider picker, and every picker added
later — is this custom-styled listbox. Rationale: the native popup cannot render grouped options,
parameter badges, a check mark on the current item, or an in-panel search, and its look is
platform-dependent.

- **Trigger button** (`.listbox__trigger`): h 32, pad-x 10, pad-r 28, radius `--r-md`, bg
  `--surface`, 1 px `--hairline-strong`, text 13 `--ink` (mono 12.5 for model ids). Shows the
  **selected model name** (plus a provider/context suffix when helpful) and a ChevronDown 14 px
  pinned right that rotates 180° when open. Follows input hover/focus/error states (border
  `--primary` + 3 px ring at 15 % orange on focus). `aria-haspopup="listbox"`, `aria-expanded`
  toggled, `aria-controls` pointing at the panel.
- **Popover panel** (`.listbox__panel`): bg `--surface`, 1 px `--hairline`, radius `--r-md`,
  `--shadow-overlay` (overlay tier), min-w 240 / max-w 360, `--z-tooltip`. Renders as a sibling of
  the trigger (absolute) with **collision-aware placement**: opens downward by default, flips
  upward when the space below the trigger is smaller than the panel and the space above is larger.
  Closes on **outside click**, on `Esc`, and after selection.
- **Search input** (`.listbox__search`): shown at the top of the panel **only when there are more
  than 8 options**. Mono 12.5, h 30, Search icon inset-left, filters across all groups live;
  groups with zero matches hide; an empty result shows a "No models match" row.
- **Options, grouped by provider** (`.listbox__list`): `max-height: 320px; overflow-y: auto`.
  Options are grouped under **group headers** (`.listbox__group-label`, 11·600 uppercase `--muted`,
  sticky within the scroll) — grouped by provider for the Dashboard switcher; the Logs filter may
  use a single "All" group. Each option row (`.listbox__option`, h 32, pad-x 10) shows:
  - **model name** (mono 12.5 `--ink`) + optional provider/origin suffix (11 `--muted`);
  - **parameter badges** (context/output/modalities/reasoning) using the existing `.badge`
    / `.param-chip` tokens;
  - a **Check 14 px on the currently selected option**, right-aligned.
  Hovered and keyboard-active options share the same visual state: bg `--surface-3`. The selected
  option additionally carries a left 2 px `--primary` inset and `aria-selected="true"`.
- **Keyboard navigation**: `↓`/`↑` move the active option (wrapping), `Home`/`End` jump to ends,
  `Enter`/`Space` select, `Esc` closes and returns focus to the trigger, printable characters
  move to the first option starting with the typed prefix. Focus stays on the trigger/panel; the
  active option is tracked via `aria-activedescendant`.
- **ARIA**: panel `role="listbox"` + `aria-labelledby` (trigger's label), `tabindex="-1"`; options
  `role="option"` + `aria-selected`; active option referenced by `aria-activedescendant`; search
  input `aria-label="Search models"`. A live "N of M" is not required at this density.
- **Behavior contract**: selecting an option updates the trigger label, marks the option selected,
  closes the panel, and fires the same `change` payload a native select would. The Dashboard
  switcher dispatches `use-model`; the Logs filter applies the `model` query. The keyless-provider
  detour (FR-22) still applies to the Dashboard switcher.

### 3.4 Card

- bg `--surface`, 1 px `--hairline`, radius `--r-lg` (12), padding `--sp-5` (20) /
  `--sp-6` for heroes. **No shadow.** Header: 11·600 uppercase `--muted` label, tracking
  `--tracking-caps`; optional right-aligned action cluster. Cards are static — no hover lift
  (anti-pattern: layout-shifting hover). Interactive rows *inside* cards get row hover, not
  card hover.

### 3.5 Badges & pills

| Component | h / pad-x / radius | Font | Colors |
|---|---|---|---|
| **Badge** (neutral) | 20 / 8 / `--r-pill` | 11·500 | bg `--neutral-tint`, text `--body` |
| **Badge success** ("Key saved") | 20 / 8 / pill | 11·500 + Check 12 px | bg `--success-tint`, text `--success` |
| **Badge warning** ("No API key") | 20 / 8 / pill | 11·500 + TriangleAlert 12 px | bg `--warning-tint`, text `--warning` |
| **Status pill** (log status) | 20 / 8 / `--r-sm` | 11·600 mono | 2xx: success tint/`--success`; 4xx·5xx: danger tint/`--danger-strong` |
| **Mode pill — CUSTOM** | 24 / 10 / pill | 11·700 uppercase + mono model id | bg `--accent-tint`, label `--primary-strong`, divider 1 px, model `--ink` mono |
| **Mode pill — OFFICIAL** | 24 / 10 / pill | same | bg `--neutral-tint`, label `--body`, model part absent |
| **Param chip** (reasoning allow-list) | 22 / 8 / `--r-sm` | 11·500 mono | inactive: bg `--surface-2`, text `--muted`, 1 px `--hairline`; active: bg `--accent-tint`, text `--primary-strong`, border `--primary`·45%; `default` chip pinned first, never removable |

### 3.6 Health dot / status item

- Dot: 8 px circle, semantic fill, 2 px `color-mix` glow ring at 25% when fault (pulse 1.6 s
  ease-in-out, disabled under reduced-motion). **Always paired with a word** ("Host · running").
- Strip item: dot + label 12 `--muted` + value 12 mono `--ink`; fault state value turns
  `--danger` and appends the remedy link.

### 3.7 Toast

- Fixed top-right stack, w 360, gap 8, newest on top, `aria-live="polite"`, never steals focus.
- Card: bg `--surface`, 1 px `--hairline`, radius `--r-md`, pad 10×12, `--shadow-overlay`
  (overlay tier), icon 16 px semantic + title 13·600 + body 12 `--body` + close icon button.
- Success = CheckCircle2 `--success`; failure = TriangleAlert `--danger` **leading with the
  remedy**; auto-dismiss 5 s (hover pauses); exit faster than enter (140 ms vs 220 ms).
- Success toasts quote the post-save human message verbatim, e.g. *"Grok Bot will use
  glm-5.3 (high) on the next message."* + restart note when `wrapBytesChanged`.

### 3.8 Confirm dialog / modal

- Scrim `--scrim`, dialog centered, w 440 (wizard/forms 520), bg `--surface`, radius `--r-lg`,
  `--shadow-overlay`, pad 20. Enter: opacity 0→1 + scale .97→1, `--dur-3` `--ease-enter`; exit
  `--dur-exit` `--ease-exit`.
- Anatomy: icon+title (15·600), consequence list (13 `--body`, each row icon + plain-language
  consequence — PRD "destructive actions are deliberate"), footer right: Cancel ghost +
  confirm button (danger solid for destructive, orange primary for saves).
- Behavior: `role="alertdialog"` for destructive, `aria-modal`, focus trapped, initial focus on
  **Cancel** (safe default), Esc + scrim click dismiss (non-destructive only), return focus to
  trigger. Never used for navigation.

### 3.9 Drawer (log record detail)

- Right side, w 480, full height below top nav, bg `--surface`, left border `--hairline`,
  `--shadow-overlay`, `--z-drawer`. Enter: translateX(16px)→0 + fade, 220 ms `--ease-enter`.
- Header: record id mono + status pill + time, close icon button. Body scrolls; sections:
  Overview (definition grid), Error (danger-tint block when present), Token usage (mono trio),
  Upstream endpoint (mono, wrapped), Request / Response bodies (`pre` mono 11.5, `--surface-2`
  pane, max-h 240, truncation notice row).
- `role="dialog"`, labelled by record id, Esc closes, focus returns to the row. Deep link
  `#/logs?id=…` opens it directly; unknown id → "record pruned by retention" notice.

### 3.10 Data table

- Full-width in a card; header row h 30, 11·600 uppercase `--muted`, border-b `--hairline`;
  body rows h 34, 13, border-b `--hairline-soft`; numeric/mono columns in `--font-mono` 12 with
  tabular figures. Row hover bg `--surface-3`; clickable rows show pointer + chevron affordance
  on hover. Selected/open row: 2 px left inset `--primary`.
- Columns truncate with ellipsis + tooltip; the Error column truncates hardest (max-w 320).
- Empty/loading states live inside the table frame (skeleton rows / empty state), header stays.

### 3.11 Top nav + status strip (global shell)

- **Top nav**: sticky, h 48, bg `--canvas`·92% + backdrop-blur 8 px, border-b `--hairline`,
  `--z-sticky`. Left: wordmark (18 px orange rounded-square with white `>` glyph + "OpenBot"
  14·600). Center-left: 3 links (Dashboard, Models, Logs), 13·500, icon 14 + label,
  h 48 hit area; active link `--ink` + 2 px bottom `--primary` indicator; inactive `--muted`,
  hover `--ink` on `--surface-3` pill. Right: theme toggle icon button, then loopback chip
  (`127.0.0.1:9280` mono 11 + compact ghost copy icon button, 20×20, hover `--surface-3`).
- **Status strip**: h 36, border-b `--hairline`, bg `--canvas`; left: mode pill; center: 4
  health items (Host / Port 9280 / Wrap / Service) dot+word, 24 px gaps; right: "Saving…" pill
  (visible only during a save queue; spinner + `--warning` text) and last-poll time.
- Mobile floor (390 px): nav collapses to bottom tab bar (3 icon+label tabs, h 56, safe-area
  padding); status strip condenses to mode pill + worst-state health dot. Not-break P0, polish P1.

### 3.12 Toggle switch

- Track 28×16, radius pill, bg `--hairline-strong`; thumb 12 px `--surface` (light) /
  `--ink` (dark), translateX 12 px when on; on-state track `--success`. 150 ms transform.
  `role="switch"`, `aria-checked`, label always adjacent text ("Recording"), never color-only.
  Hit area extended to 28×28 via padding.

### 3.13 Skeleton

- Rect blocks, radius `--r-xs`, bg linear-gradient shimmer `--surface-3`→`--hairline`→`--surface-3`,
  1.4 s sweep; under reduced-motion the shimmer freezes (static blocks). Skeletons mirror the
  final layout 1:1 (hero block, dot row, table rows ×8) — never a lone spinner for lists.

### 3.14 Empty state

- Centered in its panel: 32 px Lucide icon in `--surface-3` 48 px rounded tile, title 14·600,
  body 13 `--body` (what to do, one sentence), one action (secondary button or text link).
  Examples: Dashboard no-providers → "Set up your first provider" CTA → `#/setup`; Logs
  recording-off → explainer + "Turn on recording"; Logs enabled-empty → "No requests yet —
  send a message in Grok Bot."

### 3.15 Tooltip

- 11·500, bg `--ink`, text `--canvas`, radius `--r-sm`, pad 4×8, max-w 240, `--shadow-overlay`,
  `--z-tooltip`, 120 ms fade, 4 px offset; on hover *and* focus (`aria-describedby`), never on
  touch-critical paths, never hides required info (full text reachable by expanding the row).

### 3.16 Banners & inline notices

- **Blocking banner** (hostile host, FR-4): page-wide strip under the status strip, bg
  `--danger-tint`, 1 px `--danger`·40% border-l 3 px, ShieldAlert icon + kind name mono
  (`foreign-opengrok`) + remedy sentence + "View diagnostics" disclosure (raw snapshot in mono
  pane). All mutating controls disabled while present.
- **Inline notice** (needs-reinstall, key-required, tunnel warning): same anatomy in
  `--warning-tint` / `--info-tint` inside the relevant card.

### 3.17 Model fetch UI (Source A / Source B)

- **Fetch models button** (DownloadCloud 14 px, compact ghost `--hairline` border — not a heavy
  button) on the provider detail header, and in the setup wizard's credentials step where it reads
  **"Save provider & fetch models"** (it upserts the provider + key before fetching). States:
  - **idle** — normal secondary button, label "Fetch models".
  - **loading** — button disabled, label swaps to a Loader2 spinner + "Fetching…"; width locked;
    no other control blocks.
  - **done** — button returns to idle; the **Import models dialog** (below) opens. The result is
    never rendered as an inline list.
- **Import models dialog** (`.overlay` + `.dialog--import`, `role="dialog"`, `aria-modal="true"`,
  `aria-labelledby` → title). Size **w 640**, bg `--surface`, radius `--r-lg`, `--shadow-overlay`,
  `max-height: min(680px, calc(100vh - 48px))`; the body is a flex column so the list scrolls
  between a fixed header and a fixed footer. Reuses the shared overlay behavior (§3.8): focus trap,
  `Esc` + scrim dismiss (non-destructive), return focus to the Fetch button.
  - **Sticky header** (`.import-head`): DownloadCloud icon + title **"Import models"** (15·600) +
    desc *"Choose which of {provider}'s models to add."* (13 `--body`) + close icon button. Beneath
    it a **toolbar** row: **search input** (mono 12.5, h 30, Search icon inset-left, `aria-label
    "Filter models"`, shown when the list exceeds ~8 rows), a **count** ("12 models" mono 12
    `--muted`), and a **select-all/none** toggle button (ghost) flipping between "Select all" and
    "Select none" (disabled when nothing is selectable).
  - **Scrollable list** (`.import-body`, `overflow-y: auto`, `role="group"`, `aria-label "Fetched
    models"`). Each row (`.import-row`, min-h 38, pad 5×8) is a `<label>` wrapping a **native
    checkbox** (`.checkbox`, 16 px box, orange fill when checked, `:focus-visible` ring) plus the
    model identity: **model id** mono 12 + optional **name** 12 `--muted`, a **"catalog" badge**
    (Database 12 px + "catalog") when the id matched Source B, and a **context-length badge** (e.g.
    "128K") when known. Rows already in the catalog render **disabled with an "Already added" tag**
    (Check + neutral tint, id/name at `--faint`, no checkbox) — not selectable, so the import count
    is unambiguous.
  - **Partial-failure notice** (`--warning-tint` inline notice above the list): *"2 of 8 models were
    skipped (missing id) — the valid models are still selectable."* Valid rows stay enabled.
  - **Error state** (`--danger-tint` notice in the body, list hidden, import disabled) naming the
    structured kind + remedy: `no-secret` → "Add key first" (links the key field) · `unauthorized` →
    "key was rejected" · `not-supported` → "this provider exposes no /v1/models — add models
    manually" · `unreachable` → "couldn't reach the provider".
  - **Empty state**: centered icon + "No models found" + remedy (add manually) — import disabled.
  - **Sticky footer** (`.import-foot`, border-t `--hairline`): left **selected count** ("3 selected"
    12 `--muted`), right **Cancel** ghost + **"Import selected (N)"** primary (orange) CTA. The CTA
    is **disabled at 0**, its label tracks the live count, and on confirm it enters a loading state
    (spinner + "Importing…", disabled) then appends the chosen rows to the provider's model table and
    closes.
  - **Keyboard**: native checkbox semantics (Space toggles); Arrow Up/Down move focus between the
    visible checkboxes (checkbox-group roving); `Esc` closes; Tab is trapped by the shared dialog
    logic; initial focus on the search input (`data-autofocus`).
  - **ARIA**: dialog `aria-modal` + `aria-labelledby`; list `role="group"` + `aria-label`; each row's
    `<label>` gives the checkbox its accessible name (model id + name); the import count is reflected
    in the button label ("Import selected (N)"); toasts `aria-live="polite"`.
- **Auto-filled field indicator**: on import, a model whose id matched Source B pre-fills the model
  form (context window, max output, modalities, reasoning) and the form shows a small **catalog
  badge** (Database 12 px + "catalog") inside each auto-filled field's label row; the input keeps its
  default text color (no error styling). Fields the user then edits drop the badge (it marks *which*
  fields came from the catalog, not a lock). Unmatched models show **no badge** and start empty.
- **Import toast**: *"Imported 3 models — glm-5.2, glm-4.5 and 1 more added to {provider}."* (single
  matched import: *"…{slug} — fields auto-filled from catalog."*).
- **Model catalog card (Source B)** on the Models page settings area (a full-width card below the
  master–detail grid, labelled "MODEL CATALOG"): left = status badge (Ready `--success-tint` /
  Loading `--warning-tint` with spinner / Failed `--danger-tint`) + "Last fetched {time}" mono +
  "614 models · openrouter + models.dev"; right = **Refresh** ghost button (RefreshCw 14 px →
  spinner + "Refreshing…" while in flight). The refresh is a demo interaction in the prototype
  (fake async → updates the timestamp); live it polls `GET /api/model-catalog`.
- **Placement decision (stated):** cache status + refresh live on **Models**, not Logs — Logs keeps
  only its recording-settings card. This keeps catalog hygiene next to where models are added.

---

## 4. Page blueprints

Viewport targets: design at 1440, full usability ≥1152, functional floor 1024 (no horizontal
scroll), 390 px not-break (single column, bottom tabs). Content column: max 1200, pad-x 24.

### 4.0 Global shell

```
┌──────────────────────────────────────────────────────────┐
│ top-nav (48, sticky): wordmark · 4 links · theme · loop  │
├──────────────────────────────────────────────────────────┤
│ status strip (36): mode pill · health dots · Saving…     │
├──────────────────────────────────────────────────────────┤
│ [blocking banner — only when hostBlocked()]              │
│ <main> max-w 1200, py 20, page grid                      │
└──────────────────────────────────────────────────────────┘
 toast stack (fixed, top-right) · dialogs · drawer · tooltips
```

- Hash routes: `#/`, `#/models`, `#/setup`, `#/logs`; unknown → `#/`.
- On route change focus moves to `<main>` (skip link target first in DOM).
- Shell states: **unreachable** full-screen (Unplug icon, "Can't reach the openbot service…",
  Retry secondary, auto-retry 30 s); **blocked** banner above.

### 4.1 Dashboard (`#/`)

Grid 12-col: hero spans 8, tunnel 4; health strip 12; recent requests 12 (P1).

1. **Mode hero card** — label "MODE"; mode pill; active model id mono 20·500 `--ink` with Zap
   "active" badge; sub-line: provider name · key badge; reasoning chips row (allow-list,
   active = accent); rule microcopy (Info icon, `--muted` 12): *"Changes apply to the next new
   message in Grok Bot. One model is active at a time."* Actions: quick switcher **listbox**
   (§3.3 — catalog models grouped by provider, mono) → picking a keyless provider's model routes to
   its key field with the explainer notice; ghost-danger "Switch to Official Grok" → confirm dialog
   (consequences:
   stock on next message / host restarts / catalog+keys kept / tunnel stays).
   - Official mode: hero shows OFFICIAL pill + "Ready to re-enable (last model: X)" + secondary
     "Re-enable custom".
2. **Tunnel card** — label "PHONE ACCESS"; states: off (body copy + ink-solid "Start tunnel" →
   confirm dialog with unauthenticated-URL warning) / starting (skeleton line + "downloading
   cloudflared…" first run) / live (URL mono + copy icon button + ASCII QR `pre` block +
   persistent warning line + secondary "Refresh URL" + ghost-danger "Stop") / error
   (danger-tint notice + Retry).
3. **Health strip** — 5 cells (Host process, Port 9280, Wrap, Alignment, Service): dot + word
   + mono value; faults expand a remedy line ("foreign process on :9280 — stop it before
   switching modes"); `needs-reinstall` renders warning notice + guided "Re-wrap host" action.
4. **Recent requests** — 5 compact rows (time, model, status pill, latency) + "View all" →
   `#/logs`.
- **Loading:** skeleton hero + dots + rows. **Empty (no providers):** hero replaced by setup
  CTA card (Rocket tile icon, copy, orange "Set up a provider" — the dashboard's one orange
  button is allowed here because it *is* the primary commit path into the wizard save).
- **Micro-interactions:** chip select = instant visual + save queue; copy button flashes
  Check + "Copied" tooltip; auto-refresh 30 s while tab visible (pause indicator in strip).

### 4.2 Models (`#/models`, `#/models/:providerId`)

Master–detail: left rail 300 px provider list; right detail pane.

- **Provider row** (h 56): name 13·600 + active Zap badge; sub: mono origin 11 `--muted`;
  right: key badge mini (Key/No key) + ChevronRight. Selected: bg `--surface-3` + 2 px left
  `--primary`. Rail footer: secondary "Add provider" → `#/setup`.
- **Detail header**: provider name 16·600, origin mono 12, badges (Key saved / No API key),
  actions in a compact ghost button group (28 px, 8 px gap): ghost-small "Fetch models" (§3.17),
  ghost-small "Edit", ghost-small "Replace key" / "Add key", ghost-danger-small "Remove".
  - Edit dialog: name + origin (+ optional key rotate), orange "Save changes".
  - Replace key dialog: blind field + eye, explainer "write-only — the current key is never
    shown", orange "Save key". Empty-after-trim rejected inline.
  - Remove confirm: cascade copy; **last provider** gets the strongest copy ("…returns the box
    to Official Grok; the plan file is deleted. Keys stay on disk."— never claims "key deleted").
- **Model table**: columns Model (mono slug), Context, Max output, Reasoning (chips),
  Active level, Modalities ("metadata only" tooltip), Actions (ghost-small "Use" / icon
  Edit). Active row: "Active" badge instead of Use. Footer: ghost "+ Add model" → model dialog
  (slug, context, max output, reasoning chip multi-toggle with `default` pinned, modalities
  checkboxes, 10 000 000 cap helper, orange "Save model").
- **Import models dialog (Source A)** — opens when "Fetch models" is clicked (§3.17); the user
  checks models and confirms "Import selected (N)"; the chosen rows append to the model table. Rows
  that matched Source B show the "catalog" badge and the auto-filled field indicators; unmatched rows
  import with manual fields; already-added rows are disabled.
- **Model catalog card (Source B)** — full-width card below the master–detail grid (§3.17): status
  badge + last-fetched + refresh button.
- **Empty:** full-pane setup CTA. **Loading:** skeleton rail + rows; detail keeps stale content
  while refreshing (no flicker).

### 4.3 Setup wizard (`#/setup`)

Centered column 680 px. Steps header: 3 items (Provider → Credentials & model → Review &
activate), current = `--ink` + number in `--primary`-ring circle, done = Check `--success`.

1. **Provider**: 3×3 preset card grid (OpenAI, DeepSeek, Zhipu GLM, Kimi, Qwen, OpenRouter,
   Groq, xAI, Custom): name 13·600 + mono origin 11; selected = 2 px `--primary` outline +
   accent-tint; hint line under grid swaps per preset.
2. **Credentials & model**: prefilled name / base URL / model id (mono inputs 36 px, **model id
   optional**), blind API key + eye, per-preset helper ("Create a key at platform.deepseek.com —
   stored locally, never displayed again"). A **"Save provider & fetch models"** action (§3.17)
   upserts the provider + key, then opens the **Import models dialog** to pick which models to add
   with Source B auto-fill instead of typing; imported models are summarized in step 2 and carried
   into Review. Inline validation on Continue (model id not required).
3. **Review & activate**: definition list summary (key shown as "••••• — saved on activate", model
   listed or "— (none)"), warning notice *"Grok Bot will restart and use {model} on the next
   message."* when a model is selected — otherwise an info notice *"No model yet — you can fetch
   models from the Models page after activation."* Primary large orange "Wrap host and activate" →
   spinner + global Saving pill → success toast. Refusal → blocking-style banner inside the wizard
   with the remedy; input retained.
- Back ghost between steps; Cancel link top-left returns to `#/`; step state survives navigation
  within the wizard (session storage).

### 4.4 Logs (`#/logs`)

1. **Settings card** (collapsible, default expanded): Recording toggle; Bodies radio
   (Errors only / All); Retention number input (1–365 days) with inline validation; orange-small
   "Save settings"; privacy note (ShieldCheck): *"Keys are always redacted server-side; bodies
   default off."* Advanced accordion (P2): max body bytes, max records.
2. **Toolbar**: search input (Search icon, filters id/model/error/provider/endpoint), errors-only
   toggle, model filter **listbox** (§3.3), record count mono, Refresh icon button, ghost-danger
   "Clear all" → confirm dialog.
3. **Table**: Time · Model · Status · Latency · Tokens · Stream · Error. Row click opens the
   **drawer** (§3.9); deep link `#/logs?id=…` supported; 404 → "record pruned by retention".
4. **Empty**: recording off → explainer + "Turn on recording" (scrolls to settings); enabled but
   empty → "No requests yet…". **Loading:** 8 skeleton rows.

---

## 5. Motion specification

| Transition | Duration | Easing | Properties |
|---|---|---|---|
| Hover / color fades | 120 ms | `--ease-standard` | color, background, border-color |
| Button press | 120 ms | `--ease-standard` | background (no scale) |
| Toggle / chips | 150 ms | `--ease-standard` | transform, background |
| Tooltip / popover | 120 ms in / 100 out | enter `--ease-enter` | opacity, translateY(2→0) |
| Listbox open / close | 140 ms in / 100 out | enter `--ease-enter` / exit `--ease-exit` | opacity, translateY(-2→0); chevron rotate |
| Toast enter / exit | 220 / 140 ms | `--ease-enter` / `--ease-exit` | opacity, translateX(12→0) |
| Dialog enter / exit | 240 / 140 ms | `--ease-enter` / `--ease-exit` | opacity, scale(.97→1) |
| Drawer enter / exit | 220 / 140 ms | `--ease-enter` / `--ease-exit` | opacity, translateX(16→0) |
| Skeleton shimmer | 1400 ms loop | linear | background-position |
| Route fade | 160 out / 200 in | `--ease-exit` / `--ease-enter` | opacity only |
| Health-dot pulse (fault) | 1600 ms | ease-in-out | opacity |

Rules: transform + opacity only; never animate width/height/top/left; exit ≈ 60–70 % of enter;
max 1–2 simultaneous focal animations; streaming text renders without animation (append only).
`@media (prefers-reduced-motion: reduce)` → all durations 0.01 ms, shimmer/pulse/caret frozen,
no transform entrances.

---

## 6. Accessibility

### 6.1 Verified contrast pairs (computed, WCAG formula)

| Pair | Ratio | Verdict |
|---|---|---|
| Light ink / canvas · surface | 14.33 · 15.38 | AAA |
| Light body / canvas · surface | 6.63 · 7.11 | AA |
| Light muted `#6e6b60` / canvas · surface | 4.97 · 5.34 | AA |
| Light faint `#8f8b7e` / surface | 3.41 | placeholder/disabled only |
| Light `--primary-strong` `#c24400` text / canvas · surface | 4.75 · 5.10 | AA |
| White on `--primary` `#f54e00` (CTA label) | 3.52 | brand exception ≥ 3:1 (Cursor ships this pair; label 13–14 px 600, also non-text threshold for the button graphic) |
| White on `--danger-solid` `#cf2d56` | 5.04 | AA |
| Light success `#177152` / canvas · surface · tint | 5.56 · 5.97 · 5.06 | AA |
| Light danger text / canvas · surface; `#b02347` / tint | 4.70 · 5.04; 5.53 | AA |
| Light warning `#8a6100` / canvas · tint | 5.16 · 4.67 | AA |
| Light info `#2a61a8` / canvas · tint | 4.72+ · 5.26 | AA |
| Dark ink / canvas · surface · raised | 15.41 · 14.24 · 12.97 | AAA |
| Dark body / canvas · surface | 9.79 · 9.05 | AA |
| Dark muted `#918e7f` / canvas · surface | 5.55 · 5.13 | AA |
| Dark `--primary-strong` `#ff7a33` / canvas · surface | 7.03 · 6.50 | AA |
| Dark success / danger / warning / info on tints | 6.45 · 4.51 · 6.24 · 5.94 | AA |

### 6.2 Interaction contract

- **Focus**: `:focus-visible` 2 px `--focus-ring` + 2 px offset everywhere; never `outline: none`
  without replacement; tab order = visual order; route change moves focus to `<main>`; dialogs
  trap focus and restore it to the trigger.
- **Keyboard**: every flow completable by keyboard; Enter/Space activate; Esc dismisses
  dialog/drawer/popover; chips are `button`s (arrow-key roving optional); table rows focusable
  (`tabindex="0"`) and Enter opens the drawer.
- **ARIA**: toasts `aria-live="polite"` (never steal focus); field errors `aria-live` +
  `aria-describedby`; dialogs `role="alertdialog"` (destructive) / `role="dialog"` +
  `aria-modal="true"` + `aria-labelledby`; drawer `role="dialog"`; toggles `role="switch"` +
  `aria-checked`; status dots `role="img"` + `aria-label` ("Host: running"); nav `aria-current="page"`.
- **Never color alone**: every status pairs icon/word with color; status pills spell the code.
- Targets ≥ 28 px (dense floor); touch-critical (bottom tabs, wizard buttons) ≥ 40 px at 390 px.
- `prefers-reduced-motion` honored per §5; skip link first in DOM; page `<title>` per route.

---

## 7. Icon system — Lucide (inline SVG, React + Vite target)

Conventions: 24 viewBox, `stroke="currentColor"`, stroke-width 2, round caps/joins, `fill:none`;
sizes 12 (badge), 14 (nav/button), 16 (toast/title), 32 (empty state); `aria-hidden="true"` on
decorative, `<title>` + role img on meaningful.

| Icon | Where |
|---|---|
| `layout-dashboard`, `boxes`, `scroll-text` | top-nav items 1–3 (+ bottom tabs) |
| `sun`, `moon` | theme toggle |
| `zap` | active model marker (hero, provider row, table) |
| `check`, `check-circle-2` | success toast, key badge, wizard done step, ping ok |
| `x` | close (toast, dialog, drawer, chip) |
| `triangle-alert`, `shield-alert`, `circle-alert` | warning notice, blocking banner, field error |
| `info` | rule microcopy, reminders, tooltips |
| `copy`, `check` (swap) | copy URL/endpoint buttons |
| `refresh-cw` | refresh (tunnel URL, logs, model catalog) |
| `plus` | add provider / model |
| `search` | logs search input, listbox search |
| `chevron-down` / `-right` / `-left` | listbox trigger, provider rows, wizard back |
| `pencil`, `trash-2`, `key-round`, `eye`, `eye-off` | provider/model actions, key field |
| `settings-2` | log settings card |
| `download-cloud` | "Fetch models" button (Source A) |
| `database` | model catalog card + auto-fill "catalog" badge (Source B) |
| `loader-2` | all spinners ( Saving pill, loading buttons ) |
| `globe`, `qr-code`, `unplug` | tunnel card, unreachable screen |
| `server`, `activity`, `heart-pulse` | health items (host, port, service) |
| `file-json-2`, `clock` | log drawer sections, latency |
| `rocket` | empty-state setup CTA |
| `external-link` | docs links |
| `arrow-right` | "View all" logs link |

---

## 8. Copy conventions (normative)

- Toast success quotes the post-save message: *"Grok Bot will use {model} ({level}) on the next
  message."* Append *"Grok Bot was restarted to apply the wrap."* when `wrapBytesChanged`.
- Import toast: *"Imported {N} models — added to {provider}."* (single: *"…{slug} — fields
  auto-filled from catalog."* or *"…{slug} — manual fields (no catalog match)."*).
- Refusal banner names the kind + remedy: `foreign-ui` → "Another process owns port 9280. Stop
  it, then retry." · `foreign-opengrok` → "A foreign opengrok wrap is present; remove it before
  OpenBot can manage the host." · `census-refused` → "Host file layout not recognized: {reason}."
  · `syntax-check-failed` → "Wrapped host failed node --check: {stderr}." · `listen-failed` →
  "Port 9280 could not be bound." · `host-missing` → "host-main.cjs not found — is Grok Bot
  installed on this machine?"
- Secrets copy: always "Key saved" / "No API key" / "Replace key"; never "key deleted",
  never echoes, never in URLs/toasts/dialogs.
- Tunnel: persistent warning while live — *"Anyone with this URL can open this console. Keys
  stay on the Computer."*

---

## 9. Prototype guide

Static files in `docs/rebuild/prototype/` (no build step; open directly in a browser):
`index.html` (Dashboard) · `models.html` · `setup.html` · `logs.html`.
All pages share the §2 token block verbatim; a floating PROTO bar toggles theme, skeleton/empty
states, saving pill, toasts, and the blocked banner. Sample data is fictional but plausible
(providers "GLM Coding Plan", "DeepSeek", "OpenRouter-no-key"; 15 log rows). The prototype
demonstrates the working custom listbox (§3.3) on the Dashboard switcher and the Logs filter, plus
a working "Fetch models" demo (fake async → Import models dialog with checkbox selection,
select-all/none, live count, auto-fill badges, already-added rows → import) and a model-catalog
cache status + refresh demo (§3.17) on the Models page. Everything is inline SVG — no emoji, no
external assets except Google Fonts (graceful fallback offline).
