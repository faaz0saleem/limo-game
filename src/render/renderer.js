import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { CinematicShader } from './post.js';
import { clamp, damp } from '../util.js';

export const QUALITY = {
  low: {
    pixelRatio: 1.0, shadows: false, shadowSize: 1024, bloom: 0.34,
    smaa: false, cinematic: true, samples: 3, drawDistance: 380,
    particles: 220, skidSegments: 900, lightsPerBlock: 1,
  },
  high: {
    pixelRatio: 1.5, shadows: true, shadowSize: 2048, bloom: 0.48,
    smaa: true, cinematic: true, samples: 6, drawDistance: 620,
    particles: 520, skidSegments: 2200, lightsPerBlock: 1,
  },
  ultra: {
    pixelRatio: 2.0, shadows: true, shadowSize: 4096, bloom: 0.58,
    smaa: true, cinematic: true, samples: 10, drawDistance: 900,
    particles: 900, skidSegments: 4000, lightsPerBlock: 2,
  },
};

export class Stage {
  constructor(canvas, qualityName = 'high') {
    this.quality = QUALITY[qualityName] ? qualityName : 'high';
    const q = QUALITY[this.quality];

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // SMAA in the composer handles edges
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      62, window.innerWidth / window.innerHeight, 0.4, 2600,
    );

    this._buildComposer(q);

    this._targetExposure = 1.08;
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  _buildComposer(q) {
    this.composer?.dispose();

    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.composer.setSize(window.innerWidth, window.innerHeight);

    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y), q.bloom, 0.42, 0.95,
    );
    this.composer.addPass(this.bloomPass);

    this.cinematicPass = new ShaderPass(CinematicShader);
    this.cinematicPass.uniforms.uSamples.value = q.samples;
    this.cinematicPass.enabled = q.cinematic;
    this.composer.addPass(this.cinematicPass);

    this.composer.addPass(new OutputPass());

    if (q.smaa) {
      this.smaaPass = new SMAAPass(window.innerWidth, window.innerHeight);
      this.composer.addPass(this.smaaPass);
    } else {
      this.smaaPass = null;
    }
  }

  setQuality(name) {
    if (!QUALITY[name] || name === this.quality) return;
    this.quality = name;
    const q = QUALITY[name];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadows;
    this._buildComposer(q);
    this.resize();
  }

  get settings() {
    return QUALITY[this.quality];
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.bloomPass?.setSize(size.x, size.y);
  }

  /** `speed01` drives the radial blur; `damage` flashes the frame red. */
  update(dt, { speed01 = 0, damage = 0 } = {}) {
    if (!this.cinematicPass) return;
    const u = this.cinematicPass.uniforms;
    u.uTime.value += dt;
    u.uSpeed.value = damp(u.uSpeed.value, clamp(speed01, 0, 1), 6, dt);
    u.uDamage.value = damp(u.uDamage.value, damage, 9, dt);
  }

  render() {
    this.composer.render();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.composer?.dispose();
    this.renderer.dispose();
  }
}
