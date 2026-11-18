// deep-visit.js — FSS Deep Visit Worker v5 (завършена и поправена)
// Node 18+; deps: express, playwright, playwright-extra, puppeteer-extra-plugin-stealth
//
// v5 (спрямо v4):
//  - Куките (window.open, synthetic click, form submit) се докладват веднага към Node през exposeBinding,
//    затова не се губят при навигация между страници.
//  - Цел: плейърът. Откриване по DOM (video / голям iframe / player контейнер), не по URL.
//    Клик върху <video>, iframe и контейнери; до 3 клика на плейъра с различно отместване.
//  - Празните опити (няма елемент) НЕ харчат бюджета от кликове.
//  - Линкове към съдържание: не от меню/хедър/футър; target=_blank се сваля, за да не се брои собствен таб за popup.
//  - Пауза ~6 сек. с движение/скрол преди първия клик (рекламните скриптове се "активират" със закъснение).
//  - Втори рунд в НОВ чист контекст директно на намерената страница с плейър (рекламите имат лимит по бисквитки).
//  - Параметър play_url: директен адрес на страница с плейър (препоръчително да се пази в базата).
//  - Точкуване по УНИКАЛНИ рекламни хостове (не по заявки); реклами и тракери са разделени;
//    DGA хевристиката е само информативна (не точкува).
//  - JS-отваряния се точкуват само над броя реални popup-и (без двойно броене).
//  - @@ изключения и опции ($domain=, ~, redirect…) в списъците се уважават.
//  - Състояние "неубедителен тест": inconclusive / confidence / verdict / test_notes.
//  - SSRF защита за ВСЯКА заявка на браузъра (частни IP, localhost, имена без точка, .local/.internal).
//  - Новият headless режим (по-малко разпознаваем) с автоматично връщане към стария, ако не стартира.
//  - В отговора: environment (headless, proxy, ua) и rounds.
//  - Съвместимо с v4: всички стари полета са налични.
//
// ENV: DEEP_VISIT_PORT, DEEP_VISIT_KEY, DEEP_VISIT_MAX_CONCURRENT, DEEP_VISIT_PROXY (по избор),
//      DEEP_VISIT_HEADFUL=1 (иска xvfb), DEEP_VISIT_NEW_HEADLESS=0 (изключва новия headless),
//      DEEP_VISIT_ROUNDS (по подразбиране 2), DEEP_VISIT_UA, DEEP_VISIT_EXECUTABLE,
//      DEEP_VISIT_ALLOW_QUERY_KEY=0 (приема ключ само в хедър x-api-key), DEEP_VISIT_EXTRA_ARGS (през запетая).
//
// API: GET /deep-check?url=...&clicks=6&wait=2.5&mobile=0|1&deep=1|0&rounds=1..3&play_url=...

const express = require('express');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const PORT = process.env.DEEP_VISIT_PORT || 3001;
const API_KEY = process.env.DEEP_VISIT_KEY || '';
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.DEEP_VISIT_MAX_CONCURRENT || '2', 10));
const PROXY = process.env.DEEP_VISIT_PROXY || '';
const HEADFUL = process.env.DEEP_VISIT_HEADFUL === '1';
const NEW_HEADLESS = process.env.DEEP_VISIT_NEW_HEADLESS !== '0';
const DEFAULT_ROUNDS = Math.min(3, Math.max(1, parseInt(process.env.DEEP_VISIT_ROUNDS || '2', 10) || 2));
const ALLOW_QUERY_KEY = process.env.DEEP_VISIT_ALLOW_QUERY_KEY !== '0';
const EXTRA_ARGS = (process.env.DEEP_VISIT_EXTRA_ARGS || '').split(',').map((s) => s.trim()).filter(Boolean);
const BLOCKLIST_TTL_MS = 24 * 3600 * 1000;
const WORKER_VERSION = 'v5';

// ---------------------------------------------------------------------------------------------
// Списъци
// ---------------------------------------------------------------------------------------------
const AD_DOMAINS = [
  'doubleclick.net','googlesyndication.com','googleadservices.com','adservice.google.com',
  'popads.net','popcash.net','propellerads.com','propellerpops.com','onclickalgo.com',
  'onclickmax.com','onclckds.com','onclckpro.com','onclckstr.com','onclckinp.com','onclckmetrics.com',
  'profitablecpmrate.com','profitableratecpm.com','adsterra.com','displayformatcontent.com',
  'displayformatrevenue.com','effectiveratecpm.com','effectivegatecpm.com','highratecpm.com',
  'profitablegatecpm.com','revenuecpmgate.com','toprevenuegate.com','trustedgatetocontent.com',
  'exoclick.com','exosrv.com','juicyads.com','trafficjunky.com','clickadu.com','adcash.com',
  'mgid.com','revcontent.com','taboola.com','outbrain.com','adnxs.com','rubiconproject.com',
  'pubmatic.com','openx.net','criteo.com','zedo.com','adroll.com','bidvertiser.com',
  'adf.ly','shorte.st','linkvertise.com','monetag.com','ad-maven.com','adnium.com',
  'exdynsrv.com','tsyndicate.com','a-ads.com','cointraffic.io','trafmag.com','kadam.net',
  'richads.com','adkernel.com','hilltopads.net','adpushup.com','ezoic.com','mediavine.com',
  'onesignal.com','pushwoosh.com','pushcrew.com','izooto.com','cleverpush.com',
  'betweendigital.com','adhigh.net','adhood.com','admedo.com','adnami.io','adnuntius.com',
  'adotmob.com','adpone.com','adsafeprotected.com','adsrvr.org','adtelligent.com',
  'adthrive.com','adtrue.com','aduptech.com','adverline.com','advertserve.com',
  'adyoulike.com','aniview.com','bidswitch.net','bluekai.com','casalemedia.com',
  'contextweb.com','crwdcntrl.net','demdex.net','dotomi.com','emxdgt.com','exelator.com',
  'eyeota.net','gumgum.com','improvedigital.com','indexww.com','inmobi.com','innity.com',
  'innovid.com','intellitxt.com','intergient.com','krxd.net','lijit.com','loopme.com',
  'mathtag.com','media.net','mediamath.com','mookie1.com','nativo.com','nexage.com',
  'nrich.ai','omnitagjs.com','onetag.com','pagefair.com','perfectaudience.com',
  'pippio.com','plista.com','powerlinks.com','pulsepoint.com','quantcast.com',
  'quantserve.com','richaudience.com','rlcdn.com','rtbhouse.com','sape.ru','sekindo.com',
  'serving-sys.com','sharethrough.com','simpli.fi','sitescout.com','smaato.com',
  'smartadserver.com','sonobi.com','sovrn.com','spotxchange.com','springserve.com',
  'stackadapt.com','stickyadstv.com','supersonicads.com','tapad.com','teads.tv',
  'tremorhub.com','tribalfusion.com','triplelift.com','tritondigital.com','turn.com',
  'undertone.com','unrulymedia.com','vidoomy.com','vidora.com','vidspring.com',
  'viralize.com','vi-serve.com','vungle.com','yieldbot.com','yieldlab.net',
  'yieldmo.com','yieldoptimizer.com','zemanta.com','zeotap.com','zergnet.com','zorosrv.com',
  'laiserpeglet.com','nidehetaira.com','ochringptolemy.com','alwingulla.com','betotodilea.com',
  'chooxaur.com','gloaphoo.net','phaurtuh.net','thaudray.com','whephoochi.com','zaubanel.com',
  'ptauxofi.net','jouteetu.net','loukoost.net','phicmune.net','toapoabu.net','zugnogne.com',
  'diketime.com','bytogeticr.com','vebo-vast.com','adoto.net','proftrafficcounter.com',
  'wpadmngr.com','nawpush.com','capndr.com','ntvpforever.com','cabnnr.com','metricswpsh.com',
  'uuidksinc.net','new-programmatic.com','liftdsp.com',
];

const LEGIT_CDNS = [
  'cloudflare.com','cdnjs.cloudflare.com','jsdelivr.net','googletagmanager.com','google-analytics.com',
  'gstatic.com','googleapis.com','ggpht.com','bootstrapcdn.com','jquery.com','sharethis.com',
  'whatsapp.net','google.com','recaptcha.net','cloudflareinsights.com','fontawesome.com',
  'youtube.com','ytimg.com','vimeo.com','jwpcdn.com','jwplatform.com','jwpsrv.com','plyr.io',
  'videojs.com','disqus.com','disquscdn.com','addthis.com','addtoany.com','histats.com',
  'statcounter.com','paypal.com','stripe.com','akamaized.net','akamai.net','fastly.net',
  'edgecastcdn.net','azureedge.net','cloudfront.net','amazonaws.com','twimg.com','fbcdn.net',
  'apple.com','mzstatic.com','sentry.io','hotjar.com','clarity.ms','unpkg.com','dailymotion.com','dmcdn.net',
  'wikimedia.org','wikipedia.org','wikimediafoundation.org','themoviedb.org','tmdb.org',
];

const SOCIAL_HOSTS = [
  'facebook.com','fb.com','twitter.com','x.com','instagram.com','t.me','telegram.me','telegram.org',
  'whatsapp.com','reddit.com','pinterest.com','linkedin.com','tiktok.com',
];

const BENIGN_POPUP_HOSTS = [
  'play.google.com','apps.apple.com','itunes.apple.com','chromewebstore.google.com','addons.mozilla.org',
];

const ANALYTICS_LABELS = new Set([
  'intake-analytics','analytics','stats','telemetry','metrics','umami','matomo','piwik','collect','beacon',
]);

const MULTI_TLDS = new Set([
  'co.uk','org.uk','ac.uk','gov.uk','com.au','net.au','org.au','co.nz','co.jp','co.kr','co.in',
  'com.br','com.mx','com.tr','com.pl','com.ar','co.za','com.sg','com.hk','com.tw','co.il',
  'com.ua','com.ru','com.cn','com.co','com.pe','com.ve','com.ec','com.pk','com.bd','com.my',
  'com.ph','com.vn','co.id','co.th','or.id','web.id',
]);

const COMMON_WORDS = [
  'google','cloud','share','this','font','awesome','media','video','movie','movies','film','play',
  'player','stream','show','watch','free','online','site','page','host','server','data','link',
  'click','track','stats','stat','count','pixel','tags','social','news','blog','shop','store',
  'game','games','sport','live','life','home','world','global','tech','soft','code','tool','tools',
  'mail','chat','talk','call','phone','mobile','desk','best','good','great','super','mega','ultra',
  'plus','mini','micro','auto','smart','fast','quick','easy','simple','clean','clear','true','real',
  'pure','prime','first','next','last','script','image','images','photo','music','audio','sound',
  'radio','book','books','read','learn','school','jobs','work','team','group','club','forum','board',
  'wiki','help','support','service','system','network','digital','studio','design','craft','build',
  'make','create','agency','market','trade','invest','finance','legal','health','care','medical',
  'static','assets','cdn','content','api','web','app','box','hub','zone','base','core','dev',
];

// ---------------------------------------------------------------------------------------------
// Динамични блок-листове: AD_SET (реклами) и TRACKER_SET (тракери/смесени), ALLOW_SET (изключения)
// ---------------------------------------------------------------------------------------------
const AD_SET = new Set();
const TRACKER_SET = new Set();
const ALLOW_SET = new Set();
let blocklistReady = false;
const blocklistStatus = {};

async function fetchText(url, ms = 60000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;
const BAD_OPTS = /(^|,)(domain=|~|redirect|removeparam|dnsrewrite|csp|badfilter|cookie|replace|denyallow|app=|client=|header=|rewrite)/i;

// Връща { type: 'block'|'allow'|null, domain } за един ред от списък.
function parseListLine(line, fmt) {
  line = String(line || '').trim();
  if (!line || line[0] === '!' || line[0] === '#' || line[0] === '[') return { type: null };
  if (fmt === 'hosts') {
    const m = line.match(/^(?:127\.0\.0\.1|0\.0\.0\.0)\s+([a-z0-9.-]+)/i);
    if (m) { const d = m[1].toLowerCase().replace(/\.$/, ''); if (DOMAIN_RE.test(d)) return { type: 'block', domain: d }; }
    return { type: null };
  }
  let allow = false;
  if (line.startsWith('@@')) { allow = true; line = line.slice(2); }
  const m = line.match(/^\|\|([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\^(?:\$(.*))?$/i);
  if (!m) return { type: null };
  const d = m[1].toLowerCase();
  const opts = m[2] || '';
  if (allow) {
    // изключенията се прилагат глобално само когато нямат никакви опции
    return opts === '' ? { type: 'allow', domain: d } : { type: null };
  }
  if (opts && BAD_OPTS.test(opts)) return { type: null };
  return { type: 'block', domain: d };
}

async function refreshBlocklists() {
  const sources = [
    { name: 'peter_lowe', url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext', fmt: 'hosts', kind: 'ad' },
    { name: 'easylist', url: 'https://easylist.to/easylist/easylist.txt', fmt: 'adblock', kind: 'ad' },
    { name: 'easylist_mirror', url: 'https://easylist-downloads.adblockplus.org/easylist.txt', fmt: 'adblock', kind: 'ad', onlyIfPrevFailed: 'easylist' },
    { name: 'adguard_dns', url: 'https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt', fmt: 'adblock', kind: 'tracker' },
  ];
  let ok = 0;
  for (const s of sources) {
    if (s.onlyIfPrevFailed && blocklistStatus[s.onlyIfPrevFailed] && blocklistStatus[s.onlyIfPrevFailed].ok) {
      blocklistStatus[s.name] = { ok: true, skipped: true, added: 0, ts: Date.now() };
      continue;
    }
    try {
      const txt = await fetchText(s.url);
      let added = 0, allowed = 0;
      for (const line of txt.split('\n')) {
        const r = parseListLine(line, s.fmt);
        if (r.type === 'block') {
          const target = s.kind === 'ad' ? AD_SET : TRACKER_SET;
          if (!target.has(r.domain)) { target.add(r.domain); added++; }
        } else if (r.type === 'allow') {
          if (!ALLOW_SET.has(r.domain)) { ALLOW_SET.add(r.domain); allowed++; }
        }
      }
      blocklistStatus[s.name] = { ok: true, added, allowed, bytes: txt.length, ts: Date.now() };
      console.log('[deep-visit] blocklist OK:', s.name, '+' + added, 'allow +' + allowed);
      ok++;
    } catch (e) {
      blocklistStatus[s.name] = { ok: false, error: String(e.message || e).slice(0, 120), ts: Date.now() };
      console.error('[deep-visit] blocklist FAIL:', s.name, '-', String(e.message || e).slice(0, 120));
    }
  }
  blocklistReady = ok > 0;
  console.log('[deep-visit] blocklist: ads', AD_SET.size, 'trackers', TRACKER_SET.size, 'allow', ALLOW_SET.size);
}

// ---------------------------------------------------------------------------------------------
// Помощни
// ---------------------------------------------------------------------------------------------
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function auth(req, res, next) {
  if (!API_KEY) return res.status(503).json({ success: false, error: 'No DEEP_VISIT_KEY configured' });
  const given = req.get('x-api-key') || (ALLOW_QUERY_KEY ? req.query.key : '') || '';
  if (!safeEqual(given, API_KEY)) return res.status(401).json({ success: false, error: 'Invalid key' });
  next();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') ||
      x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb');
  }
  return true;
}

// Дали хост е позволен (за браузъра). Кеш по хост.
const hostCache = new Map();
function hostAllowed(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (hostCache.has(h)) return hostCache.get(h);
  const p = (async () => {
    if (!h) return false;
    if (net.isIP(h)) return !isPrivateIp(h);
    if (!h.includes('.') || /(^|\.)localhost$/.test(h) || /\.(local|internal|lan|home|corp|localdomain)$/.test(h)) return false;
    try {
      const addrs = await Promise.race([
        dns.lookup(h, { all: true }),
        sleep(4000).then(() => { throw new Error('dns timeout'); }),
      ]);
      return addrs.length > 0 && !addrs.some((a) => isPrivateIp(a.address));
    } catch { return true; } // не се резолвира: браузърът сам ще се провали
  })();
  hostCache.set(h, p);
  if (hostCache.size > 5000) hostCache.delete(hostCache.keys().next().value);
  return p;
}

async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http/https allowed');
  if (!(await hostAllowed(u.hostname))) throw new Error('Address not allowed');
  return u;
}

function getRootDomain(hostname) {
  const parts = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_TLDS.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
  return lastTwo;
}
function rootOfUrl(u) { try { return getRootDomain(new URL(u).hostname); } catch { return ''; } }
function isLegitCdn(hostname) {
  const h = String(hostname || '').toLowerCase();
  return LEGIT_CDNS.some((c) => h === c || h.endsWith('.' + c));
}
function isAnalyticsHost(hostname) {
  const first = String(hostname || '').toLowerCase().split('.')[0];
  return ANALYTICS_LABELS.has(first);
}
function isSocialUrl(urlStr) {
  const s = String(urlStr || '');
  if (/^(mailto|tel|javascript|sms):/i.test(s)) return true;
  try {
    const h = new URL(s).hostname.toLowerCase();
    return SOCIAL_HOSTS.some((x) => h === x || h.endsWith('.' + x));
  } catch { return false; }
}
function isBenignUrl(urlStr) {
  try {
    const h = new URL(String(urlStr || '')).hostname.toLowerCase();
    return BENIGN_POPUP_HOSTS.some((b) => h === b || h.endsWith('.' + b));
  } catch { return false; }
}
function setMatch(set, h) {
  const parts = h.split('.');
  for (let i = 0; i <= parts.length - 2; i++) {
    const d = parts.slice(i).join('.');
    if (set.has(d)) return d;
  }
  return null;
}
// Реклама: твърд списък (винаги) + динамични реклами (освен ако има @@ изключение или е легитимен CDN).
function adMatchHost(h) {
  if (!h) return null;
  for (const ad of AD_DOMAINS) if (h === ad || h.endsWith('.' + ad)) return ad;
  if (isLegitCdn(h) || isAnalyticsHost(h)) return null;
  const hit = setMatch(AD_SET, h);
  if (!hit) return null;
  if (setMatch(ALLOW_SET, h)) return null;
  return hit;
}
function trackerMatchHost(h) {
  if (!h || isLegitCdn(h)) return null;
  const hit = setMatch(TRACKER_SET, h);
  if (!hit || setMatch(ALLOW_SET, h)) return null;
  return hit;
}
function adDomainMatch(urlStr) {
  try { return adMatchHost(new URL(urlStr).hostname.toLowerCase()); } catch { return null; }
}
function trackerDomainMatch(urlStr) {
  try { return trackerMatchHost(new URL(urlStr).hostname.toLowerCase()); } catch { return null; }
}
// Само информативно (не точкува).
function looksLikeDga(host) {
  const sld = getRootDomain(host).split('.')[0];
  if (!sld || sld.length < 8 || !/^[a-z0-9-]+$/.test(sld)) return false;
  for (const w of COMMON_WORDS) if (w.length >= 3 && sld.includes(w)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Браузър
// ---------------------------------------------------------------------------------------------
let browserPromise = null;
let browserMode = 'unknown';
function getBrowser() {
  if (!browserPromise) {
    const base = {
      headless: !HEADFUL,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--mute-audio',
        ...EXTRA_ARGS,
      ],
    };
    if (PROXY) base.proxy = { server: PROXY };
    if (process.env.DEEP_VISIT_EXECUTABLE) base.executablePath = process.env.DEEP_VISIT_EXECUTABLE;
    const launch = async () => {
      if (!HEADFUL && NEW_HEADLESS && !base.executablePath) {
        try {
          const b = await chromium.launch({ ...base, channel: 'chromium' });
          browserMode = 'new_headless';
          return b;
        } catch (e) {
          console.warn('[deep-visit] new headless недостъпен, връщам стария:', String(e.message || e).split('\n')[0]);
        }
      }
      const b = await chromium.launch(base);
      browserMode = HEADFUL ? 'headful' : 'old_headless';
      return b;
    };
    browserPromise = launch().then((b) => {
      b.on('disconnected', () => { browserPromise = null; });
      console.log('[deep-visit] browser mode:', browserMode);
      return b;
    }).catch((e) => { browserPromise = null; throw e; });
  }
  return browserPromise;
}

let active = 0;
const waiters = [];
async function acquire() {
  if (active < MAX_CONCURRENT) { active++; return; }
  await new Promise((r) => waiters.push(r));
}
function release() {
  const n = waiters.shift();
  if (n) n(); else active--;
}
async function runLimited(fn) {
  await acquire();
  try { return await fn(); } finally { release(); }
}

async function syncClientHints(p, ua, isMobile, fullVer) {
  try {
    const major = String(fullVer).split('.')[0];
    const brands = [
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
      { brand: 'Not-A.Brand', version: '24' },
    ];
    const cdp = await p.context().newCDPSession(p);
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: ua,
      acceptLanguage: 'en-US',
      platform: isMobile ? 'Linux armv8l' : 'Win32',
      userAgentMetadata: {
        brands,
        fullVersionList: brands.map((b) => ({ brand: b.brand, version: fullVer })),
        fullVersion: fullVer,
        platform: isMobile ? 'Android' : 'Windows',
        platformVersion: isMobile ? '13.0.0' : '15.0.0',
        architecture: isMobile ? '' : 'x86',
        bitness: isMobile ? '' : '64',
        model: isMobile ? 'Pixel 7' : '',
        mobile: !!isMobile,
      },
    });
  } catch { /* ignore */ }
}

// Скрипт, който се изпълнява във ВСЕКИ document/frame преди страницата. Докладва към Node през binding.
function hookScript(bindName) {
  try {
    const nativeToString = Function.prototype.toString;
    const mask = new WeakMap();
    const toStringWrapper = function toString() {
      if (mask.has(this)) return mask.get(this);
      return nativeToString.call(this);
    };
    mask.set(toStringWrapper, 'function toString() { [native code] }');
    Function.prototype.toString = toStringWrapper;
    const camouflage = (fn, orig, name) => {
      try { mask.set(fn, nativeToString.call(orig)); } catch (_) {}
      try { Object.defineProperty(fn, 'name', { value: name }); } catch (_) {}
      return fn;
    };
    let cached = null;
    const report = (type, targetUrl) => {
      try {
        if (typeof targetUrl !== 'string' || !targetUrl || targetUrl.startsWith('javascript:')) return;
        if (!cached) cached = window[bindName];
        if (typeof cached === 'function') {
          const r = cached(type, targetUrl.slice(0, 300), String(location.href).slice(0, 160));
          if (r && r.catch) r.catch(() => {});
        }
      } catch (_) {}
    };
    const origOpen = window.open;
    if (origOpen) {
      window.open = camouflage(function (u) {
        report('window.open', String(u == null ? 'about:blank' : u));
        return origOpen.apply(this, arguments);
      }, origOpen, 'open');
    }
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = camouflage(function () {
      try {
        if (this.href && (this.target === '_blank' || this.hostname !== location.hostname)) {
          report('synthetic_a_click', this.href);
        }
      } catch (_) {}
      return origClick.apply(this, arguments);
    }, origClick, 'click');
    const origSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = camouflage(function () {
      try {
        if (this.action && (this.target === '_blank' || new URL(this.action, location.href).hostname !== location.hostname)) {
          report('form_submit', new URL(this.action, location.href).href);
        }
      } catch (_) {}
      return origSubmit.apply(this, arguments);
    }, origSubmit, 'submit');
    document.addEventListener('submit', (e) => {
      try {
        const f = e.target;
        if (f && f.action && (f.target === '_blank' || new URL(f.action, location.href).hostname !== location.hostname)) {
          report('form_submit', new URL(f.action, location.href).href);
        }
      } catch (_) {}
    }, true);
    document.addEventListener('click', (e) => {
      try {
        const a = e.target && e.target.closest ? e.target.closest('a[target="_blank"]') : null;
        if (a && a.href && a.hostname !== location.hostname) report('blank_target_click', a.href);
      } catch (_) {}
    }, true);
  } catch (_) {}
}

// ---------------------------------------------------------------------------------------------
// Основен анализ
// ---------------------------------------------------------------------------------------------
const CF_RE = /just a moment|verifying you are human|verify you are human|checking your browser|attention required/i;
const PLAYER_SEL = 'video, iframe, [id*="player" i], [class*="player" i], [class*="jwplayer"], [class*="video-js"], [class*="plyr"], [class*="dplayer"], [id*="video" i]';
const PLAY_SEL = 'a, button, [role="button"], [class*="play"], [class*="watch"], [class*="btn"]';
const FILTER_SEL = 'a, button, [role="button"], .play, [class*="play"], [class*="poster"], [class*="card"]';

async function analyze(rawUrl, opts) {
  const t0 = Date.now();
  const deadline = t0 + (opts.deep ? 150000 : 80000);
  const parsedStart = await assertSafeUrl(rawUrl);
  const url = parsedStart.href;
  const startRoot = getRootDomain(parsedStart.hostname.toLowerCase());
  let playUrl = null;
  if (opts.playUrl) {
    try { playUrl = (await assertSafeUrl(opts.playUrl)).href; } catch { playUrl = null; }
  }
  const browser = await getBrowser();
  const isMobile = !!opts.mobile;
  const fullVer = browser.version();
  const major = String(fullVer).split('.')[0];
  const ua = isMobile
    ? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + major + '.0.0.0 Mobile Safari/537.36'
    : (process.env.DEEP_VISIT_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + major + '.0.0.0 Safari/537.36');

  // Споделено състояние за всички рундове
  const S = {
    popupRecords: [],
    hijackUrls: [],
    interceptedOpens: [],
    redirectChains: [],
    externalScripts: new Set(),
    unknownHosts: new Set(),
    adHosts: new Map(),       // домейн -> брой заявки (само от основната страница)
    trackerHosts: new Map(),
    adNavHosts: new Map(),    // реклами, към които водят popup/пренасочване
    clickLog: [],
    downloads: 0,
    siteRoots: new Set([startRoot]),
    detailReached: false,
    playerFound: false,
    playerClicked: false,
    playerUrl: null,
    title: '',
    cfChallenge: false,
    navError: null,
    loaded: false,
    techStack: 'unknown',
    hasVideo: false, hasIframe: false, hasM3u8: false,
    overlays: 0,
  };
  const roundsInfo = [];
  const maxRounds = opts.deep ? Math.min(3, Math.max(1, opts.rounds || DEFAULT_ROUNDS)) : 1;
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const rawBad = () => S.popupRecords.length + S.hijackUrls.length + S.downloads;

  async function runRound(idx, target, direct) {
    const info = { round: idx + 1, target: target.slice(0, 200), direct, clicks: 0, player_found: false, player_clicks: 0, popups: 0, blocked: false };
    const popupsBefore = S.popupRecords.length;
    const total = idx === 0 ? opts.clicks : Math.min(opts.clicks, 4);
    const waitMs = opts.waitMs;
    const context = await browser.newContext({
      userAgent: ua,
      viewport: isMobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
      locale: 'en-US',
      ignoreHTTPSErrors: true,
      isMobile,
      hasTouch: isMobile,
      deviceScaleFactor: isMobile ? 3 : 1,
      acceptDownloads: false,
    });
    const killer = setTimeout(() => context.close().catch(() => {}), Math.max(15000, deadline - Date.now() + 5000));
    let phase = 'load';
    let page = null;
    let lastMainUrl = target;
    let clicks = 0;
    const clickedSigs = new Set();
    try {
      // SSRF: всяка заявка на браузъра се проверява
      await context.route('**/*', async (route) => {
        try {
          const u = new URL(route.request().url());
          if (u.protocol === 'http:' || u.protocol === 'https:') {
            if (!(await hostAllowed(u.hostname))) return route.abort('blockedbyclient');
          } else if (!/^(data|blob|about|ws|wss):$/.test(u.protocol)) {
            return route.abort('blockedbyclient');
          }
        } catch (_) {}
        return route.continue().catch(() => {});
      });
      // Куки -> Node (оцеляват навигация)
      const bindName = '_f' + crypto.randomBytes(6).toString('hex');
      await context.exposeBinding(bindName, (_src, type, u, pageUrl) => {
        try {
          if (S.interceptedOpens.length < 200) {
            S.interceptedOpens.push({ type: String(type), url: String(u).slice(0, 300), page: String(pageUrl).slice(0, 160), ts: Date.now(), round: idx + 1 });
          }
        } catch (_) {}
      });
      await context.addInitScript(hookScript, bindName);
      page = await context.newPage();
      await syncClientHints(page, ua, isMobile, fullVer);
      page.on('dialog', (d) => (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}));
      page.on('download', () => { S.downloads++; });
      page.on('crash', () => { info.crashed = true; });
      page.on('framenavigated', (fr) => {
        if (fr !== page.mainFrame()) return;
        const u = fr.url();
        if (!u || u === 'about:blank' || u === lastMainUrl) return;
        const prev = lastMainUrl;
        lastMainUrl = u;
        let h;
        try { h = new URL(u).hostname.toLowerCase(); } catch { return; }
        if (!h || S.siteRoots.has(getRootDomain(h)) || isSocialUrl(u)) return;
        const ad = adDomainMatch(u);
        if (ad) bump(S.adNavHosts, ad);
        if (phase === 'load') {
          S.redirectChains.push({ from: String(prev).slice(0, 120), to: u.slice(0, 200), status: 'load_nav', src: 'page' });
        } else {
          S.hijackUrls.push(u.slice(0, 200));
          page.goBack({ timeout: 3000 }).catch(() => {});
        }
      });
      context.on('page', async (p) => {
        if (p === page) return;
        const rec = { opened_ts: Date.now(), phase, round: idx + 1, urls: [] };
        S.popupRecords.push(rec);
        p.on('dialog', (d) => (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}));
        p.on('download', () => { S.downloads++; });
        const track = (fr) => {
          if (fr !== p.mainFrame()) return;
          const u = fr.url();
          if (!u) return;
          const prev = rec.urls[rec.urls.length - 1];
          if (prev === u) return;
          rec.urls.push(u.slice(0, 300));
          if (prev && prev !== 'about:blank') {
            const a = rootOfUrl(prev), b = rootOfUrl(u);
            if (a && b && a !== b) S.redirectChains.push({ from: prev.slice(0, 120), to: u.slice(0, 200), status: 'popup_nav', src: 'popup' });
          }
          const ad = adDomainMatch(u);
          if (ad) bump(S.adNavHosts, ad);
        };
        p.on('framenavigated', track);
        try { track(p.mainFrame()); } catch (_) {}
        syncClientHints(p, ua, isMobile, fullVer).catch(() => {});
        // оставяме го малко да се пренасочва (за веригата), после затваряме
        setTimeout(() => { p.close().catch(() => {}); }, S.popupRecords.length > 12 ? 300 : 5000);
      });
      // Заявки от основната страница (без popup-и): уникални рекламни/тракер хостове
      context.on('request', (req) => {
        try {
          const fr = req.frame();
          const pg = fr ? fr.page() : null;
          if (!pg || pg !== page) return;
          const u = new URL(req.url());
          const host = u.hostname.toLowerCase();
          if (!host) return;
          const ad = adMatchHost(host);
          if (ad) { bump(S.adHosts, ad); }
          else {
            const tr = trackerMatchHost(host);
            if (tr) bump(S.trackerHosts, tr);
          }
          const rType = req.resourceType();
          if (!S.siteRoots.has(getRootDomain(host)) && !isSocialUrl(req.url()) &&
              (rType === 'script' || rType === 'document' || rType === 'subdocument')) {
            S.externalScripts.add(host);
            if (!ad && !isLegitCdn(host) && !isAnalyticsHost(host) && looksLikeDga(host)) S.unknownHosts.add(host);
          }
        } catch (_) {}
      });
      context.on('response', (res) => {
        try {
          const status = res.status();
          if (status < 300 || status >= 400) return;
          const fr = res.frame();
          const pg = fr ? fr.page() : null;
          if (!pg || pg !== page) return;
          const loc = res.headers()['location'];
          if (!loc) return;
          const target2 = new URL(loc, res.url());
          if (target2.hostname && !S.siteRoots.has(getRootDomain(target2.hostname)) && !isSocialUrl(target2.href)) {
            S.redirectChains.push({ from: res.url().slice(0, 120), to: target2.href.slice(0, 200), status, src: 'page' });
          }
        } catch (_) {}
      });
      // ---- Зареждане ----
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (err) {
        if (!S.loaded) S.navError = String(err.message || err).split('\n')[0];
      }
      await sleep(2500);
      // Cloudflare проверка: изчакваме малко да се реши сама
      let title = await page.title().catch(() => '');
      let bodySnip = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 800)).catch(() => '');
      let cf = CF_RE.test(title + ' ' + bodySnip);
      for (let i = 0; cf && i < 4; i++) {
        await sleep(2500);
        title = await page.title().catch(() => '');
        bodySnip = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 800)).catch(() => '');
        cf = CF_RE.test(title + ' ' + bodySnip);
      }
      if (cf) {
        S.cfChallenge = true;
        info.blocked = true;
        return info;
      }
      S.loaded = true;
      S.navError = null;
      if (idx === 0) S.title = title;
      try { S.siteRoots.add(getRootDomain(new URL(page.url()).hostname)); } catch (_) {}
      lastMainUrl = page.url();
      // Пауза със "жив" потребител: движение + скрол (активира забавени рекламни скриптове)
      const vp = page.viewportSize() || { width: 1280, height: 720 };
      for (let i = 0; i < 4; i++) {
        try {
          if (isMobile) {
            await page.evaluate((y) => window.scrollBy(0, y), 120 + i * 40);
          } else {
            await page.mouse.move(rnd(vp.width * 0.2, vp.width * 0.8), rnd(vp.height * 0.2, vp.height * 0.8), { steps: 8 });
            if (i === 1) await page.mouse.wheel(0, 300);
            if (i === 3) await page.mouse.wheel(0, -300);
          }
        } catch (_) {}
        await sleep(850);
      }
      phase = 'interact';
      // Информация за страницата (само първия рунд)
      if (idx === 0) {
        try {
          const pageInfo = await page.evaluate(() => {
            const html = document.documentElement.outerHTML.slice(0, 250000);
            const isNextOrReact = Boolean(document.getElementById('__next') || document.getElementById('root') ||
              window.__NEXT_DATA__ || document.querySelector('[data-reactroot]'));
            const vw = window.innerWidth, vh = window.innerHeight;
            let overlays = 0;
            for (const el of document.querySelectorAll('div, a, iframe')) {
              try {
                const st = window.getComputedStyle(el);
                const z = parseInt(st.zIndex, 10) || 0;
                if (!(st.position === 'fixed' || st.position === 'absolute') || z <= 999) continue;
                const r = el.getBoundingClientRect();
                if (r.width * r.height < vw * vh * 0.5) continue;
                const external = el.tagName === 'A' && el.hostname && el.hostname !== location.hostname;
                const transparent = parseFloat(st.opacity) <= 0.05 ||
                  (/rgba\(0, 0, 0, 0\)|transparent/.test(st.backgroundColor) && st.cursor === 'pointer');
                if (external || el.tagName === 'IFRAME' || transparent) overlays++;
              } catch (_) {}
            }
            return { isNextOrReact, overlays, v: document.querySelectorAll('video').length, i: document.querySelectorAll('iframe').length, h: html };
          });
          S.techStack = pageInfo.isNextOrReact ? 'spa_react_next' : 'classic_ssr_php';
          S.overlays = Math.min(3, pageInfo.overlays);
          S.hasVideo = pageInfo.v > 0;
          S.hasIframe = pageInfo.i > 0;
          S.hasM3u8 = /\.m3u8|\.mpd/.test(pageInfo.h);
        } catch (_) {}
      }
      // ---- Действия ----
      function refreshDetail() {
        try {
          const p = new URL(page.url()).pathname;
          S.detailReached = S.detailReached ||
            /\/(watch|watching|episode|player|vod|detail|play|stream|embed|view|video|film|movie|movies|tv|series|anime|drama)\/[^/]+/i.test(p) ||
            /\/(watch|play|watching|episode)\b/i.test(p);
        } catch (_) {}
      }
      async function tapOrClick(x, y) {
        try { await page.bringToFront(); } catch (_) {}
        if (isMobile) {
          await page.touchscreen.tap(x, y);
        } else {
          await page.mouse.move(x, y, { steps: 5 });
          await sleep(60 + Math.random() * 80);
          await page.mouse.down();
          await sleep(40 + Math.random() * 50);
          await page.mouse.up();
        }
      }
      async function clickHandle(h, sameTab) {
        if (sameTab) {
          try { await h.evaluate((el) => { if (el.tagName === 'A' && el.target === '_blank') el.target = '_self'; }); } catch (_) {}
        }
        try { await h.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch (_) {}
        let box = null;
        try { box = await h.boundingBox(); } catch (_) {}
        if (!box) return null;
        const v = page.viewportSize() || { width: 1280, height: 720 };
        const x1 = Math.max(box.x, 0), y1 = Math.max(box.y, 0);
        const x2 = Math.min(box.x + box.width, v.width), y2 = Math.min(box.y + box.height, v.height);
        if (x2 - x1 < 4 || y2 - y1 < 4) return null;
        const x = Math.min(Math.max((x1 + x2) / 2, 5), v.width - 5);
        const y = Math.min(Math.max((y1 + y2) / 2, 5), v.height - 5);
        await tapOrClick(x, y);
        return { x: Math.round(x), y: Math.round(y) };
      }
      // Един клик = една стъпка; бюджетът се харчи САМО при реален клик.
      async function step(type, fn) {
        if (clicks >= total || Date.now() > deadline - 3000) return false;
        const before = rawBad();
        let pt = null;
        try { pt = await fn(); } catch (_) {}
        if (!pt) return false;
        clicks++;
        await sleep(waitMs);
        let cur = '';
        try { cur = page.url().slice(0, 100); } catch (_) {}
        S.clickLog.push({ round: idx + 1, n: S.clickLog.length + 1, type, x: pt.x, y: pt.y, page: cur, events: rawBad() - before, hit: true });
        return true;
      }
      async function settle() {
        try { await page.waitForLoadState('domcontentloaded', { timeout: 6000 }); } catch (_) {}
        await sleep(1200);
        refreshDetail();
      }
      async function findPlayerCandidate() {
        const list = await page.evaluate((sel) => {
          const vw = window.innerWidth, vh = window.innerHeight, res = [];
          const els = Array.from(document.querySelectorAll(sel));
          for (let i = 0; i < els.length; i++) {
            try {
              const el = els[i];
              if (el.closest('header, nav, footer')) continue;
              const r = el.getBoundingClientRect();
              if (r.width < 300 || r.height < 170) continue;
              if (r.width >= vw * 0.98 && r.height >= vh * 1.6) continue;
              const st = getComputedStyle(el);
              if (st.visibility === 'hidden' || st.display === 'none') continue;
              const tag = el.tagName.toLowerCase();
              res.push({ i, tag, area: r.width * r.height, src: tag === 'iframe' ? (el.src || el.getAttribute('src') || '') : '' });
            } catch (_) {}
          }
          return res;
        }, PLAYER_SEL).catch(() => []);
        const prio = { video: 0, iframe: 1 };
        const good = list.filter((c) => !(c.tag === 'iframe' && c.src && adDomainMatch(c.src)));
        good.sort((a, b) => ((prio[a.tag] ?? 2) - (prio[b.tag] ?? 2)) || (b.area - a.area));
        return good[0] || null;
      }
      const OFFSETS = [[0, 0], [18, 10], [-24, -12]];
      async function clickPlayer(cand, k) {
        const handles = await page.$$(PLAYER_SEL);
        const h = handles[cand.i];
        if (!h) return null;
        const pt = await (async () => {
          try { await h.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch (_) {}
          const box = await h.boundingBox().catch(() => null);
          if (!box) return null;
          const v = page.viewportSize() || { width: 1280, height: 720 };
          const x1 = Math.max(box.x, 0), y1 = Math.max(box.y, 0);
          const x2 = Math.min(box.x + box.width, v.width), y2 = Math.min(box.y + box.height, v.height);
          if (x2 - x1 < 40 || y2 - y1 < 40) return null;
          const o = OFFSETS[k % OFFSETS.length];
          const x = Math.min(Math.max((x1 + x2) / 2 + o[0], 5), v.width - 5);
          const y = Math.min(Math.max((y1 + y2) / 2 + o[1], 5), v.height - 5);
          await tapOrClick(x, y);
          return { x: Math.round(x), y: Math.round(y) };
        })();
        if (pt) {
          S.playerFound = true; S.playerClicked = true; info.player_found = true;
          if (!S.playerUrl) {
            try { const cu = page.url(); if (S.siteRoots.has(rootOfUrl(cu))) S.playerUrl = cu; } catch (_) {}
          }
        }
        return pt;
      }
      async function findPlayButton() {
        const pick = await page.evaluate(({ sel, roots }) => {
          const els = Array.from(document.querySelectorAll(sel));
          let best = null, bestS = 0;
          const rootOf = (h) => h.toLowerCase().split('.').slice(-2).join('.');
          for (let i = 0; i < els.length; i++) {
            try {
              const el = els[i];
              const r = el.getBoundingClientRect();
              if (r.width < 30 || r.height < 20) continue;
              if (r.right <= 0 || r.left >= window.innerWidth) continue;
              const t = (el.innerText || '').trim().toLowerCase();
              if (/google play|app store|appgallery|download the app|get it on/i.test(t)) continue;
              if (el.hostname && !roots.includes(rootOf(el.hostname))) continue;
              const href = (el.getAttribute('href') || '').toLowerCase();
              const cls = String(el.className || '').toLowerCase();
              let s = 0;
              if (t.length < 40 && /(^|\s|▶)(play|watch|stream)(\s|$| now| movie| online)/.test(t)) s += 4;
              if (/btn[-_ ]?play|play[-_ ]?btn|btn[-_ ]?watch|watch[-_ ]?btn|watching/.test(cls)) s += 3;
              if (/\/watch|\/play|\/stream|watching\.html|-watch\b/.test(href)) s += 3;
              if (el.closest('header, nav, footer')) s -= 3;
              if (s > bestS) { bestS = s; best = { idx: i, sig: el.tagName + '|' + href + '|' + cls.slice(0, 60) + '|' + t.slice(0, 30) }; }
            } catch (_) {}
          }
          return bestS >= 3 ? best : null;
        }, { sel: PLAY_SEL, roots: Array.from(S.siteRoots) }).catch(() => null);
        if (!pick || clickedSigs.has(pick.sig)) return null;
        const h = (await page.$$(PLAY_SEL))[pick.idx];
        if (!h) return null;
        clickedSigs.add(pick.sig);
        return await clickHandle(h, true);
      }
      async function findContentLink() {
        const cur = page.url();
        const pick = await page.evaluate(({ roots, cur }) => {
          const bad = /\/(genre|genres|country|login|register|signin|signup|filter|search|tag|tags|actor|actors|director|year|type|page|privacy|terms|dmca|contact|about|faq|category|categories|az-list|a-z|top-imdb|most-popular|upcoming|release|schedule|news|blog)(\/|$|\.)/i;
          const good = /(movie|movies|film|watch|series|tv|episode|anime|drama|show|video|stream|play|detail|vod|title|info|season)/i;
          const rootOf = (h) => h.toLowerCase().split('.').slice(-2).join('.');
          const as = Array.from(document.querySelectorAll('a[href]'));
          let best = null, bestS = 0;
          for (let i = 0; i < as.length; i++) {
            try {
              const a = as[i];
              if (a.closest('nav, header, footer, [class*="menu" i], [class*="navbar" i], [class*="sidebar" i]')) continue;
              const u = new URL(a.href);
              if (!/^https?:$/.test(u.protocol) || !roots.includes(rootOf(u.hostname))) continue;
              if (a.href === cur || bad.test(u.pathname) || u.pathname.length < 4) continue;
              const r = a.getBoundingClientRect();
              if (r.width < 30 || r.height < 18) continue;
              if (r.right <= 0 || r.left >= window.innerWidth) continue;
              let s = 0;
              if (good.test(u.pathname)) s += 3;
              if (u.pathname.split('/').filter(Boolean).length >= 2) s += 1;
              if (u.pathname.length > 12 && u.pathname.includes('-')) s += 1;
              if (a.querySelector('img')) s += 2;
              if (/poster|card|item|thumb|film|movie/i.test(String(a.className) + ' ' + String(a.parentElement ? a.parentElement.className : ''))) s += 2;
              if (s > bestS) { bestS = s; best = { idx: i, sig: a.href }; }
            } catch (_) {}
          }
          return bestS >= 3 ? best : null;
        }, { roots: Array.from(S.siteRoots), cur }).catch(() => null);
        if (!pick || clickedSigs.has(pick.sig)) return null;
        const h = (await page.$$('a[href]'))[pick.idx];
        if (!h) return null;
        clickedSigs.add(pick.sig);
        return await clickHandle(h, true);
      }
      async function filteredPick() {
        const pick = await page.evaluate(({ sel, skip, social }) => {
          const els = Array.from(document.querySelectorAll(sel));
          const cands = [];
          for (let i = 0; i < els.length; i++) {
            try {
              const el = els[i];
              const href = el.getAttribute('href') || '';
              if (/^(mailto|tel|javascript):/i.test(href)) continue;
              if (href) {
                try {
                  const h = new URL(el.href || href, location.href).hostname.toLowerCase();
                  if (social.some((s) => h === s || h.endsWith('.' + s))) continue;
                } catch (_) {}
              }
              const cls = String(el.className || '');
              if (/share|social|login|register|bookmark/i.test(cls)) continue;
              const r = el.getBoundingClientRect();
              if (r.width < 25 || r.height < 20) continue;
              if (r.right <= 0 || r.left >= window.innerWidth) continue;
              const sig = el.tagName + '|' + href + '|' + cls.slice(0, 60) + '|' + (el.innerText || '').trim().slice(0, 30);
              if (skip.includes(sig)) continue;
              cands.push({ idx: i, sig });
            } catch (_) {}
          }
          if (!cands.length) return null;
          return cands[Math.floor(Math.random() * Math.min(cands.length, 15))];
        }, { sel: FILTER_SEL, skip: Array.from(clickedSigs), social: SOCIAL_HOSTS }).catch(() => null);
        if (!pick) {
          const v = page.viewportSize() || { width: 1280, height: 720 };
          const x = Math.floor(v.width * (0.25 + Math.random() * 0.5));
          const y = Math.floor(v.height * (0.25 + Math.random() * 0.5));
          await tapOrClick(x, y);
          return { x, y };
        }
        const h = (await page.$$(FILTER_SEL))[pick.idx];
        if (!h) return null;
        clickedSigs.add(pick.sig);
        return await clickHandle(h, true);
      }
      async function centerProbe() {
        const v = page.viewportSize() || { width: 1280, height: 720 };
        const x = v.width / 2 + (Math.random() * 30 - 15);
        const y = v.height / 2 + (Math.random() * 30 - 15);
        await tapOrClick(x, y);
        return { x: Math.round(x), y: Math.round(y) };
      }
      // 1) Проба в центъра (само при вход през начална страница)
      if (!direct) await step('center_probe', centerProbe);
      if (!opts.deep) {
        let guard = 0;
        while (clicks < total && guard++ < 20 && Date.now() < deadline - 3000) {
          await step('filtered_element', filteredPick);
        }
      } else {
        let navClicks = 0, playerClicks = 0, filler = 0, lateWaitFor = '', scrolledFor = '';
        for (let guard = 0; guard < 30 && clicks < total && Date.now() < deadline - 3000; guard++) {
          await settle();
          const cur = page.url();
          const cand = await findPlayerCandidate();
          if (cand) {
            if (playerClicks >= 3) break;
            const ok = await step(playerClicks === 0 ? 'player_click' : 'player_click' + (playerClicks + 1), () => clickPlayer(cand, playerClicks));
            if (ok) { playerClicks++; info.player_clicks = playerClicks; continue; }
            break;
          }
          // Плейърът може да се зареди със закъснение
          if (lateWaitFor !== cur) { lateWaitFor = cur; await sleep(2500); continue; }
          if (navClicks < 4) {
            if (await step('play_button', findPlayButton)) { navClicks++; await sleep(1500); continue; }
            if (!S.detailReached || navClicks === 0) {
              if (await step('content_link', findContentLink)) { navClicks++; await sleep(1500); continue; }
            }
          }
          if (scrolledFor !== cur) {
            scrolledFor = cur;
            try { if (isMobile) await page.evaluate(() => window.scrollBy(0, 700)); else await page.mouse.wheel(0, 700); } catch (_) {}
            await sleep(900);
            continue;
          }
          if (filler < 2 && await step('filtered_element', filteredPick)) { filler++; continue; }
          break;
        }
      }
      await sleep(4000);
      // Късна информация
      try {
        const late = await page.evaluate(() => ({ v: document.querySelectorAll('video').length, i: document.querySelectorAll('iframe').length }));
        S.hasVideo = S.hasVideo || late.v > 0;
        S.hasIframe = S.hasIframe || late.i > 0;
      } catch (_) {}
      refreshDetail();
      info.clicks = clicks;
      return info;
    } finally {
      info.clicks = clicks;
      info.popups = S.popupRecords.length - popupsBefore;
      clearTimeout(killer);
      await context.close().catch(() => {});
    }
  }

  try {
    for (let r = 0; r < maxRounds; r++) {
      if (r > 0) {
        if (!S.playerUrl || deadline - Date.now() < 40000) break;
        try { await assertSafeUrl(S.playerUrl); } catch { break; }
      }
      const target = r === 0 ? (playUrl || url) : S.playerUrl;
      let info;
      try {
        info = await runRound(r, target, r > 0 || !!playUrl);
      } catch (e) {
        info = { round: r + 1, target: target.slice(0, 200), error: String(e.message || e).split('\n')[0] };
        if (r === 0 && !S.loaded) throw e;
      }
      roundsInfo.push(info);
      if (info.blocked) break;
    }
    // ---- Обобщение ----
    const seenInt = new Set();
    const dedupInt = S.interceptedOpens.filter((x) => {
      if (isSocialUrl(x.url) || isBenignUrl(x.url)) return false;
      const k = x.type + '|' + x.url;
      if (seenInt.has(k)) return false;
      seenInt.add(k);
      return true;
    });
    // кои JS отваряния са "външни" (различен root от сайта и от страницата, от която идват)
    const extOpens = dedupInt.filter((x) => {
      if (x.url.startsWith('about:')) return false;
      const to = rootOfUrl(x.url);
      if (!to || S.siteRoots.has(to)) return false;
      if (x.type === 'blank_target_click') return !!adDomainMatch(x.url);
      return true;
    });
    const uniqueJsOpens = new Set(extOpens.map((x) => x.url)).size;
    for (const item of extOpens) {
      const ad = adDomainMatch(item.url);
      if (ad) bump(S.adNavHosts, ad);
    }
    const effectivePopups = S.popupRecords.filter((r) => {
      const real = r.urls.filter((u) => u && u !== 'about:blank');
      if (!real.length) return true;
      // собствени табове на сайта (не реклама) не са popup
      if (real.every((u) => S.siteRoots.has(rootOfUrl(u)) && !adDomainMatch(u))) return false;
      return real.some((u) => !isSocialUrl(u) && !isBenignUrl(u));
    });
    const popups = effectivePopups.length;
    const popupUrls = effectivePopups.map((r) => {
      const real = r.urls.filter((u) => u && u !== 'about:blank');
      return (real[real.length - 1] || 'about:blank').slice(0, 200);
    });
    const seenRed = new Set();
    const dedupRed = S.redirectChains.filter((x) => {
      const k = x.from + '|' + x.to;
      if (seenRed.has(k)) return false;
      seenRed.add(k);
      return true;
    });
    // Пренасочване точкува само ако е от основната страница и е от/към разпознат рекламен домейн
    const adRedirects = dedupRed.filter((x) => x.src === 'page' && (adDomainMatch(x.to) || adDomainMatch(x.from)));
    const uniqueRedirects = new Set(adRedirects.map((x) => x.to)).size;
    const adHostCount = Math.min(15, S.adHosts.size);
    const trackerCount = Math.min(8, S.trackerHosts.size);
    const extraJs = Math.max(0, uniqueJsOpens - popups);
    const breakdown = {
      hijacks: S.hijackUrls.length * 10,
      popups: popups * 5,
      js_opens_beyond_popups: extraJs * 4,
      ad_redirects: uniqueRedirects * 3,
      overlays: S.overlays * 2,
      unique_ad_hosts: adHostCount,
      unique_tracker_hosts: Math.floor(trackerCount * 0.5),
      downloads: S.downloads * 5,
    };
    const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
    let level = 'none';
    if (score >= 30) level = 'high';
    else if (score >= 10) level = 'medium';
    else if (score >= 1) level = 'low';
    // Колко е убедителен тестът
    const notes = [];
    if (S.cfChallenge) notes.push('cf_blocked');
    if (!S.loaded && !S.cfChallenge) notes.push('page_not_loaded');
    if (S.loaded && !S.playerClicked) notes.push('player_not_reached');
    if (S.playerClicked && popups === 0 && S.adHosts.size > 0 && browserMode !== 'headful') {
      notes.push('ad_scripts_present_but_no_popups_headless_suppression_possible');
    }
    let confidence = 'high';
    if (S.cfChallenge || !S.loaded) confidence = 'none';
    else if (!S.playerClicked) confidence = 'low';
    else if (S.playerClicked && popups === 0 && S.adHosts.size > 0 && browserMode !== 'headful') confidence = 'medium';
    // Чист сайт без плейърна повърхност и без рекламни сигнали -> уверен "чист"
    const noPlayerSurface = !S.hasVideo && !S.hasIframe && !S.playerFound;
    if (S.loaded && !S.cfChallenge && noPlayerSurface && S.adHosts.size === 0 && popups === 0 && S.hijackUrls.length === 0) {
      confidence = 'high';
    }
    const inconclusive = confidence === 'none' || (confidence === 'low' && score < 10);
    let verdict;
    if (confidence === 'none') verdict = 'blocked_or_failed';
    else if (score >= 10) verdict = 'ads_detected';
    else if (score >= 1) verdict = 'light_ads';
    else if (inconclusive) verdict = 'inconclusive';
    else verdict = 'clean_or_light';
    const totalAdHits = Array.from(S.adHosts.values()).reduce((a, b) => a + b, 0);
    const adDomainBreakdown = {};
    for (const [k, v] of S.adHosts) adDomainBreakdown[k] = v;
    for (const [k, v] of S.adNavHosts) adDomainBreakdown[k] = (adDomainBreakdown[k] || 0) + v;
    return {
      success: true,
      worker_version: WORKER_VERSION,
      url,
      detected_stack: S.techStack,
      status: S.cfChallenge ? 'blocked' : (S.navError && !S.loaded ? 'error' : 'loaded'),
      nav_error: S.navError,
      title: S.title,
      cf_challenge: S.cfChallenge,
      elapsed_sec: Math.round((Date.now() - t0) / 100) / 10,
      has_video: S.hasVideo,
      has_iframe: S.hasIframe,
      has_m3u8_in_html: S.hasM3u8,
      suspicious_overlays: S.overlays,
      clicks: S.clickLog.length,
      click_log: S.clickLog,
      popups,
      hijacks: S.hijackUrls.length,
      js_runtime_hooks_triggered: uniqueJsOpens,
      network_redirects_triggered: uniqueRedirects,
      ad_domain_hits: totalAdHits,
      unique_ad_hosts: S.adHosts.size,
      unique_tracker_hosts: S.trackerHosts.size,
      ad_domains: Object.keys(adDomainBreakdown),
      ad_domain_breakdown: adDomainBreakdown,
      tracker_domains: Array.from(S.trackerHosts.keys()).slice(0, 20),
      external_script_hosts: Array.from(S.externalScripts).slice(0, 25),
      suspicious_script_hosts: Array.from(S.unknownHosts).slice(0, 15), // само информативно, не точкува
      downloads: S.downloads,
      detail_page_reached: S.detailReached,
      player_found: S.playerFound,
      player_clicked: S.playerClicked,
      player_url: S.playerUrl,
      deep: !!opts.deep,
      blocklist_domains: AD_SET.size + TRACKER_SET.size + AD_DOMAINS.length,
      bad_events: S.hijackUrls.length + popups + uniqueJsOpens,
      ad_score: score,
      ad_level: level,
      score_breakdown: breakdown,
      inconclusive,
      confidence,
      verdict,
      test_notes: notes,
      environment: {
        browser_mode: browserMode,
        headless: !HEADFUL,
        proxy: !!PROXY,
        mobile: isMobile,
        user_agent: ua,
        rounds_planned: maxRounds,
      },
      rounds: roundsInfo,
      evidence: {
        popup_urls: popupUrls.slice(0, 10),
        popup_details: S.popupRecords.slice(0, 10).map((r) => ({ phase: r.phase, round: r.round, urls: r.urls.slice(0, 6) })),
        hijack_urls: S.hijackUrls.slice(0, 10),
        js_intercepted: dedupInt.slice(0, 10),
        redirect_chains: dedupRed.slice(0, 10),
      },
    };
  } catch (e) {
    return { success: false, error: String(e.message || e).split('\n')[0], elapsed_sec: Math.round((Date.now() - t0) / 100) / 10 };
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------
function buildApp() {
  const app = express();
  app.get('/health', (_req, res) => res.json({
    ok: true, service: 'deep-visit', version: WORKER_VERSION,
    active, queued: waiters.length,
    browser_mode: browserMode, proxy: !!PROXY,
    blocklist_domains: AD_SET.size + TRACKER_SET.size + AD_DOMAINS.length,
    blocklist_ads: AD_SET.size, blocklist_trackers: TRACKER_SET.size, blocklist_allow: ALLOW_SET.size,
    blocklist_ready: blocklistReady,
    blocklist_sources: blocklistStatus,
  }));
  app.get('/deep-check', auth, async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ success: false, error: 'Missing URL' });
    const clicks = Math.min(10, Math.max(1, parseInt(req.query.clicks || '6', 10) || 6));
    const waitSec = Math.min(10, Math.max(1, parseFloat(req.query.wait || '2.5') || 2.5));
    const mobile = req.query.mobile === '1';
    const deep = req.query.deep !== '0';
    const rounds = Math.min(3, Math.max(1, parseInt(req.query.rounds || String(DEFAULT_ROUNDS), 10) || DEFAULT_ROUNDS));
    const playUrl = req.query.play_url ? String(req.query.play_url) : '';
    try {
      const result = await runLimited(() => analyze(String(url), {
        clicks, waitMs: Math.round(waitSec * 1000), mobile, deep, rounds, playUrl,
      }));
      res.json(result);
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });
  return app;
}
async function shutdown() {
  try { if (browserPromise) await (await browserPromise).close(); } catch (_) {}
  process.exit(0);
}
if (require.main === module) {
  refreshBlocklists().catch(() => {});
  setInterval(() => refreshBlocklists().catch(() => {}), BLOCKLIST_TTL_MS).unref();
  process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  buildApp().listen(PORT, '0.0.0.0', () => {
    console.log('[deep-visit] ' + WORKER_VERSION + ' on port ' + PORT + ' (max concurrent: ' + MAX_CONCURRENT + ')' +
      (API_KEY ? '' : ' — WARNING: no key set') + (PROXY ? ' — proxy: ' + PROXY : ' — no proxy'));
  });
}
module.exports = { analyze, buildApp, parseListLine, adMatchHost, trackerMatchHost, hostAllowed, assertSafeUrl,
  looksLikeDga, getRootDomain, AD_SET, TRACKER_SET, ALLOW_SET, isPrivateIp };
