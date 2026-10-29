/**
 * Host half of the Bing daily wallpaper bundle.
 *
 * Serves wallpaper metadata on same-origin HTTP routes so the Web UI never
 * performs a cross-origin request:
 *
 *  - GET /plugins/bing-wallpaper/today -> { ok, headline, title, copyright,
 *    date, imageUrl, pageUrl }  (proxied from the public /bing/today API)
 *  - GET /plugins/bing-wallpaper/list  -> { ok, today, items: [...] }  the
 *    recent gallery window (last 30 days), parsed from the server-rendered
 *    homepage plus a rolling archive the plugin accumulates from /today
 *
 * The upstream's signed archive API rejects third-party signatures, so the
 * homepage HTML is the list source; the rolling archive keeps earlier days
 * alive after they scroll off the homepage.
 */

export const inject = ['webServer'];

const UPSTREAM_URL = 'https://bing.fullpx.com/bing/today';
const HOMEPAGE_URL = 'https://bing.fullpx.com/';
const TODAY_PATH = '/plugins/bing-wallpaper/today';
const LIST_PATH = '/plugins/bing-wallpaper/list';
const PAGE_URL = 'https://bing.fullpx.com/';
const CACHE_TTL_MS = 30 * 60 * 1000;
const STALE_RETRY_MS = 5 * 60 * 1000;
const LIST_TTL_MS = 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const ARCHIVE_WINDOW_DAYS = 30;

/** Normalize the double-slash the upstream API sometimes returns in URLs. */
function normalizeUrl(value) {
  if (typeof value !== 'string' || value === '') return '';
  return value.replace('bing.fullpx.com//', 'bing.fullpx.com/');
}

function absoluteUrl(value) {
  if (/^https?:/.test(value)) return value;
  return `https://bing.fullpx.com${value.startsWith('/') ? '' : '/'}${value}`;
}

/** Derive the 4K variant from a 1080p URL (same path under /uhd/). */
function toUhd(url) {
  return url.includes('/fhd/') ? url.replace('/fhd/', '/uhd/') : url;
}

/** Derive the thumbnail variant (same path under /abb/). */
function toThumb(url) {
  return url.includes('/fhd/') ? url.replace('/fhd/', '/abb/') : url;
}

function pickQuality(config) {
  return config?.quality === 'uhd' ? 'uhd' : 'fhd';
}

/** Local calendar day (yyyy-mm-dd) of the Host, used to detect rollover. */
function hostLocalDay() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** First day of the archive window (today minus ARCHIVE_WINDOW_DAYS - 1). */
function archiveCutoff() {
  const d = new Date();
  d.setDate(d.getDate() - (ARCHIVE_WINDOW_DAYS - 1));
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Parse the server-rendered homepage wallpaper list into the archive. Each
 * panel carries data-fhd/data-title attributes plus a location line and a
 * dated footer, so no signed archive API is needed.
 * @returns {number} how many entries were merged.
 */
function parseHomepage(html, archive) {
  let merged = 0;
  const chunks = html.split('<div class="panel mainItem').slice(1);
  for (const chunk of chunks) {
    const head = chunk.slice(0, 6000);
    const fhd = /data-fhd="([^"]+)"/.exec(head)?.[1];
    const headline = /data-title="([^"]*)"/.exec(head)?.[1] ?? '';
    const title = /<div class="panel-body">([^<]*)<\/div>/.exec(chunk)?.[1]?.trim() ?? '';
    const date = /<span>(\d{4}-\d{2}-\d{2})<\/span>/.exec(chunk)?.[1];
    if (!fhd || !date) continue;
    const imageUrl = absoluteUrl(normalizeUrl(fhd));
    archive.set(date, { date, headline, title, copyright: '', imageUrl, thumbUrl: toThumb(imageUrl) });
    merged += 1;
  }
  return merged;
}

async function loadUpstream(signal) {
  const response = await fetch(UPSTREAM_URL, {
    signal,
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
  const body = await response.json();
  if (body === null || typeof body !== 'object') {
    throw new Error('upstream returned no JSON object');
  }
  // The upstream wraps the payload in `data` and sets `success: true`.
  const data = body.data !== null && typeof body.data === 'object' ? body.data : body;
  const fhd = normalizeUrl(data.fhdUrl);
  if (fhd === '') throw new Error('upstream response has no fhdUrl');
  // The upstream's `title` is the poetic headline and its `label` is the
  // location caption; keep both names stable for the UI.
  return {
    ok: true,
    headline: typeof data.title === 'string' ? data.title : '',
    title: typeof data.label === 'string' ? data.label : '',
    copyright: typeof data.copyright === 'string' ? data.copyright : '',
    date: typeof data.time === 'string' ? data.time : '',
    imageUrl: fhd.startsWith('http') ? fhd : absoluteUrl(fhd),
    pageUrl: PAGE_URL,
  };
}

export function apply(ctx, config = {}) {
  const preferUhd = pickQuality(config) === 'uhd';
  let cache = null; // { at: number, payload: object }
  /** Rolling archive of seen wallpapers: date -> entry (fhd canonical URLs). */
  const archive = new Map();
  let listAt = 0;

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: TODAY_PATH,
        handler: async (_req, res) => {
          const send = (status, body) => {
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(JSON.stringify(body));
          };
          try {
            // Same-day data keeps the normal TTL. Data whose date no longer
            // matches the local today is retried at most every
            // STALE_RETRY_MS until the upstream rolls over, so a page that
            // stays open across midnight switches within minutes.
            const maxAge =
              cache !== null && cache.payload.date === hostLocalDay()
                ? CACHE_TTL_MS
                : STALE_RETRY_MS;
            if (cache === null || Date.now() - cache.at > maxAge) {
              const upstream = await loadUpstream(AbortSignal.timeout(UPSTREAM_TIMEOUT_MS));
              if (upstream.date !== '') {
                archive.set(upstream.date, {
                  date: upstream.date,
                  headline: upstream.headline,
                  title: upstream.title,
                  copyright: upstream.copyright,
                  imageUrl: upstream.imageUrl,
                  thumbUrl: toThumb(upstream.imageUrl),
                });
              }
              const payload = preferUhd
                ? { ...upstream, imageUrl: toUhd(upstream.imageUrl) }
                : upstream;
              cache = { at: Date.now(), payload };
            }
            send(200, cache.payload);
          } catch (error) {
            // Serve the last good copy when the upstream is unreachable;
            // the wallpaper staying visible matters more than freshness.
            if (cache !== null) send(200, cache.payload);
            else
              send(502, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
          }
        },
      }),
    'bing-wallpaper: metadata route',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: LIST_PATH,
        handler: async (_req, res) => {
          const send = (status, body) => {
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(JSON.stringify(body));
          };
          const collect = () => {
            const cutoff = archiveCutoff();
            return [...archive.values()]
              .filter((entry) => entry.date >= cutoff)
              .sort((a, b) => b.date.localeCompare(a.date))
              .map((entry) =>
                preferUhd ? { ...entry, imageUrl: toUhd(entry.imageUrl) } : { ...entry },
              );
          };
          try {
            if (Date.now() - listAt > LIST_TTL_MS) {
              try {
                const page = await fetch(HOMEPAGE_URL, {
                  signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
                  headers: { accept: 'text/html' },
                });
                if (page.ok) parseHomepage(await page.text(), archive);
              } catch {
                /* keep serving the rolling archive when the homepage fails */
              } finally {
                listAt = Date.now();
              }
            }
            send(200, { ok: true, today: hostLocalDay(), items: collect() });
          } catch (error) {
            if (archive.size > 0) send(200, { ok: true, today: hostLocalDay(), items: collect() });
            else
              send(502, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
          }
        },
      }),
    'bing-wallpaper: gallery list route',
  );
}
