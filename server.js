const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CHECK_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS || 25000);

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function classifyStream(url, contentType = '', resourceType = '') {
  const u = String(url || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();

  if (/\.m3u8(?:$|[?#])/.test(u) ||
      ct.includes('application/vnd.apple.mpegurl') ||
      ct.includes('application/x-mpegurl') ||
      ct === 'audio/mpegurl') return 'hls-manifest';

  if (/\.mpd(?:$|[?#])/.test(u) || ct === 'application/dash+xml') {
    return 'dash-manifest';
  }

  if (resourceType === 'media' || ct.startsWith('video/') ||
      (ct === 'application/octet-stream' &&
       /\.(?:m4s|mp4|ts|m4v)(?:$|[?#])/.test(u)) ||
      /\.(?:m4s|mp4|ts|m4v)(?:$|[?#])/.test(u)) {
    return 'media-resource';
  }

  return null;
}
app.get('/check', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({
      success: false,
      error: 'Липсва URL параметър'
    });
  }

  if (!isHttpUrl(targetUrl)) {
    return res.status(400).json({
      success: false,
      error: 'Невалиден URL. Подай пълен http:// или https:// адрес.'
    });
  }

  let browser;
  let page;

  const startedAt = Date.now();
  const candidates = new Map();
  const failedRequests = [];
  const pageErrors = [];
  const consoleErrors = [];

  let mainResponse = null;
  let playAction = 'not-attempted';

  function addCandidate(url, type, contentType = '', status = null) {
    if (!type || !url) return;

    const priority = {
      'hls-manifest': 3,
      'dash-manifest': 3,
      'media-resource': 1
    };

    const previous = candidates.get(url);

    if (!previous || priority[type] > priority[previous.type]) {
      candidates.set(url, {
        url,
        type,
        contentType: contentType || '',
        status,
        firstSeenAt: new Date().toISOString()
      });
    }
  }

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });

    const context = await browser.newContext({
      viewport: {
        width: 1365,
        height: 900
      }
    });

    page = await context.newPage();
    page.setDefaultNavigationTimeout(35000);

    // JavaScript errors
    page.on('pageerror', error => {
      if (pageErrors.length < 20) {
        pageErrors.push(
          String(error.message || error).slice(0, 500)
        );
      }
    });

    // Console errors
    page.on('console', message => {
      if (
        message.type() === 'error' &&
        consoleErrors.length < 20
      ) {
        consoleErrors.push(
          message.text().slice(0, 500)
        );
      }
    });

    // Failed network requests
    page.on('requestfailed', request => {
      if (failedRequests.length < 30) {
        failedRequests.push({
          url: request.url(),
          resourceType: request.resourceType(),
          error: request.failure()?.errorText || 'request failed'
        });
      }
    });

    // Detect potential media requests
    page.on('request', request => {
      const type = classifyStream(
        request.url(),
        '',
        request.resourceType()
      );

      if (type) {
        addCandidate(request.url(), type);
      }
    });

    // Detect media responses
    page.on('response', response => {
      const request = response.request();

      const contentType =
        response.headers()['content-type'] || '';

      const type = classifyStream(
        response.url(),
        contentType,
        request.resourceType()
      );

      if (type) {
        addCandidate(
          response.url(),
          type,
          contentType,
          response.status()
        );
      }
    });

    // Load target page
    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 35000
    });

    if (response) {
      mainResponse = {
        status: response.status(),
        url: response.url(),
        contentType:
          response.headers()['content-type'] || ''
      };
    }

    // Wait for player initialization
    await page.waitForTimeout(2500);

    // Click only a visible, labelled play control
    try {
      const playControl = page.locator(
        'button[aria-label*="play" i], ' +
        'button[title*="play" i], ' +
        '[role="button"][aria-label*="play" i], ' +
        'button:has-text("Play")'
      ).first();

      if (await playControl.count()) {
        const visible = await playControl
          .isVisible()
          .catch(() => false);

        const enabled = await playControl
          .isEnabled()
          .catch(() => false);

        if (visible && enabled) {
          await playControl.click({
            timeout: 2500
          });

          playAction = 'clicked-visible-play-control';
        } else {
          playAction =
            'play-control-found-but-not-interactable';
        }
      } else {
        playAction = 'no-labelled-play-control-found';
      }
    } catch (error) {
      playAction =
        `play-click-failed: ${String(error.message || error).slice(0, 180)}`;
    }

    // Wait for a manifest or timeout
    const deadline = Date.now() + CHECK_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const hasManifest = [
        ...candidates.values()
      ].some(item =>
        item.type === 'hls-manifest' ||
        item.type === 'dash-manifest'
      );

      if (hasManifest) break;

      await page.waitForTimeout(500);
    }

    // Inspect player state
    const pageInfo = await page.evaluate(() => {
      const video = document.querySelector('video');
      const audio = document.querySelector('audio');

      return {
        title: document.title || '',
        pageUrl: location.href,
        readyState: document.readyState,

        bodySnippet: (
          document.body?.innerText || ''
        ).replace(/\s+/g, ' ').slice(0, 300),

        videoElementFound: !!video,

        videoReadyState:
          video ? video.readyState : null,

        videoNetworkState:
          video ? video.networkState : null,

        videoCurrentSrc:
          video?.currentSrc || null,

        audioElementFound: !!audio,

        audioCurrentSrc:
          audio?.currentSrc || null
      };
    });

    const allCandidates = [
      ...candidates.values()
    ];

    const hls = allCandidates.find(
      item => item.type === 'hls-manifest'
    );

    const dash = allCandidates.find(
      item => item.type === 'dash-manifest'
    );

    const directMedia = allCandidates.find(
      item => item.type === 'media-resource'
    );

    const selected = hls || dash || directMedia || null;

    return res.json({
      success: true,

      targetUrl,
      finalUrl: pageInfo.pageUrl,
      title: pageInfo.title,

      httpStatus: mainResponse?.status ?? null,
      mainResponse,

      contentReady:
        (pageInfo.videoReadyState ?? 0) >= 2 ||
        !!selected,

      streamDetected: !!selected,

      streamType: selected?.type || null,

      hlsUrl: hls?.url || null,
      dashUrl: dash?.url || null,
      mediaUrl: directMedia?.url || null,

      streamUrl: selected?.url || null,

      candidates: allCandidates.slice(0, 30),

      playAction,

      pageInfo,

      diagnostics: {
        elapsedMs: Date.now() - startedAt,

        failedRequests:
          failedRequests.slice(0, 20),

        pageErrors:
          pageErrors.slice(0, 20),

        consoleErrors:
          consoleErrors.slice(0, 20)
      }
    });

  } catch (error) {
    return res.status(200).json({
      success: false,

      targetUrl,

      error: String(error.message || error),

      title: page
        ? await page.title().catch(() => '')
        : '',

      diagnostics: {
        elapsedMs: Date.now() - startedAt,

        failedRequests:
          failedRequests.slice(0, 20),

        pageErrors:
          pageErrors.slice(0, 20),

        consoleErrors:
          consoleErrors.slice(0, 20)
      }
    });

  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

// Health check
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'stream-checker'
  });
});

app.listen(PORT, () => {
  console.log(
    `Stream checker listening on port ${PORT}`
  );
});
