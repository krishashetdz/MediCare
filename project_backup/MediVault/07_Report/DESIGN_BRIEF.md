# MediVault — approved clinical-record design brief

Written before UI changes. Scope: the twelve working screens in the supplied application; the staff-dashboard redirect and 404 remain supporting pages. The original Express application and folder structure remain authoritative.

## Character and role emphasis

This is a shared clinical record, not a corporate dashboard. Doctors mid-shift need precise document sections; receptionists need patient-context appointment and billing actions; patients need calm booking and readable charges; pharmacists need aligned queues and unambiguous stock consequences. Navigation and typography are shared, but density follows the job.

## Six-color system

| Name | Value | Meaning |
|---|---|---|
| Record White | #F7F8F5 | Reading surfaces |
| Graphite | #252B2A | Text and ordinary actions |
| Pewter | #5D6965 | Supporting information |
| Evergreen | #315C45 | Available, completed, confirmed |
| Oxide | #9A3543 | Errors, destructive and urgent states |
| Caution Gold | #E7BA5C | Attention, always with Graphite text |

Neutral dark surfaces and contrast-adjusted light status text preserve the same semantics in dark mode. Labels accompany color. No new clinical severity classification is introduced.

## Typography and structure

IBM Plex Sans carries controls, queues, forms, clinical details and tabular numbers. Source Serif 4 appears only in titles and document headings. Sentence case, normal letter spacing. Quiet neutral navigation replaces the dark sidebar. Queues are ruled rows; clinical histories are documents; billing is a ledger; statistics are unframed metric groups; forms use field groups and separate action areas. Borders and spacing replace ubiquitous shadows and rounded cards.

## Signature: dispense reconciliation

Give the existing dispense preview a reconciliation-record structure: available patient/prescription context, medicine identity, current stock, required quantity, remaining stock and original validation. Preserve the existing server preview and trigger stock math, including duplicate-item aggregation. No new stock reservation, simplified calculation or clinical decision support. Keep its confirmation safeguard. Booking retains its real sequence and stays visually quieter.

## Will not use

- Tracked-out ALL-CAPS eyebrows or single-word-highlighted headlines.
- Decorative arrow suffixes on buttons.
- 01/02/03 decoration except genuine sequential steps.
- Repeated fade-and-slide-up entrances.
- Universal pill statuses or identical shadowed rounded cards.
- Teal/dark-slate identity, purple substitution, marketing slogans or ornamental charts.

## Self-review before implementation

Revised generic dashboard defaults into role-specific records, queues, ledgers and field groups. Changed all-purpose saturated primary buttons to Graphite so status colors retain meaning. Limited distinctive treatment to dispensing, rather than decorating twelve screens equally. Serif is restricted to orientation, not operational rows. These choices do not require any excluded generic tell.

## Verification gates

Check all twelve screens in light/dark, narrow/wide layouts, visible keyboard focus, real dialogs and print media. Preserve labels, ARIA, keyboard navigation, medicine autocomplete, all booking steps, RBAC and API contracts. Run the actual MySQL constraint failures and corrections. Verify receptionist procedure-generated bills in staff billing and the owning patient's bills. Document actual evidence and any unresolved limitation separately.