/**
 * Home page content renderer.
 *
 * Deliberately additive: index.html keeps ALL of its existing markup, and
 * this script replaces the section content only when a homepage document
 * exists in Firestore. If the document is missing, the fetch fails, or
 * anything throws, the page is left exactly as it shipped — so deploying
 * this before any content is saved changes nothing visible.
 *
 * That fallback is the whole point. The home page is the most visible
 * thing HCCGC has; it should degrade to "what it looks like today"
 * rather than to a blank page.
 *
 * Include AFTER the existing markup, near the end of <body>:
 *   <script type="module" src="/homepage-content.js"></script>
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyA6IzLjWTg7Rq04HsTH-iA3eDmSzKI7xME',
  authDomain: 'hccgc-a7a54.firebaseapp.com',
  projectId: 'hccgc-a7a54',
  storageBucket: 'hccgc-a7a54.firebasestorage.app',
  messagingSenderId: '75757201418',
  appId: '1:75757201418:web:c31e9361921242145717f3'
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── Section renderers ─────────────────────────────────────────────────
   Each returns the full <section> markup, reusing the classes already in
   index.html so styling is inherited rather than duplicated. */

function sectionHead(s) {
  return '<div class="section-head content-width">' +
    (s.kicker ? '<span class="section-kicker">' + esc(s.kicker) + '</span>' : '') +
    (s.heading ? '<h2 style="margin:8px 0 10px;line-height:1.2;color:var(--maroon);' +
      "font-family:Georgia,'Times New Roman',serif;font-size:clamp(2rem,3.4vw,3rem);\">" +
      esc(s.heading) + '</h2>' : '') +
    (s.intro ? '<p class="section-copy">' + esc(s.intro) + '</p>' : '') +
  '</div>';
}

function renderCards(s) {
  const grid = s.cardStyle === 'value' ? 'three-values' : 'contact-grid';
  const card = s.cardStyle === 'value' ? 'value-card' : 'contact-card';
  const cards = (s.cards || []).map(c =>
    '<div class="card ' + card + '">' +
      (c.title ? '<h3>' + esc(c.title) + '</h3>' : '') +
      '<p class="section-copy">' + esc(c.body) + '</p>' +
      (c.buttonLabel && c.buttonUrl
        ? '<div style="display:flex;justify-content:center;margin-top:16px;">' +
          '<a href="' + esc(c.buttonUrl) + '" class="btn btn-primary">' + esc(c.buttonLabel) + '</a></div>'
        : '') +
    '</div>').join('');

  const b = s.banner;
  const banner = (b && b.enabled)
    ? '<div class="card" style="margin-top:18px;padding:30px 24px;text-align:center;' +
      'background:linear-gradient(135deg, var(--saffron), var(--maroon));">' +
      "<h3 style=\"color:#fff;font-family:Georgia,'Times New Roman',serif;font-size:clamp(1.25rem,2.4vw,1.7rem);margin:0 0 10px;\">" +
      esc(b.heading) + '</h3>' +
      '<p class="section-copy" style="color:rgba(255,255,255,0.92);text-align:center;max-width:600px;margin:0 auto 18px;">' +
      esc(b.body) + '</p>' +
      (b.buttonUrl ? '<a href="' + esc(b.buttonUrl) + '" class="btn btn-outline">' + esc(b.buttonLabel) + '</a>' : '') +
    '</div>' : '';

  return '<section class="section" id="' + esc(s.anchor || s.id) + '"><div class="container">' +
    sectionHead(s) + '<div class="' + grid + '">' + cards + '</div>' + banner +
  '</div></section>';
}

function renderImageGrid(s) {
  const items = (s.items || []).map(i =>
    '<div style="border-radius:16px;overflow:hidden;border:1px solid var(--border);' +
    'box-shadow:0 8px 24px rgba(93,43,14,0.08);background:#fff;">' +
      '<img src="' + esc(i.image) + '" alt="' + esc(i.title) + '" ' +
      'style="width:100%;height:140px;object-fit:cover;display:block;">' +
      '<div style="padding:14px 16px;">' +
        '<strong style="color:var(--maroon);font-family:Georgia,serif;">' + esc(i.title) + '</strong>' +
        (i.subtitle ? '<span style="display:block;font-size:0.8rem;color:var(--saffron-dark);' +
          'font-weight:700;margin-top:3px;">' + esc(i.subtitle) + '</span>' : '') +
      '</div>' +
    '</div>').join('');
  const buttons = (s.buttons || []).map(b =>
    '<a href="' + esc(b.url) + '" class="btn btn-' + esc(b.style || 'primary') + '">' + esc(b.label) + '</a>').join('');
  const cols = Math.min(Math.max((s.items || []).length, 1), 4);
  return '<section class="section" id="' + esc(s.anchor || s.id) + '"><div class="container">' +
    sectionHead(s) +
    '<div style="display:grid;grid-template-columns:repeat(' + cols + ',1fr);gap:16px;margin-bottom:32px;">' + items + '</div>' +
    (buttons ? '<div style="display:flex;justify-content:center;gap:14px;flex-wrap:wrap;">' + buttons + '</div>' : '') +
  '</div></section>';
}

function renderTwoColumn(s) {
  const cols = (s.columns || []).map(c =>
    '<div class="card contact-card">' +
      (c.title ? '<h3>' + esc(c.title) + '</h3>' : '') +
      '<p class="section-copy">' + esc(c.body) + '</p>' +
      (c.buttonLabel && c.buttonUrl
        ? '<div style="display:flex;justify-content:center;margin-top:12px;">' +
          '<a href="' + esc(c.buttonUrl) + '" class="btn btn-primary">' + esc(c.buttonLabel) + '</a></div>'
        : '') +
    '</div>').join('');
  return '<section class="section" id="' + esc(s.anchor || s.id) + '"><div class="container">' +
    sectionHead(s) + '<div class="contact-grid">' + cols + '</div>' +
  '</div></section>';
}

function renderRichText(s) {
  return '<section class="section" id="' + esc(s.anchor || s.id) + '"><div class="container">' +
    sectionHead(s) +
    (s.html ? '<div class="section-copy">' + s.html + '</div>' : '') +
  '</div></section>';
}

const RENDERERS = {
  cards: renderCards,
  imageGrid: renderImageGrid,
  twoColumn: renderTwoColumn,
  richText: renderRichText
};

async function applyHomepageContent() {
  const app = initializeApp(firebaseConfig, 'homepage-content');
  const db = getFirestore(app);
  // Verbose on purpose: every early return below leaves the page looking
  // untouched, which is indistinguishable from "the script never ran".
  // Say which branch was taken so a silent no-op can be diagnosed.
  console.log('[homepage] reading siteContent/homepage…');
  const snap = await getDoc(doc(db, 'siteContent', 'homepage'));
  if (!snap.exists()) { console.warn('[homepage] no document — leaving page as-is'); return; }
  const data = snap.data();
  console.log('[homepage] document found. sections:', (data && data.sections) ? data.sections.length : 0,
              'types:', (data && data.sections) ? data.sections.map(s => s && s.type) : []);
  if (!data || !Array.isArray(data.sections) || !data.sections.length) {
    console.warn('[homepage] document has no sections array — leaving page as-is');
    return;
  }

  const main = document.getElementById('home');
  if (!main) { console.warn('[homepage] <main id="home"> not found'); return; }

  // The hero carousel keeps its own markup and script; only its image list
  // is driven from content, via a global the existing initHeroCarousel()
  // picks up. Re-implementing the carousel here would risk breaking
  // behaviour that already works.
  if (data.hero && Array.isArray(data.hero.slides) && data.hero.slides.length) {
    window.__hccgcHeroSlides = data.hero.slides;
    if (typeof window.__hccgcRefreshHero === 'function') window.__hccgcRefreshHero();
  }

  const html = data.sections
    .filter(s => {
      if (!s) return false;
      if (s.enabled === false) { console.log('[homepage] skipping hidden section:', s.id); return false; }
      if (!RENDERERS[s.type]) { console.warn('[homepage] unknown section type:', s.type, 'on', s.id); return false; }
      return true;
    })
    .map(s => {
      try { return RENDERERS[s.type](s); }
      catch (e) { console.error('Section failed to render:', s.id, e); return ''; }
    })
    .join('');
  if (!html.trim()) {
    console.warn('[homepage] every section rendered empty — leaving page as-is. ' +
      'Section types must be one of: ' + Object.keys(RENDERERS).join(', '));
    return;
  }
  console.log('[homepage] applying', data.sections.length, 'section(s)');

  // Replace everything after the hero banner, leaving the carousel intact.
  const hero = main.querySelector('.hero-banner');
  Array.from(main.children).forEach(el => { if (el !== hero) el.remove(); });
  main.insertAdjacentHTML('beforeend', html);
}

applyHomepageContent().catch(err => {
  // Any failure leaves the original markup untouched.
  console.error('Homepage content not applied:', err);
});
