import * as THREE from 'three';

/**
 * One combined "camera" pass: radial speed blur, chromatic aberration,
 * vignette and film grain. Bundling them means a single fullscreen read
 * instead of four, which matters a lot at 4K on integrated graphics.
 *
 * Runs in HDR linear space, before tone mapping.
 */
export const CinematicShader = {
  name: 'CinematicShader',

  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uSpeed: { value: 0 },        // 0..1, drives radial blur + aberration
    uVignette: { value: 0.34 },
    uAberration: { value: 0.4 },
    uGrain: { value: 0.016 },
    uDamage: { value: 0 },       // brief red pulse on impact
    uSamples: { value: 6 },
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,

  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uSpeed, uVignette, uAberration, uGrain, uDamage;
    uniform int uSamples;
    varying vec2 vUv;

    float hash( vec2 p ) {
      return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
    }

    void main() {
      vec2 centered = vUv - 0.5;
      float dist = length( centered );

      // --- radial blur: streak pixels outward from the vanishing point.
      vec3 col = vec3( 0.0 );
      float blur = uSpeed * 0.035 * smoothstep( 0.05, 0.75, dist );
      float total = 0.0;
      for ( int i = 0; i < 12; i++ ) {
        if ( i >= uSamples ) break;
        float t = float( i ) / float( uSamples );
        float w = 1.0 - t * 0.65;
        vec2 uv = vUv - centered * blur * t;

        // --- chromatic aberration grows with distance from centre.
        float ca = ( 0.0012 + uSpeed * 0.0035 ) * uAberration * dist;
        col += vec3(
          texture2D( tDiffuse, uv + centered * ca ).r,
          texture2D( tDiffuse, uv ).g,
          texture2D( tDiffuse, uv - centered * ca ).b
        ) * w;
        total += w;
      }
      col /= total;

      // --- vignette.
      float vig = smoothstep( 0.92, 0.22, dist * ( 1.0 + uVignette * 0.55 ) );
      col *= mix( 1.0, vig, uVignette );

      // --- impact flash.
      col = mix( col, col * vec3( 1.6, 0.35, 0.42 ), uDamage * 0.55 );

      // --- grain, strongest in the shadows where banding would show.
      float g = hash( vUv * vec2( 1024.0, 768.0 ) + fract( uTime ) * 91.7 ) - 0.5;
      float lum = dot( col, vec3( 0.299, 0.587, 0.114 ) );
      col += g * uGrain * ( 1.0 - smoothstep( 0.0, 0.85, lum ) );

      gl_FragColor = vec4( max( col, 0.0 ), 1.0 );
    }
  `,
};

/**
 * The sky itself: a gradient dome with procedural stars and a sun/moon disc.
 * Every colour is a uniform so the day/night cycle can drive it, and the stars
 * fade out as dawn comes up.
 */
export function makeSkyDome(radius = 2200) {
  const geo = new THREE.SphereGeometry(radius, 40, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x05070f) },
      uHorizon: { value: new THREE.Color(0x1b2450) },
      uGlow: { value: new THREE.Color(0x6a3a5c) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.6, 0.2) },
      uStarFade: { value: 1 },
      uDaylight: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vWorld = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uTop, uHorizon, uGlow, uSunDir;
      uniform float uStarFade, uDaylight;
      varying vec3 vWorld;

      // Cheap 3D hash — good enough for a star field.
      float hash13( vec3 p ) {
        p = fract( p * 0.1031 );
        p += dot( p, p.yzx + 33.33 );
        return fract( ( p.x + p.y ) * p.z );
      }

      void main() {
        vec3 dir = normalize( vWorld );
        float h = dir.y;

        vec3 c = mix( uHorizon, uTop, smoothstep( 0.0, 0.55, h ) );
        c = mix( c, uGlow, smoothstep( 0.14, -0.06, h ) * 0.75 );

        // --- stars: quantise the direction into cells and light a few.
        if ( uStarFade > 0.01 && h > -0.05 ) {
          vec3 cell = floor( dir * 260.0 );
          float r = hash13( cell );
          if ( r > 0.9965 ) {
            float tw = 0.65 + 0.35 * sin( uStarFade * 6.2831 + r * 90.0 );
            float bright = ( r - 0.9965 ) / 0.0035;
            c += vec3( 0.85, 0.9, 1.0 ) * bright * tw * uStarFade
                 * smoothstep( -0.05, 0.25, h );
          }
        }

        // --- sun / moon disc plus its halo.
        float sd = max( dot( dir, normalize( uSunDir ) ), 0.0 );
        vec3 discCol = mix( vec3( 0.86, 0.91, 1.0 ), vec3( 1.0, 0.94, 0.78 ), uDaylight );
        c += discCol * pow( sd, 2200.0 ) * 3.0;
        c += discCol * pow( sd, 24.0 ) * ( 0.10 + uDaylight * 0.22 );

        gl_FragColor = vec4( c, 1.0 );
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}
