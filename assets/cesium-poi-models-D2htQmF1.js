const MODEL_EXTENSIONS = new Set(['glb', 'gltf']);

function mediaExtension(url = '') {
  if (typeof url !== 'string') return '';
  try {
    const parsed = new URL(url, window.location.href);
    const pathname = parsed.pathname || '';
    const ext = pathname.split('.').pop();
    return ext && ext !== pathname ? ext.toLowerCase() : '';
  } catch {
    const clean = url.split(/[?#]/)[0] || '';
    const ext = clean.split('.').pop();
    return ext && ext !== clean ? ext.toLowerCase() : '';
  }
}

function normalizeMedia(item, projectMediaById) {
  if (!item) return null;
  if (typeof item === 'string') return projectMediaById.get(item) || null;
  if (item.id && !item.url && !item.dataURL && projectMediaById.has(item.id)) {
    return { ...projectMediaById.get(item.id), ...item };
  }
  return item;
}

function modelScale(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1;
}

function placementFor(poi = {}, media = {}) {
  const placement = media.placement || media.globePlacement || poi.modelPlacement || poi.globeModelPlacement || {};
  return {
    height: Number(placement.height ?? placement.altitude ?? media.height ?? media.altitude ?? poi.modelHeight ?? poi.altitude ?? poi.height ?? 0) || 0,
    heading: Number(placement.heading ?? media.heading ?? poi.modelHeading ?? poi.heading ?? 0) || 0,
    pitch: Number(placement.pitch ?? media.pitch ?? poi.modelPitch ?? 0) || 0,
    roll: Number(placement.roll ?? media.roll ?? poi.modelRoll ?? 0) || 0,
    scale: modelScale(placement.scale ?? media.scale ?? poi.modelScale ?? poi.scale ?? 1)
  };
}

function renderableModelMedia(poi = {}, project = {}) {
  const projectMediaById = new Map((project.media || []).filter(Boolean).map(item => [item.id, item]));
  return (poi.media || [])
    .map(item => normalizeMedia(item, projectMediaById))
    .filter(Boolean)
    .map(item => ({ ...item, url: item.url || item.dataURL || item.src || '' }))
    .filter(item => {
      const type = String(item.type || '').toLowerCase();
      const ext = mediaExtension(item.url);
      return (type === 'model3d' || type === 'model' || MODEL_EXTENSIONS.has(ext)) && MODEL_EXTENSIONS.has(ext);
    });
}

export function renderPoiGlobeModels({ Cesium, viewer, poi, project }) {
  if (!Cesium || !viewer?.entities || !poi) return [];
  const lon = Number(poi.lon ?? poi.lng);
  const lat = Number(poi.lat);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  return renderableModelMedia(poi, project).map((media, index) => {
    const placement = placementFor(poi, media);
    const position = Cesium.Cartesian3.fromDegrees(lon, lat, placement.height);
    return viewer.entities.add({
      id: `${poi.id}::model::${media.id || index}`,
      name: media.title || media.name || `${poi.title || poi.id} model`,
      position,
      orientation: Cesium.Transforms?.headingPitchRollQuaternion
        ? Cesium.Transforms.headingPitchRollQuaternion(
          position,
          Cesium.HeadingPitchRoll.fromDegrees(placement.heading, placement.pitch, placement.roll)
        )
        : undefined,
      model: {
        uri: media.url,
        scale: placement.scale,
        minimumPixelSize: 64,
        maximumScale: 20000,
        heightReference: Cesium.HeightReference?.RELATIVE_TO_GROUND || Cesium.HeightReference?.NONE
      },
      properties: {
        poiId: poi.id,
        mediaId: media.id || null,
        renderTarget: 'poi-globe-model'
      }
    });
  });
}
