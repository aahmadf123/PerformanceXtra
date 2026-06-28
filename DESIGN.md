---
name: PerformanceXtra
description: Dark-first mental performance workspace for athletes, coaches, and admins.
colors:
  primary: "#c9f24e"
  primary-strong: "#d6ff5c"
  primary-ink: "#14180a"
  secondary: "#ff6a3d"
  secondary-strong: "#ff7d54"
  secondary-ink: "#1d0c05"
  bg: "#0b0d12"
  bg-2: "#0e1118"
  surface: "#14171f"
  surface-2: "#191d27"
  surface-3: "#1f2430"
  text: "#f1f4f8"
  text-soft: "#aeb6c6"
  muted: "#6f7889"
  line: "#ffffff14"
  line-strong: "#ffffff26"
  danger: "#ff5d6c"
  warn: "#f5c451"
typography:
  display:
    fontFamily: "Bricolage Grotesque, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "clamp(1.7rem, 3.4vw, 2.4rem)"
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  body:
    fontFamily: "Hanken Grotesk, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Hanken Grotesk, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "0.76rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.01em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "0.72rem"
    fontWeight: 600
    lineHeight: 1.2
rounded:
  sm: "10px"
  md: "14px"
  lg: "20px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "10px"
  md: "16px"
  lg: "22px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  button-accent:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-ink}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  input-default:
    backgroundColor: "{colors.bg-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "22px"
  chip-topic:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.primary-strong}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  segmented-control-active:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-ink}"
    rounded: "7px"
    padding: "8px 6px"
---

# Design System: PerformanceXtra

## Overview

**Creative North Star: "Performance Lab"**

PerformanceXtra is a dark-first operational workspace that blends athlete energy with coaching discipline. The visual system uses high-contrast ink surfaces, a sharp electric-lime primary signal, and a warm ember secondary signal to make active states, progress, and creation tasks feel immediate without turning the app into a noisy sports dashboard.

The tone is encouraging, energetic, and calm. That combination matters: the system should feel like a serious training tool, but not a punitive one. Dense admin and coach flows are allowed, yet the interface still needs enough quiet structure that athletes can check in, complete work, and message their coach without friction.

This system explicitly rejects generic AI-looking SaaS dashboards, over-gamified productivity apps, sterile clinical wellness interfaces, and aggressive sports branding that confuses noise for confidence.

**Key Characteristics:**
- Dark-first, with a light mode available as a utility rather than the primary identity.
- Two-signal color system: lime for progress, active state, and primary action; ember for creation, assignment, and unread attention.
- Rounded but not soft shapes, with 10px to 20px corners and pill forms reserved for compact controls and status tags.
- Lifted surfaces with restrained motion, used to separate workflow layers and reward interaction.
- Display type reserved for headings, with cleaner body typography carrying dense product workflows.

## Colors

The palette is a disciplined high-contrast athletic set: one active green-yellow signal, one warm action orange, and a stack of inked neutrals that keep the interface focused.

### Primary
- **Electric Lime** (#c9f24e): The core action and progress color. Use it for primary buttons, active tabs, selected segmented controls, completion bars, and focus-adjacent highlights where the interface needs to say “this is the current path.”
- **Charged Lime** (#d6ff5c): The brighter companion tone for hover states, emphasized links, and brighter progression fills.
- **Lime Ink** (#14180a): The dark text color that sits on lime surfaces. It keeps primary actions readable without slipping into pure black.

### Secondary
- **Warm Ember** (#ff6a3d): The create and assign signal. Use it for add, generate, assign, unread emphasis, and moments where the workflow pivots from browsing to action.
- **Hot Ember** (#ff7d54): The hover or stronger-emphasis variant for ember actions.
- **Ember Ink** (#1d0c05): The dark text color for ember-backed controls.

### Neutral
- **Night Base** (#0b0d12): The global background and the anchor for the dark theme.
- **Deep Utility** (#0e1118): Input beds, secondary bands, and recessed areas.
- **Panel Ink** (#14171f): The default panel and card surface.
- **Raised Panel** (#191d27): Hover, nested, and secondary container surfaces.
- **Structural Surface** (#1f2430): The strongest neutral layer in the stack.
- **Cold Text** (#f1f4f8): Primary reading text.
- **Support Text** (#aeb6c6): Secondary explanation, metadata, and supporting labels.
- **Muted Signal** (#6f7889): Quiet labels, tags, and low-priority affordances.
- **Hairline** (#ffffff14): Low-contrast borders and separators.
- **Strong Hairline** (#ffffff26): Higher-priority borders and control outlines.

### Named Rules
**The Two-Signal Rule.** Lime is for progress, current state, and the main path forward. Ember is for creation, assignment, and attention. Do not swap them casually, and do not add a third accent just for decoration.

**The Dark-First Rule.** The dark theme is the identity surface. Light mode is supported, but it should preserve the same role relationships instead of inventing a different personality.

## Typography

**Display Font:** Bricolage Grotesque (with Hanken Grotesk and system sans fallbacks)
**Body Font:** Hanken Grotesk (with system sans fallbacks)
**Label/Mono Font:** JetBrains Mono for data tags and compact metadata

**Character:** The type system mixes one athletic display face with a cleaner operational sans. Headings feel assertive and branded, while the bulk of the UI stays legible under dense product use. Mono is a supporting accent, not a dominant voice.

### Hierarchy
- **Display** (800, `clamp(1.7rem, 3.4vw, 2.4rem)`, 1.02): Section titles and major screen headings.
- **Headline** (800, `1.28rem`, 1.12): Brand line, feature heads, and compact headline moments that still need a strong voice.
- **Title** (700, `1.12rem`, 1.2): Panel heads, roster detail titles, and sub-section framing.
- **Body** (400, `1rem`, 1.55): General app copy, instructions, settings text, and athlete-facing explanations. Keep longer prose within roughly 65 to 75 characters when possible.
- **Label** (700, `0.76rem`, `0.01em`): Field labels, utility heads, compact UI guidance, and form scaffolding.
- **Mono Label** (600, `0.72rem`, `0.08em`, uppercase): Technical tags, pills, hidden/custom markers, and condensed metadata.

### Named Rules
**The Display Reserve Rule.** Bricolage Grotesque belongs in headings and branded moments only. Do not use it for buttons, inputs, tabs, or dense data.

**The Supportive Body Rule.** Athlete-facing copy should stay plainspoken and calm. The typography can feel energetic without turning instructional text into hype.

## Elevation

This system is lifted rather than flat. Depth comes from stacked ink surfaces, thin translucent borders, and a compact shadow vocabulary that makes panels and interactive objects feel tangible. Hover states rise slightly, active indicators glow subtly, and modal surfaces carry the heaviest depth. Motion supports this layered model without becoming ornamental.

### Shadow Vocabulary
- **Resting Surface** (`0 1px 0 rgba(255,255,255,.03) inset, 0 2px 10px rgba(0,0,0,.45)`): Default panel, card, assignment, and secondary container shadow.
- **Hover Lift** (`0 1px 0 rgba(255,255,255,.04) inset, 0 22px 55px -16px rgba(0,0,0,.75)`): Hovered cards, modals, and elevated utility surfaces.
- **Signal Glow** (`0 0 0 1px rgba(201,242,78,.35), 0 14px 40px -10px rgba(201,242,78,.18)`): Rare accent halo for active or high-value interactive states.

### Named Rules
**The Lift-On-Interaction Rule.** Heavy lift belongs on interaction, not on every resting element. Surfaces can feel substantial, but the stronger shadow vocabulary should appear when focus, hover, or modal state justifies it.

## Components

Components should feel tactile and confident. They are rounded, dense, and readable, with strong role separation and clear state transitions.

### Buttons
- **Shape:** Compact rounded rectangles with a 10px radius. Icon-only utility buttons may use a pill or circular treatment.
- **Primary:** Lime background with lime-ink text, 10px by 16px padding, medium-to-bold weight, and a subtle glow on hover.
- **Hover / Focus:** Hover brightens the active color and slightly increases lift. Focus uses a clear 2px outline or a 3px tinted ring, depending on the control family.
- **Secondary / Ghost / Tertiary:** Ember buttons carry create-and-assign actions. Ghost buttons stay transparent and inherit the signal color rather than creating another filled style.

### Chips
- **Style:** Compact pill forms. Topic and accent chips use tinted signal backgrounds, sub and meta chips sit on neutral surfaces with muted text or borders.
- **State:** Selected or important chips should shift color meaningfully, not just by 2% lightness. Pills are for status, taxonomy, and condensed metadata, not for major navigation.

### Cards / Containers
- **Corner Style:** 14px default corners, with 20px reserved for modal or large-overlay surfaces.
- **Background:** Most containers use `surface` or `surface-2`, with `bg-2` reserved for recessed regions and field beds.
- **Shadow Strategy:** Resting surfaces use the compact inset-plus-drop shadow; hoverable cards can step up to the hover lift.
- **Border:** Thin translucent borders define shape before shadow does.
- **Internal Padding:** 16px to 22px is the normal comfort zone for app panels and cards.

### Inputs / Fields
- **Style:** Dark utility background, strong hairline border, 10px radius, and enough padding to feel usable on touch and desktop.
- **Focus:** Border shifts to lime and picks up a 3px tinted ring. Focus should be obvious even in dense admin forms.
- **Error / Disabled:** Warning and danger states should stay functional, with no decorative treatment. Disabled controls should dim and lose motion.

### Navigation
- **Style:** Header tabs use understated text by default, then shift to lime when active. The active state is anchored by a 2px underbar that expands with a cubic-bezier motion curve.
- **Segmented controls:** Segmented groups sit on recessed utility surfaces; the active option fills with lime and gains a small lift.
- **Mobile treatment:** Navigation condenses structurally rather than stylistically. Hidden filters become explicit toggles, but the same color logic should remain intact.

### Signature Component
- **Progress bars:** Progress bars are one of the product’s signature motifs. They use lime fills, glow sparingly, and animate width with fast ease-out timing to reinforce momentum without turning progress into spectacle.

## Do's and Don'ts

### Do:
- **Do** keep lime tied to primary action, current selection, completion, and focus-adjacent success states.
- **Do** use ember for assign, generate, unread, and other creation-oriented actions.
- **Do** keep the app dark-first, with layered surfaces at `#0b0d12`, `#14171f`, and `#191d27` doing most of the structural work.
- **Do** reserve Bricolage Grotesque for headings and use Hanken Grotesk for the working UI.
- **Do** make focus states unmistakable with a visible outline or tinted ring, especially in coach and admin workflows.
- **Do** keep motion short and purposeful, typically around 150 to 250 milliseconds, with ease-out curves that reinforce state change.

### Don't:
- **Don't** drift into generic AI-looking SaaS dashboards with interchangeable card grids, decorative gradients, or empty “modern” polish.
- **Don't** turn the product into an over-gamified productivity app built on pressure, streak obsession, or leaderboard energy.
- **Don't** make athlete wellbeing flows look like a sterile clinical wellness interface.
- **Don't** lean on aggressive sports branding that feels macho, chaotic, or visually noisy at the expense of clarity.
- **Don't** add colored side-stripe borders to callouts, cards, or alerts. Use full-border tint, background tint, icon-led emphasis, or nothing.
- **Don't** introduce a third accent color, gradient text, or decorative glass effects just to make a screen feel newer.