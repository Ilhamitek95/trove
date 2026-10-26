// Prints ~/Downloads/Trove Phase 1 posts/Review.html to "Trove Phase 1 posts (draft).pdf" in the same folder, A4 portrait,
// one post per page, captions open. Run after export.py: PW_CORE=<repo>/e2e/node_modules/playwright-core node review-pdf.js
const path = require('path');
const os = require('os');
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const DIR = path.join(os.homedir(), 'Downloads', 'Trove Phase 1 posts');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage();
  await page.goto('file:///' + path.join(DIR, 'Review.html').split(path.sep).join('/'), { waitUntil: 'load' });
  await page.evaluate(async () => {
    document.querySelectorAll('details').forEach((d) => { d.open = true; });
    document.querySelectorAll('img').forEach((i) => { i.loading = 'eager'; });
    await Promise.all([...document.images].map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))));
  });
  const out = path.join(DIR, 'Trove Phase 1 posts (draft).pdf');
  await page.pdf({ path: out, preferCSSPageSize: true, printBackground: true });
  await browser.close();
  console.log((require('fs').statSync(out).size / 1e6).toFixed(1) + ' MB →', out);
})();
