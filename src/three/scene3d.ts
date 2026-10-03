// Real-time 3D table. Hands are the MIT-licensed WebXR "generic-hand" rig
// (public/models). Its bones are stored flat (no hierarchy), so finger curls
// are posed with our own forward kinematics.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Side } from '../game/rules';

export interface HandFlags {
  selectable: boolean;
  selected: boolean;
  target: boolean;
  hinted: boolean;
  last?: boolean;
}
export interface SceneInput {
  hands: [[number, number], [number, number]];
  bottom: Side;
  skins: [string, string];
  sleeves: [string, string];
  flags: (side: Side, hand: 0 | 1) => HandFlags;
}
export type HandKey = `${Side}${0 | 1}`;
export type CameraMode = 'player' | 'top' | 'low';
export type Motion = { kind: 'attack' | 'self'; from: HandKey; to: HandKey } | { kind: 'split'; side: Side };

const FINGERS = ['index', 'middle', 'ring', 'pinky'] as const;
const CHAIN = ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'];
const THUMB = ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'];

const HANDED_LEFT = Number((import.meta.env.DEV && (globalThis as unknown as { __hl?: number }).__hl) || 1);
const THUMB_FIST = (import.meta.env.DEV && (globalThis as unknown as { __tf?: number[] }).__tf) || [0, 0.15, 0.15];
// [swing in the palm plane, base curl, middle curl, tip curl, roll under the palm]
export const THUMB_POSE = [0.3, 0.4, 0.6, 0.5, 1.2];

const HAND_X = 0.135;
const HAND_Z = 0.27;
const HAND_Y = 0.05;
export const STRIKE_MS = 640;
export const CONTACT_AT = 0.42; // fraction of STRIKE_MS when the tap lands

const CAMERAS: Record<CameraMode, { pos: [number, number, number]; look: [number, number, number]; fov: number }> = {
  player: { pos: [0, 1.32, 1.02], look: [0, 0, 0.035], fov: 22 },
  top: { pos: [0, 1.95, 0.26], look: [0, 0, 0.005], fov: 19 },
  low: { pos: [0, 0.5, 1.0], look: [0, 0.03, -0.04], fov: 29 },
};

let modelsPromise: Promise<THREE.Object3D[]> | null = null;
export function loadModels() {
  modelsPromise ??= Promise.all(
    ['left', 'right'].map((n) => new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/${n}.glb`).then((g) => g.scene)),
  );
  return modelsPromise;
}

const ease = {
  inOut: (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  out: (x: number) => 1 - Math.pow(1 - x, 3),
};
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function radialTexture(inner: string, outer: string) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, inner);
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export class HandRig {
  key: HandKey;
  root = new THREE.Group(); // placement + motion
  tilt = new THREE.Group(); // whole arm pitch
  wrist = new THREE.Group(); // hand-only pitch (flicks), arm stays put
  material: THREE.MeshPhysicalMaterial;
  sleeveMat: THREE.MeshStandardMaterial;
  hitbox: THREE.Mesh;
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  blob: THREE.Mesh;
  base = new THREE.Vector3();
  fingerDir = new THREE.Vector3(0, 0, -1);
  yaw = 0;
  flags: HandFlags = { selectable: false, selected: false, target: false, hinted: false };
  dead = false;
  phase = Math.random() * 10;
  // springy finger curls
  curl = [0, 0, 0, 0];
  vel = [0, 0, 0, 0];
  target = [0, 0, 0, 0];
  pending: ({ at: number; value: number } | undefined)[] = [];
  lift = 0;
  dip = 0;
  deadMix = 0;
  skin = new THREE.Color('#e8b48f');
  private bones: Record<string, THREE.Object3D> = {};
  private rest: Record<string, { p: THREE.Vector3; q: THREE.Quaternion }> = {};
  private axes: THREE.Vector3[] = [];
  private thumbAxis = new THREE.Vector3();
  private palm = new THREE.Vector3();
  private along = new THREE.Vector3(); // wrist -> middle fingertip
  private handed = 1; // mirrored models need the thumb swung the other way

  constructor(source: THREE.Object3D, key: HandKey, shadowTex: THREE.Texture, glowTex: THREE.Texture) {
    this.key = key;
    const model = cloneSkinned(source);
    this.material = new THREE.MeshPhysicalMaterial({
      color: '#e8b48f',
      roughness: 0.5,
      sheen: 0.45,
      sheenRoughness: 0.5,
      specularIntensity: 0.35,
      clearcoat: 0.06,
      clearcoatRoughness: 0.6,
    });
    model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
        const m = o as THREE.SkinnedMesh;
        m.material = this.material;
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
      }
      if (/finger|thumb|wrist/.test(o.name)) this.bones[o.name] = o;
    });
    for (const [name, b] of Object.entries(this.bones)) this.rest[name] = { p: b.position.clone(), q: b.quaternion.clone() };

    const P = (n: string) => this.rest[n].p;
    const lateral = P('index-finger-phalanx-proximal').clone().sub(P('pinky-finger-phalanx-proximal')).normalize();
    const mid = P('middle-finger-tip').clone().sub(P('middle-finger-phalanx-proximal')).normalize();
    const palm = new THREE.Vector3().crossVectors(mid, lateral).normalize();
    this.handed = 1;
    if (palm.dot(P('thumb-tip').clone().sub(P('middle-finger-phalanx-proximal'))) < 0) palm.negate(), (this.handed = -1);
    for (const f of FINGERS) {
      const d = P(`${f}-finger-tip`).clone().sub(P(`${f}-finger-phalanx-proximal`)).normalize();
      this.axes.push(new THREE.Vector3().crossVectors(d, palm).normalize());
    }
    this.thumbAxis.crossVectors(P('thumb-tip').clone().sub(P('thumb-metacarpal')).normalize(), palm).normalize();
    this.palm.copy(palm);
    this.along.copy(P('middle-finger-tip')).sub(P('wrist')).normalize();

    // Orient: fingers away from the owner (-Z), back of the hand up (+Y).
    const fingerDir = P('middle-finger-tip').clone().sub(P('wrist')).normalize();
    const back = palm.clone().negate();
    back.sub(fingerDir.clone().multiplyScalar(back.dot(fingerDir))).normalize();
    const local = new THREE.Matrix4().makeBasis(fingerDir, back, new THREE.Vector3().crossVectors(fingerDir, back));
    const world = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0));
    const orient = new THREE.Group();
    orient.quaternion.setFromRotationMatrix(world.multiply(local.transpose()));
    model.position.copy(P('wrist')).negate();
    orient.add(model);
    orient.position.set(0, 0, 0.012);
    this.wrist.add(orient);
    this.tilt.add(this.wrist);
    this.tilt.rotation.x = 0.08;
    this.root.add(this.tilt);

    // Forearm: tapered, slightly flattened, meeting the wrist cleanly.
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      pts.push(new THREE.Vector2(0.021 + 0.009 * Math.pow(t, 0.8), t * 0.5));
    }
    const arm = new THREE.Mesh(new THREE.LatheGeometry(pts, 32), this.material);
    arm.rotation.x = Math.PI / 2;
    arm.scale.set(1.3, 1, 0.78);
    arm.position.set(0, -0.003, 0);
    arm.castShadow = true;
    this.tilt.add(arm);

    this.sleeveMat = new THREE.MeshStandardMaterial({ color: '#e9e5dc', roughness: 0.95 });
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 1.8, 40), this.sleeveMat);
    sleeve.rotation.x = Math.PI / 2;
    sleeve.scale.set(1.18, 1, 0.8);
    sleeve.position.set(0, -0.002, 1.05);
    sleeve.castShadow = true;
    const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.005, 12, 40), this.sleeveMat);
    cuff.scale.set(1.18, 0.8, 1);
    cuff.position.set(0, -0.002, 0.15);
    this.tilt.add(sleeve, cuff);

    this.hitbox = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.14, 0.27),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
    );
    this.hitbox.position.set(0, 0, -0.065);
    this.hitbox.userData.key = key;
    this.root.add(this.hitbox);

    // Table decals live in world space (they stay on the table when the hand lifts).
    this.ringMat = new THREE.MeshBasicMaterial({ color: '#8fd16a', map: glowTex, transparent: true, opacity: 0, depthWrite: false });
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.34), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.blob = new THREE.Mesh(
      new THREE.PlaneGeometry(0.2, 0.3),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.6 }),
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.pose();
  }

  setLook(skin: string, sleeve: string) {
    this.skin.set(skin);
    this.sleeveMat.color.set(sleeve);
  }

  setCount(n: number, now: number) {
    this.dead = n === 0;
    const next = FINGERS.map((_, i) => (i < n ? 0 : 1));
    const goal = this.target.map((v, i) => this.pending[i]?.value ?? v);
    if (next.every((v, i) => v === goal[i])) return;
    // Fingers that change move one after another.
    let k = 0;
    next.forEach((v, i) => {
      if (v !== goal[i]) this.pending[i] = { at: now + k++ * 45, value: v };
    });
  }

  snap() {
    this.pending.forEach((p, i) => p && (this.target[i] = p.value));
    this.pending = [];
    this.curl = [...this.target];
    this.vel = [0, 0, 0, 0];
    this.pose();
  }

  pose(time = 0) {
    FINGERS.forEach((f, i) => {
      // Raised fingers sway a touch so the hand never looks frozen.
      const idle = this.curl[i] < 0.5 ? Math.sin(time * 1.1 + this.phase + i * 0.9) * 0.025 : 0;
      const c = this.curl[i] + idle;
      this.chain(CHAIN.map((j) => `${f}-finger-${j}`), this.axes[i], [0.05 + c * 1.5, 0.08 + c * 1.8, 0.05 + c * 1.1, 0], 1);
    });
    // Thumb is never counted, so it always stays tucked in under the palm.
    const T = (import.meta.env.DEV && (window as unknown as { __thumb?: number[] }).__thumb) || THUMB_POSE;
    const roll = new THREE.Quaternion().setFromAxisAngle(this.along, (T[4] ?? 0) * this.handed * HANDED_LEFT);
    const swing = roll.multiply(new THREE.Quaternion().setFromAxisAngle(this.palm, T[0] * this.handed * HANDED_LEFT));
    // As the hand closes, the thumb wraps around the front of the curled fingers.
    const fist = Math.max(0, Math.min(1, this.curl.reduce((a, b) => a + b, 0) / 4));
    const W = THUMB_FIST;
    this.chain(THUMB, this.thumbAxis.clone().applyQuaternion(swing), [T[1] + fist * W[0], T[2] + fist * W[1], T[3] + fist * W[2], 0], 0, swing);
  }

  applyColor() {
    const hsl = { h: 0, s: 0, l: 0 };
    this.skin.getHSL(hsl);
    const grey = new THREE.Color().setHSL(hsl.h, hsl.s * 0.25, hsl.l * 0.72);
    this.material.color.copy(this.skin).lerp(grey, this.deadMix);
    this.material.sheenColor.copy(this.material.color).lerp(new THREE.Color('#ffd8c8'), 0.45);
    this.material.emissive.copy(this.material.color).multiplyScalar(0.035);
  }

  /** Pose instantly (used to render 2D sprites). */
  setStatic(count: number) {
    this.pending = [];
    this.target = FINGERS.map((_, i) => (i < count ? 0 : 1));
    this.dead = count === 0;
    this.deadMix = this.dead ? 1 : 0;
    this.snap();
    this.applyColor();
  }

  private chain(names: string[], axis: THREE.Vector3, angles: number[], start: number, pre?: THREE.Quaternion) {
    let total = 0;
    let pos = this.rest[names[start]].p.clone();
    const q = new THREE.Quaternion();
    for (let k = start; k < names.length; k++) {
      total += angles[k - start] ?? 0;
      q.setFromAxisAngle(axis, total);
      if (pre) q.multiply(pre);
      const b = this.bones[names[k]];
      b.position.copy(pos);
      b.quaternion.copy(q).multiply(this.rest[names[k]].q);
      if (k + 1 < names.length) pos = pos.clone().add(this.rest[names[k + 1]].p.clone().sub(this.rest[names[k]].p).applyQuaternion(q));
    }
  }

  step(dt: number, now: number) {
    const time = now / 1000;
    this.pending.forEach((p, i) => {
      if (p && now >= p.at) {
        this.target[i] = p.value;
        this.pending[i] = undefined;
      }
    });
    // Slightly underdamped spring: fingers snap with a hint of overshoot.
    const k = 210, c = 2 * Math.sqrt(k) * 0.72;
    const sdt = Math.min(dt, 0.033);
    for (let i = 0; i < 4; i++) {
      const a = k * (this.target[i] - this.curl[i]) - c * this.vel[i];
      this.vel[i] += a * sdt;
      this.curl[i] += this.vel[i] * sdt;
    }
    this.pose(time);

    const wantLift = this.flags.selected ? 0.04 : 0;
    this.lift += (wantLift - this.lift) * Math.min(1, dt * 10);
    this.dip *= Math.max(0, 1 - dt * 7);
    this.deadMix += ((this.dead ? 1 : 0) - this.deadMix) * Math.min(1, dt * 5);

    this.applyColor();

    // Ring under the hand shows what it can do.
    const pulse = 0.5 + 0.5 * Math.sin(time * 4.5);
    let color = '#8fd16a', op = 0;
    if (this.flags.selected) (color = '#8fd16a'), (op = 0.75);
    else if (this.flags.target) (color = '#f5b942'), (op = 0.3 + pulse * 0.4);
    else if (this.flags.hinted) (color = '#5cb8ff'), (op = 0.7);
    else if (this.flags.last) (color = '#ffffff'), (op = 0.12);
    this.ringMat.color.lerp(new THREE.Color(color), Math.min(1, dt * 12));
    this.ringMat.opacity += (op - this.ringMat.opacity) * Math.min(1, dt * 12);
  }
}

function woodTexture() {
  const W = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = W;
  const g = c.getContext('2d')!;
  const planks = 4;
  const ph = W / planks;
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let p = 0; p < planks; p++) {
    const y0 = p * ph;
    g.fillStyle = `hsl(${23 + rnd() * 4} 38% ${25 + rnd() * 4}%)`;
    g.fillRect(0, y0, W, ph);
    const phase = rnd() * 100;
    for (let i = 0; i < 170; i++) {
      const y = y0 + rnd() * ph;
      const amp = 2 + rnd() * 5;
      const freq = 0.003 + rnd() * 0.005;
      g.strokeStyle = rnd() < 0.6 ? `rgba(30,12,4,${0.03 + rnd() * 0.07})` : `rgba(255,205,150,${0.012 + rnd() * 0.03})`;
      g.lineWidth = 0.6 + rnd() * 2;
      g.beginPath();
      for (let x = 0; x <= W; x += 16) {
        const yy = y + Math.sin(x * freq + phase + i) * amp + Math.sin(x * 0.0013 + p) * 7;
        if (x === 0) g.moveTo(x, yy);
        else g.lineTo(x, yy);
      }
      g.stroke();
    }
    g.fillStyle = 'rgba(20,8,2,0.45)';
    g.fillRect(0, y0, W, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1.5, 1.5);
  t.anisotropy = 8;
  return t;
}

export class Scene3D {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(22, 1, 0.01, 10);
  rigs = new Map<HandKey, HandRig>();
  ready: Promise<void>;
  onHand: (side: Side, hand: 0 | 1) => void = () => {};
  onDrag: (from: HandKey, to: HandKey) => void = () => {};
  onFrame: (screen: Record<string, { x: number; y: number }>) => void = () => {};
  /** Dev only: freeze the clock (ms) to inspect animation frames. */
  debugNow: number | null = null;
  private host: HTMLElement;
  private raf = 0;
  private last = performance.now();
  private input: SceneInput | null = null;
  private motion: (Motion & { start: number }) | null = null;
  private ro: ResizeObserver;
  private ray = new THREE.Raycaster();
  private hover: HandKey | null = null;
  private down: { key: HandKey | null; x: number; y: number } | null = null;
  private pointer = new THREE.Vector2();
  private cam = { mode: 'player' as CameraMode, pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 22 };
  private shadowTex = radialTexture('rgba(0,0,0,0.55)', 'rgba(0,0,0,0)');
  private glowTex = radialTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0)');

  constructor(host: HTMLElement, camera: CameraMode = 'player') {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    const r = this.renderer;
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 0.95;
    r.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(r.domElement);

    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    this.scene.background = new THREE.Color('#141414');
    this.scene.fog = new THREE.Fog('#141414', 2, 3);

    const table = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.6 }));
    table.rotation.x = -Math.PI / 2;
    table.receiveShadow = true;
    this.scene.add(table);

    const key = new THREE.DirectionalLight('#fff0dc', 2.3);
    key.position.set(-0.5, 1.6, 0.6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -0.75;
    sc.right = sc.top = 0.75;
    sc.near = 0.3;
    sc.far = 3.2;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.012;
    const rim = new THREE.DirectionalLight('#ffd9a8', 0.7);
    rim.position.set(0.7, 0.6, -0.9);
    this.scene.add(key, rim, new THREE.HemisphereLight('#fff4e6', '#3b2414', 0.5));

    this.setCamera(camera, true);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();

    const el = r.domElement;
    el.addEventListener('pointermove', this.pointerMove);
    el.addEventListener('pointerdown', this.pointerDown);
    el.addEventListener('pointerup', this.pointerUp);
    el.addEventListener('pointerleave', () => {
      this.hover = null;
      this.pointer.set(0, 0);
    });

    if (import.meta.env.DEV) (window as unknown as { __scene: Scene3D }).__scene = this;
    this.ready = loadModels().then(([left, right]) => {
      for (const side of [0, 1] as Side[])
        for (const hand of [0, 1] as const) {
          const rig = new HandRig(hand === 0 ? left : right, `${side}${hand}`, this.shadowTex, this.glowTex);
          this.rigs.set(rig.key, rig);
          this.scene.add(rig.root, rig.ring, rig.blob);
        }
      if (this.input) this.update(this.input);
      for (const rig of this.rigs.values()) rig.snap();
    });
    this.loop();
  }

  setCamera(mode: CameraMode, instant = false) {
    this.cam.mode = mode;
    if (instant) {
      const c = CAMERAS[mode];
      this.cam.pos.set(...c.pos);
      this.cam.look.set(...c.look);
      this.cam.fov = c.fov;
    }
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(input: SceneInput) {
    this.input = input;
    const now = this.now();
    for (const rig of this.rigs.values()) {
      const side = Number(rig.key[0]) as Side;
      const hand = Number(rig.key[1]) as 0 | 1;
      const near = side === input.bottom;
      // Near: left hand on the left. The far player faces us, so their left is on our right.
      const x = (hand === 0 ? -1 : 1) * (near ? 1 : -1) * HAND_X;
      rig.base.set(x, HAND_Y, near ? HAND_Z : -HAND_Z);
      rig.yaw = near ? 0 : Math.PI;
      rig.fingerDir.set(0, 0, near ? -1 : 1);
      rig.setLook(input.skins[side], input.sleeves[side]);
      rig.setCount(input.hands[side][hand], now);
      rig.flags = input.flags(side, hand);
    }
  }

  play(m: Motion) {
    this.motion = { ...m, start: this.now() };
  }

  private now() {
    return this.debugNow ?? performance.now();
  }

  private pick(e: { clientX: number; clientY: number }): HandKey | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(p, this.camera);
    const hits = this.ray.intersectObjects([...this.rigs.values()].map((r) => r.hitbox));
    return (hits[0]?.object.userData.key as HandKey) ?? null;
  }
  private pointerMove = (e: PointerEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.hover = this.pick(e);
    const rig = this.hover && this.rigs.get(this.hover);
    this.renderer.domElement.style.cursor = this.down?.key ? 'grabbing' : rig && (rig.flags.selectable || rig.flags.target) ? 'pointer' : 'default';
  };
  private pointerDown = (e: PointerEvent) => {
    this.down = { key: this.pick(e), x: e.clientX, y: e.clientY };
  };
  private pointerUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d) return;
    const k = this.pick(e);
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12;
    if (moved && d.key && k && k !== d.key) this.onDrag(d.key, k);
    else if (!moved && k) this.onHand(Number(k[0]) as Side, Number(k[1]) as 0 | 1);
  };

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = this.now();
    const dt = this.debugNow !== null ? 1 : Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const time = now / 1000;

    // Camera eases between presets with a little pointer parallax.
    const c = CAMERAS[this.cam.mode];
    const narrow = this.camera.aspect < 0.9 ? 1.18 : 1;
    const k = Math.min(1, dt * 4);
    const par = this.cam.mode === 'top' ? 0 : 0.012;
    this.cam.pos.lerp(new THREE.Vector3(c.pos[0] + this.pointer.x * par, c.pos[1] + this.pointer.y * par * 0.5, c.pos[2]), k);
    this.cam.look.lerp(new THREE.Vector3(...c.look), k);
    this.cam.fov += (c.fov * narrow - this.cam.fov) * k;
    this.camera.position.copy(this.cam.pos);
    this.camera.lookAt(this.cam.look);
    const fog = this.scene.fog as THREE.Fog;
    const d = this.cam.pos.distanceTo(this.cam.look);
    fog.near = d + 0.35;
    fog.far = d + 1.25;
    if (Math.abs(this.camera.fov - this.cam.fov) > 0.01) {
      this.camera.fov = this.cam.fov;
      this.camera.updateProjectionMatrix();
    }

    for (const rig of this.rigs.values()) {
      rig.step(dt, now);
      const hoverLift = this.hover === rig.key && rig.flags.selectable && !rig.flags.selected ? 0.012 : 0;
      const breathe = Math.sin(time * 1.3 + rig.phase) * 0.0025;
      rig.root.position.copy(rig.base);
      rig.root.position.y += rig.lift + hoverLift - rig.dip - rig.deadMix * 0.014 + breathe;
      rig.root.rotation.set(0, rig.yaw, 0);
      rig.tilt.rotation.x = 0.08 + rig.lift * 0.5;
      rig.wrist.rotation.x = -rig.lift * 1.2;
    }

    const m = this.motion;
    if (m) {
      const p = (now - m.start) / STRIKE_MS;
      if (p >= 1) this.motion = null;
      else if (m.kind === 'split') this.animateSplit(m.side, p);
      else this.animateStrike(m.from, m.to, m.kind === 'self', p);
    }

    for (const rig of this.rigs.values()) {
      const at = rig.root.position.clone().addScaledVector(rig.fingerDir, 0.065);
      rig.ring.position.set(at.x, 0.0015, at.z);
      rig.ring.scale.setScalar(1 + rig.lift * 1.5);
      rig.blob.position.set(at.x, 0.001, at.z);
      const h = rig.root.position.y - HAND_Y;
      (rig.blob.material as THREE.MeshBasicMaterial).opacity = Math.max(0.12, 0.6 - h * 7);
      rig.blob.scale.setScalar(1 + h * 3);
    }

    this.renderer.render(this.scene, this.camera);

    const w = this.host.clientWidth, h = this.host.clientHeight;
    const out: Record<string, { x: number; y: number }> = {};
    for (const rig of this.rigs.values()) {
      // chip sits on the back of the hand, never at the table edge
      const v = rig.base.clone().addScaledVector(rig.fingerDir, 0.035);
      v.y = 0.1;
      v.project(this.camera);
      out[rig.key] = { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
    }
    this.onFrame(out);
  };

  private animateStrike(from: HandKey, to: HandKey, self: boolean, p: number) {
    const a = this.rigs.get(from), t = this.rigs.get(to);
    if (!a || !t) return;
    const meet = self ? 0 : 0.05; // target leans in a little to meet the tap
    const offset = t.base.clone().sub(a.base);
    offset.y = 0;
    if (self) offset.multiplyScalar(0.5).addScaledVector(a.fingerDir, 0.06);
    // fingertips land on the target's fingertips, never through the hand
    else offset.addScaledVector(t.fingerDir, meet + 0.3);
    const contactY = self ? 0.065 : 0.03;

    // wind-up -> thrust -> contact flick -> return
    let reach = 0, up = 0, flick = 0;
    if (p < 0.14) {
      const q = ease.out(p / 0.14);
      reach = -0.1 * q;
      up = 0.02 * q;
    } else if (p < CONTACT_AT) {
      const q = ease.inOut((p - 0.14) / (CONTACT_AT - 0.14));
      reach = -0.1 + 1.1 * q;
      up = 0.02 + (contactY - 0.02) * q + Math.sin(Math.PI * q) * 0.025;
      flick = -0.12 * q;
    } else if (p < 0.56) {
      const q = (p - CONTACT_AT) / (0.56 - CONTACT_AT);
      reach = 1;
      up = contactY - Math.sin(Math.PI * q) * 0.008;
      flick = -0.12 - Math.sin(Math.PI * q) * 0.22;
    } else {
      const q = ease.inOut((p - 0.56) / 0.44);
      reach = 1 - q;
      up = contactY * (1 - q);
      flick = -0.12 * (1 - q);
    }
    a.root.position.addScaledVector(offset, reach);
    a.root.position.y += up;
    a.wrist.rotation.x += flick;
    if (self) a.root.rotation.z = (a.base.x < t.base.x ? -1 : 1) * (a.fingerDir.z < 0 ? 1 : -1) * 0.3 * Math.sin(Math.PI * clamp01(reach));
    if (meet) {
      const lean = p < CONTACT_AT ? ease.inOut(clamp01((p - 0.1) / (CONTACT_AT - 0.1))) : 1 - ease.inOut((p - CONTACT_AT) / (1 - CONTACT_AT));
      t.root.position.addScaledVector(t.fingerDir, meet * lean);
    }
    if (p > CONTACT_AT && p < CONTACT_AT + 0.05) t.dip = 0.018;
  }

  private animateSplit(side: Side, p: number) {
    const hands = [this.rigs.get(`${side}0`), this.rigs.get(`${side}1`)] as HandRig[];
    if (!hands[0] || !hands[1]) return;
    const q = p < CONTACT_AT ? ease.inOut(p / CONTACT_AT) : 1 - ease.inOut((p - CONTACT_AT) / (1 - CONTACT_AT));
    for (const h of hands) {
      const sx = Math.sign(h.base.x);
      h.root.position.x -= h.base.x * 0.12 * q;
      h.root.position.y += 0.025 * q;
      h.root.rotation.y = h.yaw + sx * (h.fingerDir.z < 0 ? 1 : -1) * 0.42 * q;
    }
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/* ---------- 2D sprites: the same hands, rendered flat from above ---------- */

let spriteRenderer: THREE.WebGLRenderer | null = null;
const spriteCache = new Map<string, Promise<string[][]>>();

/** Returns data URLs indexed [hand 0=left 1=right][finger count 0..4]. */
export function handSprites(skin: string, sleeve: string): Promise<string[][]> {
  const key = `${skin}|${sleeve}`;
  if (!spriteCache.has(key)) spriteCache.set(key, loadModels().then((m) => renderSprites(m, skin, sleeve)));
  return spriteCache.get(key)!;
}

function renderSprites(models: THREE.Object3D[], skin: string, sleeve: string) {
  const W = 420, H = 600;
  if (!spriteRenderer) {
    spriteRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    spriteRenderer.setPixelRatio(1);
    spriteRenderer.setSize(W, H);
    spriteRenderer.setClearColor(0x000000, 0);
    spriteRenderer.toneMapping = THREE.NeutralToneMapping;
    spriteRenderer.toneMappingExposure = 1;
    spriteRenderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  const r = spriteRenderer;
  const scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  const key = new THREE.DirectionalLight('#fff3e6', 2.2);
  key.position.set(-0.5, 1.4, -0.3);
  scene.add(key, new THREE.HemisphereLight('#fff8f0', '#7a5236', 0.7));
  const fw = 0.17, fh = (fw * H) / W, cz = -0.088;
  const cam = new THREE.OrthographicCamera(-fw / 2, fw / 2, fh / 2, -fh / 2, 0.1, 3);
  cam.position.set(0, 1, cz);
  cam.up.set(0, 0, -1);
  cam.lookAt(0, 0, cz);

  const blank = new THREE.Texture();
  const out: string[][] = [[], []];
  for (const hand of [0, 1] as const) {
    const rig = new HandRig(models[hand], `0${hand}`, blank, blank);
    rig.setLook(skin, sleeve);
    rig.root.position.set(0, HAND_Y, 0);
    scene.add(rig.root);
    for (let c = 0; c <= 4; c++) {
      rig.setStatic(c);
      r.render(scene, cam);
      out[hand][c] = r.domElement.toDataURL('image/png');
    }
    scene.remove(rig.root);
  }
  return out;
}
