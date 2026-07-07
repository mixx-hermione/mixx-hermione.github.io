import { D as EventBus } from './companion-C11S3Qca.js';

const THREE_URL = 'https://esm.sh/three@0.160.0';
const ORBIT_CONTROLS_URL = 'https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js';
const GLTF_LOADER_URL = 'https://esm.sh/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
const COLLADA_LOADER_URL = 'https://esm.sh/three@0.160.0/examples/jsm/loaders/ColladaLoader.js';
const USDZ_LOADER_URL = 'https://esm.sh/three@0.160.0/examples/jsm/loaders/USDZLoader.js';

const FALLBACK_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
    <path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/>
  </svg>
`;

function safeModelUrl(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    if (!['http:', 'https:', 'blob:', 'data:'].includes(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function extensionFor(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    const pathname = parsed.pathname.toLowerCase();
    return pathname.includes('.') ? pathname.split('.').pop() : '';
  } catch {
    const clean = String(url || '').split('?')[0].split('#')[0].toLowerCase();
    return clean.includes('.') ? clean.split('.').pop() : '';
  }
}

function resolveConversionEndpoint(options = {}) {
  const runtimeConfig = window.__MIXX_CONFIG__ || {};
  const viewerConfig = window.__MIXX_THREE_MODEL_VIEWER__ || {};
  return options.ifcConversionEndpoint
    || viewerConfig.ifcConversionEndpoint
    || runtimeConfig.ifcConversionEndpoint
    || runtimeConfig.modelConversionEndpoint
    || null;
}

class ThreeModelViewer {
  constructor() {
    this._initialized = false;
    this._loadPromise = null;
    this._current = null;
    this._modules = null;
    this._resizeObserver = null;
  }

  async init() {
    if (this._initialized) return true;
    this._modules = await this._loadThreeModules();
    this._initialized = true;
    return true;
  }

  async _loadThreeModules() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = Promise.all([
      import(THREE_URL),
      import(ORBIT_CONTROLS_URL),
      import(GLTF_LOADER_URL),
      import(COLLADA_LOADER_URL),
      import(USDZ_LOADER_URL)
    ]).then(([THREE, controls, gltf, collada, usdz]) => ({
      THREE,
      OrbitControls: controls.OrbitControls,
      GLTFLoader: gltf.GLTFLoader,
      ColladaLoader: collada.ColladaLoader,
      USDZLoader: usdz.USDZLoader
    }));
    return this._loadPromise;
  }

  async render(container, modelUrl, options = {}) {
    if (!container) return false;

    const safeUrl = safeModelUrl(modelUrl);
    if (!safeUrl) {
      this._renderFallback(container, 'Invalid 3D model URL');
      return false;
    }

    try {
      await this.init();
      this.destroy();
      container.innerHTML = '';

      const stage = this._createStage(container);
      const sceneState = this._createScene(stage);
      const loaded = await this._loadModelForUrl(safeUrl, options);
      const object = loaded.scene || loaded.object || loaded;
      sceneState.scene.add(object);
      this._fitCamera(sceneState, object);
      this._start(sceneState);

      this._current = { ...sceneState, stage, object };
      EventBus.emit('three_model_viewer_render', { url: modelUrl, extension: extensionFor(safeUrl), loader: loaded.loaderName });
      return true;
    } catch (error) {
      this._renderFallback(container, error && error.message ? error.message : 'Error loading 3D model');
      EventBus.emit('three_model_viewer_error', { url: modelUrl, message: error && error.message ? error.message : String(error) });
      return false;
    }
  }

  _createStage(container) {
    const stage = document.createElement('div');
    stage.className = 'three-model-viewer';
    stage.setAttribute('data-three-model-viewer', 'true');
    stage.style.cssText = 'position:relative;width:100%;height:100%;min-height:280px;background:#07111f;border-radius:16px;overflow:hidden;';
    container.appendChild(stage);
    return stage;
  }

  _createScene(stage) {
    const { THREE, OrbitControls } = this._modules;
    const width = Math.max(stage.clientWidth || stage.getBoundingClientRect().width || 320, 320);
    const height = Math.max(stage.clientHeight || stage.getBoundingClientRect().height || 280, 240);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07111f);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 10000);
    camera.position.set(3, 2, 5);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    stage.appendChild(renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x223344, 2.4);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(4, 8, 5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x82ffdc, 0.8);
    fill.position.set(-5, 3, -4);
    scene.add(fill);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);

    this._resizeObserver = new ResizeObserver(() => {
      const rect = stage.getBoundingClientRect();
      const w = Math.max(rect.width, 320);
      const h = Math.max(rect.height, 240);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    this._resizeObserver.observe(stage);

    return { THREE, scene, camera, renderer, controls, animationFrame: null };
  }

  async _loadModelForUrl(url, options) {
    switch (extensionFor(url)) {
      case 'glb':
      case 'gltf':
        return this._loadGltf(url);
      case 'dae':
        return this._loadDae(url);
      case 'usdz':
        return this._loadUsdz(url);
      case 'ifc':
        return this._loadIfcViaConversion(url, options);
      default:
        throw new Error('Unsupported 3D model format. Use GLB, GLTF, DAE, USDZ, or IFC with conversion.');
    }
  }

  async _loadGltf(url) {
    const loader = new this._modules.GLTFLoader();
    const gltf = await loader.loadAsync(url);
    return { scene: gltf.scene, loaderName: 'GLTFLoader' };
  }

  async _loadDae(url) {
    const loader = new this._modules.ColladaLoader();
    const collada = await loader.loadAsync(url);
    return { scene: collada.scene, loaderName: 'ColladaLoader' };
  }

  async _loadUsdz(url) {
    const loader = new this._modules.USDZLoader();
    const object = await loader.loadAsync(url);
    return { object, loaderName: 'USDZLoader' };
  }

  async _loadIfcViaConversion(url, options) {
    const convertedUrl = await this.convertIfcToGltfUrl(url, options);
    const loaded = await this._loadGltf(convertedUrl);
    return { ...loaded, loaderName: 'IFC conversion → GLTFLoader' };
  }

  async convertIfcToGltfUrl(url, options = {}) {
    const endpoint = resolveConversionEndpoint(options);
    if (!endpoint) {
      throw new Error('IFC requires a conversion endpoint before browser preview/render. Configure ifcConversionEndpoint to return a GLB/GLTF URL.');
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl: url, targetFormat: 'glb' })
    });
    if (!response.ok) throw new Error(`IFC conversion failed (${response.status})`);
    const payload = await response.json();
    const convertedUrl = payload.url || payload.gltfUrl || payload.glbUrl;
    if (!convertedUrl) throw new Error('IFC conversion response did not include a GLB/GLTF URL');
    return new URL(convertedUrl, window.location.origin).href;
  }

  _fitCamera(state, object) {
    const { THREE, camera, controls } = state;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const distance = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360));
    camera.position.copy(center).add(new THREE.Vector3(distance * 0.8, distance * 0.55, distance * 1.25));
    camera.near = Math.max(distance / 100, 0.01);
    camera.far = Math.max(distance * 100, 1000);
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
  }

  _start(state) {
    const tick = () => {
      state.controls.update();
      state.renderer.render(state.scene, state.camera);
      state.animationFrame = window.requestAnimationFrame(tick);
    };
    tick();
  }

  _renderFallback(container, message) {
    this.destroy();
    container.innerHTML = `
      <div class="model-viewer__fallback" data-three-model-viewer-fallback="true">
        ${FALLBACK_ICON}
        <p>${this._escape(message)}</p>
      </div>
    `;
  }

  _escape(value) {
    return String(value || '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[char]));
  }

  destroy() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (!this._current) return;
    if (this._current.animationFrame) window.cancelAnimationFrame(this._current.animationFrame);
    this._current.controls?.dispose?.();
    this._current.renderer?.dispose?.();
    this._current.stage?.remove?.();
    this._current = null;
  }

  isSupported() {
    try {
      const canvas = document.createElement('canvas');
      return !!(canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
    } catch {
      return false;
    }
  }
}

const threeModelViewer = new ThreeModelViewer();
export { threeModelViewer as X };
