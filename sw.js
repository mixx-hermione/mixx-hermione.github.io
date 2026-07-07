/**
 * Mixx Reality PWA v4 - Service Worker
 *
 * Multi-tier caching strategy with comprehensive offline support.
 * Features:
 * - App shell caching (stale-while-revalidate with update notification)
 * - Project data caching (network-first with fallback)
 * - Media caching (stale-while-revalidate with LRU cap)
 * - Map tile caching with LRU eviction
 * - Offline page fallback
 * - Background sync for deferred requests
 * - Cache size management
 * - Update notifications
 */

// App version for logging/notifications (can change frequently)
// BUILD_TIMESTAMP is replaced by the build plugin to force SW update detection
const APP_VERSION = 'v4.1.0';
const BUILD_TIMESTAMP = '2026-06-12T08:02:55.568Z';
const VERSION_METADATA = {
  version: APP_VERSION,
  buildTimestamp: BUILD_TIMESTAMP,
  cacheSchemaVersion: 'v1',
  shellVersion: 'v1'
};

// Cache schema version - only increment on breaking cache structure changes
// This prevents data loss on minor app version bumps.
const CACHE_SCHEMA_VERSION = VERSION_METADATA.cacheSchemaVersion;

// Shell version - bump this to invalidate the app shell (HTML, CSS, JS bundles,
// shipped images) without nuking the user's tile / media / project caches.
// Audit H-02: prior behavior tied every cache to APP_VERSION/CACHE_SCHEMA_VERSION,
// which meant a single layout deploy forced users to re-download all map tiles.
//
// Bump this when a deploy ships new app shell assets and you want existing
// users to pull the fresh shell on next activation. Tile + media + project
// caches survive because they keep using CACHE_SCHEMA_VERSION only.
const SHELL_VERSION = VERSION_METADATA.shellVersion;

const CACHE_NAMES = {
  shell: `mixx-shell-${CACHE_SCHEMA_VERSION}-${SHELL_VERSION}`,
  project: `mixx-project-${CACHE_SCHEMA_VERSION}`,
  media: `mixx-media-${CACHE_SCHEMA_VERSION}`,
  tiles: `mixx-tiles-${CACHE_SCHEMA_VERSION}`
  // API cache removed per spec - read-only PWA, no auth caching
};

// App shell assets to precache
// Note: CSS is bundled into main-*.css during build, not separate files
// Icon uses mixx-ai.png as the default app icon
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './offline.html',
  './assets/icons/favicon.svg',
  './assets/img/mixx-ai.png'
  ,
  // MIXX:SHELL_ASSETS - Injected by Mixx Tool
  './runtime-config.json',
  './telemetry.js',
  './analytics.json',
  './assistant/assistant-core.js',
  './assistant/assistant.css'
  // END MIXX:SHELL_ASSETS
];

// Project data assets to cache on first load
// Note: These are export-mode static paths. In hosted mode, data comes from
// /pwa-api/apps/:username/:slug/* endpoints — these precache attempts will 404
// silently (caught by try/catch in install handler), which is expected.
const PROJECT_ASSETS = [
  './project/data.json',
  './project/meta.json',
  './data/project.json'  // New spec path for export mode
];

// Cache size limits
const LIMITS = {
  media: { maxItems: 100, maxSize: 100 * 1024 * 1024 }, // 100MB
  tiles: { maxItems: 500, maxSize: 50 * 1024 * 1024 }   // 50MB
  // API limits removed per spec - no API caching
};

// Offline fallback page
const OFFLINE_PAGE = './offline.html';

// Custom header for storing access timestamps in cached responses (for LRU eviction)
const TIMESTAMP_HEADER = 'sw-access-time';

/**
 * Install - precache shell and project assets
 */
self.addEventListener('install', event => {
  console.log('[SW] Installing', APP_VERSION);

  event.waitUntil(
    (async () => {
      // Cache shell assets
      const shellCache = await caches.open(CACHE_NAMES.shell);
      for (const asset of SHELL_ASSETS) {
        try {
          await shellCache.add(asset);
        } catch (err) {
          console.warn('[SW] Failed to cache shell asset:', asset, err);
        }
      }

      // Cache project data assets
      const projectCache = await caches.open(CACHE_NAMES.project);
      for (const asset of PROJECT_ASSETS) {
        try {
          await projectCache.add(asset);
        } catch (err) {
          console.warn('[SW] Failed to cache project asset:', asset, err);
        }
      }

      // Do NOT skipWaiting here — let the user choose when to activate
      // via the SKIP_WAITING message handler (prevents mid-session breakage)
      console.log('[SW] Installed successfully — waiting for user-prompted activation');
    })()
  );
});

/**
 * Activate - clean old caches, claim clients
 */
self.addEventListener('activate', event => {
  console.log('[SW] Activating', APP_VERSION);

  event.waitUntil(
    (async () => {
      // Get all cache names
      const cacheNames = await caches.keys();

      // Delete old caches
      await Promise.all(
        cacheNames
          .filter(name => name.startsWith('mixx-') && !Object.values(CACHE_NAMES).includes(name))
          .map(name => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );

      // Claim all clients
      await self.clients.claim();

      // Run periodic cache cleanup on activation
      trimTileCache();
      trimMediaCache();

      // Notify clients of activation
      const clients = await self.clients.matchAll();
      clients.forEach(client => {
        client.postMessage({
          type: 'SW_ACTIVATED',
          ...VERSION_METADATA
        });
      });

      console.log('[SW] Activated successfully');
    })()
  );
});

/**
 * Fetch - multi-tier caching strategy
 */
self.addEventListener('fetch', event => {
  const { request } = event;

  // GUARD: Validate request URL exists and is not empty (prevents crashes)
  if (!request.url || request.url === '') {
    console.warn('[SW] Empty URL in fetch request, skipping');
    return;
  }

  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    console.warn('[SW] Invalid URL in fetch request:', request.url);
    return;
  }

  // Skip non-GET requests (read-only PWA per spec)
  if (request.method !== 'GET') {
    return;
  }

  // Skip chrome-extension and other non-http(s)
  if (!url.protocol.startsWith('http')) return;

  // Skip analytics and tracking
  if (isTrackingRequest(url)) return;

  // Route to appropriate strategy per spec Section 7
  if (isNavigationRequest(request)) {
    event.respondWith(handleNavigation(request));
  } else if (isShellAsset(url)) {
    // Per spec Section 7.1: Stale-while-revalidate for shell assets
    event.respondWith(staleWhileRevalidateShell(request, CACHE_NAMES.shell));
  } else if (isPwaApiRequest(url)) {
    // Per spec Section 7.1: Network-first for /pwa-api/apps/:appSlug/manifest and /data
    event.respondWith(networkFirst(request, CACHE_NAMES.project));
  } else if (isProjectData(url)) {
    // Per spec Section 7.1: Network-first for project data
    event.respondWith(networkFirst(request, CACHE_NAMES.project));
  } else if (isApiRequest(url)) {
    // Per spec Section 7.1: Do NOT cache general API requests
    // Let them fall through to network only
    return;
  } else if (isFontAsset(url)) {
    // Per spec Section 7.1: Cache-first for font assets (long-lived)
    event.respondWith(cacheFirst(request, CACHE_NAMES.shell));
  } else if (isMediaAsset(url)) {
    // Per spec Section 7.1: Stale-while-revalidate with LRU cap for media
    event.respondWith(staleWhileRevalidate(request, CACHE_NAMES.media));
  } else if (isMapTile(url)) {
    // Per spec Section 7.1: Cache-first for map tiles
    event.respondWith(handleMapTile(request));
  } else if (isCDNAsset(url)) {
    // Per spec Section 7.1: Cache-first for CDN assets
    event.respondWith(cacheFirst(request, CACHE_NAMES.shell));
  } else {
    // Default: network-first
    event.respondWith(networkFirst(request, CACHE_NAMES.project));
  }
});

/**
 * Request type detection
 */
function isNavigationRequest(request) {
  return request.mode === 'navigate';
}

function isShellAsset(url) {
  const shellPatterns = [
    /\.(html|css|js)$/,
    /manifest\.json$/,
    /\/assets\/icons\//,
    /favicon/
  ];
  return shellPatterns.some(p => p.test(url.pathname));
}

function isProjectData(url) {
  return /\/(meta|data|project)\.json$/.test(url.pathname) ||
         url.pathname.includes('/bundle/') ||
         (url.pathname.includes('/pwa-api/apps/') && url.pathname.includes('/manifest')) ||
         (url.pathname.includes('/pwa-api/apps/') && url.pathname.includes('/data'));
}

/**
 * Check if URL is a PWA API request
 * Per spec Section 7.1: Network-first for /pwa-api/apps/:appSlug/manifest and /data
 */
function isPwaApiRequest(url) {
  return url.pathname.includes('/pwa-api/apps/');
}

function isApiRequest(url) {
  return url.pathname.includes('/api/') ||
         url.hostname.includes('api.');
}

function isMediaAsset(url) {
  return /\.(png|jpg|jpeg|gif|webp|svg|ico|mp4|webm|mov|mp3|wav|ogg|m4a|glb|gltf|dae|usdz|usd|ifc|pdf)$/i.test(url.pathname);
}

function isFontAsset(url) {
  return /\.(woff2?|ttf|otf|eot)$/i.test(url.pathname) ||
         url.pathname.includes('/fonts/');
}

function isMapTile(url) {
  return url.hostname.includes('tile.openstreetmap.org') ||
         url.hostname.includes('tiles.') ||
         url.hostname.includes('cesium') ||
         (url.hostname.includes('google') && url.pathname.includes('tile')) ||
         /\/tiles?\//.test(url.pathname) ||
         /\/\d+\/\d+\/\d+/.test(url.pathname);
}

function isCDNAsset(url) {
  return url.hostname.includes('cdn') ||
         url.hostname.includes('esm.sh') ||
         url.hostname.includes('unpkg.com') ||
         url.hostname.includes('cdnjs.') ||
         url.hostname.includes('jsdelivr');
}

function isTrackingRequest(url) {
  // MIXX:TRACKING_WHITELIST - Injected by Mixx Tool
  if (url.hostname.includes('mixxreality.com') && url.pathname.includes('/pwa-api/events')) {
    return false;
  }
  // END MIXX:TRACKING_WHITELIST

  return url.hostname.includes('analytics') ||
         url.hostname.includes('track') ||
         url.hostname.includes('telemetry') ||
         url.pathname.includes('/beacon');
}

/**
 * Handle navigation requests with offline fallback
 */
async function handleNavigation(request) {
  try {
    // Try network first
    const response = await fetch(request);

    // Cache the navigation response
    if (response.ok) {
      const cache = await caches.open(CACHE_NAMES.shell);
      cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    // Try exact cache match first
    const cached = await caches.match(request);
    if (cached) return cached;

    // SPA fallback: serve cached index.html for any navigation request
    // This enables deep links to work offline (e.g., /username/slug/app)
    const cachedIndex = await caches.match('./index.html') || await caches.match('/index.html');
    if (cachedIndex) return cachedIndex;

    // Fall back to offline page
    const offlinePage = await caches.match(OFFLINE_PAGE);
    if (offlinePage) return offlinePage;

    // Last resort: return basic offline HTML
    // Note: Using addEventListener instead of onclick to comply with CSP
    return new Response(
      `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Offline - Mixx Reality</title>
        <style>
          body {
            font-family: system-ui, -apple-system, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: #1a1a2e;
            color: #eee;
            text-align: center;
            padding: 20px;
          }
          h1 { font-size: 24px; margin-bottom: 16px; }
          p { color: #888; margin-bottom: 24px; }
          button {
            background: #007AFF;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 16px;
            cursor: pointer;
          }
          button:hover { background: #0056b3; }
        </style>
      </head>
      <body>
        <div>
          <h1>You're Offline</h1>
          <p>Check your internet connection and try again.</p>
          <button id="retry-btn">Retry</button>
        </div>
        <script>document.getElementById('retry-btn').addEventListener('click',function(){location.reload();});</script>
      </body>
      </html>`,
      {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      }
    );
  }
}

/**
 * Handle map tiles with LRU cache
 */
async function handleMapTile(request) {
  try {
    const cache = await caches.open(CACHE_NAMES.tiles);

    // Check cache first
    const cached = await cache.match(request);
    if (cached) {
      // Update access time in background (non-blocking)
      updateTileAccessTime(request);
      return cached;
    }

    const response = await fetch(request);

    if (response.ok) {
      try {
        // Clone response and add timestamp header before caching
        const blob = await response.clone().blob();
        const headers = new Headers(response.headers);
        headers.set(TIMESTAMP_HEADER, Date.now().toString());

        const timestampedResponse = new Response(blob, {
          status: response.status,
          statusText: response.statusText,
          headers
        });

        cache.put(request, timestampedResponse);

        // Trim cache if needed (in background)
        trimTileCache();
      } catch (cacheErr) {
        // Caching failed (quota, opaque response) — still return the response
      }
    }

    return response;
  } catch (error) {
    // Cache or fetch failed — try a plain fetch as fallback
    try {
      return await fetch(request);
    } catch {
      return createPlaceholderTile();
    }
  }
}

/**
 * Update access time for a cached tile
 * Re-caches the response with an updated timestamp header
 */
async function updateTileAccessTime(request) {
  try {
    const cache = await caches.open(CACHE_NAMES.tiles);
    const cached = await cache.match(request);
    if (!cached) return;

    // Clone response and add/update timestamp header
    const blob = await cached.blob();
    const headers = new Headers(cached.headers);
    headers.set(TIMESTAMP_HEADER, Date.now().toString());

    const updatedResponse = new Response(blob, {
      status: cached.status,
      statusText: cached.statusText,
      headers
    });

    // Update cache with timestamped response (non-blocking)
    cache.put(request, updatedResponse);
  } catch (err) {
    // Non-critical, just continue
  }
}

/**
 * Get access time from cached response header
 */
function getAccessTime(response) {
  const timestamp = response?.headers?.get(TIMESTAMP_HEADER);
  return timestamp ? parseInt(timestamp, 10) : 0;
}

async function trimTileCache() {
  try {
    const cache = await caches.open(CACHE_NAMES.tiles);
    const requests = await cache.keys();

    if (requests.length > LIMITS.tiles.maxItems) {
      // Get access times from cached response headers
      const requestsWithTimes = await Promise.all(
        requests.map(async (request) => {
          const response = await cache.match(request);
          return {
            request,
            accessTime: getAccessTime(response)
          };
        })
      );

      // Sort by access time (oldest first)
      requestsWithTimes.sort((a, b) => a.accessTime - b.accessTime);

      // Delete oldest entries (use Promise.all for parallel deletion)
      const toDelete = requestsWithTimes.slice(0, requests.length - LIMITS.tiles.maxItems);
      await Promise.all(toDelete.map(({ request }) => cache.delete(request)));

      console.log('[SW] Trimmed tile cache, removed', toDelete.length, 'items');
    }
  } catch (err) {
    console.warn('[SW] Error trimming tile cache:', err);
  }
}

/**
 * Create placeholder tile for offline
 */
function createPlaceholderTile() {
  // Return a simple gray placeholder
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <rect fill="#2a2a3e" width="256" height="256"/>
    <text x="128" y="128" text-anchor="middle" fill="#666" font-size="12" font-family="system-ui">Offline</text>
  </svg>`;

  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-cache'
    }
  });
}

/**
 * Cache-first strategy (for static assets that rarely change)
 */
async function cacheFirst(request, cacheName) {
  try {
    const cached = await caches.match(request);
    if (cached) return cached;
  } catch {
    // Cache match failed — continue to fetch
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      try {
        const cache = await caches.open(cacheName);
        cache.put(request, response.clone());
      } catch {
        // Caching failed — still return the response
      }
    }
    return response;
  } catch (error) {
    console.warn('[SW] Cache-first fetch failed:', request.url);
    return createOfflineResponse(request);
  }
}

/**
 * Stale-while-revalidate for shell assets (HTML/CSS/JS)
 * Returns cached version immediately, fetches update in background
 * Notifies clients when updates are available
 */
async function staleWhileRevalidateShell(request, cacheName) {
  try {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);

    // Fetch in background
    const fetchPromise = fetch(request)
      .then(async response => {
        if (response.ok) {
          try {
            // Check if content changed
            if (cached) {
              const cachedText = await cached.clone().text();
              const newText = await response.clone().text();

              if (cachedText !== newText) {
                // Content changed - notify clients
                const clients = await self.clients.matchAll();
                clients.forEach(client => {
                  client.postMessage({
                    type: 'SW_UPDATE_AVAILABLE',
                    url: request.url,
                    ...VERSION_METADATA
                  });
                });
              }
            }

            // Update cache
            await cache.put(request, response.clone());
          } catch {
            // Caching/comparison failed — still return the response
          }
        }
        return response;
      })
      .catch(() => null);

    // Return cached immediately, or wait for fetch
    return cached || (await fetchPromise) || createOfflineResponse(request);
  } catch {
    // Cache API failed — fall back to plain fetch
    try {
      return await fetch(request);
    } catch {
      return createOfflineResponse(request);
    }
  }
}

/**
 * Network-first strategy with optional max age
 */
async function networkFirst(request, cacheName, maxAge = 0) {
  try {
    const response = await fetch(request);

    if (response.ok) {
      const cache = await caches.open(cacheName);
      const clonedResponse = response.clone();

      // Add timestamp header for age checking
      if (maxAge > 0) {
        const headers = new Headers(clonedResponse.headers);
        headers.set('sw-cached-at', Date.now().toString());
        const timedResponse = new Response(await clonedResponse.blob(), {
          status: clonedResponse.status,
          statusText: clonedResponse.statusText,
          headers
        });
        cache.put(request, timedResponse);
      } else {
        cache.put(request, clonedResponse);
      }
    }

    return response;
  } catch (error) {
    const cached = await caches.match(request);

    if (cached) {
      // Check if cached response is still valid
      if (maxAge > 0) {
        const cachedAt = parseInt(cached.headers.get('sw-cached-at') || '0', 10);
        if (Date.now() - cachedAt > maxAge) {
          console.log('[SW] Cached response expired:', request.url);
          // Still return it, but it's stale
        }
      }
      return cached;
    }

    return createOfflineResponse(request);
  }
}

/**
 * Stale-while-revalidate strategy with LRU for media
 * Uses timestamp headers for persistent LRU tracking
 */
async function staleWhileRevalidate(request, cacheName) {
  try {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);

    // Update access time for LRU (non-blocking, using timestamp headers)
    if (cached && cacheName === CACHE_NAMES.media) {
      updateMediaAccessTime(request, cache);
    }

    const fetchPromise = fetch(request)
      .then(async response => {
        if (response.ok) {
          try {
            // Add timestamp header for media cache
            if (cacheName === CACHE_NAMES.media) {
              const blob = await response.clone().blob();
              const headers = new Headers(response.headers);
              headers.set(TIMESTAMP_HEADER, Date.now().toString());

              const timestampedResponse = new Response(blob, {
                status: response.status,
                statusText: response.statusText,
                headers
              });

              cache.put(request, timestampedResponse);
              trimMediaCache();
            } else {
              cache.put(request, response.clone());
            }
          } catch {
            // Caching failed — still return the response
          }
        }
        return response;
      })
      .catch(() => null);

    return cached || (await fetchPromise) || createOfflineResponse(request);
  } catch {
    // Cache API failed — fall back to plain fetch
    try {
      return await fetch(request);
    } catch {
      return createOfflineResponse(request);
    }
  }
}

/**
 * Update access time for a cached media item (non-blocking)
 */
async function updateMediaAccessTime(request, cache) {
  try {
    const cached = await cache.match(request);
    if (!cached) return;

    const blob = await cached.blob();
    const headers = new Headers(cached.headers);
    headers.set(TIMESTAMP_HEADER, Date.now().toString());

    const updatedResponse = new Response(blob, {
      status: cached.status,
      statusText: cached.statusText,
      headers
    });

    cache.put(request, updatedResponse);
  } catch (err) {
    // Non-critical, just continue
  }
}

/**
 * Trim media cache based on item count and total size
 * Uses timestamp headers (same as tile cache) for LRU eviction
 */
async function trimMediaCache() {
  try {
    const cache = await caches.open(CACHE_NAMES.media);
    const requests = await cache.keys();

    // Check if we need to trim (by count)
    const needsTrimByCount = requests.length > LIMITS.media.maxItems;

    // Calculate total cache size and get access times
    let totalSize = 0;
    const requestsWithMeta = await Promise.all(
      requests.map(async (request) => {
        const response = await cache.match(request);
        const size = parseInt(response?.headers?.get('content-length') || '0', 10) || (response?.type === 'opaque' ? 500000 : 0);
        const accessTime = getAccessTime(response);
        totalSize += size;
        return { request, size, accessTime };
      })
    );

    // Check if we need to trim (by size)
    const needsTrimBySize = totalSize > LIMITS.media.maxSize;

    if (!needsTrimByCount && !needsTrimBySize) return;

    // Sort by access time (oldest first)
    requestsWithMeta.sort((a, b) => a.accessTime - b.accessTime);

    // Delete items until we're under both limits
    let currentSize = totalSize;
    let currentCount = requests.length;
    let deletedCount = 0;

    for (const { request, size } of requestsWithMeta) {
      // Stop if we're under both limits
      if (currentCount <= LIMITS.media.maxItems && currentSize <= LIMITS.media.maxSize) {
        break;
      }

      await cache.delete(request);
      currentSize -= size;
      currentCount--;
      deletedCount++;
    }

    if (deletedCount > 0) {
      console.log('[SW] Trimmed media cache, removed', deletedCount, 'items');
    }
  } catch (err) {
    console.warn('[SW] Error trimming media cache:', err);
  }
}

/**
 * Create appropriate offline response
 */
function createOfflineResponse(request) {
  const url = new URL(request.url);

  // JSON response for API requests
  if (isApiRequest(url) || url.pathname.endsWith('.json')) {
    return new Response(
      JSON.stringify({ error: 'offline', message: 'You are currently offline' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  // Image placeholder for media
  if (isMediaAsset(url)) {
    return createPlaceholderImage();
  }

  // Generic offline response
  return new Response('Offline', {
    status: 503,
    statusText: 'Service Unavailable'
  });
}

/**
 * Create placeholder image for offline
 */
function createPlaceholderImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
    <rect fill="#2a2a3e" width="200" height="200"/>
    <path fill="#444" d="M75 65h50v45H75z"/>
    <circle cx="87" cy="77" r="5" fill="#666"/>
    <path fill="#555" d="M75 110l15-20 10 12 20-25 5 33H75z"/>
  </svg>`;

  return new Response(svg, {
    status: 200,
    headers: { 'Content-Type': 'image/svg+xml' }
  });
}

// Background sync handlers removed per v4 spec - read-only PWA

/**
 * Message handling for cache management
 */
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};

  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'GET_VERSION':
      event.ports[0]?.postMessage({
        version: VERSION_METADATA.version,
        cacheSchemaVersion: VERSION_METADATA.cacheSchemaVersion,
        shellVersion: VERSION_METADATA.shellVersion,
        buildTimestamp: VERSION_METADATA.buildTimestamp
      });
      break;

    case 'CLEAR_CACHE':
      clearAllCaches().then(() => {
        event.ports[0]?.postMessage({ success: true });
      });
      break;

    case 'CLEAR_CACHE_TYPE':
      clearCacheType(payload.type).then(() => {
        event.ports[0]?.postMessage({ success: true });
      });
      break;

    case 'CACHE_PROJECT':
      cacheProjectAssets(payload.assets).then(() => {
        event.ports[0]?.postMessage({ success: true });
      });
      break;

    case 'PRECACHE_POIS':
      precachePOIMedia(payload.pois).then(count => {
        event.ports[0]?.postMessage({ success: true, cached: count });
      });
      break;

    case 'GET_CACHE_SIZE':
      getCacheSize().then(size => {
        event.ports[0]?.postMessage({ size });
      });
      break;

    case 'PERIODIC_TRIM':
      // Clients can request periodic cache cleanup
      trimTileCache();
      trimMediaCache();
      break;
  }
});

/**
 * Clear all caches
 */
async function clearAllCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k.startsWith('mixx-')).map(key => caches.delete(key)));
  console.log('[SW] All caches cleared');
}

/**
 * Clear specific cache type
 */
async function clearCacheType(type) {
  const cacheName = CACHE_NAMES[type];
  if (cacheName) {
    await caches.delete(cacheName);
    console.log('[SW] Cache cleared:', cacheName);
  }
}

/**
 * Cache project assets for offline use
 */
async function cacheProjectAssets(assets = []) {
  const cache = await caches.open(CACHE_NAMES.project);
  let cached = 0;

  for (const url of assets) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        await cache.put(url, response);
        cached++;
      }
    } catch (err) {
      console.warn('[SW] Failed to cache asset:', url);
    }
  }

  console.log('[SW] Project assets cached:', cached, '/', assets.length);
  return cached;
}

/**
 * Precache POI media for offline use
 */
async function precachePOIMedia(pois = []) {
  const cache = await caches.open(CACHE_NAMES.media);
  let cached = 0;

  for (const poi of pois) {
    const mediaUrls = [
      poi.thumbnail,
      poi.image,
      ...(poi.images || []),
      ...(poi.audio || []),
      ...(poi.media || []).map(item => item.url || item.dataURL || item.src)
    ].filter(Boolean);

    for (const url of mediaUrls) {
      try {
        // Skip if already cached
        const existing = await cache.match(url);
        if (existing) continue;

        const response = await fetch(url);
        if (response.ok) {
          await cache.put(url, response);
          cached++;
        }
      } catch (err) {
        // Ignore individual failures
      }
    }
  }

  console.log('[SW] POI media cached:', cached, 'files');
  return cached;
}

/**
 * Get total cache size
 */
async function getCacheSize() {
  let totalSize = 0;

  for (const cacheName of Object.values(CACHE_NAMES)) {
    try {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();

      for (const request of requests) {
        const response = await cache.match(request);
        if (response) {
          const blob = await response.clone().blob();
          totalSize += blob.size;
        }
      }
    } catch {
      // Ignore errors
    }
  }

  return totalSize;
}

// Push notifications removed per v4 spec - read-only PWA

console.log('[SW] Service Worker loaded', APP_VERSION);
