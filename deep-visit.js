// deep-visit.js — FSS Deep Visit Worker v5.4
// Node 18+; deps: express, playwright, playwright-extra, puppeteer-extra-plugin-stealth
// (по желание: patchright — виж DEEP_VISIT_ENGINE)

const express = require('express');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Двигател: по подразбиране playwright-extra + stealth. По желание (експериментално): patchright.
let chromium = null;
let ENGINE = 'playwright-extra';
if (process.env.DEEP_VISIT_ENGINE === 'patchright') {
  try {
    chromium = require('patchright').chromium;
    ENGINE = 'patchright';
  } catch (e) {
    console.warn('[deep-visit] patchright не е инсталиран, връщам playwright-extra:', String(e.message || e).split('\n')[0]);
  }
}
if (!chromium) {
  chromium = require('playwright-extra').chromium;
  chromium.use(require('puppeteer-extra-plugin-stealth')());
}

const PORT = process.env.DEEP_VISIT_PORT || 3001;
const API_KEY = process.env.DEEP_VISIT_KEY || '';
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.DEEP_VISIT_MAX_CONCURRENT || '1', 10));
const PROXY = process.env.DEEP_VISIT_PROXY || '';
const HEADFUL = process.env.DEEP_VISIT_HEADFUL === '1';
const NEW_HEADLESS = process.env.DEEP_VISIT_NEW_HEADLESS !== '0';
const DEFAULT_ROUNDS = Math.min(3, Math.max(1, parseInt(process.env.DEEP_VISIT_ROUNDS || '2', 10) || 2));
const ALLOW_QUERY_KEY = process.env.DEEP_VISIT_ALLOW_QUERY_KEY !== '0';
const EXTRA_ARGS = (process.env.DEEP_VISIT_EXTRA_ARGS || '').split(',').map((s) => s.trim()).filter(Boolean);
const BLOCKLIST_TTL_MS = 24 * 3600 * 1000;
const WORKER_VERSION = 'v5.5';
const QUIET_CONSOLE_DEFAULT = process.env.DEEP_VISIT_QUIET_CONSOLE !== '0';   // заглушава console.* срещу anti-devtool капани
const BLOCK_ANTIDEBUG = process.env.DEEP_VISIT_BLOCK_ANTIDEBUG !== '0';        // блокира известни anti-devtool скриптове
const SNAP_DIR = process.env.DEEP_VISIT_SNAPSHOT_DIR || path.join(os.tmpdir(), 'fss-snapshots');
const SNAP_KEEP = Math.max(5, parseInt(process.env.DEEP_VISIT_SNAPSHOT_KEEP || '20', 10) || 20);
const DEFAULT_LOCALE = process.env.DEEP_VISIT_LOCALE || 'en-US';
const DEFAULT_TZ = process.env.DEEP_VISIT_TZ || '';

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
  'uuidksinc.net','new-programmatic.com','liftdsp.com','whfcutler.com',
  'sneerscuartel.com','deofleadyetca.org','kentinedafile.org','leforgottedydisgu.org','rm358.com'
];

const POPUNDER_DOMAINS = [
  'popads.net','popcash.net','propellerads.com','propellerpops.com','onclickalgo.com','onclickmax.com',
  'onclckds.com','onclckpro.com','onclckstr.com','onclckinp.com','onclckmetrics.com',
  'profitablecpmrate.com','profitableratecpm.com','adsterra.com','displayformatcontent.com',
  'displayformatrevenue.com','effectiveratecpm.com','effectivegatecpm.com','highratecpm.com',
  'profitablegatecpm.com','revenuecpmgate.com','toprevenuegate.com','trustedgatetocontent.com',
  'exoclick.com','exosrv.com','juicyads.com','trafficjunky.com','clickadu.com','adcash.com',
  'monetag.com','ad-maven.com','hilltopads.net','adnium.com','exdynsrv.com','tsyndicate.com',
  'laiserpeglet.com','nidehetaira.com','ochringptolemy.com','alwingulla.com','betotodilea.com',
  'chooxaur.com','gloaphoo.net','phaurtuh.net','thaudray.com','whephoochi.com','zaubanel.com',
  'ptauxofi.net','jouteetu.net','loukoost.net','phicmune.net','toapoabu.net','zugnogne.com',
  'diketime.com','bytogeticr.com','wpadmngr.com','nawpush.com','capndr.com','ntvpforever.com',
  'cabnnr.com','metricswpsh.com','uuidksinc.net','whfcutler.com',
  'sneerscuartel.com','deofleadyetca.org','kentinedafile.org','leforgottedydisgu.org','rm358.com'
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
  'wikimedia.org','wikipedia.org','wikimediafoundation.org','themoviedb.org','tmdb.org'
];

const SOCIAL_HOSTS = [
  'facebook.com','fb.com','twitter.com','x.com','instagram.com','t.me','telegram.me','telegram.org',
  'whatsapp.com','reddit.com','pinterest.com','linkedin.com','tiktok.com'
];

const BENIGN_POPUP_HOSTS = [
  'play.google.com','apps.apple.com','itunes.apple.com','chromewebstore.google.com','addons.mozilla.org'
];

const ANALYTICS_LABELS = new Set([
  'intake-analytics','analytics','stats','telemetry','metrics','umami','matomo','piwik','collect','beacon'
]);

const MULTI_TLDS = new Set([
  'co.uk','org.uk','ac.uk','gov.uk','com.au','net.au','org.au','co.nz','co.jp','co.kr','co.in',
  'com.br','com.mx','com.tr','com.pl','com.ar','co.za','com.sg','com.hk','com.tw','co.il',
  'com.ua','com.ru','com.cn','com.co','com.pe','com.ve','com.ec','com.pk','com.bd','com.my',
  'com.ph','com.vn','co.id','co.th','or.id','web.id'
]);

// Попъндър мрежите връщат 5-байтов „пънч“ от типа "// mt" / "// pr", когато не желаят да покажат реклама
// (най-често защото IP-то е от хостинг). Самият отговор е признак за семейството.
const STUB_RE = /^\/\/\s*[a-z0-9]{1,6}\s*$/i;
const POPUNDER_PATH_RE = /(^|[\/_.-])(pop-?under|click-?under|popunder)([\/_.-]|$)/i;
// Примамки: страници за „безплатно сваляне“, афилиейт/оферта параметри и т.н.
const LURE_RE = /(download[-_]?free|free[-_]?download|download\.php|\/download\b|\/dl\/|[?&](clickid|click_id|affid|aff_id|offer_id|offerid|subid|sub_id|zoneid|zone_id)=|giftcard|survey|you-?won|prize|virus|update[-_]?(flash|chrome|browser))/i;
const ANTIDEBUG_URL_RE = /disable-devtool|devtools?-detect|devtools-detector|console-ban|fuck-devtools/i;
// Признаци в скрипт, който може да изпразни страницата / да засича автоматизация
const SCRIPT_FLAG_RES = [
  ['devtool_detect', /disable-devtool|devtools?-?detect|devtoolsDetector|isDevToolOpen|ondevtoolopen|DevToolsOpen/i],
  ['debugger_stmt', /\bdebugger\b\s*[;}]/],
  ['about_blank', /about:blank/],
  ['webdriver_check', /navigator\.webdriver|__webdriver|_phantom|callPhantom|__nightmare/],
  ['window_close', /window\.close\s*\(|top\.close\s*\(/],
  ['outer_size_check', /outerWidth\s*-\s*innerWidth|innerWidth\s*-\s*outerWidth|outerHeight\s*-\s*innerHeight|innerHeight\s*-\s*outerHeight/],
];

function scanScriptText(txt, host) {
  const flags = [];
  for (const [name, re] of SCRIPT_FLAG_RES) { if (re.test(txt)) flags.push(name); }
  // CDN библиотеки (jQuery и др.) често съдържат about:blank / close — не са интересни сами по себе си
  if (host && isLegitCdn(host) && flags.every((f) => f === 'about_blank' || f === 'window_close')) return [];
  return flags;
}

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
  'static','assets','cdn','content','api','web','app','box','hub','zone','base','core','dev'
];

// ---------------------------------------------------------------------------------------------
// Динамични блок-листове
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
    if (s.onlyIfPrevFailed && blocklistStatus[s.onlyIfPrevFailed] && blocklistStatus[s.onlyIfPrevFailed].ok) continue;
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
    return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') ||
      x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb');
  }
  return true;
}

const hostCache = new Map();
function hostAllowed(host) {
  const h = String(host || '').toLowerCase().replace(/^[|]$/g, '').replace(/\.$/, '');
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
    } catch { return true; }
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

function adMatchHost(h) {
  if (!h) return null;
  for (const ad of AD_DOMAINS) if (h === ad || h.endsWith('.' + ad)) return ad;
  if (isLegitCdn(h) || isAnalyticsHost(h)) return null;
  const hit = setMatch(AD_SET, h);
  if (!hit) return null;
  if (setMatch(ALLOW_SET, h)) return null;
  return hit;
}

function popunderMatchHost(h) {
  if (!h) return null;
  for (const d of POPUNDER_DOMAINS) if (h === d || h.endsWith('.' + d)) return d;
  return null;
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

function looksLikeDga(host) {
  if (!String(host || '').includes('.')) return false;
  const sld = getRootDomain(host).split('.')[0];
  if (!sld || sld.length < 8 || !/^[a-z0-9-]+$/.test(sld)) return false;
  for (const w of COMMON_WORDS) if (w.length >= 3 && sld.includes(w)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Статистика и текстови снимки (snapshots)
// ---------------------------------------------------------------------------------------------
const STATS = {
  started: Date.now(), total: 0, ok: 0, failed: 0, blanked: 0, saved_by_retry: 0, cf_blocked: 0,
  by_verdict: {}, by_label: {}, last_errors: [],
};

function recordStats(result) {
  try {
    STATS.total++;
    if (!result || !result.success) {
      STATS.failed++;
      STATS.last_errors.unshift({ ts: new Date().toISOString(), error: String((result && result.error) || 'unknown').slice(0, 160) });
      STATS.last_errors.length = Math.min(STATS.last_errors.length, 10);
      return;
    }
    STATS.ok++;
    if (result.cf_challenge) STATS.cf_blocked++;
    const d = result.diagnostics || {};
    if (d.blanked) STATS.blanked++;
    if (d.attempts && d.attempts.length > 1 && !d.blanked) STATS.saved_by_retry++;
    STATS.by_verdict[result.verdict] = (STATS.by_verdict[result.verdict] || 0) + 1;
    STATS.by_label[result.label] = (STATS.by_label[result.label] || 0) + 1;
  } catch (_) {}
}

function newSnapshotId(url) {
  const d = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  let slug = '';
  try { slug = new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 14); } catch (_) {}
  return d.slice(0, 8) + '-' + d.slice(8) + '-' + crypto.randomBytes(2).toString('hex') + (slug ? '-' + slug : '');
}

async function saveSnapshot(id, text) {
  await fs.promises.mkdir(SNAP_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(SNAP_DIR, id + '.txt'), text, 'utf8');
  try {
    const files = (await fs.promises.readdir(SNAP_DIR)).filter((f) => f.endsWith('.txt'));
    if (files.length > SNAP_KEEP) {
      const stats = await Promise.all(files.map(async (f) => ({ f, t: (await fs.promises.stat(path.join(SNAP_DIR, f))).mtimeMs })));
      stats.sort((a, b) => a.t - b.t);
      for (const x of stats.slice(0, files.length - SNAP_KEEP)) await fs.promises.unlink(path.join(SNAP_DIR, x.f)).catch(() => {});
    }
  } catch (_) {}
}

async function listSnapshots() {
  try {
    const files = (await fs.promises.readdir(SNAP_DIR)).filter((f) => f.endsWith('.txt'));
    const out = [];
    for (const f of files) {
      try {
        const st = await fs.promises.stat(path.join(SNAP_DIR, f));
        out.push({ id: f.replace(/\.txt$/, ''), bytes: st.size, ts: new Date(st.mtimeMs).toISOString(), mtime: st.mtimeMs });
      } catch (_) {}
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out.map(({ mtime, ...r }) => r);
  } catch (_) { return []; }
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

async function syncClientHints(p, ua, isMobile, fullVer, lang) {
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
      acceptLanguage: lang || 'en-US',
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
  } catch (_) {}
}

function hookScript(cfg) {
  const bindName = cfg && cfg.bind;
  const quiet = !!(cfg && cfg.quiet);
  try {
    // Маскиране на подменените функции като „native“
    const nativeToString = Function.prototype.toString;
    const mask = new WeakMap();
    const toStringWrapper = function toString() {
      if (mask.has(this)) return mask.get(this);
      return nativeToString.call(this);
    };
    mask.set(toStringWrapper, 'function toString() { [native code] }');
    try { Function.prototype.toString = toStringWrapper; } catch (_) {}

    const camouflage = (fn, orig, name) => {
      try { mask.set(fn, nativeToString.call(orig)); } catch (_) {}
      try { Object.defineProperty(fn, 'name', { value: name }); } catch (_) {}
      return fn;
    };

    // Тих режим на конзолата: anti-devtool капаните (console.log/debug/table с „капан“ обект) засичат
    // автоматизацията през DevTools протокола. Без реални console.* повиквания няма какво да се засече.
    if (quiet && typeof console === 'object') {
      for (const n of ['log', 'info', 'debug', 'table', 'dir', 'dirxml', 'trace', 'clear', 'group', 'groupCollapsed',
        'groupEnd', 'count', 'countReset', 'time', 'timeEnd', 'timeLog', 'assert', 'profile', 'profileEnd']) {
        try {
          const o = console[n];
          if (typeof o === 'function') console[n] = camouflage(function () {}, o, n);
        } catch (_) {}
      }
      for (const n of ['warn', 'error']) {
        try {
          const o = console[n];
          if (typeof o !== 'function') continue;
          console[n] = camouflage(function () {
            try { return o.apply(console, Array.prototype.map.call(arguments, (a) => (a && typeof a === 'object') ? '[object]' : a)); } catch (_) {}
          }, o, n);
        } catch (_) {}
      }
    }

    // Размери на прозореца (някои защити сравняват outer/inner)
    try {
      if (!window.outerWidth) Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth || 1920 });
      if (!window.outerHeight) Object.defineProperty(window, 'outerHeight', { get: () => (window.innerHeight || 1080) + 85 });
    } catch (_) {}

    // Страницата не трябва да може да затвори себе си (anti-bot). Фалшиво „затваряне“ не променя нищо за анализа.
    try {
      const oc = window.close;
      if (typeof oc === 'function') window.close = camouflage(function () {}, oc, 'close');
    } catch (_) {}

    if (!bindName) return;

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
// Статичен анализ на HTML (резервен вариант, когато браузърът е блокиран или не стига до плеера)
// ---------------------------------------------------------------------------------------------
async function fetchHtmlSafe(rawUrl, ua, lang) {
  let cur = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertSafeUrl(cur);
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 10000);
    try {
      const r = await fetch(u.href, {
        signal: c.signal, redirect: 'manual',
        headers: { 'user-agent': ua, 'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'accept-language': lang || 'en-US' },
      });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { cur = new URL(r.headers.get('location'), u.href).href; continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      return { url: u.href, status: r.status, bytes: buf.length, html: buf.toString('utf8', 0, 1500000) };
    } finally { clearTimeout(t); }
  }
  throw new Error('too many redirects');
}

function staticScanHtml(html, baseUrl, siteRoots) {
  const out = {
    title: '', bytes: html.length, scripts_total: 0, inline_scripts: 0, third_party_script_hosts: [],
    ad_hosts: [], popunder_hosts: [], iframes: [], media_urls: [], watch_links: [], inline_flags: [], meta_refresh: false,
  };
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) out.title = t[1].replace(/\s+/g, ' ').trim().slice(0, 120);
  out.meta_refresh = /<meta[^>]+http-equiv=["']?refresh/i.test(html);
  const base = (() => { try { return new URL(baseUrl); } catch { return null; } })();
  const abs = (x) => { try { return new URL(x, base || undefined).href; } catch { return null; } };
  const roots = siteRoots instanceof Set ? siteRoots : new Set();
  if (base) roots.add(getRootDomain(base.hostname));

  const tp = new Set(), ads = new Set(), pops = new Set();
  const reScript = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = reScript.exec(html))) {
    out.scripts_total++;
    const src = (m[1].match(/\bsrc=["']([^"']+)["']/i) || [])[1];
    if (src) {
      const a = abs(src);
      if (!a) continue;
      let h = '';
      try { h = new URL(a).hostname.toLowerCase(); } catch (_) { continue; }
      if (!roots.has(getRootDomain(h))) tp.add(h);
      const ad = adMatchHost(h);
      if (ad) ads.add(ad);
      const pu = popunderMatchHost(h);
      if (pu) pops.add(pu);
    } else if (m[2] && m[2].trim()) {
      out.inline_scripts++;
      const fl = scanScriptText(m[2], '');
      for (const f of fl) if (!out.inline_flags.includes(f)) out.inline_flags.push(f);
    }
  }
  out.third_party_script_hosts = Array.from(tp).slice(0, 25);
  out.ad_hosts = Array.from(ads).slice(0, 15);
  out.popunder_hosts = Array.from(pops).slice(0, 10);

  const seenI = new Set();
  const reIf = /<iframe\b[^>]*?\b(?:data-)?src=["']([^"']+)["']/gi;
  while ((m = reIf.exec(html)) && out.iframes.length < 8) {
    const a = abs(m[1]);
    if (!a || seenI.has(a) || !/^https?:/i.test(a)) continue;
    seenI.add(a);
    out.iframes.push(a.slice(0, 160));
  }
  const unesc = html.replace(/\\\//g, '/');
  const seenM = new Set();
  const reMedia = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4)(?:\?[^\s"'<>\\]*)?/gi;
  while ((m = reMedia.exec(unesc)) && out.media_urls.length < 8) {
    if (seenM.has(m[0])) continue;
    seenM.add(m[0]);
    out.media_urls.push(m[0].slice(0, 160));
  }
  const seenW = new Set();
  const reA = /<a\b[^>]*?\bhref=["']([^"'#]+)["']/gi;
  while ((m = reA.exec(html)) && out.watch_links.length < 8) {
    const a = abs(m[1]);
    if (!a || !/^https?:/i.test(a)) continue;
    let u;
    try { u = new URL(a); } catch (_) { continue; }
    if (!roots.has(getRootDomain(u.hostname))) continue;
    if (!/\/(watch|play|episode|stream|embed|movie|series|tv)[-/]/i.test(u.pathname)) continue;
    if (seenW.has(u.pathname)) continue;
    seenW.add(u.pathname);
    out.watch_links.push(a.slice(0, 160));
  }
  out.player_hint = out.iframes.some((x) => !adDomainMatch(x)) || out.media_urls.length > 0;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Основен анализ
// ---------------------------------------------------------------------------------------------
const CF_RE = /just a moment|verifying you are human|verify you are human|checking your browser|attention required/i;
// Фикс: Разширен PLAYER_SEL за по-модерни контейнери
const PLAYER_SEL = 'video, iframe, [id*="player" i], [class*="player" i], [class*="embed" i], [id*="embed" i], [class*="stream" i], [class*="jwplayer"], [class*="video-js"], [class*="plyr"], [class*="dplayer"], [class*="artplayer"], [id*="video" i]';
const PLAY_SEL = 'a, button, [role="button"], [class*="play"], [class*="watch"], [class*="btn"]';
const FILTER_SEL = 'a, button, [role="button"], .play, [class*="play"], [class*="poster"], [class*="card"]';

function countOverlays() {
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
  return overlays;
}

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

  const S = {
    popupRecords: [], hijackUrls: [], interceptedOpens: [], redirectChains: [],
    externalScripts: new Set(), unknownHosts: new Set(), adHosts: new Map(), trackerHosts: new Map(),
    adNavHosts: new Map(), popunderHosts: new Map(), adResponses: [], clickLog: [], downloads: 0,
    siteRoots: new Set([startRoot]), detailReached: false, playerFound: false, playerClicked: false,
    playerUrl: null, title: '', cfChallenge: false, navError: null, loaded: false, techStack: 'unknown',
    hasVideo: false, hasIframe: false, hasM3u8: false, overlays: 0, debug: [],
    nav: [], pageErrors: [], consoleMsgs: [], docs: [], scriptScan: [], antiBlocked: [],
    stubHosts: new Map(), attempts: [], blanked: false, blank: null,
  };
  const quiet = opts.quiet == null ? QUIET_CONSOLE_DEFAULT : !!opts.quiet;
  
  const roundsInfo = [];
  const lang = opts.locale || DEFAULT_LOCALE;
  const tzId = opts.tz || DEFAULT_TZ;
  let savedState = null;
  const maxRounds = opts.deep ? Math.min(3, Math.max(1, opts.rounds || DEFAULT_ROUNDS)) : 1;
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const rawBad = () => S.popupRecords.length + S.hijackUrls.length + S.downloads;

  async function runRound(idx, target, direct, profile = 'standard') {
    const bare = profile === 'bare';   // „bare“: без нашите куки в страницата (hooks, тиха конзола, блокиране на anti-debug)
    const roundStart = Date.now();
    const info = { round: idx + 1, profile, target: target.slice(0, 200), direct, clicks: 0, player_found: false, player_clicks: 0, popups: 0, blocked: false };
    const popupsBefore = S.popupRecords.length;
    const total = idx === 0 ? opts.clicks : Math.min(opts.clicks, 4);
    const waitMs = opts.waitMs;
    const ctxOpts = {
      userAgent: ua,
      viewport: isMobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
      locale: lang, ignoreHTTPSErrors: true, isMobile, hasTouch: isMobile,
      deviceScaleFactor: isMobile ? 3 : 1, acceptDownloads: false,
    };
    if (tzId) ctxOpts.timezoneId = tzId;
    if (opts.returning && savedState) ctxOpts.storageState = savedState;
    
    const context = await browser.newContext(ctxOpts);
    const killer = setTimeout(() => context.close().catch(() => {}), Math.max(15000, deadline - Date.now() + 5000));
    let phase = 'load';
    let page = null;
    let lastMainUrl = target;
    let lastSiteUrl = target;
    let midBlank = false;
    let closing = false;   // ние затваряме страницата (не сайтът)
    let clicks = 0;
    const clickedSigs = new Set();

    try {
      // Защита (SSRF) + блокиране на известни anti-devtool скриптове.
      // При ГРЕШКА в проверката заявката се БЛОКИРА (във v5.3 минаваше).
      await context.route('**/*', async (route) => {
        let ok = false;
        try {
          const req = route.request();
          const u = new URL(req.url());
          if (!bare && BLOCK_ANTIDEBUG && ANTIDEBUG_URL_RE.test(u.href)) {
            if (S.antiBlocked.length < 8) S.antiBlocked.push(u.href.slice(0, 160));
            ok = false;
          } else if (u.protocol === 'http:' || u.protocol === 'https:') {
            ok = await hostAllowed(u.hostname);
          } else {
            ok = /^(data|blob|about|ws|wss):$/.test(u.protocol);
          }
        } catch (_) { ok = false; }
        if (!ok) return route.abort('blockedbyclient').catch(() => {});
        return route.continue().catch(() => {});
      });

      if (!bare) {
        const bindName = '_f' + crypto.randomBytes(6).toString('hex');
        await context.exposeBinding(bindName, (_src, type, u, pageUrl) => {
          try {
            if (S.interceptedOpens.length < 200) {
              S.interceptedOpens.push({ type: String(type), url: String(u).slice(0, 300), page: String(pageUrl).slice(0, 160), ts: Date.now(), round: idx + 1 });
            }
          } catch (_) {}
        });
        await context.addInitScript(hookScript, { bind: bindName, quiet });
      }

      page = await context.newPage();
      await syncClientHints(page, ua, isMobile, fullVer, lang);
      // Диагностика: времева линия на навигациите, грешки на страницата, затваряне
      page.on('close', () => { if (!closing && S.nav.length < 80) S.nav.push({ round: idx + 1, profile, t: Date.now() - roundStart, event: 'page_closed' }); });
      page.on('pageerror', (e) => { if (S.pageErrors.length < 12) S.pageErrors.push({ round: idx + 1, profile, t: Date.now() - roundStart, msg: String((e && e.message) || e).slice(0, 160) }); });
      page.on('console', (m) => {
        try {
          const ty = m.type();
          if ((ty === 'error' || ty === 'warning') && S.consoleMsgs.length < 12) S.consoleMsgs.push({ round: idx + 1, profile, t: Date.now() - roundStart, type: ty, msg: m.text().slice(0, 160) });
        } catch (_) {}
      });
      page.on('dialog', (d) => (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}));
      page.on('download', () => { S.downloads++; });
      page.on('crash', () => { info.crashed = true; });
      page.on('framenavigated', (fr) => {
        if (fr !== page.mainFrame()) return;
        const u = fr.url();
        if (S.nav.length < 80) S.nav.push({ round: idx + 1, profile, t: Date.now() - roundStart, url: String(u).slice(0, 200) });
        if (!u || u === 'about:blank' || u === lastMainUrl) return;
        const prev = lastMainUrl;
        lastMainUrl = u;
        let h;
        try { h = new URL(u).hostname.toLowerCase(); } catch { return; }
        if (h && S.siteRoots.has(getRootDomain(h))) lastSiteUrl = u;
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
        syncClientHints(p, ua, isMobile, fullVer, lang).catch(() => {});
        setTimeout(() => { p.close().catch(() => {}); }, S.popupRecords.length > 12 ? 300 : 5000);
      });

      context.on('request', (req) => {
        try {
          const fr = req.frame();
          const pg = fr ? fr.page() : null;
          if (!pg || pg !== page) return;
          const u = new URL(req.url());
          const host = u.hostname.toLowerCase();
          if (!host) return;
          const ad = adMatchHost(host);
          if (ad) { bump(S.adHosts, ad); const pu = popunderMatchHost(host); if (pu) bump(S.popunderHosts, pu); }
          else {
            const tr = trackerMatchHost(host);
            if (tr) bump(S.trackerHosts, tr);
          }
          if (!S.siteRoots.has(getRootDomain(host)) && POPUNDER_PATH_RE.test(u.pathname)) bump(S.popunderHosts, getRootDomain(host));
          const rType = req.resourceType();
          if (!S.siteRoots.has(getRootDomain(host)) && !isSocialUrl(req.url()) &&
            (rType === 'script' || rType === 'document' || rType === 'subdocument')) {
            S.externalScripts.add(host);
            if (!ad && !isLegitCdn(host) && !isAnalyticsHost(host) && looksLikeDga(host)) S.unknownHosts.add(host);
          }
        } catch (_) {}
      });

      // Основен документ (суров HTML) и скриптове: пазим суровия HTML за диагностика и търсим скриптове,
      // които могат да изпразнят страницата / да засичат автоматизация, както и „пънч“ скриптове на попъндър мрежи.
      const onDocOrScript = async (res) => {
        const rq = res.request();
        const rt = rq.resourceType();
        if (rt !== 'document' && rt !== 'script') return;
        let fr = null;
        try { fr = rq.frame(); } catch (_) {}
        if (!fr) return;
        let pg = null;
        try { pg = fr.page(); } catch (_) {}
        if (!pg || pg !== page) return;
        const ru = new URL(res.url());
        const host = ru.hostname.toLowerCase();
        if (rt === 'document') {
          if (fr !== page.mainFrame()) return;
          if (S.docs.filter((d) => d.round === idx + 1 && d.profile === profile).length >= 4) return;
          const st = res.status();
          let html = '', bytes = null;
          if (st < 300 || st >= 400) {
            try { const b = await res.body(); bytes = b.length; html = b.toString('utf8', 0, 150000); } catch (_) {}
          }
          S.docs.push({ round: idx + 1, profile, url: res.url().slice(0, 200), status: st, bytes, ct: String(res.headers()['content-type'] || '').slice(0, 40), html });
          return;
        }
        if (S.scriptScan.length >= 60) return;
        let b;
        try { b = await res.body(); } catch (_) { return; }
        const txt = b.toString('utf8', 0, 250000);
        const sameSite = S.siteRoots.has(getRootDomain(host));
        const stub = !sameSite && b.length <= 20 && STUB_RE.test(txt.trim());
        if (stub) {
          bump(S.stubHosts, getRootDomain(host));
          if (!adMatchHost(host)) bump(S.popunderHosts, getRootDomain(host));
        }
        const flags = scanScriptText(txt, host);
        if (flags.length || stub) {
          let snippet = null;
          if (flags.length) {
            const re = SCRIPT_FLAG_RES.find((x) => x[0] === flags[0])[1];
            const mm = re.exec(txt);
            if (mm) snippet = txt.slice(Math.max(0, mm.index - 60), mm.index + 100).replace(/\s+/g, ' ');
          }
          S.scriptScan.push({ round: idx + 1, profile, host, path: (ru.pathname + ru.search).slice(0, 80), bytes: b.length, third_party: !sameSite, flags, stub, snippet });
        }
      };

      context.on('response', async (res) => {
        try { await onDocOrScript(res); } catch (_) {}
        try {
          const ru = new URL(res.url());
          const host = ru.hostname.toLowerCase();
          if (S.adResponses.length < 16 && adMatchHost(host)) {
            const h = res.headers();
            const entry = { round: idx + 1, host: ru.hostname, path: (ru.pathname + ru.search).slice(0, 60), status: res.status(), type: String(h['content-type'] || '').slice(0, 40), len: h['content-length'] || null, bytes: null, snippet: null, set_cookie: !!h['set-cookie'] };
            S.adResponses.push(entry);
            try {
              const b = await res.body();
              entry.bytes = b.length;
              entry.snippet = b.toString('utf8', 0, 160).replace(/\s+/g, ' ');
              
              // Попъндър семейство: 5-байтов „пънч“ ("// mt", "// pr" ...) вместо реален скрипт
              if (b.length <= 20 && STUB_RE.test(b.toString('utf8').trim())) {
                bump(S.popunderHosts, getRootDomain(host));
                bump(S.stubHosts, getRootDomain(host));
                entry.stub = true;
              }
            } catch (_) {}
          }
        } catch (_) {}
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

      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (err) {
        if (!S.loaded) S.navError = String(err.message || err).split('\n')[0];
      }
      await sleep(2500);

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
      lastSiteUrl = lastMainUrl && lastMainUrl !== 'about:blank' ? lastMainUrl : target;

      // Страницата „изпразнена“ от самия сайт (about:blank / затворена / празен DOM)?
      const blankCheck = async () => {
        let url = '';
        try { url = page.url(); } catch (_) {}
        if (page.isClosed()) return { kind: 'page_closed' };
        if (url === 'about:blank' || url === '') return { kind: 'about_blank' };
        try {
          const rawBytes = Math.max(0, ...S.docs.filter((d) => d.round === idx + 1 && d.profile === profile).map((d) => d.bytes || 0));
          const d = await page.evaluate(() => ({ els: document.getElementsByTagName('*').length, text: (document.body ? document.body.innerText : '').trim().length }));
          if (rawBytes >= 5000 && d.els <= 8 && d.text === 0) return { kind: 'empty_dom' };
        } catch (_) {}
        return null;
      };
      const finishBlank = (bk) => {
        info.blanked = true;
        info.blank_kind = bk.kind;
        const bn = S.nav.find((n) => n.round === idx + 1 && n.profile === profile && n.url === 'about:blank');
        info.blank_at_ms = bn ? bn.t : (Date.now() - roundStart);
        info.last_site_url = String(lastSiteUrl).slice(0, 200);
        return info;
      };
      {
        const bk0 = await blankCheck();
        if (bk0) return finishBlank(bk0);
      }

      const vp = page.viewportSize() || { width: 1280, height: 720 };
      for (let i = 0; i < 4; i++) {
        try {
          if (isMobile) await page.evaluate((y) => window.scrollBy(0, y), 120 + i * 40);
          else {
            await page.mouse.move(rnd(vp.width * 0.2, vp.width * 0.8), rnd(vp.height * 0.2, vp.height * 0.8), { steps: 8 });
            if (i === 1) await page.mouse.wheel(0, 300);
            if (i === 3) await page.mouse.wheel(0, -300);
          }
        } catch (_) {}
        await sleep(850);
      }
      {
        const bk1 = await blankCheck();
        if (bk1) return finishBlank(bk1);
      }

      const dwellMs = Math.min(Math.max(0, (opts.dwell || 0) * 1000), Math.max(0, deadline - Date.now() - 60000));
      for (let t = 0; t < dwellMs; t += 2000) {
        try {
          if (!isMobile) await page.mouse.move(rnd(vp.width * 0.2, vp.width * 0.8), rnd(vp.height * 0.2, vp.height * 0.8), { steps: 6 });
          else await page.evaluate(() => window.scrollBy(0, 80));
        } catch (_) {}
        await sleep(Math.min(2000, dwellMs - t));
      }
      {
        const bk2 = await blankCheck();
        if (bk2) return finishBlank(bk2);
      }
      phase = 'interact';

      if (idx === 0) {
        try {
          const pageInfo = await page.evaluate(() => {
            const html = document.documentElement.outerHTML.slice(0, 250000);
            const isNextOrReact = Boolean(document.getElementById('__next') || document.getElementById('root') || window.__NEXT_DATA__ || document.querySelector('[data-reactroot]'));
            return { isNextOrReact, v: document.querySelectorAll('video').length, i: document.querySelectorAll('iframe').length, h: html };
          });
          S.techStack = pageInfo.isNextOrReact ? 'spa_react_next' : 'classic_ssr_php';
          S.overlays = Math.min(3, await page.evaluate(countOverlays).catch(() => 0));
          S.hasVideo = pageInfo.v > 0;
          S.hasIframe = pageInfo.i > 0;
          S.hasM3u8 = /\.m3u8|\.mpd/.test(pageInfo.h);
        } catch (_) {}
      }

      function refreshDetail() {
        try {
          const p = new URL(page.url()).pathname;
          S.detailReached = S.detailReached || /\/(watch|watching|episode|player|vod|detail|play|stream|embed|view|video|film|movie|movies|tv|series|anime|drama)\/[^/]+/i.test(p) || /\/(watch|play|watching|episode)\b/i.test(p);
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
        if (sameTab) { try { await h.evaluate((el) => { if (el.tagName === 'A' && el.target === '_blank') el.target = '_self'; }); } catch (_) {} }
        try { await h.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch (_) {}
        let box = null;
        try { box = await h.boundingBox(); } catch (_) {}
        try {
          const im = await h.$('img');
          const ib = im ? await im.boundingBox() : null;
          if (ib && (!box || ib.width * ib.height > box.width * box.height)) box = ib;
        } catch (_) {}
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

      async function step(type, fn) {
        if (clicks >= total || Date.now() > deadline - 3000) return false;
        try { if (page.isClosed() || page.url() === 'about:blank') { midBlank = true; return false; } } catch (_) {}
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

      async function snap(label) {
        if (!opts.debug || S.debug.length >= 10) return;
        try {
          const d = await page.evaluate(() => {
            const cut = (x, n) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, n);
            const box = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top + scrollY), vis: st.visibility !== 'hidden' && st.display !== 'none' }; };
            return {
              iframes: Array.from(document.querySelectorAll('iframe')).slice(0, 10).map((f) => ({ src: cut(f.src || f.getAttribute('src') || f.getAttribute('data-src'), 120), ...box(f) })),
              videos: document.querySelectorAll('video').length,
              player_like: Array.from(document.querySelectorAll('[id*="player" i], [class*="player" i]')).slice(0, 8).map((e) => ({ tag: e.tagName.toLowerCase(), id: cut(e.id, 30), cls: cut(e.className, 50), ...box(e) })),
              buttons: Array.from(document.querySelectorAll('a, button, [role="button"]')).filter((e) => /play|watch|server|episode|season|стрийм|▶/i.test((e.innerText || '') + ' ' + (e.className || ''))).slice(0, 14)
                .map((e) => ({ tag: e.tagName.toLowerCase(), text: cut(e.innerText, 30), href: cut(e.getAttribute('href'), 70), cls: cut(e.className, 40), ...box(e) })),
              links: Array.from(document.querySelectorAll('a[href]')).filter((a) => a.hostname === location.hostname).slice(0, 400)
                .map((a) => { const r = a.getBoundingClientRect(); const im = a.querySelector('img'); return { href: cut(a.getAttribute('href'), 60), text: cut(a.innerText, 20), img: !!im, w: Math.round(Math.max(r.width, im ? im.getBoundingClientRect().width : 0)), anc: cut(a.parentElement ? a.parentElement.className : '', 30), nav: !!a.closest('nav, header, footer') }; })
                .filter((l) => !l.nav).slice(0, 12),
              text: cut(document.body ? document.body.innerText : '', 250),
            };
          });
          S.debug.push({ label, round: idx + 1, url: page.url().slice(0, 140), ...d });
        } catch (_) {}
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
              if (r.width < 220 || r.height < 120) continue;
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
        const pick = await page.evaluate(({ sel, roots, multi }) => {
          const els = Array.from(document.querySelectorAll(sel));
          let best = null, bestS = 0;
          const rootOf = (h) => { const p = h.toLowerCase().split('.').filter(Boolean); if (p.length <= 2) return p.join('.'); const t = p.slice(-2).join('.'); return multi.indexOf(t) !== -1 ? p.slice(-3).join('.') : t; };
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
              
              // Фикс: SVG Play бутони без текст
              if (!t && el.querySelector('svg') && r.width >= 36 && r.width <= 140 && r.height >= 36 && r.height <= 140 && r.top > 100 && r.top < window.innerHeight * 0.85) {
                s += 3;
              }
              
              if (el.closest('header, nav, footer')) s -= 3;
              if (s > bestS) bestS = s, best = { idx: i, sig: el.tagName + '|' + href + '|' + cls.slice(0, 60) + '|' + t.slice(0, 30) };
            } catch (_) {}
          }
          return bestS >= 3 ? best : null;
        }, { sel: PLAY_SEL, roots: Array.from(S.siteRoots), multi: Array.from(MULTI_TLDS) }).catch(() => null);
        if (!pick || clickedSigs.has(pick.sig)) return null;
        const h = (await page.$$(PLAY_SEL))[pick.idx];
        if (!h) return null;
        clickedSigs.add(pick.sig);
        return await clickHandle(h, true);
      }

      async function findContentLink() {
        const cur = page.url();
        const pick = await page.evaluate(({ roots, cur, multi }) => {
          const bad = /\/(genre|genres|country|login|register|signin|signup|filter|search|tag|tags|actor|actors|director|year|type|page|privacy|terms|dmca|contact|about|faq|category|categories|az-list|a-z|top-imdb|most-popular|upcoming|release|schedule|news|blog)(\/|$|\.)/i;
          const good = /(movie|movies|film|watch|series|tv|episode|anime|drama|show|video|stream|play|detail|vod|title|info|season)/i;
          const rootOf = (h) => { const p = h.toLowerCase().split('.').filter(Boolean); if (p.length <= 2) return p.join('.'); const t = p.slice(-2).join('.'); return multi.indexOf(t) !== -1 ? p.slice(-3).join('.') : t; };
          const as = Array.from(document.querySelectorAll('a[href]'));
          let best = null, bestS = 0;
          for (let i = 0; i < as.length; i++) {
            try {
              const a = as[i];
              if (a.closest('nav, header, footer, [role="navigation"], [class~="menu"], [class~="navbar"], [class~="nav"], [class~="sidebar"]')) continue;
              const u = new URL(a.href);
              if (!/^https?:$/.test(u.protocol) || !roots.includes(rootOf(u.hostname))) continue;
              if (a.href === cur || bad.test(u.pathname) || u.pathname.length < 4) continue;
              const r = a.getBoundingClientRect();
              const im = a.querySelector('img');
              const ir = im ? im.getBoundingClientRect() : null;
              const w = Math.max(r.width, ir ? ir.width : 0), hh = Math.max(r.height, ir ? ir.height : 0);
              if (w < 30 || hh < 18) continue;
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
          if (bestS >= 2) return best;

          const cards = Array.from(document.querySelectorAll('div, article, li'));
          for (let i = 0; i < cards.length; i++) {
            try {
              const el = cards[i];
              if (el.closest('nav, header, footer, [role="navigation"], [class~="menu"], [class~="navbar"], [class~="nav"], [class~="sidebar"]')) continue;
              const im = el.querySelector('img');
              if (!im) continue;
              const r = el.getBoundingClientRect();
              if (r.width < 100 || r.width > 360 || r.height < 140 || r.height > 520) continue;
              if (r.right <= 0 || r.left >= window.innerWidth) continue;
              const elStyle = getComputedStyle(el);
              const imStyle = getComputedStyle(im);
              if (elStyle.cursor !== 'pointer' && imStyle.cursor !== 'pointer') continue;
              if (elStyle.visibility === 'hidden' || elStyle.display === 'none') continue;
              const sig = 'CARD|' + (im.alt || im.src || '').slice(0, 60);
              return { idx: i, sig, isCard: true };
            } catch (_) {}
          }
          return null;
        }, { roots: Array.from(S.siteRoots), cur, multi: Array.from(MULTI_TLDS) }).catch(() => null);

        if (!pick || clickedSigs.has(pick.sig)) return null;

        let h;
        if (pick.isCard) {
          h = (await page.$$('div, article, li'))[pick.idx];
        } else {
          h = (await page.$$('a[href]'))[pick.idx];
        }

        if (!h) return null;
        clickedSigs.add(pick.sig);
        return await clickHandle(h, true);
      }

      async function findServerTab() {
        const pick = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('a, button, li, div, span'));
          let best = null, bestS = 0;
          for (let i = 0; i < els.length; i++) {
            try {
              const el = els[i];
              if (el.children.length > 3) continue;
              const t = (el.innerText || '').trim();
              if (!t || t.length > 24) continue;
              const r = el.getBoundingClientRect();
              if (r.width < 24 || r.height < 16) continue;
              const st = getComputedStyle(el);
              if (st.visibility === 'hidden' || st.display === 'none') continue;
              const cls = String(el.className || '').toLowerCase();
              if (/\bactive\b|\bcurrent\b|\bselected\b/.test(cls)) continue;
              let s = 0;
              if (/^(server|source|mirror|player|embed)\s*[#:]?\s*\d*$/i.test(t)) s = 4;
              else if (/^(vidcloud|upcloud|megacloud|streamtape|doodstream|voe|filemoon|mixdrop|vidplay|vidsrc|embedsu)\b/i.test(t)) s = 3;
              else if (/server[-_]?(item|btn|tab|link)|(^|\s)sv-|source[-_]?item|link-item/.test(cls)) s = 3;
              if (s > 0 && s >= bestS) { bestS = s; best = { idx: i, sig: 'SV|' + t.slice(0, 20) + '|' + cls.slice(0, 40) }; }   // при равен резултат — най-вътрешният елемент
            } catch (_) {}
          }
          return bestS >= 3 ? best : null;
        }).catch(() => null);
        if (!pick || clickedSigs.has(pick.sig)) return null;
        const h = (await page.$$('a, button, li, div, span'))[pick.idx];
        if (!h) return null;
        clickedSigs.add(pick.sig);
        return await clickHandle(h, true);
      }

      async function findEpisodeLink() {
        const pick = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('a, button, li, div, span'));
          let best = null, bestS = 0;
          for (let i = 0; i < els.length; i++) {
            try {
              const el = els[i];
              if (el.children.length > 3) continue;
              const t = (el.innerText || '').trim();
              if (!t || t.length > 40) continue;
              const r = el.getBoundingClientRect();
              if (r.width < 20 || r.height < 15) continue;
              const st = getComputedStyle(el);
              if (st.visibility === 'hidden' || st.display === 'none') continue;
              const cls = String(el.className || '').toLowerCase();
              let s = 0;
              if (/^(eps?\.?|episode|ep)\s*0*1\b/i.test(t)) s = 5;
              else if (/^(eps?\.?|episode|ep)\s*\d+/i.test(t)) s = 3;
              else if (/eps-item|episode-item|ep-item|episode_item/.test(cls)) s = 4;
              if (s > bestS) { bestS = s; best = { idx: i, sig: 'EP|' + t.slice(0, 30) + '|' + cls.slice(0, 40) }; }
            } catch (_) {}
          }
          return bestS >= 3 ? best : null;
        }).catch(() => null);
        if (!pick || clickedSigs.has(pick.sig)) return null;
        const h = (await page.$$('a, button, li, div, span'))[pick.idx];
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
              if (el.closest('nav, header, footer, [role="navigation"], [role="banner"], [class~="menu"], [class~="navbar"], [class~="nav"]')) continue;
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
              if (r.top < 80 && r.height < 80) continue;
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

      if (!direct) await step('center_probe', centerProbe);
      if (!opts.deep) {
        let guard = 0;
        while (clicks < total && guard++ < 20 && Date.now() < deadline - 3000 && !midBlank) {
          await step('filtered_element', filteredPick);
        }
      } else {
        let navClicks = 0, playerClicks = 0, filler = 0, lateWaitFor = '', scrolledFor = '', contentClicks = 0, returned = 0;
        for (let guard = 0; guard < 30 && clicks < total && Date.now() < deadline - 3000 && !midBlank; guard++) {
          await settle();
          if (page.isClosed() || page.url() === 'about:blank') { midBlank = true; break; }
          let cur = page.url();
          // Ако рекламата ни е изкарала от сайта — връщаме се на последната страница на сайта
          if (returned < 3 && lastSiteUrl && !S.siteRoots.has(rootOfUrl(cur))) {
            returned++;
            await page.goto(lastSiteUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await sleep(1200);
            cur = page.url();
          }
          const cand = await findPlayerCandidate();
          if (cand) {
            if (playerClicks >= 3) break;
            const ok = await step(playerClicks === 0 ? 'player_click' : 'player_click' + (playerClicks + 1), () => clickPlayer(cand, playerClicks));
            if (ok) { playerClicks++; info.player_clicks = playerClicks; continue; }
            break;
          }
          if (lateWaitFor !== cur) {
            lateWaitFor = cur;
            // SPA сайтовете (React/Next) рисуват плеера по-късно — изчакваме до няколко пъти
            const polls = S.techStack === 'spa_react_next' ? 5 : 1;
            for (let k = 0; k < polls; k++) { await sleep(k === 0 ? 2500 : 2000); if (await findPlayerCandidate()) break; }
            await snap('no_player_after_wait');
            continue;
          }
          if (navClicks < 4) {
            if (await step('play_button', findPlayButton)) { navClicks++; await sleep(1500); continue; }
            if ((S.detailReached || navClicks >= 1) && await step('episode_click', findEpisodeLink)) { navClicks++; await sleep(1500); continue; }
            if (navClicks >= 1 && await step('server_tab', findServerTab)) { navClicks++; await sleep(1500); continue; }
            if ((!S.detailReached || navClicks === 0) && contentClicks < 2) {
              if (await step('content_link', findContentLink)) { navClicks++; contentClicks++; await sleep(1500); continue; }
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
      if (midBlank) return finishBlank({ kind: page.isClosed() ? 'page_closed' : 'about_blank' });
      await snap('round_end');
      try { S.overlays = Math.max(S.overlays, Math.min(3, await page.evaluate(countOverlays))); } catch (_) {}
      await sleep(4000);
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
      if (opts.returning) { try { savedState = await context.storageState(); } catch (_) {} }
      closing = true;
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
      // Рунд 1: първо „standard“ профил; ако сайтът изпразни страницата — втори опит „bare“ (без нашите куки в страницата)
      const profiles = r === 0 ? ['standard', 'bare'] : ['standard'];
      let info = null;
      for (let pi = 0; pi < profiles.length; pi++) {
        const prof = profiles[pi];
        if (pi > 0 && deadline - Date.now() < 50000) break;
        try {
          info = await runRound(r, target, r > 0 || !!playUrl, prof);
        } catch (e) {
          info = { round: r + 1, profile: prof, target: target.slice(0, 200), error: String(e.message || e).split('\n')[0] };
          if (r === 0 && !S.loaded) {
            if (pi === profiles.length - 1) throw e;
            S.attempts.push({ round: r + 1, profile: prof, error: info.error });
            continue;
          }
        }
        S.attempts.push({ round: r + 1, profile: prof, blanked: !!info.blanked, blank_kind: info.blank_kind || null, blank_at_ms: info.blank_at_ms || null, clicks: info.clicks || 0, player_found: !!info.player_found });
        roundsInfo.push(info);
        const retry = r === 0 && info.blanked && prof === 'standard' && !S.playerClicked && pi < profiles.length - 1;
        if (!retry) break;
      }
      if (info && r === 0 && info.blanked) {
        S.blanked = true;
        S.blank = { kind: info.blank_kind, at_ms: info.blank_at_ms, profile: info.profile, last_site_url: info.last_site_url || null };
      }
      if (info && info.blocked) break;
    }

    // Статичен анализ на суровия HTML (резервен вариант): когато страницата е изпразнена или плеерът не е намерен
    let staticScan = null;
    if (opts.static !== false && (S.blanked || !S.playerFound)) {
      try {
        const doc = S.docs.find((d) => d.html && d.html.length > 200);
        let html = doc ? doc.html : '', src = 'browser_doc', baseUrl = doc ? doc.url : url, status = doc ? doc.status : null;
        if (!html) {
          const f = await fetchHtmlSafe(url, ua, lang);
          html = f.html; src = 'fetch'; baseUrl = f.url; status = f.status;
        }
        if (html) { staticScan = staticScanHtml(html, baseUrl, new Set(S.siteRoots)); staticScan.source = src; staticScan.status = status; }
      } catch (e) { staticScan = { error: String(e.message || e).split('\n')[0].slice(0, 120) }; }
    }

    const seenInt = new Set();
    const dedupInt = S.interceptedOpens.filter((x) => {
      if (isSocialUrl(x.url) || isBenignUrl(x.url)) return false;
      const k = x.type + '|' + x.url;
      if (seenInt.has(k)) return false;
      seenInt.add(k);
      return true;
    });

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
    const BENIGN_REDIRECT_RE = /\/pagead\/id|\/instream\/ad_status|\/ccm\/collect|\/pagead\/viewthroughconversion/i;
    const adRedirects = dedupRed.filter((x) => x.src === 'page' && (adDomainMatch(x.to) || adDomainMatch(x.from))
      && rootOfUrl(x.from) !== rootOfUrl(x.to)           // пренасочване в рамките на една и съща мрежа (напр. синхронизация на Google)
      && !BENIGN_REDIRECT_RE.test(x.from) && !BENIGN_REDIRECT_RE.test(x.to));
    const uniqueRedirects = new Set(adRedirects.map((x) => x.to)).size;

    const stubHosts = Array.from(S.stubHosts.keys());
    const popSet = new Set([...S.popunderHosts.keys(), ...((staticScan && staticScan.popunder_hosts) || [])]);
    const adSet2 = new Set([...S.adHosts.keys(), ...((staticScan && staticScan.ad_hosts) || [])]);
    const popunderCount = Math.min(2, popSet.size);
    const adHostCount = Math.min(15, Array.from(adSet2).filter((h) => !popSet.has(h)).length);
    const trackerCount = Math.min(8, S.trackerHosts.size);
    const extraJs = Math.max(0, uniqueJsOpens - popups);

    // Примамки: страници за „безплатно сваляне“, афилиейт/оферта линкове в рекламните вериги
    const lureCandidates = [...popupUrls, ...dedupRed.map((x) => x.to), ...S.hijackUrls];
    const lureUrls = Array.from(new Set(lureCandidates.filter((u) => u && !S.siteRoots.has(rootOfUrl(u)) && LURE_RE.test(u)))).slice(0, 6);

    // Голям прозрачен слой сам по себе не е реклама — брои се само ако има и други признаци за реклами
    const hasAdEvidence = adSet2.size > 0 || popSet.size > 0 || popups > 0 || uniqueRedirects > 0 || S.hijackUrls.length > 0;
    const overlayPoints = hasAdEvidence ? S.overlays * 2 : 0;

    const breakdown = {
      hijacks: S.hijackUrls.length * 10,
      popups: popups * 5,
      js_opens_beyond_popups: extraJs * 4,
      ad_redirects: uniqueRedirects * 3,
      overlays: overlayPoints,
      popunder_network_hosts: popunderCount * 8,
      unique_ad_hosts: adHostCount,
      unique_tracker_hosts: Math.floor(trackerCount * 0.5),
      downloads: S.downloads * 5,
      lure_pages: Math.min(3, lureUrls.length) * 3,
    };
    const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
    let level = 'none';
    if (score >= 30) level = 'high';
    else if (score >= 10) level = 'medium';
    else if (score >= 1) level = 'low';
    if (popSet.size > 0 && (level === 'none' || level === 'low')) level = 'medium';

    const observed = popups > 0 || S.hijackUrls.length > 0 || uniqueRedirects > 0 || S.downloads > 0 || extraJs > 0;
    const scoreBasis = observed ? 'observed_behaviour' : ((popSet.size > 0 || adSet2.size > 0) ? 'ad_scripts_only' : 'none');
    const riskFlags = [];
    if (popSet.size > 0) riskFlags.push('popunder_network');
    if (stubHosts.length > 0) riskFlags.push('popunder_stub_response');
    if (popups > 0) riskFlags.push('popups');
    if (S.hijackUrls.length > 0) riskFlags.push('page_hijack');
    if (S.downloads > 0) riskFlags.push('forced_download');
    if (lureUrls.length > 0) riskFlags.push('download_or_offer_lure');
    if (uniqueRedirects > 0) riskFlags.push('ad_redirects');

    const notes = [];
    if (S.cfChallenge) notes.push('cf_blocked');
    if (!S.loaded && !S.cfChallenge) notes.push('page_not_loaded');
    if (S.blanked) notes.push('page_blanked_by_site' + (S.blank && S.blank.kind ? ':' + S.blank.kind : ''));
    if (!S.blanked && S.attempts.length > 1 && S.attempts[0].blanked) notes.push('first_profile_blanked_retry_profile_worked');
    if (S.loaded && !S.playerClicked) notes.push('player_not_reached');
    if (S.overlays > 0 && !hasAdEvidence) notes.push('overlay_ignored_no_ads_detected');
    if (staticScan && staticScan.player_hint && !S.playerFound) notes.push('static_scan_sees_player_hint');
    const silentAds = S.playerClicked && popups === 0 && S.hijackUrls.length === 0 && adSet2.size > 0;
    if (silentAds) notes.push('ad_scripts_loaded_but_no_activity_environment_may_suppress_them');

    let confidence = 'high';
    if (S.cfChallenge || !S.loaded) confidence = 'none';
    else if (!S.playerClicked) confidence = 'low';
    else if (silentAds) confidence = 'medium';

    const inconclusive = confidence === 'none' || (confidence === 'low' && score < 10);
    let verdict;
    if (confidence === 'none') verdict = 'blocked_or_failed';
    else if (popups > 0 || S.hijackUrls.length > 0 || score >= 10) verdict = 'ads_detected';
    else if (adSet2.size >= 1 && !(S.playerClicked === false && popSet.size === 0)) verdict = 'ads_scripts_present';
    else if (inconclusive) verdict = 'inconclusive';
    else verdict = 'clean_or_light';

    // Прост етикет за показване на сайта
    let label = { none: 'Clean', low: 'Light', medium: 'Moderate', high: 'Aggressive' }[level];
    if (confidence === 'none' || (inconclusive && (level === 'none' || level === 'low'))) label = 'Unknown';

    // Дали резултатът е достатъчно надежден, за да влезе в оценката на сайта (за интеграцията в директорията)
    let usable = true, usableReason = 'ok';
    if (confidence === 'none') { usable = false; usableReason = S.cfChallenge ? 'cloudflare_challenge' : (S.blanked ? 'page_blanked_by_site' : 'page_not_loaded'); }
    else if (inconclusive) { usable = false; usableReason = 'inconclusive'; }
    else if (!S.playerClicked) { usable = false; usableReason = 'player_not_reached'; }
    const labelNote = scoreBasis === 'ad_scripts_only'
      ? 'Ad networks are present but no popups were observed from our test server; real visitors may see more.'
      : (scoreBasis === 'observed_behaviour' ? 'Based on behaviour observed during the test.' : 'No ad activity found.');

    // Диагностика: защо страницата е станала празна (най-вероятна причина по наличните данни)
    const sus = S.scriptScan.filter((x) => x.flags.length);
    let likelyCause = null;
    if (S.blanked) {
      const all = new Set(sus.flatMap((x) => x.flags).concat((staticScan && staticScan.inline_flags) || []));
      if (all.has('devtool_detect')) likelyCause = 'anti_devtool_script_present';
      else if (all.has('webdriver_check') || all.has('outer_size_check') || all.has('window_close')) likelyCause = 'automation_check_script_present';
      else if (S.antiBlocked.length) likelyCause = 'anti_devtool_script_was_blocked_but_page_still_blanked';
      else likelyCause = 'unknown_site_side_blanking_(automation_detection_or_server_ip_check)';
    } else if (S.attempts.length > 1 && S.attempts[0].blanked) {
      likelyCause = 'our_page_hooks_or_console_changes_were_detected_by_site';
    }
    const diagnostics = {
      blanked: S.blanked, blank_kind: S.blank ? S.blank.kind : null, blank_at_ms: S.blank ? S.blank.at_ms : null,
      last_site_url: S.blank ? S.blank.last_site_url : null, likely_cause: likelyCause,
      attempts: S.attempts, anti_debug_scripts_blocked: S.antiBlocked,
      suspicious_scripts: sus.slice(0, 12), stub_hosts: stubHosts,
      nav_timeline: S.nav.slice(0, 25), page_errors: S.pageErrors.slice(0, 8), console_messages: S.consoleMsgs.slice(0, 8),
      main_documents: S.docs.map((d) => ({ round: d.round, profile: d.profile, url: d.url, status: d.status, bytes: d.bytes, content_type: d.ct })),
      html_head: opts.debug && S.docs[0] && S.docs[0].html ? S.docs[0].html.slice(0, 4000) : undefined,
    };

    // Текстова снимка (файл на сървъра) — при debug=1, snapshot=1 или когато страницата е изпразнена
    let snapshotId = null;
    if (opts.debug || opts.snapshot || S.blanked) {
      try {
        snapshotId = newSnapshotId(url);
        const L = [];
        L.push('FSS deep-visit snapshot ' + snapshotId, 'time: ' + new Date().toISOString(), 'version: ' + WORKER_VERSION, 'url: ' + url,
          'verdict: ' + verdict + '  level: ' + level + '  score: ' + score + '  label: ' + label + '  confidence: ' + confidence,
          'blanked: ' + S.blanked + (S.blank ? ' (' + S.blank.kind + ' at ' + S.blank.at_ms + 'ms)' : '') + '  likely_cause: ' + likelyCause,
          'environment: ' + JSON.stringify({ engine: ENGINE, browser_mode: browserMode, mobile: isMobile, quiet_console: quiet, antidebug_block: BLOCK_ANTIDEBUG }), '');
        L.push('== ATTEMPTS ==', JSON.stringify(S.attempts, null, 1), '');
        L.push('== NAVIGATION TIMELINE (main frame) ==');
        for (const n of S.nav) L.push('+' + String(n.t).padStart(6) + 'ms  [r' + n.round + '/' + n.profile + ']  ' + (n.event || '') + (n.url || ''));
        L.push('', '== PAGE ERRORS ==');
        for (const e of S.pageErrors) L.push('+' + e.t + 'ms [r' + e.round + '/' + e.profile + '] ' + e.msg);
        L.push('', '== CONSOLE (warn/error) ==');
        for (const e of S.consoleMsgs) L.push('+' + e.t + 'ms [r' + e.round + '/' + e.profile + '] ' + e.type + ': ' + e.msg);
        L.push('', '== ANTI-DEBUG SCRIPTS BLOCKED BY US ==', ...S.antiBlocked);
        L.push('', '== SCRIPTS WITH FLAGS / STUB RESPONSES ==');
        for (const x of S.scriptScan) L.push('[r' + x.round + '/' + x.profile + '] ' + x.host + x.path + ' bytes=' + x.bytes + ' third_party=' + x.third_party + ' flags=' + x.flags.join(',') + (x.stub ? ' STUB' : '') + (x.snippet ? '\n    ...' + x.snippet : ''));
        L.push('', '== STATIC SCAN ==', JSON.stringify(staticScan, null, 1));
        L.push('', '== EXTERNAL SCRIPT HOSTS ==', Array.from(S.externalScripts).join(', '));
        L.push('', '== MAIN DOCUMENTS (raw HTML, first 60000 chars each) ==');
        for (const d of S.docs) L.push('--- [r' + d.round + '/' + d.profile + '] ' + d.url + ' status=' + d.status + ' bytes=' + d.bytes + ' type=' + d.ct, (d.html || '').slice(0, 60000), '');
        await saveSnapshot(snapshotId, L.join('\n'));
      } catch (e) { snapshotId = null; }
    }

    const totalAdHits = Array.from(S.adHosts.values()).reduce((a, b) => a + b, 0);
    const adDomainBreakdown = {};
    for (const [k, v] of S.adHosts) adDomainBreakdown[k] = v;
    for (const [k, v] of S.adNavHosts) adDomainBreakdown[k] = (adDomainBreakdown[k] || 0) + v;

    return {
      success: true, worker_version: WORKER_VERSION, url, detected_stack: S.techStack,
      status: S.cfChallenge ? 'blocked' : (S.navError && !S.loaded ? 'error' : 'loaded'),
      nav_error: S.navError, title: S.title, cf_challenge: S.cfChallenge,
      elapsed_sec: Math.round((Date.now() - t0) / 100) / 10,
      has_video: S.hasVideo, has_iframe: S.hasIframe, has_m3u8_in_html: S.hasM3u8,
      suspicious_overlays: S.overlays, clicks: S.clickLog.length, click_log: S.clickLog,
      popups, hijacks: S.hijackUrls.length, js_runtime_hooks_triggered: uniqueJsOpens,
      network_redirects_triggered: uniqueRedirects, ad_domain_hits: totalAdHits,
      unique_ad_hosts: adSet2.size, unique_tracker_hosts: S.trackerHosts.size,
      ad_domains: Object.keys(adDomainBreakdown), ad_domain_breakdown: adDomainBreakdown,
      tracker_domains: Array.from(S.trackerHosts.keys()).slice(0, 20),
      external_script_hosts: Array.from(S.externalScripts).slice(0, 25),
      suspicious_script_hosts: Array.from(S.unknownHosts).slice(0, 15),
      downloads: S.downloads, detail_page_reached: S.detailReached, player_found: S.playerFound,
      player_clicked: S.playerClicked, player_url: S.playerUrl, deep: !!opts.deep,
      blocklist_domains: AD_SET.size + TRACKER_SET.size + AD_DOMAINS.length,
      bad_events: S.hijackUrls.length + popups + uniqueJsOpens, ad_score: score, ad_level: level,
      score_breakdown: breakdown, popunder_networks: Array.from(popSet),
      label, label_confidence: confidence, label_note: labelNote, usable_for_score: usable, usable_reason: usableReason, score_basis: scoreBasis, risk_flags: riskFlags, lure_urls: lureUrls, stub_hosts: stubHosts,
      ad_responses: S.adResponses, inconclusive, confidence, verdict, test_notes: notes,
      environment: {
        engine: ENGINE, quiet_console: quiet, antidebug_block: BLOCK_ANTIDEBUG,
        browser_mode: browserMode, headless: !HEADFUL, proxy: !!PROXY, mobile: isMobile,
        user_agent: ua, rounds_planned: maxRounds, locale: lang, timezone: tzId || 'server_default',
        dwell_sec: opts.dwell || 0, returning_visitor_round2: !!opts.returning,
      },
      rounds: roundsInfo, debug: opts.debug ? S.debug : undefined,
      diagnostics, static_scan: staticScan, snapshot_id: snapshotId,
      snapshot_hint: snapshotId ? '/snapshot?id=' + snapshotId + '&key=YOUR_KEY' : null,
      evidence: {
        popup_urls: popupUrls.slice(0, 10),
        popup_details: S.popupRecords.slice(0, 10).map((r) => ({ phase: r.phase, round: r.round, urls: r.urls.slice(0, 6) })),
        hijack_urls: S.hijackUrls.slice(0, 10), js_intercepted: dedupInt.slice(0, 10),
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
    active, queued: waiters.length, browser_mode: browserMode, proxy: !!PROXY,
    blocklist_domains: AD_SET.size + TRACKER_SET.size + AD_DOMAINS.length,
    blocklist_ads: AD_SET.size, blocklist_trackers: TRACKER_SET.size, blocklist_allow: ALLOW_SET.size,
    blocklist_ready: blocklistReady, blocklist_sources: blocklistStatus,
    engine: ENGINE, quiet_console_default: QUIET_CONSOLE_DEFAULT, antidebug_block: BLOCK_ANTIDEBUG,
    snapshots_dir: SNAP_DIR, snapshots_keep: SNAP_KEEP,
    stats: { ...STATS, uptime_min: Math.round((Date.now() - STATS.started) / 60000) },
  }));
  app.get('/snapshots', auth, async (_req, res) => {
    res.json({ success: true, dir: SNAP_DIR, snapshots: await listSnapshots() });
  });
  app.get('/snapshot', auth, async (req, res) => {
    const id = String(req.query.id || '');
    if (!/^[0-9a-z-]{8,60}$/.test(id)) return res.status(400).type('text/plain').send('Bad id');
    try {
      const txt = await fs.promises.readFile(path.join(SNAP_DIR, id + '.txt'), 'utf8');
      res.type('text/plain; charset=utf-8').send(txt);
    } catch (_) {
      res.status(404).type('text/plain').send('Snapshot not found (може да е изтрита — пазят се само последните ' + SNAP_KEEP + ')');
    }
  });
  app.get('/deep-check', auth, async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ success: false, error: 'Missing URL' });
    const clicks = Math.min(10, Math.max(1, parseInt(req.query.clicks || '6', 10) || 6));
    const waitSec = Math.min(10, Math.max(1, parseFloat(req.query.wait || '2.5') || 2.5));
    const mobile = req.query.mobile === '1';
    const deep = req.query.deep !== '0';
    const rounds = Math.min(3, Math.max(1, parseInt(req.query.rounds || String(DEFAULT_ROUNDS), 10) || DEFAULT_ROUNDS));
    const playUrl = req.query.play_url ? String(req.query.play_url) : '';
    const debug = req.query.debug === '1';
    const locale = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(String(req.query.locale || '')) ? String(req.query.locale) : '';
    const tz = /^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$/.test(String(req.query.tz || '')) ? String(req.query.tz) : '';
    const dwell = Math.min(40, Math.max(0, parseFloat(req.query.dwell || '0') || 0));
    const returning = req.query.returning === '1';
    const quiet = req.query.quiet === '0' ? false : (req.query.quiet === '1' ? true : null);   // null = по подразбиране от .env
    const snapshot = req.query.snapshot === '1';
    const stat = req.query.static === '0' ? false : true;
    try {
      const result = await runLimited(() => analyze(String(url), {
        clicks, waitMs: Math.round(waitSec * 1000), mobile, deep, rounds, playUrl, debug, locale, tz, dwell, returning,
        quiet, snapshot, static: stat,
      }));
      recordStats(result);
      res.json(result);
    } catch (e) {
      const result = { success: false, error: e.message };
      recordStats(result);
      res.json(result);
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

module.exports = {
  scanScriptText, staticScanHtml, STUB_RE, LURE_RE, POPUNDER_PATH_RE, listSnapshots,
  popunderMatchHost, analyze, buildApp, parseListLine, adMatchHost, trackerMatchHost, 
  hostAllowed, assertSafeUrl, looksLikeDga, getRootDomain, AD_SET, TRACKER_SET, ALLOW_SET, isPrivateIp 
};
