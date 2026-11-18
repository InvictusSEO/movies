// deep-visit.js — FSS Deep Visit Worker v4
// Node 18+; deps: express, playwright, playwright-extra, puppeteer-extra-plugin-stealth
// v4 поправки (прецизност + устойчивост):
//  - Wikipedia фалшив "medium": app-store линкове (Google Play badge) вече не се броят за popunder;
//    първични analytics (intake-analytics.wikimedia.org, umami.* и др.) и собствените SSO/CDN redirect-и
//    на сайта не се броят като реклами; redirect-и се точкат само ако са към/от ad домейн.
//  - Request-и от benign popup страници (Play Store и др.) не се броят като ad hits на сканирания сайт.
//  - Deep flow: сравнение по root домейн (www/огледала), по-широк regex за съдържание, клик върху
//    частично видими карти (clamp), "умно" добиване на бюджета след навигация (late content/play/iframe).
//  - play_button пропуска външни линкове и app store badges.

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
const BLOCKLIST_TTL_MS = 24 * 3600 * 1000;
const WORKER_VERSION = 'v4';

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
  'clinic','fitness','food','cafe','coffee','pizza','grill','kitchen','travel','trip','tour','hotel',
  'flight','cars','motor','bike','rent','estate','realty','garden','green','blue','black','white',
  'gold','silver','iron','steel','stone','rock','star','stars','moon','ocean','river','forest',
  'tree','flower','lion','tiger','bear','wolf','bird','eagle','fish','shark','whale','dragon',
  'magic','power','energy','force','light','dark','night','dream','vision','future','time','date',
  'clock','guard','shield','secure','safe','trust','check','test','scan','search','find','seek',
  'look','view','scope','focus','lens','zoom','snap','shot','frame','byte','nano','tera','giga',
  'meta','omni','multi','poly','mono','quad','hexa','octo','cent','kilo','meter','gram','watt',
  'volt','hertz','tesla','apple','amazon','azure','fastly','akamai','jquery','bootstrap','disqus',
  'addthis','histats','sentry','hotjar','clarity','paypal','stripe','recaptcha','youtube','vimeo',
  'jwplayer','plyr','videojs','cloudflare','jsdelivr','cdnjs','unpkg','fontawesome','wordpress',
  'wixstatic','squarespace','shopify','bigcommerce','magento','prestashop','opencart','woocommerce',
];

const BLOCK_SET = new Set(AD_DOMAINS);
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

function addBlockDomain(d) {
  d = String(d || '').trim().toLowerCase().replace(/\.$/, '');
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(d)) BLOCK_SET.add(d);
}

async function refreshBlocklists() {
  const sources = [
    { name: 'peter_lowe', url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext', fmt: 'hosts' },
    { name: 'easylist', url: 'https://easylist.to/easylist/easylist.txt', fmt: 'adblock' },
    { name: 'easylist_mirror', url: 'https://easylist-downloads.adblockplus.org/easylist.txt', fmt: 'adblock' },
    { name: 'adguard_dns', url: 'https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt', fmt: 'adblock' },
  ];
  let ok = 0;
  for (const s of sources) {
    const before = BLOCK_SET.size;
    try {
      const txt = await fetchText(s.url);
      for (const line of txt.split('\n')) {
        if (s.fmt === 'hosts') {
          const m = line.match(/^(?:127\.0\.0\.1|0\.0\.0\.0)\s+([a-z0-9.-]+)/i);
          if (m) addBlockDomain(m[1]);
        } else {
          if (line.startsWith('@@') || line.startsWith('!')) continue;
          const m = line.match(/^\|\|([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\^/i);
          if (m) addBlockDomain(m[1]);
        }
      }
      const added = BLOCK_SET.size - before;
      blocklistStatus[s.name] = { ok: true, added, bytes: txt.length, ts: Date.now() };
      console.log('[deep-visit] blocklist OK:', s.name, '+' + added, '(total ' + BLOCK_SET.size + ')');
      ok++;
    } catch (e) {
      blocklistStatus[s.name] = { ok: false, error: String(e.message || e).slice(0, 120), ts: Date.now() };
      console.error('[deep-visit] blocklist FAIL:', s.name, '-', String(e.message || e).slice(0, 120));
    }
  }
  blocklistReady = ok > 0;
  console.log('[deep-visit] blocklist domains total:', BLOCK_SET.size);
}
refreshBlocklists().catch(() => {});
setInterval(() => refreshBlocklists().catch(() => {}), BLOCKLIST_TTL_MS).unref();

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function auth(req, res, next) {
  if (!API_KEY) return res.status(503).json({ success: false, error: 'No DEEP_VISIT_KEY configured' });
  const given = req.get('x-api-key') || req.query.key || '';
  if (!safeEqual(given, API_KEY)) return res.status(401).json({ success: false, error: 'Invalid key' });
  next();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
  }
  return true;
}
async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http/https allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Address not allowed');
  return u;
}
function getRootDomain(hostname) {
  const parts = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_TLDS.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
  return lastTwo;
}
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
function blocklistMatch(h) {
  const parts = h.split('.');
  for (let i = 0; i <= parts.length - 2; i++) {
    const d = parts.slice(i).join('.');
    if (BLOCK_SET.has(d)) return d;
  }
  return null;
}
function adDomainMatch(urlStr) {
  try {
    const u = new URL(urlStr);
    const h = u.hostname.toLowerCase();
    if (!h) return null;
    for (const ad of AD_DOMAINS) if (h === ad || h.endsWith('.' + ad)) return ad;
    if (isLegitCdn(h) || isAnalyticsHost(h)) return null;
    return blocklistMatch(h);
  } catch { return null; }
}
function looksLikeDga(host) {
  const sld = getRootDomain(host).split('.')[0];
  if (!sld || sld.length < 8 || !/^[a-z0-9-]+$/.test(sld)) return false;
  for (const w of COMMON_WORDS) if (w.length >= 4 && sld.includes(w)) return false;
  return true;
}

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    const opts = {
      headless: !HEADFUL,
      args: [
        '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--mute-audio',
      ],
    };
    if (PROXY) opts.proxy = { server: PROXY };
    if (process.env.DEEP_VISIT_EXECUTABLE) opts.executablePath = process.env.DEEP_VISIT_EXECUTABLE;
    browserPromise = chromium.launch(opts).then((b) => {
      b.on('disconnected', () => { browserPromise = null; });
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

async function analyze(rawUrl, opts) {
  const t0 = Date.now();
  const parsedStart = await assertSafeUrl(rawUrl);
  const url = parsedStart.href;
  const startHost = parsedStart.hostname.toLowerCase();
  const startRoot = getRootDomain(startHost);
  const browser = await getBrowser();
  const isMobile = !!opts.mobile;
  const fullVer = browser.version();
  const major = String(fullVer).split('.')[0];
  const ua = isMobile
    ? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + major + '.0.0.0 Mobile Safari/537.36'
    : (process.env.DEEP_VISIT_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + major + '.0.0.0 Safari/537.36');

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
  const killer = setTimeout(() => context.close().catch(() => {}), opts.deep ? 150000 : 90000);

  let popupsOpened = 0;
  let downloads = 0;
  const popupRecords = [];
  const hijackUrls = [];
  const interceptedOpens = [];
  const redirectChains = [];
  const externalScripts = new Set();
  const suspiciousHosts = new Set();
  const adDomainHits = {};
  const clickLog = [];
  let phase = 'load';
  let lastMainUrl = url;
  let detailReached = false;
  let playerClicked = false;
  let page;

  try {
    await context.addInitScript(() => {
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
        window.__fssIntercepted = [];
        const record = (type, targetUrl) => {
          try {
            if (typeof targetUrl !== 'string' || !targetUrl) return;
            if (targetUrl.startsWith('javascript:')) return;
            window.__fssIntercepted.push({
              type, url: targetUrl.slice(0, 300), ts: Date.now(),
              page: String(location.href).slice(0, 120),
            });
          } catch (_) {}
        };
        const origOpen = window.open;
        if (origOpen) {
          window.open = camouflage(function (u) {
            record('window.open', String(u == null ? 'about:blank' : u));
            return origOpen.apply(this, arguments);
          }, origOpen, 'open');
        }
        const origClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = camouflage(function () {
          try {
            if (this.href && (this.target === '_blank' || this.hostname !== location.hostname)) {
              record('synthetic_a_click', this.href);
            }
          } catch (_) {}
          return origClick.apply(this, arguments);
        }, origClick, 'click');
        document.addEventListener('submit', (e) => {
          try {
            const f = e.target;
            if (f && f.action && (f.target === '_blank' || new URL(f.action).hostname !== location.hostname)) {
              record('form_submit', f.action);
            }
          } catch (_) {}
        }, true);
        document.addEventListener('click', (e) => {
          try {
            const a = e.target && e.target.closest ? e.target.closest('a[target="_blank"]') : null;
            if (a && a.href) record('blank_target_click', a.href);
          } catch (_) {}
        }, true);
      } catch (_) {}
    });

    page = await context.newPage();
    await syncClientHints(page, ua, isMobile, fullVer);
    page.on('dialog', (d) => (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}));
    page.on('download', () => { downloads++; });

    page.on('framenavigated', (fr) => {
      if (fr !== page.mainFrame()) return;
      const u = fr.url();
      if (!u || u === 'about:blank' || u === lastMainUrl) return;
      const prev = lastMainUrl;
      lastMainUrl = u;
      let h;
      try { h = new URL(u).hostname.toLowerCase(); } catch { return; }
      if (!h || getRootDomain(h) === startRoot || isSocialUrl(u)) return;
      const ad = adDomainMatch(u);
      if (ad) adDomainHits[ad] = (adDomainHits[ad] || 0) + 1;
      if (phase === 'load') {
        redirectChains.push({ from: String(prev).slice(0, 120), to: u.slice(0, 200), status: 'load_nav' });
      } else {
        hijackUrls.push(u.slice(0, 200));
        page.goBack({ timeout: 3000 }).catch(() => {});
      }
    });

    context.on('page', async (p) => {
      if (p === page) return;
      popupsOpened++;
      const rec = { opened_ts: Date.now(), phase, urls: [] };
      popupRecords.push(rec);
      p.on('dialog', (d) => (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}));
      p.on('download', () => { downloads++; });
      const track = (fr) => {
        if (fr !== p.mainFrame()) return;
        const u = fr.url();
        if (!u) return;
        const prev = rec.urls[rec.urls.length - 1];
        if (prev === u) return;
        rec.urls.push(u.slice(0, 300));
        if (prev && prev !== 'about:blank') {
          try {
            if (getRootDomain(new URL(prev).hostname) !== getRootDomain(new URL(u).hostname)) {
              redirectChains.push({ from: prev.slice(0, 120), to: u.slice(0, 200), status: 'popup_nav' });
            }
          } catch (_) {}
        }
        const ad = adDomainMatch(u);
        if (ad) adDomainHits[ad] = (adDomainHits[ad] || 0) + 1;
      };
      p.on('framenavigated', track);
      try { track(p.mainFrame()); } catch (_) {}
      await syncClientHints(p, ua, isMobile, fullVer);
      if (popupRecords.length > 12) { try { await p.close(); } catch (_) {} }
    });

    context.on('request', (req) => {
      const reqUrl = req.url();
      try {
        const fr = req.frame();
        const pg = fr ? fr.page() : null;
        if (pg && pg !== page) {
          const pu = pg.url();
          if (isBenignUrl(pu) || isSocialUrl(pu)) return; // реклами в benign popup не се броят
        }
      } catch (_) {}
      const ad = adDomainMatch(reqUrl);
      if (ad) adDomainHits[ad] = (adDomainHits[ad] || 0) + 1;
      try {
        const u = new URL(reqUrl);
        const host = u.hostname.toLowerCase();
        if (!host) return;
        const rType = req.resourceType();
        if (getRootDomain(host) !== startRoot && !isSocialUrl(reqUrl) &&
            (rType === 'script' || rType === 'document' || rType === 'subdocument')) {
          externalScripts.add(host);
          if (!ad && !isLegitCdn(host) && !isAnalyticsHost(host) && looksLikeDga(host)) suspiciousHosts.add(host);
        }
      } catch (_) {}
    });

    context.on('response', (res) => {
      const status = res.status();
      if (status >= 300 && status < 400) {
        const loc = res.headers()['location'];
        if (loc) {
          try {
            const target = new URL(loc, res.url());
            if (target.hostname && getRootDomain(target.hostname) !== startRoot && !isSocialUrl(target.href)) {
              redirectChains.push({ from: res.url().slice(0, 120), to: target.href.slice(0, 200), status });
            }
          } catch (_) {}
        }
      }
    });

    let navError = null;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      navError = String(err.message || err).split('\n')[0];
    }
    await sleep(4000);
    phase = 'interact';

    const title = await page.title().catch(() => '');
    const bodySnip = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 800)).catch(() => '');
    const CF_RE = /just a moment|verifying you are human|verify you are human|checking your browser|attention required/i;
    const isCfChallenge = CF_RE.test(title + ' ' + bodySnip);

    let techStack = 'unknown';
    let hasVideo = false, hasIframe = false, hasM3u8 = false;
    let suspiciousOverlays = 0;
    try {
      const info = await page.evaluate(() => {
        const html = document.documentElement.outerHTML.slice(0, 250000);
        const isNextOrReact = Boolean(
          document.getElementById('__next') || document.getElementById('root') ||
          window.__NEXT_DATA__ || document.querySelector('[data-reactroot]')
        );
        let overlays = 0;
        for (const el of document.querySelectorAll('div, a, iframe')) {
          const style = window.getComputedStyle(el);
          const z = parseInt(style.zIndex, 10) || 0;
          if ((style.position === 'fixed' || style.position === 'absolute') && z > 999) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 300 && rect.height > 250) overlays++;
          }
        }
        return {
          isNextOrReact, overlays,
          v: document.querySelectorAll('video').length,
          i: document.querySelectorAll('iframe').length,
          h: html,
        };
      });
      techStack = info.isNextOrReact ? 'spa_react_next' : 'classic_ssr_php';
      suspiciousOverlays = info.overlays;
      hasVideo = info.v > 0;
      hasIframe = info.i > 0;
      hasM3u8 = /\.m3u8|\.mpd/.test(info.h);
    } catch (_) {}

    const total = Math.min(10, Math.max(1, opts.clicks));
    const waitMs = Math.max(1000, opts.waitMs);
    const clickedSigs = new Set();
    let performed = 0;
    const rawBad = () => popupsOpened + hijackUrls.length + downloads;

    function refreshDetail() {
      try {
        const p = new URL(page.url()).pathname;
        detailReached = detailReached ||
          /\/(watch|watching|episode|player|vod|detail)/i.test(p) ||
          /\/(movie|movies|film|tv|series|anime|drama)\/[^/]{6,}/i.test(p);
      } catch (_) {}
    }

    async function tapOrClick(x, y) {
      if (isMobile) {
        await page.touchscreen.tap(x, y);
      } else {
        await page.mouse.move(x, y, { steps: 5 });
        await page.mouse.click(x, y);
      }
    }

    async function clickHandle(h) {
      try { await h.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch (_) {}
      let box = null;
      try { box = await h.boundingBox(); } catch (_) {}
      if (box) {
        const vp = page.viewportSize() || { width: 1280, height: 720 };
        if (box.x + box.width <= 0 || box.x >= vp.width || box.y + box.height <= 0 || box.y >= vp.height) return null;
        let x = box.x + box.width / 2;
        let y = box.y + box.height / 2;
        x = Math.min(Math.max(x, 5), vp.width - 5);
        y = Math.min(Math.max(y, 5), vp.height - 5);
        await tapOrClick(x, y);
        return { x: Math.round(x), y: Math.round(y) };
      }
      try { await h.click({ timeout: 2500 }); } catch (_) {}
      return { x: -1, y: -1 };
    }

    async function doStep(type, fn, skipOnMiss) {
      if (performed >= total || Date.now() - t0 > 115000) return false;
      const before = rawBad();
      let pt = { x: -1, y: -1 };
      let ok = false;
      try { const r = await fn(); if (r) { pt = r; ok = true; } } catch (_) {}
      if (!ok && skipOnMiss) return false;
      performed++;
      await sleep(waitMs);
      let cur = '';
      try { cur = page.url().slice(0, 100); } catch (_) {}
      clickLog.push({ n: performed, type, x: pt.x, y: pt.y, page: cur, events: rawBad() - before, hit: ok });
      return ok;
    }

    async function findContentLink() {
      const pick = await page.evaluate((root) => {
        const bad = /\/(genre|country|login|register|filter|search|tag|actor|director|year|type|page|privacy|terms|dmca|contact)\b/i;
        const good = /(movie|movies|film|watch|series|tv|episode|anime|drama|show|video|stream|play|detail|vod|title|info|season)/i;
        const as = Array.from(document.querySelectorAll('a[href]'));
        let best = null, bestS = 0;
        for (let i = 0; i < as.length; i++) {
          try {
            const a = as[i];
            const u = new URL(a.href);
            const rh = u.hostname.toLowerCase().split('.').slice(-2).join('.');
            if (rh !== root || bad.test(u.pathname) || u.pathname.length < 4) continue;
            const r = a.getBoundingClientRect();
            if (r.width < 30 || r.height < 18) continue;
            if (r.right <= 0 || r.left >= window.innerWidth) continue;
            let s = 0;
            if (good.test(u.pathname)) s += 3;
            if (u.pathname.length > 12) s += 1;
            if (a.querySelector('img')) s += 2;
            if (/poster|card|item|thumb|film|movie/i.test(String(a.className) + ' ' + String(a.parentElement ? a.parentElement.className : ''))) s += 2;
            if (s > bestS) { bestS = s; best = { idx: i, sig: a.href }; }
          } catch (_) {}
        }
        return bestS >= 3 ? best : null;
      }, startRoot).catch(() => null);
      if (!pick || clickedSigs.has(pick.sig)) return null;
      const handles = await page.$$('a[href]');
      const h = handles[pick.idx];
      if (!h) return null;
      clickedSigs.add(pick.sig);
      return await clickHandle(h);
    }

    const PLAY_SEL = 'a, button, [role="button"], [class*="play"], [class*="watch"], [class*="btn"]';
    async function findPlayButton() {
      const pick = await page.evaluate(({ sel, root }) => {
        const els = Array.from(document.querySelectorAll(sel));
        let best = null, bestS = 0;
        for (let i = 0; i < els.length; i++) {
          try {
            const el = els[i];
            const r = el.getBoundingClientRect();
            if (r.width < 30 || r.height < 20) continue;
            if (r.right <= 0 || r.left >= window.innerWidth) continue;
            const t = (el.innerText || '').trim().toLowerCase();
            if (/google play|app store|appgallery|download the app|get it on/i.test(t)) continue;
            if (el.hostname) {
              const rh = el.hostname.toLowerCase().split('.').slice(-2).join('.');
              if (rh !== root) continue;
            }
            const href = (el.getAttribute('href') || '').toLowerCase();
            const cls = String(el.className || '').toLowerCase();
            let s = 0;
            if (t.length < 40 && /(^|\s|▶)(play|watch)(\s|$| now| movie)/.test(t)) s += 4;
            if (/btn[-_ ]?play|play[-_ ]?btn|btn[-_ ]?watch|watch[-_ ]?btn|watching/.test(cls)) s += 3;
            if (/\/watch|\/play|watching\.html|-watch\b/.test(href)) s += 3;
            if (s > bestS) { bestS = s; best = { idx: i, sig: el.tagName + '|' + href + '|' + cls.slice(0, 60) + '|' + t.slice(0, 30) }; }
          } catch (_) {}
        }
        return bestS >= 3 ? best : null;
      }, { sel: PLAY_SEL, root: startRoot }).catch(() => null);
      if (!pick || clickedSigs.has(pick.sig)) return null;
      const handles = await page.$$(PLAY_SEL);
      const h = handles[pick.idx];
      if (!h) return null;
      clickedSigs.add(pick.sig);
      return await clickHandle(h);
    }

    async function clickPlayerIframe(k) {
      let handles = await page.$$('iframe');
      if (!handles.length) { await sleep(2500); handles = await page.$$('iframe'); }
      let bestH = null, bestArea = 0;
      for (const h of handles) {
        try {
          const box = await h.boundingBox();
          if (!box || box.width < 160 || box.height < 120) continue;
          if (box.width * box.height > bestArea) { bestArea = box.width * box.height; bestH = h; }
        } catch (_) {}
      }
      if (!bestH) return null;
      try { await bestH.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch (_) {}
      const box = await bestH.boundingBox().catch(() => null);
      if (!box) return null;
      const vp = page.viewportSize() || { width: 1280, height: 720 };
      const x = box.x + box.width / 2 + (k ? 20 : 0);
      const y = box.y + box.height / 2 + (k ? 10 : 0);
      if (x < 0 || y < 0 || x >= vp.width || y >= vp.height) return null;
      await tapOrClick(x, y);
      playerClicked = true;
      return { x: Math.round(x), y: Math.round(y) };
    }

    const FILTER_SEL = 'a, button, [role="button"], .play, [class*="play"], [class*="poster"], [class*="card"]';
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
        const vp = page.viewportSize() || { width: 1280, height: 720 };
        const x = Math.floor(vp.width * (0.25 + Math.random() * 0.5));
        const y = Math.floor(vp.height * (0.25 + Math.random() * 0.5));
        await tapOrClick(x, y);
        return { x, y };
      }
      const handles = await page.$$(FILTER_SEL);
      const h = handles[pick.idx];
      if (!h) return null;
      clickedSigs.add(pick.sig);
      return await clickHandle(h);
    }

    // 1) Център
    await doStep('center_probe', async () => {
      const vp = page.viewportSize() || { width: 1280, height: 720 };
      const x = vp.width / 2 + (Math.random() * 30 - 15);
      const y = vp.height / 2 + (Math.random() * 30 - 15);
      if (isMobile) {
        await page.touchscreen.tap(x, y);
      } else {
        await page.mouse.move(x, y, { steps: 6 });
        await page.mouse.down();
        await sleep(60);
        await page.mouse.up();
      }
      return { x: Math.round(x), y: Math.round(y) };
    });

    if (opts.deep) {
      // 2) Съдържание -> 3) Play -> 4+5) Player
      await doStep('content_link', findContentLink);
      await sleep(1500);
      refreshDetail();
      await doStep('play_button', findPlayButton);
      await sleep(2500);
      for (let k = 0; k < 2 && performed < total; k++) {
        const done = await doStep(k === 0 ? 'player_iframe_click' : 'player_iframe_click2', () => clickPlayerIframe(k));
        if (!done && k === 0) break;
      }
      if (!playerClicked && performed < total) {
        await doStep('player_iframe_retry', () => clickPlayerIframe(0));
      }
    }

    // Умен остатък: ако още не сме стигнали плейъра, опитваме content/play/iframe на ТЕКУЩАТА страница
    while (performed < total && Date.now() - t0 < 115000) {
      if (opts.deep && !playerClicked) {
        if (!detailReached) {
          const c = await doStep('content_link_late', findContentLink, true);
          if (c) { await sleep(1500); refreshDetail(); continue; }
        }
        const p = await doStep('play_button_late', findPlayButton, true);
        if (p) { await sleep(2500); refreshDetail(); continue; }
        const f = await doStep('player_iframe_late', () => clickPlayerIframe(0), true);
        if (f) continue;
      }
      await doStep('filtered_element', filteredPick);
    }

    await sleep(3000);

    try {
      const late = await page.evaluate(() => ({
        v: document.querySelectorAll('video').length,
        i: document.querySelectorAll('iframe').length,
      }));
      hasVideo = hasVideo || late.v > 0;
      hasIframe = hasIframe || late.i > 0;
    } catch (_) {}
    refreshDetail();

    for (const p of context.pages()) {
      for (const fr of p.frames()) {
        try {
          const arr = await fr.evaluate(() => window.__fssIntercepted || []);
          for (const item of arr) if (!isSocialUrl(item.url) && !isBenignUrl(item.url)) interceptedOpens.push(item);
        } catch (_) {}
      }
    }
    const seenInt = new Set();
    const dedupInt = interceptedOpens.filter((x) => {
      const k = x.type + '|' + x.url;
      if (seenInt.has(k)) return false;
      seenInt.add(k);
      return true;
    });
    for (const item of dedupInt) {
      const ad = adDomainMatch(item.url);
      if (ad) adDomainHits[ad] = (adDomainHits[ad] || 0) + 1;
    }
    const uniqueJsOpens = new Set(
      dedupInt.filter((x) => !x.url.startsWith('about:')).map((x) => x.url)
    ).size;

    const effectivePopups = popupRecords.filter((r) => {
      const real = r.urls.filter((u) => u && u !== 'about:blank');
      if (!real.length) return true;
      return real.some((u) => !isSocialUrl(u) && !isBenignUrl(u));
    });
    const popups = effectivePopups.length;
    const popupUrls = effectivePopups.map((r) => {
      const real = r.urls.filter((u) => u && u !== 'about:blank');
      return (real[real.length - 1] || 'about:blank').slice(0, 200);
    });

    const seenRed = new Set();
    const dedupRed = redirectChains.filter((x) => {
      const k = x.from + '|' + x.to;
      if (seenRed.has(k)) return false;
      seenRed.add(k);
      return true;
    });
    // Redirect се ТОЧКУВА само ако е от/към разпознат ad домейн (или DGA цел).
    const adRedirects = dedupRed.filter((x) => {
      if (adDomainMatch(x.to) || adDomainMatch(x.from)) return true;
      try { return looksLikeDga(new URL(x.to).hostname); } catch (_) { return false; }
    });
    const uniqueRedirects = new Set(adRedirects.map((x) => x.to)).size;

    const totalAdHits = Object.values(adDomainHits).reduce((a, b) => a + b, 0);
    const suspCount = suspiciousHosts.size;
    const score =
      (hijackUrls.length * 10) +
      (popups * 5) +
      (uniqueJsOpens * 4) +
      (uniqueRedirects * 3) +
      (suspiciousOverlays * 2) +
      totalAdHits +
      Math.min(6, suspCount * 2) +
      (downloads * 5);
    let level = 'none';
    if (score >= 30) level = 'high';
    else if (score >= 10) level = 'medium';
    else if (score >= 1) level = 'low';

    return {
      success: true,
      worker_version: WORKER_VERSION,
      url,
      detected_stack: techStack,
      status: isCfChallenge ? 'blocked' : (navError ? 'error' : 'loaded'),
      nav_error: navError,
      title,
      cf_challenge: isCfChallenge,
      elapsed_sec: Math.round((Date.now() - t0) / 100) / 10,
      has_video: hasVideo,
      has_iframe: hasIframe,
      has_m3u8_in_html: hasM3u8,
      suspicious_overlays: suspiciousOverlays,
      clicks: clickLog.length,
      click_log: clickLog,
      popups,
      hijacks: hijackUrls.length,
      js_runtime_hooks_triggered: uniqueJsOpens,
      network_redirects_triggered: uniqueRedirects,
      ad_domain_hits: totalAdHits,
      ad_domains: Object.keys(adDomainHits),
      ad_domain_breakdown: adDomainHits,
      external_script_hosts: Array.from(externalScripts).slice(0, 25),
      suspicious_script_hosts: Array.from(suspiciousHosts).slice(0, 15),
      downloads,
      detail_page_reached: detailReached,
      player_clicked: playerClicked,
      deep: !!opts.deep,
      blocklist_domains: BLOCK_SET.size,
      bad_events: hijackUrls.length + popups + uniqueJsOpens,
      ad_score: score,
      ad_level: level,
      evidence: {
        popup_urls: popupUrls.slice(0, 10),
        popup_details: popupRecords.slice(0, 10).map((r) => ({ phase: r.phase, urls: r.urls.slice(0, 6) })),
        hijack_urls: hijackUrls.slice(0, 10),
        js_intercepted: dedupInt.slice(0, 10),
        redirect_chains: dedupRed.slice(0, 10),
      },
    };
  } catch (e) {
    return { success: false, error: String(e.message || e).split('\n')[0], elapsed_sec: Math.round((Date.now() - t0) / 100) / 10 };
  } finally {
    clearTimeout(killer);
    await context.close().catch(() => {});
  }
}

const app = express();
app.get('/health', (_req, res) => res.json({
  ok: true, service: 'deep-visit', version: WORKER_VERSION,
  active, queued: waiters.length,
  blocklist_domains: BLOCK_SET.size, blocklist_ready: blocklistReady,
  blocklist_sources: blocklistStatus,
}));
app.get('/deep-check', auth, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ success: false, error: 'Missing URL' });
  const clicks = Math.min(10, Math.max(1, parseInt(req.query.clicks || '6', 10) || 6));
  const waitSec = Math.min(10, Math.max(1, parseFloat(req.query.wait || '2.5') || 2.5));
  const mobile = req.query.mobile === '1';
  const deep = req.query.deep !== '0';
  try {
    const result = await runLimited(() => analyze(String(url), {
      clicks, waitMs: Math.round(waitSec * 1000), mobile, deep,
    }));
    res.json(result);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('SIGTERM', async () => {
  try { if (browserPromise) await (await browserPromise).close(); } catch (_) {}
  process.exit(0);
});
app.listen(PORT, '0.0.0.0', () => {
  console.log('[deep-visit] ' + WORKER_VERSION + ' on port ' + PORT + ' (max concurrent: ' + MAX_CONCURRENT + ')' +
    (API_KEY ? '' : ' — WARNING: no key set') + (PROXY ? ' — proxy: ' + PROXY : ' — no proxy'));
});
