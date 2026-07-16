Dream Avenue (licensed display font — not on Google Fonts)

Drop the licensed font file here, named exactly:

  DreamAvenue.woff2

Every page already declares @font-face for it with font-display:swap, so the
moment the file exists the logo and display headings switch from the Cormorant
fallback to Dream Avenue automatically. Nothing else to change.

If your licence came as .otf/.ttf only, convert to woff2 first (smaller,
faster) — or ask Claude to wire the format you have.
