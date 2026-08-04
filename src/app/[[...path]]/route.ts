import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { issueCsrfCookie } from '@/lib/server/auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const BLOCKED_EXTENSIONS = new Set(['.map', '.ts', '.tsx', '.env'])

const CONTENT_TYPES = new Map<string, string>([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.otf', 'font/otf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

function exportDir(): string {
  return path.resolve(
    process.env.PATIENT_APP_WEB_EXPORT_DIR ?? path.join(process.cwd(), 'patient-app-export'),
  )
}

function noStoreHeaders(contentType?: string): Headers {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    Expires: '0',
    Pragma: 'no-cache',
  })
  if (contentType) headers.set('Content-Type', contentType)
  return headers
}

function isInsideExportDir(root: string, filePath: string): boolean {
  const relativePath = path.relative(root, filePath)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function toSafeRelativePath(pathname: string): string | null {
  try {
    const decodedPath = decodeURIComponent(pathname)
    const normalizedPath = path.normalize(decodedPath).replace(/^[/\\]+/, '')
    return normalizedPath === '' ? 'index.html' : normalizedPath
  } catch {
    return null
  }
}

async function findFile(root: string, pathname: string): Promise<{ filePath: string; contentType: string } | null> {
  const relativePath = toSafeRelativePath(pathname)
  if (!relativePath) return null

  const candidates = [path.resolve(root, relativePath)]

  if (!path.extname(relativePath)) {
    candidates.push(path.resolve(root, `${relativePath}.html`))
    candidates.push(path.resolve(root, relativePath, 'index.html'))
    candidates.push(path.resolve(root, 'index.html'))
  }

  for (const candidate of candidates) {
    if (!isInsideExportDir(root, candidate)) continue

    try {
      const fileStat = await stat(candidate)
      if (!fileStat.isFile()) continue

      const extension = path.extname(candidate)
      if (BLOCKED_EXTENSIONS.has(extension)) return null
      return {
        filePath: candidate,
        contentType: CONTENT_TYPES.get(extension) ?? 'application/octet-stream',
      }
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error
          ? (error as NodeJS.ErrnoException).code
          : undefined
      if (code !== 'ENOENT' && code !== 'EISDIR') throw error
    }
  }

  return null
}

async function servePatientApp(request: NextRequest, method: 'GET' | 'HEAD') {
  if (request.nextUrl.pathname === '/api' || request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'api_route_not_found' },
      { status: 404, headers: noStoreHeaders('application/json') },
    )
  }

  const match = await findFile(exportDir(), request.nextUrl.pathname)

  if (!match) {
    return NextResponse.json(
      { error: 'patient_app_export_not_found' },
      { status: 404, headers: noStoreHeaders('application/json') },
    )
  }

  const body = method === 'HEAD' ? null : await readResponseBody(match.filePath, match.contentType, request)

  const response = new NextResponse(body, {
    headers: noStoreHeaders(match.contentType),
  })
  if (match.contentType.startsWith('text/html')) {
    // Belt and braces with the <meta name="robots"> tag above: a crawler that
    // reads only headers still learns the shell is not for indexing.
    response.headers.set('X-Robots-Tag', 'noindex, follow')
    issueCsrfCookie(response)
  }
  return response
}

const SYSTEM_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

/**
 * `maximum-scale=1` pins the page at its rendered scale so a stray zoom cannot
 * shift the layout. `interactive-widget=resizes-content` is a load-bearing
 * assumption of the app's keyboard handling (see the app's
 * `useWebKeyboardVisible` / `WebKeyboardFocusAssist`), and `viewport-fit=cover`
 * lets the app-shell paint under the iOS home indicator.
 */
const VIEWPORT_CONTENT =
  'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, interactive-widget=resizes-content'

const VIEWPORT_META = `<meta name="viewport" content="${VIEWPORT_CONTENT}" />`

/**
 * The export ships Expo's stock viewport (`…, shrink-to-fit=no`) because the
 * BFF builds with SPINESENSE_WEB_OUTPUT=single, and Expo ignores the app's
 * `app/+html.tsx` in single mode. Rewriting here is the only path that reaches
 * production's <head>; a meta tag cannot be expressed in global.css. Replace
 * rather than append — duplicate viewport tags have engine-dependent merge
 * semantics.
 */
function rewriteViewportMeta(html: string): string {
  if (!html.includes('</head>')) {
    return html
  }

  const existing = /<meta[^>]*\bname=["']viewport["'][^>]*>/i
  if (existing.test(html)) {
    return html.replace(existing, VIEWPORT_META)
  }
  return html.replace('</head>', `${VIEWPORT_META}</head>`)
}

const MARKETING_SITE_URL = 'https://spinesense.ai'
const APP_ORIGIN = 'https://app.spinesense.ai'

const SEO_TITLE = 'SpineSense: Understand Your Back or Neck Pain Before Your Appointment'
const SEO_DESCRIPTION =
  'Describe your back or neck pain, add your imaging reports, and get a plain-language summary to take to your appointment. Built by spine surgeons.'
/**
 * Served by the marketing site so one brand image covers both surfaces. Verified
 * to resolve without the build hash Next appends to its own references.
 */
const SEO_IMAGE = `${MARKETING_SITE_URL}/opengraph-image`

const SEO_META = [
  '<meta data-patient-web-seo name="robots" content="noindex, follow" />',
  `<meta name="description" content="${SEO_DESCRIPTION}" />`,
  `<meta property="og:title" content="${SEO_TITLE}" />`,
  `<meta property="og:description" content="${SEO_DESCRIPTION}" />`,
  `<meta property="og:url" content="${APP_ORIGIN}/" />`,
  '<meta property="og:type" content="website" />',
  '<meta property="og:site_name" content="SpineSense" />',
  '<meta property="og:locale" content="en_US" />',
  `<meta property="og:image" content="${SEO_IMAGE}" />`,
  '<meta property="og:image:width" content="1200" />',
  '<meta property="og:image:height" content="630" />',
  '<meta property="og:image:alt" content="SpineSense, a free spine assessment built by spine surgeons" />',
  '<meta name="twitter:card" content="summary_large_image" />',
  `<meta name="twitter:title" content="${SEO_TITLE}" />`,
  `<meta name="twitter:description" content="${SEO_DESCRIPTION}" />`,
  `<meta name="twitter:image" content="${SEO_IMAGE}" />`,
].join('')

/**
 * Search and social metadata for the app shell. The two halves do unrelated
 * jobs and neither is an SEO play: this domain renders client-side, so every
 * crawler receives an empty shell, and the indexable content lives on the
 * marketing site.
 *
 * `noindex` keeps that shell out of search results. `findFile` falls back to
 * `index.html` for any extensionless path, so the same bytes answer /dashboard,
 * /results and /settings with a 200; without this directive Google is invited to
 * index a set of identical blank pages at those URLs. It is deliberately not
 * paired with a canonical, because noindex and canonical are conflicting
 * signals and only noindex actually removes a URL.
 *
 * The OpenGraph and Twitter tags are unaffected by `noindex`, since social
 * scrapers are not search indexers. Without them every shared link renders as a
 * bare URL with no preview card, and this domain is the landing page paid ads
 * point at.
 */
function injectSeoMeta(html: string): string {
  if (!html.includes('</head>') || html.includes('data-patient-web-seo')) {
    return html
  }

  const titleTag = `<title>${SEO_TITLE}</title>`
  const existingTitle = /<title>[\s\S]*?<\/title>/i
  const withTitle = existingTitle.test(html)
    ? html.replace(existingTitle, titleTag)
    : html.replace('</head>', `${titleTag}</head>`)

  return withTitle.replace('</head>', `${SEO_META}</head>`)
}

const WEB_COMPATIBILITY_STYLES = `<style data-patient-web-compat>
@font-face { font-family: 'Satoshi-Regular'; src: url('/assets/fonts/Satoshi-Regular.otf') format('opentype'); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: 'Satoshi-Medium'; src: url('/assets/fonts/Satoshi-Medium.otf') format('opentype'); font-weight: 500; font-style: normal; font-display: swap; }
@font-face { font-family: 'Satoshi-Bold'; src: url('/assets/fonts/Satoshi-Bold.otf') format('opentype'); font-weight: 700; font-style: normal; font-display: swap; }
@font-face { font-family: 'ClashDisplay-Semibold'; src: url('/assets/fonts/ClashDisplay-Semibold.otf') format('opentype'); font-weight: 600; font-style: normal; font-display: swap; }
@font-face { font-family: 'ClashDisplay-Bold'; src: url('/assets/fonts/ClashDisplay-Bold.otf') format('opentype'); font-weight: 700; font-style: normal; font-display: swap; }

[style*="font-family"][style*="Satoshi-Regular"],
[class*="r-ctd730"] {
  font-family: 'Satoshi-Regular', ${SYSTEM_FONT_STACK} !important;
  font-weight: 400;
}
[style*="font-family"][style*="Satoshi-Medium"],
[class*="r-18jse50"] {
  font-family: 'Satoshi-Medium', ${SYSTEM_FONT_STACK} !important;
  font-weight: 500;
}
[style*="font-family"][style*="Satoshi-Bold"],
[class*="r-1my5303"] {
  font-family: 'Satoshi-Bold', ${SYSTEM_FONT_STACK} !important;
  font-weight: 700;
}
[style*="font-family"][style*="ClashDisplay"],
[class*="r-1ai7t6e"] {
  font-family: 'ClashDisplay-Semibold', ${SYSTEM_FONT_STACK} !important;
  font-weight: 600;
}
[style*="font-family"][style*="ClashDisplay-Bold"] {
  font-family: 'ClashDisplay-Bold', ${SYSTEM_FONT_STACK} !important;
  font-weight: 700;
}

html,
body {
  font-family: 'Satoshi-Regular', ${SYSTEM_FONT_STACK};
}

input {
  box-sizing: border-box !important;
  max-width: 100% !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}

/* Textareas must keep native scrolling: overflow hidden here made any story
   longer than the box unreachable (no scrollbar, no wheel, no touch pan), and
   text-overflow never applies to multiline fields anyway. */
textarea {
  box-sizing: border-box !important;
  max-width: 100% !important;
  overflow-y: auto !important;
}

/* iOS Safari auto-zooms any focused input that renders below 16px and never
   zooms back out, leaving every subsequent screen shifted and clipped. Pin
   every input to 16px so the zoom is never triggered. The deliberately
   enlarged code-entry fields (OTP, MFA, invite) already render above the
   threshold and opt out via an ss-zoom-exempt- id, keeping their own size. */
input:not([id^="ss-zoom-exempt-"]),
textarea,
select {
  font-size: 16px !important;
}

input:focus,
textarea:focus,
select:focus,
[contenteditable]:focus {
  border-bottom: 2px solid #E8985E !important;
  box-shadow: none !important;
  outline: none !important;
}

[role="button"]:focus,
[role="button"]:focus-visible,
button:focus,
a:focus,
[tabindex]:focus {
  outline: none !important;
}

[data-testid="sticky-tab-wrapper"],
[data-testid="tab-container"],
[data-testid="sticky-tab-wrapper"] > *,
[data-testid="tab-container"] > * {
  border-color: transparent !important;
  border-style: none !important;
  outline: none !important;
}
</style>`

function injectWebCompatibilityStyles(html: string): string {
  if (!html.includes('</head>')) {
    return html
  }
  if (html.includes('data-patient-web-compat')) {
    return html
  }
  return html.replace('</head>', `${WEB_COMPATIBILITY_STYLES}</head>`)
}

function injectStyleNonceBootstrap(html: string, nonce: string): string {
  if (!html.includes('</head>') || html.includes('data-patient-web-style-nonce')) {
    return html
  }

  const script = `<script data-patient-web-style-nonce nonce="${nonce}">(function(){var n=${JSON.stringify(nonce)};var d=document;var c=d.createElement.bind(d);d.createElement=function(t,o){var e=c(t,o);if(typeof t==="string"&&t.toLowerCase()==="style"&&e&&e.setAttribute&&!e.getAttribute("nonce")){e.setAttribute("nonce",n);}return e;};})();</script>`
  return html.replace('</head>', `${script}</head>`)
}

/**
 * Anonymous landing-funnel tracker.
 *
 * Injected here rather than built into the app bundle for two reasons. The
 * campaign tag arrives as `?c=` on the very first request and the app's root
 * route redirects to `/welcome` before any screen mounts, which drops the query
 * string — a script in `<head>` reads it while it still exists. And measuring
 * a marketing surface should not require a patient-app release.
 *
 * It observes the DOM through the app's existing `data-testid` attributes and
 * mutates nothing. Everything is wrapped so that a selector this file gets
 * wrong degrades to "no data", never to a broken landing page — the page
 * earning the ad spend must not be able to fail because of its own
 * instrumentation.
 *
 * See `@/lib/server/landing-analytics` for the privacy properties: no cookie,
 * no durable storage, no identifier that outlives the tab, no third party.
 */
function injectLandingTracker(html: string, nonce: string): string {
  if (!html.includes('</head>') || html.includes('data-patient-web-landing')) {
    return html
  }

  const tracker = `<script data-patient-web-landing nonce="${nonce}">(function(){
try{
var ENDPOINT='/api/landing/events';
var params=new URLSearchParams(location.search||'');
var campaign=params.get('c')||params.get('utm_content')||params.get('utm_campaign')||'';
var visit=(crypto&&crypto.randomUUID)?crypto.randomUUID():String(Date.now())+'-'+Math.random().toString(36).slice(2);
var w=window.innerWidth||0;
var device=w>0&&w<768?'phone':(w<1024?'tablet':'desktop');
var queue=[],sent={},timer=null;

function flush(){
  if(!queue.length)return;
  var body=JSON.stringify({v:visit,c:campaign,d:device,e:queue});
  queue=[];
  try{
    var blob=new Blob([body],{type:'application/json'});
    if(!(navigator.sendBeacon&&navigator.sendBeacon(ENDPOINT,blob))){
      fetch(ENDPOINT,{method:'POST',body:body,keepalive:true,headers:{'Content-Type':'application/json'}}).catch(function(){});
    }
  }catch(e){}
}
// Once per visit per event: these are funnel milestones, not interaction counts.
function mark(name){
  if(sent[name])return;
  sent[name]=1;queue.push(name);
  if(timer)clearTimeout(timer);
  timer=setTimeout(flush,600);
}

mark('landing_view');

document.addEventListener('click',function(ev){
  try{
    var el=ev.target&&ev.target.closest?ev.target.closest('[data-testid]'):null;
    while(el){
      var id=el.getAttribute('data-testid');
      if(id==='cookie-consent-accept-all'){mark('consent_accept');break;}
      if(id==='cookie-consent-decline'){mark('consent_decline');break;}
      if(id==='cookie-consent-declined-back'){mark('consent_deadend_back');break;}
      if(id==='welcome-get-started'){mark('cta_start');flush();break;}
      if(id==='welcome-login'){mark('cta_signin');flush();break;}
      el=el.parentElement&&el.parentElement.closest?el.parentElement.closest('[data-testid]'):null;
    }
  }catch(e){}
},true);

var scroller=null;
function onScroll(){
  try{
    if(!scroller)return;
    var span=scroller.scrollHeight-scroller.clientHeight;
    if(span<=0)return;
    var pct=scroller.scrollTop/span;
    for(var i=1;i<=5;i++){if(pct>=i*0.2-0.02)mark('scroll_'+i);}
  }catch(e){}
}

// The app mounts asynchronously and swaps screens client-side, so both the
// consent sheet and the scroller appear well after this script runs.
var seenRegister=false;
var observer=new MutationObserver(function(){
  try{
    if(document.querySelector('[data-testid="cookie-consent-modal"]'))mark('consent_shown');
    if(document.querySelector('[data-testid="cookie-consent-declined"]'))mark('consent_deadend');
    var s=document.querySelector('[data-testid="welcome-scroll"]');
    if(s&&s!==scroller){scroller=s;s.addEventListener('scroll',onScroll,{passive:true});}
    if(!seenRegister&&location.pathname.indexOf('register')>=0){seenRegister=true;mark('register_view');flush();}
  }catch(e){}
});
if(document.body){observer.observe(document.body,{childList:true,subtree:true});}
else{document.addEventListener('DOMContentLoaded',function(){observer.observe(document.body,{childList:true,subtree:true});});}

addEventListener('pagehide',flush);
addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')flush();});
}catch(e){}
})();</script>`

  return html.replace('</head>', `${tracker}</head>`)
}

async function readResponseBody(
  filePath: string,
  contentType: string,
  request: NextRequest,
): Promise<string | ArrayBuffer> {
  const body = await readFile(filePath)
  if (!contentType.startsWith('text/html')) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
  }

  const html = injectSeoMeta(injectWebCompatibilityStyles(rewriteViewportMeta(body.toString('utf8'))))
  const nonce = request.headers.get('x-nonce')
  if (!nonce) return html

  return injectLandingTracker(injectStyleNonceBootstrap(html, nonce), nonce)
    .replaceAll(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`)
    .replaceAll(/<style(?![^>]*\bnonce=)/g, `<style nonce="${nonce}"`)
}

export async function GET(request: NextRequest) {
  return servePatientApp(request, 'GET')
}

export async function HEAD(request: NextRequest) {
  return servePatientApp(request, 'HEAD')
}
