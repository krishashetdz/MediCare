# MediVault: completion and redesign proposal

## Scope and boundaries

MediVault remains one cohesive hospital-management project, preserving the supplied project's organization. The scope covers the remaining syllabus gaps, the missing bill-generation interaction, and a coordinated redesign of all 12 existing screens. It is not a replacement application or a collection of separate experiment projects.

Existing behavior remains authoritative: role-based access, existing service calls, booking steps, dispense stock calculations, medicine autocomplete, patient and staff workflows, print layouts, dark mode, and accessibility must be preserved. The specific 12 screens are those present in the supplied project; no additional screens or invented replacement workflows are proposed.

Approval covers the whole scope below, without further confirmation between sections unless an essential conflict with existing behavior is discovered.

## Syllabus and functional completion

- **Report:** Make Experiment 1–10 the top-level numbered sections. Place the ER diagram, schema, and normalization in unnumbered front matter. Give stored procedures a clearly marked Bonus section. Preserve substantive existing content and align its references with the new organization rather than merely changing headings.
- **MongoDB material:** Distinguish command groups using the exact headings “Core operations (syllabus ask)” and “Extended operations (added depth).” Classification must follow the existing syllabus, not an invented interpretation of which operations count.
- **Receptionist billing:** Add a real “Generate Bill” action to the appropriate appointment interaction, invoking `sp_generate_bill`. A successfully generated bill must be visible in both `billing.html` and that patient's bills view. Preserve existing eligibility, pricing, permissions, and procedure behavior. Make pending, successful, and failed outcomes clear; do not introduce a second pricing calculation in the interface.
- **Constraint demonstration:** Retain Experiment 3's duplicate-primary-key, invalid-foreign-key, and CHECK-violation examples, each paired with its corrected case. Any changes must preserve the instructional purpose: the invalid case is rejected and its corrected counterpart succeeds.

## Design brief

### Character: a shared clinical record, not a corporate dashboard

MediVault brings distinct jobs into one system. A doctor mid-shift needs precise, readable clinical information. A receptionist needs appointment and billing actions that are easy to locate without confusing patient context. A patient needs reassuring, plain-language booking and clear charges. A pharmacist needs an unambiguous dispense queue and confidence in the stock consequence of a decision.

The visual character is therefore a **contemporary clinical record**: carefully aligned information, recognizable document structure, restrained status color, and legible operational controls. Shared typography and navigation unify the system; information density and emphasis vary by role. Patient screens have more breathing room, while staff queues prioritize scanning and comparison.

### Color system

Six named colors establish the base system:

| Name | Hex | Purpose |
| --- | --- | --- |
| Record White | `#F7F8F5` | Clean reading surfaces without a stark luminous-white field. |
| Graphite | `#252B2A` | Main text and ordinary primary actions; avoids a dark-slate dashboard identity. |
| Pewter | `#5D6965` | Secondary text and supporting information, subject to contrast requirements. |
| Evergreen | `#315C45` | Completed, available, or confirmed states where those meanings apply. |
| Oxide | `#9A3543` | Errors, destructive actions, and genuinely urgent conditions—not general decoration. |
| Caution Gold | `#E7BA5C` | Warnings that require attention, with Graphite text rather than white text. |

The palette follows the work: mostly neutral records, with green, red, and gold carrying clear operational meaning. Color is always accompanied by a label or familiar icon. It must not introduce a clinical severity classification that does not already exist.

Dark mode uses dark neutral reading surfaces and light text, with contrast-adjusted status treatments derived from the same palette. Dark foreground colors are not reused indiscriminately on dark backgrounds. WCAG AA contrast is a requirement in both modes, including selected, focused, disabled, and error states where applicable.

### Type pairing

- **IBM Plex Sans:** Navigation, controls, forms, queues, clinical details, and numbers. Tabular numerals align quantities, charges, and other comparable values.
- **Source Serif 4:** Restrained use in page titles, patient-facing orientation, and bill/document headings. It gives the record a recognizable editorial identity without slowing operational reading.

Sentence case and normal letter spacing are the default. Serif typography stays out of dense data rows and critical action labels. Large promotional headlines are not part of this application.

### Layout and components

- **Navigation:** Quiet, consistent, role-aware navigation on a neutral surface rather than a dominant dark-slate sidebar. Preserve the current destinations and access restrictions.
- **Queues:** Aligned rows, clear column hierarchy, separators, and explicit text statuses. Dense information is not broken into a grid of identical cards.
- **Clinical records:** Document-like sections with meaningful headings and carefully grouped facts.
- **Forms:** Labeled fields, related field groups, inline validation, and clearly separated action areas. Preserve the actual booking sequence and existing editable fields.
- **Statistics:** Compact, unframed metric groups with aligned values, not floating shadowed tiles.
- **Billing:** A ledger structure with readable line items, totals, and a clear print action. Printed bills remain documents, not screenshots of the interface.
- **Containers:** Use borders and spacing before shadows. Small corner radii are reserved for controls and genuinely bounded items; large rounded cards are not the universal building block.
- **Responsive behavior:** Dense staff content adapts without hiding essential patient, medicine, quantity, amount, or action information. Navigation, forms, and dialogs remain usable on narrow screens.
- **Interaction:** Visible keyboard focus, meaningful labels, accessible names, appropriate ARIA, and keyboard navigation remain integral. Motion is limited to useful state feedback and respects reduced-motion preferences.

## Signature interaction: dispense confirmation

The pharmacist's dispense confirmation receives the strongest individual design treatment because it combines a consequential action with concrete stock mathematics.

Present it as a concise reconciliation record: patient or appointment context already available, medicine identity, the existing preview's stock figures and quantity calculations, any current validation messages, and one unambiguous confirmation action. Align quantities and units so the stock consequence can be checked at a glance.

The existing calculation remains the sole source of truth. Do not replace it with simplified subtraction, introduce stock reservations, invent clinical decision support, or remove existing confirmation safeguards. The design emphasizes the real preview rather than adding celebratory animation or decorative charts.

The booking wizard keeps its actual steps and receives calm, clearly labeled progress and form refinement, but it does not compete with dispensing for decorative emphasis.

## Generic tells explicitly excluded

- Tracked-out ALL-CAPS eyebrow labels.
- Headlines with a single word highlighted for visual effect.
- Decorative “→” arrows appended to buttons.
- Numbered 01/02/03 markers unless they describe a genuine sequence.
- Repeated fade-and-slide-up entrance animations on cards.
- Pill badges as the default treatment for every status.
- Identical rounded, softly shadowed cards for queues, forms, metrics, and records.
- Teal-plus-dark-slate branding, or a simple swap to purple while retaining the same dashboard template.
- Marketing slogans, decorative charts, and ornamental visuals that compete with patient or operational information.

## Design self-review

A generic “professional healthcare dashboard” would still be too interchangeable. This proposal replaces that default with role-specific reading structures: document sections for clinical work, ledger rows for billing, tightly aligned queues for dispensing, and a calmer existing booking flow for patients.

A saturated brand-colored primary button everywhere would also blur ordinary actions and clinical statuses. The revised choice is Graphite for ordinary primary actions, reserving Evergreen, Oxide, and Caution Gold for meaningful states.

An equally decorated set of 12 screens would dilute the design. The revised emphasis is one stock-reconciliation signature moment, with disciplined supporting screens. The serif face is limited to orientation and document identity rather than becoming a decorative treatment on every component.

These choices have been checked against the exclusion list above. None requires ornamental eyebrows, highlighted headline words, appended arrows, fake sequence markers, or repeated entrance effects.

## Completion expectations

All 12 screens must reflect the same design language without erasing their different purposes. The final handoff must account for each screen, identify any generic choices corrected during the self-critique, and disclose any unresolved limitations. Existing mobile usability, focus visibility, keyboard access, and print-specific presentation must not regress.

This proposal does not claim that the supplied project has already been inspected or that any existing behavior has already been verified.

## Assumptions and decisions worth challenging

- The attached archive is the authoritative current version of MediVault.
- The existing syllabus determines the experiment mapping and MongoDB core-versus-extended classification.
- The existing 12-screen scope and business rules remain unchanged; missing details are not grounds for inventing new workflows.
- The preferred identity is a neutral clinical record with purposeful green/red/gold statuses, not a colorful branded dashboard.
- IBM Plex Sans with restrained Source Serif 4 is the proposed type pairing.
- Dispense confirmation, rather than booking or admin statistics, is the signature interaction.
- No new external service, AI feature, payment provider, or authentication replacement is proposed.