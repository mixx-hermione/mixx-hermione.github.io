const ALLOWED_ACTIONS = new Set([
  'fit_pois',
  'highlight_pois',
  'activate_story_section',
  'show_story_excerpt',
  'show_context_card',
  'expand_assistant',
  'minimize_assistant'
]);

const ALLOWED_SOURCES = new Set(['project', 'story', 'story_section', 'poi', 'phase', 'media']);
const MAX_STATIC_TEXT_CHARS = 900;
const MAX_CONTEXT_CARD_CHARS = 700;
const MAX_GUIDE_SECTIONS = 12;
const MAX_GUIDE_TEXT_CHARS = 180;
const HOSTED_ASSISTANT_TIMEOUT_MS = 4000;
const LANGUAGE_OPTIONS = {
  en: { locale: 'en-US', preferredLanguage: 'English', label: 'English', shortLabel: 'EN', state: 'Ready' },
  es: { locale: 'es-ES', preferredLanguage: 'Spanish', label: 'Español', shortLabel: 'ES', state: 'Listo' }
};
const COPY = {
  en: {
    welcome: title => `Welcome. I can explain ${title}, show its key locations, guide you step by step, or let you explore on your own.`,
    suggestions: ['Explain this project', 'Show the key locations', 'Show the locations in the next step', 'I’ll explore'],
    safety: title => `I can help with ${title} using the published guide, but I cannot follow requests to reveal or override system instructions, secrets, credentials, or hidden configuration.`,
    exhausted: 'Hosted AI credits are exhausted, so I used the local published guide.',
    timeout: 'Hosted AI timed out, so I used the local published guide.',
    unavailable: 'Hosted AI is unavailable, so I used the local published guide.',
    nextMissing: title => `I do not have another indexed Story step for ${title}, but you can continue exploring the published locations.`,
    nextDefault: 'This is the next Story section.',
    highlighted: count => ` I highlighted ${count} related location${count === 1 ? '' : 's'}.`,
    overviewSuggestions: ['Show the key locations', 'Show the locations in the next step', 'Let me explore'],
    nextSuggestions: ['Explain each location', 'Continue to the next step', 'Return to overview']
  },
  es: {
    welcome: title => `Bienvenido. Puedo explicar ${title}, mostrar sus ubicaciones clave, guiarte paso a paso o dejar que explores por tu cuenta.`,
    suggestions: ['Explica este proyecto', 'Muestra las ubicaciones clave', 'Muestra el siguiente paso', 'Voy a explorar'],
    safety: title => `Puedo ayudarte con ${title} usando la guía publicada, pero no puedo seguir solicitudes para revelar o cambiar instrucciones del sistema, secretos, credenciales o configuración oculta.`,
    exhausted: 'Los créditos de IA hospedada se agotaron, así que usé la guía local publicada.',
    timeout: 'La IA hospedada tardó demasiado, así que usé la guía local publicada.',
    unavailable: 'La IA hospedada no está disponible, así que usé la guía local publicada.',
    nextMissing: title => `No tengo otro paso indexado de la historia para ${title}, pero puedes seguir explorando las ubicaciones publicadas.`,
    nextDefault: 'Esta es la siguiente sección de la historia.',
    highlighted: count => ` Destaqué ${count} ubicaci${count === 1 ? 'ón relacionada' : 'ones relacionadas'}.`,
    overviewSuggestions: ['Muestra las ubicaciones clave', 'Muestra las ubicaciones del siguiente paso', 'Déjame explorar'],
    nextSuggestions: ['Explica cada ubicación', 'Continúa al siguiente paso', 'Volver al resumen']
  }
};
const answerCache = new Map();
const PROMPT_INJECTION_PATTERN = /\b(ignore|disregard|forget)\b.{0,80}\b(previous|above|instructions|system|developer|rules)\b|\b(system prompt|developer message|secret|credential|api key|token)\b/i;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(value, maxChars = MAX_STATIC_TEXT_CHARS) {
  const text = cleanText(value);
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, Math.max(0, maxChars - 1)).trimEnd();
  return `${clipped}…`;
}

function compactGuideSection(section = {}) {
  return {
    id: isSafeEnvelopeId(section.id) ? section.id : null,
    title: truncateText(section.title || section.id || 'Section', 80),
    excerpt: truncateText(section.excerpt || section.text || '', MAX_GUIDE_TEXT_CHARS),
    relatedPoiIds: asArray(section.relatedPoiIds).filter(isSafeEnvelopeId).slice(0, 6)
  };
}

function compactGuideIndex(project = {}) {
  const source = project.guideIndex || project.ai?.guideIndex || project.storyIndex || {};
  return {
    sections: asArray(source.sections)
      .map(compactGuideSection)
      .filter(section => section.id)
      .slice(0, MAX_GUIDE_SECTIONS)
  };
}

function compactAssistantSession(session = {}) {
  return {
    activeStorySectionId: isSafeEnvelopeId(session.activeStorySectionId) ? session.activeStorySectionId : null,
    selectedPoiId: isSafeEnvelopeId(session.selectedPoiId) ? session.selectedPoiId : null,
    highlightedPoiIds: asArray(session.highlightedPoiIds).filter(isSafeEnvelopeId).slice(0, 12),
    discussedPoiIds: asArray(session.discussedPoiIds).filter(isSafeEnvelopeId).slice(-12),
    discussedSectionIds: asArray(session.discussedSectionIds).filter(isSafeEnvelopeId).slice(-12),
    aiAvailability: cleanText(session.aiAvailability || 'available') || 'available',
    language: session.language || languageStateFromCode('en')
  };
}

function isSafeEnvelopeId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value);
}

function getProjectTitle(project) {
  return project?.project?.title || project?.title || project?.meta?.title || 'this project';
}

function getProjectId(project = {}) {
  return project?.project?.id || project?.id || project?.meta?.id || project?.slug || 'project';
}

function storageKeyForLanguage(project = {}) {
  return `mixx:pwa:${getProjectId(project)}:assistant-language`;
}

function languageCodeFromLocale(locale = '') {
  return String(locale || '').toLowerCase().startsWith('es') ? 'es' : 'en';
}

function browserLocale() {
  if (typeof navigator === 'undefined') return 'en-US';
  const languages = Array.isArray(navigator.languages) ? navigator.languages : [];
  return languages[0] || navigator.language || 'en-US';
}

function readStoredLanguage(project = {}) {
  try {
    const stored = localStorage.getItem(storageKeyForLanguage(project));
    return stored === 'es' || stored === 'en' ? stored : null;
  } catch {
    return null;
  }
}

function persistLanguage(project = {}, code = 'en') {
  try { localStorage.setItem(storageKeyForLanguage(project), code); } catch { /* storage unavailable */ }
}

function languageStateFromCode(code = 'en', source = 'browser', localeOverride = null) {
  const safeCode = code === 'es' ? 'es' : 'en';
  const option = LANGUAGE_OPTIONS[safeCode];
  return {
    locale: localeOverride || option.locale,
    preferredLanguage: option.preferredLanguage,
    source
  };
}

export function resolveAssistantLanguage(project = {}) {
  const stored = readStoredLanguage(project);
  if (stored) return languageStateFromCode(stored, 'user');
  const locale = browserLocale();
  return languageStateFromCode(languageCodeFromLocale(locale), 'browser', locale);
}

function languageCodeFromState(language = {}) {
  return language?.preferredLanguage === 'Spanish' || String(language?.locale || '').toLowerCase().startsWith('es') ? 'es' : 'en';
}

function copyForLanguage(language = {}) {
  return COPY[languageCodeFromState(language)];
}

function updateLanguageToggle(project, session) {
  const shell = document.querySelector('.mixx-assistant');
  if (!shell) return;
  const activeCode = languageCodeFromState(session?.language);
  shell.querySelectorAll('[data-mixx-language]').forEach(button => {
    const active = button.getAttribute('data-mixx-language') === activeCode;
    button.classList.toggle('mixx-assistant__language-button--active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  const state = shell.querySelector('.mixx-assistant__state');
  if (state) state.textContent = LANGUAGE_OPTIONS[activeCode].state;
}

export function setAssistantLanguage(project = {}, session = createAssistantSessionState(project), code = 'en') {
  const safeCode = code === 'es' ? 'es' : 'en';
  session.language = languageStateFromCode(safeCode, 'user');
  persistLanguage(project, safeCode);
  updateLanguageToggle(project, session);
  return session.language;
}

function getProjectDescription(project) {
  return cleanText(project?.project?.description || project?.description || project?.meta?.description || '');
}

function getSections(project) {
  return asArray(project?.storyIndex?.sections);
}

function getPois(project) {
  return asArray(project?.pois);
}

function getSectionById(project, sectionId) {
  return getSections(project).find(section => section.id === sectionId) || null;
}

function getPoiIdsForSection(project, section) {
  const explicit = asArray(section?.relatedPoiIds).filter(Boolean);
  if (explicit.length > 0) return explicit;
  const phase = asArray(project?.phases).find(item => item.id === section?.relatedPhaseId);
  if (phase?.poiIds?.length) return phase.poiIds.filter(Boolean);
  return [];
}

function firstSupportedSection(project) {
  return getSections(project).find(section => cleanText(section.excerpt || section.text)) || null;
}

function firstSectionWithPois(project) {
  return getSections(project).find(section => getPoiIdsForSection(project, section).length > 0) || firstSupportedSection(project);
}

function nextSection(project, activeSectionId) {
  const sections = getSections(project);
  if (sections.length === 0) return null;
  const activeIndex = sections.findIndex(section => section.id === activeSectionId);
  if (activeIndex < 0) return sections[0];
  return sections[Math.min(activeIndex + 1, sections.length - 1)] || sections[0];
}

function firstFallbackPoiIds(project) {
  return getPois(project)
    .filter(poi => Number.isFinite(Number(poi.lat)) && Number.isFinite(Number(poi.lon)))
    .slice(0, 6)
    .map(poi => poi.id)
    .filter(Boolean);
}

function isAssistantEnabled(project = {}) {
  if (project?.ai?.enabled === false) return false;
  if (project?.features?.ai === false) return false;
  if (project?.config?.features?.ai === false) return false;
  if (project?.runtimeConfig?.features?.ai === false) return false;
  return project?.ai?.enabled === true || Boolean(project?.storyIndex?.sections?.length);
}

function getPoiById(project, poiId) {
  return getPois(project).find(poi => poi.id === poiId) || null;
}

function poiCoordinates(poi) {
  if (!poi) return null;
  const lat = Number(poi.lat);
  const lon = Number(poi.lon ?? poi.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function dispatchPwaEvent(name, detail = {}) {
  const event = new CustomEvent(name, { detail, bubbles: true, composed: true });
  document.dispatchEvent(event);
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function patchRuntimeState(path, value) {
  const state = window.AppState || window.MixxAppState || window.mixx?.AppState || null;
  if (state && typeof state.set === 'function') {
    try { state.set(path, value); } catch { /* non-fatal bridge best effort */ }
  }
}

function bridgeStorySection(project, sectionId) {
  const section = getSectionById(project, sectionId);
  const phaseId = section?.relatedPhaseId || section?.phaseId || null;
  patchRuntimeState('narrative.mode', 'guided');
  patchRuntimeState('panels.story.open', true);
  if (phaseId) patchRuntimeState('narrative.activePhaseId', phaseId);
  dispatchPwaEvent('mixx:story-open', { source: 'assistant', sectionId, phaseId });
  if (phaseId) {
    dispatchPwaEvent('mixx:phase-change', { source: 'assistant', phaseId, sectionId });
    dispatchPwaEvent('mixx:phase-jump', { source: 'assistant', phaseId, sectionId });
  }
}

function bridgePoiSelection(project, poiId, state = 'preview') {
  const poi = getPoiById(project, poiId);
  if (!poi) return;
  patchRuntimeState('selectedPoi', poi);
  patchRuntimeState('panels.bottomSheet.state', state);
  dispatchPwaEvent('mixx:poi-select', { source: 'assistant', poi, poiId, state });
}

function bridgePoiHighlight(project, poiIds, dimOthers = false) {
  patchRuntimeState('highlightedPoiIds', poiIds);
  if (dimOthers) patchRuntimeState('visiblePoiIds', poiIds);
  dispatchPwaEvent('mixx:poi-highlight', { source: 'assistant', poiIds });
  dispatchPwaEvent('mixx:filter-apply', {
    source: 'assistant',
    visiblePoiIds: dimOthers ? poiIds : null,
    highlightPoiIds: poiIds,
    highlightedPoiIds: poiIds
  });
  const firstPoi = getPoiById(project, poiIds[0]);
  const coordinates = poiCoordinates(firstPoi);
  if (coordinates) {
    dispatchPwaEvent('mixx:poi-focus', { source: 'assistant', poiId: firstPoi.id, poi: firstPoi });
    dispatchPwaEvent('mixx:focus-location', {
      source: 'assistant',
      poiId: firstPoi.id,
      label: firstPoi.title || firstPoi.name || firstPoi.id,
      ...coordinates
    });
  }
}

function bridgeAssistantPanel(open) {
  patchRuntimeState('panels.chat.open', open);
  dispatchPwaEvent(open ? 'mixx:chat-open' : 'mixx:chat-close', { source: 'assistant' });
}

function sourceForSection(section) {
  return section ? [{ type: 'story_section', id: section.id, label: section.title || section.id }] : [];
}

function actionsForSection(project, section) {
  const poiIds = getPoiIdsForSection(project, section);
  const resolvedPoiIds = poiIds.length > 0 ? poiIds : firstFallbackPoiIds(project);
  const actions = [];
  if (section?.id) actions.push({ type: 'activate_story_section', sectionId: section.id });
  if (resolvedPoiIds.length > 0) {
    actions.push({ type: 'fit_pois', poiIds: resolvedPoiIds });
    actions.push({ type: 'highlight_pois', poiIds: resolvedPoiIds, dimOthers: true });
  }
  if (section?.id) {
    actions.push({ type: 'show_story_excerpt', sectionId: section.id });
    actions.push({
      type: 'show_context_card',
      card: {
        title: truncateText(section.title || 'Story section', 120),
        body: truncateText(section.excerpt || section.text || '', MAX_CONTEXT_CARD_CHARS),
        source: { type: 'story_section', id: section.id, label: truncateText(section.title || section.id, 120) }
      }
    });
  }
  actions.push({ type: 'expand_assistant' });
  return actions;
}

export function createAssistantSessionState(project = {}) {
  return {
    projectId: getProjectId(project),
    mode: 'guided',
    selectedPoiId: null,
    highlightedPoiIds: [],
    activeStorySectionId: null,
    activePhaseId: null,
    timelinePosition: null,
    visibleMapBounds: null,
    mapMode: null,
    currentMediaId: null,
    discussedPoiIds: [],
    discussedSectionIds: [],
    lastAssistantResponse: null,
    aiAvailability: project?.ai?.enabled ? 'available' : 'static-guide',
    language: resolveAssistantLanguage(project)
  };
}

function requireSafeEnvelopeId(value, field) {
  if (!isSafeEnvelopeId(value)) throw new Error(`${field} requires a safe id`);
  return value;
}

function cleanStringIds(value, field) {
  const ids = asArray(value).filter(isSafeEnvelopeId);
  if (ids.length === 0) throw new Error(`${field} requires poiIds`);
  return ids;
}

function validateSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('source card must be an object');
  if (!ALLOWED_SOURCES.has(source.type)) throw new Error(`invalid source type: ${source.type}`);
  const id = requireSafeEnvelopeId(source.id, 'source.id');
  const cleanedLabel = cleanText(source.label);
  return cleanedLabel ? { type: source.type, id, label: cleanedLabel } : { type: source.type, id };
}

function validateContextCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error('show_context_card requires card object');
  if (card.source) {
    const source = validateSource(card.source);
    return {
      title: cleanText(card.title) || source.label,
      body: cleanText(card.body || card.text) || source.label,
      source
    };
  }
  if (card.type || card.id) {
    if (!['story', 'poi'].includes(card.type) || !isSafeEnvelopeId(card.id)) {
      throw new Error('show_context_card requires a safe story or poi card');
    }
    return { type: card.type, id: card.id };
  }
  return {
    title: cleanText(card.title) || 'Context',
    body: cleanText(card.body || card.text) || 'Context'
  };
}

function validateAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('assistant action must be an object');
  if (!ALLOWED_ACTIONS.has(action.type)) throw new Error(`unsafe assistant action type: ${action.type}`);
  switch (action.type) {
    case 'fit_pois':
      return { type: action.type, poiIds: cleanStringIds(action.poiIds, action.type) };
    case 'highlight_pois':
      return { type: action.type, poiIds: cleanStringIds(action.poiIds, action.type), ...(action.dimOthers === true ? { dimOthers: true } : {}) };
    case 'activate_story_section':
    case 'show_story_excerpt':
      return { type: action.type, sectionId: requireSafeEnvelopeId(action.sectionId, `${action.type}.sectionId`) };
    case 'show_context_card':
      return { type: action.type, card: validateContextCard(action.card) };
    case 'expand_assistant':
    case 'minimize_assistant':
      return { type: action.type };
    default:
      throw new Error(`unsupported assistant action type: ${action.type}`);
  }
}

export function validateAssistantResponse(response = {}) {
  const errors = [];
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { valid: false, errors: ['assistant envelope must be an object'], message: '', speech: '', actions: [], suggestions: [], sources: [] };
  }
  const actions = [];
  for (const action of asArray(response.actions)) {
    try { actions.push(validateAction(action)); }
    catch (error) { errors.push(error.message); }
  }
  const sources = [];
  for (const source of asArray(response.sources)) {
    try { sources.push(validateSource(source)); }
    catch (error) { errors.push(error.message); }
  }
  const message = cleanText(response.message || response.answer);
  return {
    valid: errors.length === 0,
    errors,
    message,
    answer: message,
    speech: cleanText(response.speech || response.message || response.answer),
    actions,
    suggestions: asArray(response.suggestions).slice(0, 4).map(cleanText).filter(Boolean),
    sources
  };
}

export function createStaticGuideResponse(project = {}, session = {}, intent = 'explain_project') {
  const title = getProjectTitle(project);
  const copy = copyForLanguage(session.language);
  let section = null;
  let message = '';

  if (intent === 'next_step') {
    section = nextSection(project, session.activeStorySectionId);
    if (section) {
      const poiCount = getPoiIdsForSection(project, section).length;
      message = `${truncateText(section.title, 120)}: ${truncateText(section.excerpt || section.text || copy.nextDefault, MAX_STATIC_TEXT_CHARS)}`;
      if (poiCount > 0) message += copy.highlighted(poiCount);
    } else {
      message = copy.nextMissing(title);
    }
  } else {
    section = firstSectionWithPois(project);
    const description = getProjectDescription(project);
    const sourceText = truncateText(section?.excerpt || section?.text || description, MAX_STATIC_TEXT_CHARS);
    message = truncateText(`${title}${description ? ` — ${description}` : ''}`, 260);
    if (sourceText && !message.includes(sourceText)) message += ` ${sourceText}`;
  }

  message = truncateText(message, MAX_STATIC_TEXT_CHARS);
  const actions = section ? actionsForSection(project, section) : [{ type: 'expand_assistant' }];
  const response = {
    message: cleanText(message),
    speech: cleanText(message),
    actions,
    suggestions: intent === 'next_step' ? copy.nextSuggestions : copy.overviewSuggestions,
    sources: sourceForSection(section)
  };
  return validateAssistantResponse(response);
}

function ensureAssistantShell() {
  let shell = document.querySelector('.mixx-assistant');
  if (shell) return shell;

  shell = document.createElement('aside');
  shell.className = 'mixx-assistant mixx-assistant--expanded';
  shell.setAttribute('role', 'region');
  shell.setAttribute('aria-labelledby', 'mixx-assistant-title');
  shell.innerHTML = `
    <div class="mixx-assistant__header">
      <span class="mixx-assistant__logo" aria-hidden="true">✦</span>
      <div><strong id="mixx-assistant-title">Mixx AI</strong><span class="mixx-assistant__state">Ready</span></div>
      <div class="mixx-assistant__language" aria-label="Assistant language">
        <button type="button" class="mixx-assistant__language-button" data-mixx-language="en" aria-pressed="false">EN</button>
        <button type="button" class="mixx-assistant__language-button" data-mixx-language="es" aria-pressed="false">ES</button>
      </div>
    </div>
    <div class="mixx-assistant__answer" role="status" aria-live="polite" aria-atomic="true"></div>
    <div class="mixx-assistant__evidence" aria-live="polite"></div>
    <div class="mixx-assistant__suggestions" aria-label="Suggested assistant prompts"></div>
  `;
  document.body.appendChild(shell);
  return shell;
}

function renderAssistantResponse(response) {
  const shell = ensureAssistantShell();
  const answer = shell.querySelector('.mixx-assistant__answer');
  if (answer) answer.textContent = response.message || '';
  const suggestions = shell.querySelector('.mixx-assistant__suggestions');
  if (suggestions) {
    suggestions.replaceChildren(...asArray(response.suggestions).map(text => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mixx-assistant__suggestion';
      button.textContent = text;
      return button;
    }));
  }
}

function emitAssistantAction(action, payload = {}) {
  document.dispatchEvent(new CustomEvent('mixx:assistant-action', { detail: { type: action.type, action, ...payload } }));
}

function applyPoiHighlight(poiIds, dimOthers = false) {
  const wanted = new Set(poiIds);
  document.querySelectorAll('[data-poi-id]').forEach(node => {
    const id = node.getAttribute('data-poi-id');
    const active = wanted.has(id);
    node.classList.toggle('mixx-poi--highlighted', active);
    node.classList.toggle('mixx-poi--dimmed', dimOthers && !active);
  });
}

function showStoryCard(project, sectionId) {
  const shell = ensureAssistantShell();
  const evidence = shell.querySelector('.mixx-assistant__evidence');
  const section = getSectionById(project, sectionId);
  if (!evidence || !section) return;
  const card = document.createElement('article');
  card.className = 'mixx-assistant-source-card';
  card.setAttribute('tabindex', '-1');
  const titleId = `mixx-assistant-source-${String(section.id).replace(/[^a-z0-9_-]/gi, '-')}-title`;
  card.setAttribute('aria-labelledby', titleId);
  const label = document.createElement('div');
  label.className = 'mixx-assistant-source-card__label';
  label.textContent = 'From the project Story';
  const title = document.createElement('h3');
  title.id = titleId;
  title.textContent = section.title;
  const excerpt = document.createElement('p');
  excerpt.textContent = section.excerpt || section.text || '';
  card.append(label, title, excerpt);
  evidence.replaceChildren(card);
}

export function dispatchAssistantActions(project = {}, session = createAssistantSessionState(project), actions = []) {
  const safeActions = [];
  for (const action of asArray(actions)) {
    const validation = validateAssistantResponse({ message: 'action', actions: [action], sources: [] });
    if (validation.valid && validation.actions.length === 1) safeActions.push(validation.actions[0]);
  }
  for (const action of safeActions) {
    switch (action.type) {
      case 'activate_story_section':
        session.activeStorySectionId = action.sectionId;
        if (!session.discussedSectionIds.includes(action.sectionId)) session.discussedSectionIds.push(action.sectionId);
        document.documentElement.dataset.activeStorySection = action.sectionId;
        bridgeStorySection(project, action.sectionId);
        emitAssistantAction(action, { sectionId: action.sectionId });
        break;
      case 'show_story_excerpt':
        showStoryCard(project, action.sectionId);
        emitAssistantAction(action, { sectionId: action.sectionId });
        break;
      case 'show_context_card':
        if (action.card?.source?.type === 'story_section' && action.card.source.id) showStoryCard(project, action.card.source.id);
        if (action.card?.source?.type === 'poi' && action.card.source.id) bridgePoiSelection(project, action.card.source.id, action.state || 'preview');
        emitAssistantAction(action, { card: action.card || null });
        break;
      case 'fit_pois':
        session.visibleMapBounds = action.poiIds;
        bridgePoiHighlight(project, action.poiIds, false);
        emitAssistantAction(action, { poiIds: action.poiIds });
        break;
      case 'highlight_pois':
        session.highlightedPoiIds = [...action.poiIds];
        applyPoiHighlight(action.poiIds, action.dimOthers === true);
        bridgePoiHighlight(project, action.poiIds, action.dimOthers === true);
        emitAssistantAction(action, { poiIds: action.poiIds });
        break;
      case 'expand_assistant':
        ensureAssistantShell().classList.add('mixx-assistant--expanded');
        ensureAssistantShell().classList.remove('mixx-assistant--minimized');
        bridgeAssistantPanel(true);
        emitAssistantAction(action);
        break;
      case 'minimize_assistant':
        ensureAssistantShell().classList.add('mixx-assistant--minimized');
        ensureAssistantShell().classList.remove('mixx-assistant--expanded');
        bridgeAssistantPanel(false);
        emitAssistantAction(action);
        break;
      default:
        break;
    }
  }
  return session;
}

export function applyAssistantResponse(project, session, response) {
  const validated = validateAssistantResponse(response);
  if (!validated.valid) return validated;
  session.lastAssistantResponse = validated;
  renderAssistantResponse(validated);
  dispatchAssistantActions(project, session, validated.actions);
  return validated;
}

async function loadPublishedProject() {
  if (window.__MIXX_ASSISTANT_PROJECT__) return window.__MIXX_ASSISTANT_PROJECT__;
  try {
    const response = await fetch('./data/project.json');
    if (!response.ok) return null;
    const project = await response.json();
    window.__MIXX_ASSISTANT_PROJECT__ = project;
    return project;
  } catch {
    return null;
  }
}

function cacheKey(project, session, prompt, intent) {
  const languageCode = languageCodeFromState(session?.language);
  return [project?.project?.id || project?.id || project?.meta?.id || 'project', intent || 'hosted', languageCode, cleanText(prompt).toLowerCase(), session.activeStorySectionId || '', session.selectedPoiId || ''].join('|');
}

export function routeLocalAssistantIntent(prompt = '', project = {}, session = createAssistantSessionState(project)) {
  const text = cleanText(prompt).toLowerCase();
  if (!text) return { intent: 'explain_project', reason: 'empty' };
  if (PROMPT_INJECTION_PATTERN.test(text)) return { intent: 'safety_refusal', reason: 'prompt-injection' };
  if (/\b(next|continue|step|where now|what now)\b/.test(text)) return { intent: 'next_step', reason: 'guide' };
  if (/\b(explain|overview|about|story|project|start|begin)\b/.test(text)) return { intent: 'explain_project', reason: 'guide' };
  if (/\b(location|locations|poi|pois|place|places|map|show|highlight|key)\b/.test(text)) return { intent: 'explain_project', reason: 'guide' };
  return null;
}

function createSafetyResponse(project, session = createAssistantSessionState(project)) {
  const title = getProjectTitle(project);
  const copy = copyForLanguage(session.language);
  return validateAssistantResponse({
    message: copy.safety(title),
    actions: [{ type: 'expand_assistant' }],
    suggestions: copy.overviewSuggestions.slice(0, 2),
    sources: []
  });
}

function staticResponseForIntent(project, session, intent) {
  if (intent === 'safety_refusal') return createSafetyResponse(project, session);
  return createStaticGuideResponse(project, session, intent || 'explain_project');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = HOSTED_ASSISTANT_TIMEOUT_MS) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller?.abort();
      const timeoutError = new Error('hosted assistant timed out');
      timeoutError.code = 'AI_TIMEOUT';
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetch(url, { ...options, ...(controller ? { signal: controller.signal } : {}) }),
      timeoutPromise
    ]);
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('hosted assistant timed out');
      timeoutError.code = 'AI_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function requestHostedAssistant(project, session, prompt) {
  const endpoint = project?.ai?.endpoint || project?.runtimeConfig?.ai?.endpoint || window.__MIXX_CONFIG__?.ai?.endpoint;
  if (!endpoint || project?.ai?.enabled === false) throw new Error('hosted assistant unavailable');
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: truncateText(prompt, 1000),
      sessionId: session.sessionId || session.projectId || getProjectId(project),
      language: session.language || resolveAssistantLanguage(project),
      visitorState: compactAssistantSession(session),
      guideIndex: compactGuideIndex(project)
    })
  });
  if (response.status === 402 || response.status === 429) {
    const error = new Error('hosted assistant credits exhausted');
    error.code = 'AI_CREDITS_EXHAUSTED';
    throw error;
  }
  if (!response.ok) throw new Error(`hosted assistant failed: ${response.status}`);
  const providerBody = await response.json();
  const envelope = validateAssistantResponse(providerBody?.assistant || providerBody);
  if (!envelope.valid) throw new Error(`hosted assistant returned invalid envelope: ${envelope.errors.join('; ')}`);
  return envelope;
}

export async function askAssistant(project = {}, session = createAssistantSessionState(project), prompt = '') {
  const local = routeLocalAssistantIntent(prompt, project, session);
  if (local) {
    const response = staticResponseForIntent(project, session, local.intent);
    applyAssistantResponse(project, session, response);
    return { ...response, source: 'local-guide', reason: local.reason };
  }

  const key = cacheKey(project, session, prompt, 'hosted');
  if (answerCache.has(key)) {
    const cached = answerCache.get(key);
    applyAssistantResponse(project, session, cached);
    return { ...cached, source: 'cache' };
  }

  try {
    const hosted = await requestHostedAssistant(project, session, prompt);
    answerCache.set(key, hosted);
    applyAssistantResponse(project, session, hosted);
    return { ...hosted, source: 'hosted-ai' };
  } catch (error) {
    const code = error.code === 'AI_CREDITS_EXHAUSTED' ? 'AI_CREDITS_EXHAUSTED' : (error.code === 'AI_TIMEOUT' ? 'AI_TIMEOUT' : null);
    session.aiAvailability = code === 'AI_CREDITS_EXHAUSTED' ? 'exhausted-fallback' : 'static-guide';
    const fallback = createStaticGuideResponse(project, session, 'explain_project');
    const copy = copyForLanguage(session.language);
    const reasonText = code === 'AI_CREDITS_EXHAUSTED'
      ? copy.exhausted
      : (code === 'AI_TIMEOUT' ? copy.timeout : copy.unavailable);
    fallback.message = truncateText(`${fallback.message} ${reasonText}`, 1200);
    fallback.answer = fallback.message;
    applyAssistantResponse(project, session, fallback);
    return { ...fallback, source: 'fallback', reason: code || error.message };
  }
}

export async function initMixxAssistant() {
  const project = await loadPublishedProject();
  if (!project || !isAssistantEnabled(project)) {
    document.querySelector('.mixx-assistant')?.remove();
    window.MixxAssistant = null;
    return null;
  }
  const session = createAssistantSessionState(project);
  const copy = copyForLanguage(session.language);
  const welcome = validateAssistantResponse({
    message: copy.welcome(getProjectTitle(project)),
    actions: [{ type: 'expand_assistant' }],
    suggestions: copy.suggestions,
    sources: []
  });
  renderAssistantResponse(welcome);
  dispatchAssistantActions(project, session, welcome.actions);

  const shell = ensureAssistantShell();
  updateLanguageToggle(project, session);
  shell.addEventListener('click', event => {
    const languageButton = event.target.closest('[data-mixx-language]');
    if (languageButton) {
      setAssistantLanguage(project, session, languageButton.getAttribute('data-mixx-language'));
      const nextCopy = copyForLanguage(session.language);
      renderAssistantResponse(validateAssistantResponse({
        message: nextCopy.welcome(getProjectTitle(project)),
        actions: [],
        suggestions: nextCopy.suggestions,
        sources: []
      }));
      return;
    }
    const button = event.target.closest('.mixx-assistant__suggestion');
    if (!button) return;
    askAssistant(project, session, button.textContent || copyForLanguage(session.language).overviewSuggestions[0]);
  });

  window.MixxAssistant = { project, session, createStaticGuideResponse, applyAssistantResponse, dispatchAssistantActions, routeLocalAssistantIntent, setLanguage: (code) => setAssistantLanguage(project, session, code), ask: (prompt) => askAssistant(project, session, prompt) };
  return window.MixxAssistant;
}

if (typeof document !== 'undefined' && !window.__MIXX_ASSISTANT_DISABLE_AUTO_INIT__) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => initMixxAssistant());
  else initMixxAssistant();
}
