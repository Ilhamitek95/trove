# Brand fonts

The display face for all headings is **Cormorant** (upright weights 400/500/600
only — the site uses no italics; emphasis is an Orange accent instead) and the
body face is **Quicksand**.

The storefront (`docs/trove.html`) serves both from this folder (F359, 12 Oct
2026), so no outside stylesheet stands between a visitor and the first paint:

- `cormorant-latin.woff2`, `cormorant-latin-ext.woff2`
- `quicksand-latin.woff2`, `quicksand-latin-ext.woff2`

These are the exact files Google Fonts serves (variable fonts: one file covers
every weight), declared with `@font-face` at the top of the storefront's
`<style>` and preloaded. Both families are published under the SIL Open Font
License 1.1 (https://openfontlicense.org), which allows self-hosting. Arabic
glyphs still come from `docs/rtl.css` (IBM Plex Sans Arabic / Noto Naskh
Arabic, added into the same family names by unicode-range). The other pages
still load the same fonts from Google Fonts.

If the brand's original display face (Dream Avenue) is ever purchased, drop
`DreamAvenue.woff2` + `DreamAvenue.woff` here and ask for the @font-face wiring.
