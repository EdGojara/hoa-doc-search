# MICR (E-13B) font for check printing

trustEd prints AP checks on **blank** security stock, so it renders the entire
check **including the MICR line** (routing + account + check number) at the
bottom. A bank can only process that line if it's set in a genuine **E-13B**
magnetic font. Without one, the MICR prints as ordinary numbers and the check
will be rejected / can't be scanned.

## What to drop here
Place one of these in this directory (the renderer auto-detects and embeds it as
a data-URI, so it works in the headless-Chrome renderer on the server):

- `micr.woff2`  (preferred), or
- `micr.ttf`

Options:
- **GnuMICR** — free (GPL) E-13B font.
- A **commercial E-13B** font (e.g. from a check-stock / MICR vendor) — worth it
  for support + a guaranteed-conformant glyph set.

## Character mapping — IMPORTANT
`lib/accounting/check_renderer.js` (`formatMicr`) emits the Unicode MICR symbols:

- **⑆ = U+2446** — Transit symbol (brackets the 9-digit routing number)
- **⑈ = U+2448** — On-Us symbol (brackets the account / aux check-number fields)
- digits `0-9` as normal

The bundled font MUST map those exact codepoints (and 0-9) to the correct E-13B
glyphs. GnuMICR and many free fonts instead map the symbols to ASCII letters
(A/B/C/D). If the chosen font uses a different mapping, adjust `formatMicr` to
emit the characters that font expects — otherwise the transit/on-us symbols
render wrong even though the digits look fine.

## Before going live (non-negotiable)
1. Bundle the font here + confirm `micrFontInstalled()` is true.
2. Confirm our MICR field order matches the proven Vantaca checks (which clear at
   NewFirst) — so the layout is one NewFirst already accepts.
3. Print one check and **deposit it live at NewFirst** (or have them scan a
   sample) to confirm the magnetic read passes — before any volume run.
