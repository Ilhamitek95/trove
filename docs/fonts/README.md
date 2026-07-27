# Dream Avenue webfont — drop the files here

The whole site is already wired for the official display face. When the
licensed files arrive, drop them into this folder with EXACTLY these names:

- `DreamAvenue.woff2`  (preferred — smaller, every modern browser)
- `DreamAvenue.woff`   (fallback for older browsers)

Nothing else to do — every page declares:

    @font-face{font-family:'Dream Avenue';
      src:url('/fonts/DreamAvenue.woff2') format('woff2'),
          url('/fonts/DreamAvenue.woff') format('woff');
      font-weight:400;font-style:normal;font-display:swap}

Until the files exist the site falls back to Georgia (a quiet serif), so
nothing looks broken. If the purchase only includes .otf/.ttf, convert to
woff2/woff first (any font-converter can; keep the licence receipt).

Dream Avenue has a single weight and NO italic — the CSS never asks for
either, so don't add synthetic bold/italic files.
