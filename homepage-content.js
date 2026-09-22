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
import {
  getFirestore, doc, getDoc, collection, getDocs, query, orderBy, limit
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';

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

// One app instance for both jobs below — initializeApp throws if the same
// name is registered twice.
const app = initializeApp(firebaseConfig, 'homepage-content');
const db = getFirestore(app);

async function applyHomepageContent() {
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

/* ── Latest newsletter ─────────────────────────────────────────────────
   Shows the most recently published issue (publishedNewsletters, the
   public copy the Newsletter app writes on "Publish to website") as a
   section directly under the hero, linking to /newsletters for the full
   issue and PDF.

   Not a siteContent section on purpose: it is driven by publishing, not by
   editing the homepage, so publishing an issue is the only step needed and
   "Remove from website" takes it off the homepage too.

   It runs AFTER applyHomepageContent, which removes everything below the
   hero before inserting the saved sections — inserted any earlier, this
   would be wiped. With nothing published, nothing is added. */
const NL_STYLE_ID = 'hp-newsletter-style';
function ensureNewsletterStyles() {
  if (document.getElementById(NL_STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = NL_STYLE_ID;
  st.textContent =
    '.hp-nl{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:0;overflow:hidden;padding:0;}' +
    '.hp-nl-cover{display:block;min-height:280px;background:linear-gradient(135deg,var(--maroon),#4e1a09);' +
      'background-size:cover;background-position:center;}' +
    '.hp-nl-body{padding:34px 36px;display:flex;flex-direction:column;justify-content:center;gap:10px;text-align:left;}' +
    '.hp-nl-date{font-size:0.82rem;font-weight:700;color:var(--saffron-dark);}' +
    ".hp-nl-body h3{margin:0;font-family:Georgia,'Times New Roman',serif;color:var(--maroon);" +
      'font-size:clamp(1.4rem,2.4vw,1.9rem);line-height:1.2;}' +
    '.hp-nl-body .section-copy{margin:0;text-align:left;}' +
    '.hp-nl-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;}' +
    '@media (max-width:760px){.hp-nl{grid-template-columns:1fr;}.hp-nl-cover{min-height:190px;}' +
      '.hp-nl-body{padding:24px 22px;}}';
  document.head.appendChild(st);
}

function nlDate(v) {
  if (!v) return '';
  const d = v.toDate ? v.toDate() : new Date(v);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

async function showLatestNewsletter() {
  const snap = await getDocs(query(collection(db, 'publishedNewsletters'),
    orderBy('publishedAt', 'desc'), limit(1)));
  if (snap.empty) { console.log('[homepage] no published newsletter — section not shown'); return; }

  const d = snap.docs[0];
  const n = d.data();
  const url = '/newsletters?id=' + encodeURIComponent(d.id);
  const title = n.headline || n.title || 'Newsletter';
  const cover = n.coverImage || '';

  // Views, from the counters the /newsletters page keeps. Optional — the
  // card renders without them if the read fails.
  let views = 0;
  try {
    const st = await getDoc(doc(db, 'newsletterStats', d.id));
    if (st.exists()) views = Math.max(0, Number(st.data().views) || 0);
  } catch (e) { /* ignore */ }
  const viewsText = views > 0 ? '\u{1F441} ' + views.toLocaleString('en-US') + ' view' + (views === 1 ? '' : 's') : '';
  const dateText = [nlDate(n.publishedAt), viewsText].filter(Boolean).join(' \u00b7 ');

  const main = document.getElementById('home');
  if (!main) return;
  ensureNewsletterStyles();

  const html =
    '<section class="section" id="latest-newsletter"><div class="container">' +
      '<div class="section-head content-width"><span class="section-kicker">Newsletter</span></div>' +
      '<div class="card hp-nl">' +
        '<a class="hp-nl-cover" href="' + url + '" aria-label="Read ' + esc(title) + '"' +
          (cover ? ' style="background-image:url(&quot;' + esc(cover) + '&quot;);"' : '') + '></a>' +
        '<div class="hp-nl-body">' +
          (dateText ? '<div class="hp-nl-date">' + esc(dateText) + '</div>' : '') +
          '<h3>' + esc(title) + '</h3>' +
          (n.summary ? '<p class="section-copy">' + esc(n.summary) + '</p>' : '') +
          '<div class="hp-nl-actions">' +
            '<a href="' + url + '" class="btn btn-primary">Read this issue</a>' +
            '<a href="/newsletters" class="btn btn-outline">All issues</a>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div></section>';

  const existing = document.getElementById('latest-newsletter');
  if (existing) existing.remove();
  const hero = main.querySelector('.hero-banner');
  if (hero) hero.insertAdjacentHTML('afterend', html);
  else main.insertAdjacentHTML('afterbegin', html);
  console.log('[homepage] latest newsletter shown:', d.id);
}

/* ── Live now banner ─────────────────────────────────────────────────
   While Website Management → Live Stream has "We're live now" on, a red
   bar above the hero links to /live. Nothing is added otherwise. */
async function showLiveBanner() {
  const snap = await getDoc(doc(db, 'siteContent', 'liveStream'));
  if (!snap.exists()) return;
  const d = snap.data();
  const hasSource = d.platform === 'facebook' ? !!d.facebookVideoUrl : !!(d.youtubeVideoId || d.youtubeChannelId);
  if (!d.isLive || !hasSource) return;
  const main = document.getElementById('home');
  if (!main || document.getElementById('hp-live-banner')) return;
  if (!document.getElementById('hp-live-style')) {
    const st = document.createElement('style');
    st.id = 'hp-live-style';
    st.textContent =
      '#hp-live-banner{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;padding:12px 18px;' +
        'background:#c0392b;color:#fff;font-weight:700;text-decoration:none;font-size:0.95rem;text-align:center;}' +
      '#hp-live-banner:hover{background:#a93226;}' +
      '#hp-live-banner .dot{width:10px;height:10px;border-radius:50%;background:#fff;animation:hpLivePulse 1.4s ease-in-out infinite;}' +
      '#hp-live-banner .go{padding:5px 12px;border-radius:999px;background:#fff;color:#c0392b;font-size:0.85rem;}' +
      '@keyframes hpLivePulse{0%,100%{opacity:1}50%{opacity:.25}}';
    document.head.appendChild(st);
  }
  main.insertAdjacentHTML('afterbegin',
    '<a id="hp-live-banner" href="/live"><span class="dot"></span><span>LIVE NOW' +
    (d.title ? ' \u2014 ' + esc(d.title) : '') + '</span><span class="go">Watch</span></a>');
}

(async () => {
  try {
    await applyHomepageContent();
  } catch (err) {
    // Any failure leaves the original markup untouched.
    console.error('Homepage content not applied:', err);
  }
  try {
    await showLatestNewsletter();
  } catch (err) {
    // A newsletter that can't be read just isn't shown.
    console.error('Latest newsletter not shown:', err);
  }
  // Last, because applyHomepageContent clears everything but the hero.
  try { await showLiveBanner(); }
  catch (err) { console.error('Live banner not shown:', err); }
})();
