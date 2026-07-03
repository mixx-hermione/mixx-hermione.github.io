/**
 * Mixx PWA Telemetry Client v1.0
 * Auto-initializes from runtime-config.json.
 */
const MixxTelemetry = (function() {
  'use strict';
  let config = null, telemetryManifest = null, sessionId = null, isEnabled = false;
  let eventQueue = [], flushTimer = null, sessionStartTime = null;
  const FLUSH_INTERVAL = 5000, MAX_QUEUE_SIZE = 20, SESSION_KEY = 'mixx-telemetry-session';

  function _mkId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  function _jsonParse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

  async function init() {
    try {
      const configResponse = await fetch('./runtime-config.json');
      if (!configResponse.ok) return false;
      config = await configResponse.json();
      if (!config.telemetry?.enabled) { return false; }
      try {
        const manifestResponse = await fetch('./analytics.json');
        if (manifestResponse.ok) telemetryManifest = await manifestResponse.json();
      } catch (e) {
        // analytics.json not available — non-critical
      }
      sessionId = getOrCreateSession();
      isEnabled = true;
      flushTimer = setInterval(flushQueue, FLUSH_INTERVAL);
      track('pwa.session.start', {
        referrer: document.referrer || null, user_agent: navigator.userAgent,
        screen_width: window.screen.width, screen_height: window.screen.height,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: navigator.language
      });
      window.addEventListener('beforeunload', () => {
        track('pwa.session.end', { duration_ms: Date.now() - (sessionStartTime || Date.now()) });
        flushQueue(true);
      });
      return true;
    } catch (error) { return false; }
  }

  function getOrCreateSession() {
    sessionStartTime = Date.now();
    try {
      const stored = sessionStorage.getItem(SESSION_KEY);
      if (stored) {
        const session = _jsonParse(stored, null);
        if (session && Date.now() - session.created < 30 * 60 * 1000) { sessionStartTime = session.created; return session.id; }
      }
    } catch (e) {
      // sessionStorage read failed — non-critical
    }
    const newId = _mkId();
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: newId, created: sessionStartTime })); } catch (e) {
      // sessionStorage write failed — non-critical
    }
    return newId;
  }

  function track(eventName, properties = {}) {
    if (!isEnabled) return;
    eventQueue.push({
      event: eventName, timestamp: new Date().toISOString(), session_id: sessionId,
      pwa_id: telemetryManifest?.pwa_id || null, project_id: telemetryManifest?.project_id || config?.projectId || null,
      publish_id: telemetryManifest?.publish_id || null, publisher_org_id: telemetryManifest?.publisher_org_id || config?.publisherOrgId || null,
      app_slug: config?.appSlug || null, properties
    });
    if (eventQueue.length >= MAX_QUEUE_SIZE) flushQueue();
  }

  async function flushQueue(sync = false) {
    if (!isEnabled || eventQueue.length === 0) return;
    const events = eventQueue.splice(0, eventQueue.length);
    const endpoint = config?.telemetry?.endpoint;
    if (!endpoint) return;
    const payload = JSON.stringify({ events });
    if (sync && navigator.sendBeacon) { navigator.sendBeacon(endpoint, payload); }
    else {
      try {
        await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true });
      } catch (error) {
        if (events[0]._retries === undefined || events[0]._retries < 2) {
          events.forEach(e => e._retries = (e._retries || 0) + 1);
          eventQueue.unshift(...events);
        }
      }
    }
  }

  const events = {
    poiViewed: (poiId, poiTitle) => track('pwa.poi.viewed', { poi_id: poiId, poi_title: poiTitle }),
    viewSwitched: (fromView, toView) => track('pwa.view.switched', { from: fromView, to: toView }),
    mapInteraction: (action, details) => track('pwa.map.interaction', { action, ...details }),
    error: (errorType, message) => track('pwa.error', { error_type: errorType, message })
  };

  return { init, track, events, isActive: () => isEnabled, flush: flushQueue };
})();

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => MixxTelemetry.init());
else MixxTelemetry.init();
