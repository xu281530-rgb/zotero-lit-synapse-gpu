/**
 * A dependency-free 3D renderer for the Wiki knowledge graph.
 *
 * The picture it draws is a network of documents. One node is one piece of
 * literature; one link is a knowledge relation between two pieces. Both are
 * selectable, because the question a reader asks of this graph is either "what
 * does this paper claim?" or "what do these two papers agree and disagree
 * about?" - and the second question lives on the link, not on either end.
 *
 * The renderer is deliberately ignorant of what any of that means. It receives
 * nodes carrying a depth, a weight and a colour group, and links carrying a
 * style and a tone; it settles them into a three-dimensional layout, rotates,
 * projects and depth-sorts them through a perspective camera, and reports
 * clicks back through callbacks. Every domain decision - which documents are
 * central, which relation counts as a conflict - is made by the panel.
 *
 * Why not Three.js: this runs inside the privileged Zotero main window, where
 * a WebGL context is not guaranteed, and the plugin ships as a single bundled
 * script that Zotero parses at startup. Adding ~600 KB of WebGL engine to
 * every launch to draw a few hundred spheres is the wrong trade, so the
 * projection maths lives here and the drawing goes through Canvas 2D, which is
 * immediate-mode and therefore rebuilds no geometry between frames.
 */

export type GraphMode = "2d" | "3d";

/** Solid links are shared claims; dashed links are shared knowledge entries. */
export type GraphLinkStyle = "solid" | "dashed";

/** A link carrying at least one contradiction reads as contested. */
export type GraphLinkTone = "neutral" | "conflict";

export interface GraphNodeInput {
  id: string;
  label: string;
  /** Second tooltip line: creator, year, how many claims cite it. */
  detail?: string;
  /** Relative importance; drives the drawn radius. */
  weight?: number;
  /** 0 places the node in the core, 1 out at the rim. */
  depth?: number;
  /** Colour bucket, resolved against the current theme. */
  group?: number;
  /** Drawn faint: a document nothing else connects to. */
  dim?: boolean;
  /** Opaque payload handed back through onSelectNode. */
  payload?: unknown;
}

export interface GraphLinkInput {
  source: string;
  target: string;
  style?: GraphLinkStyle;
  tone?: GraphLinkTone;
  /** Drives line width; typically the number of shared claims. */
  strength?: number;
  /** Opaque payload handed back through onSelectLink. */
  payload?: unknown;
}

export interface GraphData {
  nodes: GraphNodeInput[];
  links: GraphLinkInput[];
}

export interface Graph3DOptions {
  win: any;
  canvas: HTMLCanvasElement;
  /** Absolutely positioned overlay moved with transform on hover. */
  tooltip?: HTMLElement;
  onSelectNode?: (node: GraphNodeInput | null) => void;
  onSelectLink?: (link: GraphLinkInput) => void;
}

export interface Graph3DController {
  setData(data: GraphData): void;
  setMode(mode: GraphMode): void;
  getMode(): GraphMode;
  setAutoRotate(on: boolean): void;
  isAutoRotate(): boolean;
  /** Which link styles are drawn; hiding a style also hides its picking. */
  setVisibleLinkStyles(styles: readonly GraphLinkStyle[]): void;
  getVisibleLinkStyles(): GraphLinkStyle[];
  /** Whether documents with no links at all are drawn. */
  setShowIsolated(show: boolean): void;
  isShowingIsolated(): boolean;
  selectNode(id: string | null): void;
  resetView(): void;
  refreshTheme(): void;
  invalidate(): void;
  dispose(): void;
}

interface RuntimeNode {
  input: GraphNodeInput;
  shell: number;
  radius: number;
  group: number;
  dim: boolean;
  degree: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Projected screen position, refreshed once per frame. */
  sx: number;
  sy: number;
  sr: number;
  depth: number;
  visible: boolean;
}

interface RuntimeLink {
  input: GraphLinkInput;
  source: RuntimeNode;
  target: RuntimeNode;
  style: GraphLinkStyle;
  tone: GraphLinkTone;
  strength: number;
  /** Projected control point of the drawn curve, for hit testing. */
  cx: number;
  cy: number;
  visible: boolean;
}

interface Palette {
  background: string;
  backgroundEdge: string;
  text: string;
  muted: string;
  neutral: string;
  conflict: string;
  halo: string;
  groups: string[];
}

const BASE_RADIUS = 300;
const NODE_RADIUS: [number, number] = [5, 21];
/** How many documents may carry a caption before collision thinning runs. */
const LABEL_BUDGET = 40;
/** Core shell for the best-connected documents, rim for the loneliest. */
const SHELL: [number, number] = [0.3, 1.06];

const LIGHT_PALETTE: Palette = {
  background: "#FBF9F3",
  backgroundEdge: "#DED5C1",
  text: "#25231F",
  muted: "#777168",
  neutral: "rgba(103, 114, 126, 0.42)",
  conflict: "rgba(164, 87, 78, 0.6)",
  halo: "rgba(255, 255, 255, 0.72)",
  groups: [
    "#536F62",
    "#8C7A5C",
    "#6B7A8F",
    "#8A6A72",
    "#6F7B55",
    "#7E6E8C",
    "#94795A",
    "#5E7C7C",
  ],
};

const DARK_PALETTE: Palette = {
  background: "#2A2823",
  backgroundEdge: "#141310",
  text: "#ECE6DA",
  muted: "#A79E90",
  neutral: "rgba(150, 162, 180, 0.38)",
  conflict: "rgba(217, 140, 129, 0.58)",
  halo: "rgba(255, 255, 255, 0.34)",
  groups: [
    "#8FB3A2",
    "#C3A879",
    "#93A3BC",
    "#C0949C",
    "#9EAE7C",
    "#AC9BC0",
    "#C6A47F",
    "#88AEAE",
  ],
};

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Deterministic PRNG, so re-opening the graph reproduces the same space. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function mix(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

/**
 * Settle the documents into three-dimensional shells.
 *
 * Repulsion spreads them, link springs pull related literature together, and a
 * radial term holds each node near the shell its connectivity earned, so the
 * well-cited core stays in the middle and isolated papers drift to the rim.
 * The pass runs once per data load, never per frame.
 */
function layout(nodes: RuntimeNode[], links: RuntimeLink[]): void {
  const count = nodes.length;
  if (!count) return;
  const random = mulberry32(
    hashSeed(nodes.map((node) => node.input.id).join()),
  );
  const golden = Math.PI * (3 - Math.sqrt(5));
  nodes.forEach((node, index) => {
    const y = 1 - (index / Math.max(1, count - 1)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * index;
    const jitter = 0.24;
    const scale = node.shell * BASE_RADIUS;
    node.x = (Math.cos(theta) * ring + (random() - 0.5) * jitter) * scale;
    node.y = (y + (random() - 0.5) * jitter) * scale;
    node.z = (Math.sin(theta) * ring + (random() - 0.5) * jitter) * scale;
    node.vx = 0;
    node.vy = 0;
    node.vz = 0;
  });

  const iterations = Math.round(clamp(320 - count * 0.4, 90, 320));
  const repulsion = 1900;
  const damping = 0.82;
  for (let step = 0; step < iterations; step += 1) {
    const cooling = 1 - step / iterations;
    for (let left = 0; left < count; left += 1) {
      const a = nodes[left];
      for (let right = left + 1; right < count; right += 1) {
        const b = nodes[right];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dz = a.z - b.z;
        let distanceSquared = dx * dx + dy * dy + dz * dz;
        if (distanceSquared < 1) {
          dx = random() - 0.5;
          dy = random() - 0.5;
          dz = random() - 0.5;
          distanceSquared = 1;
        }
        const distance = Math.sqrt(distanceSquared);
        const force = repulsion / distanceSquared;
        const ux = (dx / distance) * force;
        const uy = (dy / distance) * force;
        const uz = (dz / distance) * force;
        a.vx += ux;
        a.vy += uy;
        a.vz += uz;
        b.vx -= ux;
        b.vy -= uy;
        b.vz -= uz;
      }
    }
    for (const link of links) {
      const a = link.source;
      const b = link.target;
      // A shared claim is a stronger tie than a shared knowledge entry.
      const rest = link.style === "dashed" ? 168 : 118;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const pull =
        ((distance - rest) / distance) *
        (link.style === "dashed" ? 0.016 : 0.045) *
        link.strength;
      a.vx += dx * pull;
      a.vy += dy * pull;
      a.vz += dz * pull;
      b.vx -= dx * pull;
      b.vy -= dy * pull;
      b.vz -= dz * pull;
    }
    const stepSize = damping * cooling * 0.08;
    for (const node of nodes) {
      const target = node.shell * BASE_RADIUS;
      const distance =
        Math.sqrt(node.x * node.x + node.y * node.y + node.z * node.z) || 1;
      const correction = ((target - distance) / distance) * 0.11;
      node.vx += node.x * correction;
      node.vy += node.y * correction;
      node.vz += node.z * correction;
      node.x += node.vx * stepSize;
      node.y += node.vy * stepSize;
      node.z += node.vz * stepSize;
      node.vx *= damping;
      node.vy *= damping;
      node.vz *= damping;
    }
  }
}

/** Distance from a point to a quadratic curve, sampled finely enough to click. */
function distanceToCurve(
  px: number,
  py: number,
  ax: number,
  ay: number,
  cx: number,
  cy: number,
  bx: number,
  by: number,
): number {
  let best = Infinity;
  let previousX = ax;
  let previousY = ay;
  for (let step = 1; step <= 12; step += 1) {
    const t = step / 12;
    const inverse = 1 - t;
    const x = inverse * inverse * ax + 2 * inverse * t * cx + t * t * bx;
    const y = inverse * inverse * ay + 2 * inverse * t * cy + t * t * by;
    const dx = x - previousX;
    const dy = y - previousY;
    const lengthSquared = dx * dx + dy * dy || 1;
    const along = clamp(
      ((px - previousX) * dx + (py - previousY) * dy) / lengthSquared,
      0,
      1,
    );
    best = Math.min(
      best,
      Math.hypot(px - (previousX + along * dx), py - (previousY + along * dy)),
    );
    previousX = x;
    previousY = y;
  }
  return best;
}

export function createGraph3D(options: Graph3DOptions): Graph3DController {
  const { win, canvas } = options;
  const doc = canvas.ownerDocument as Document;
  let palette = LIGHT_PALETTE;
  let nodes: RuntimeNode[] = [];
  let links: RuntimeLink[] = [];
  let byId = new Map<string, RuntimeNode>();
  let visibleStyles = new Set<GraphLinkStyle>(["solid", "dashed"]);
  let showIsolated = true;

  let yaw = 0.6;
  let pitch = -0.32;
  let yawVelocity = 0;
  let pitchVelocity = 0;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  /** 0 = full depth, 1 = flattened; animated so the 2D/3D switch glides. */
  let flatten = 0;
  let flattenTarget = 0;
  let autoRotate = false;
  let dragging: "orbit" | "pan" | null = null;
  let dragMoved = false;
  let lastX = 0;
  let lastY = 0;
  let hoveredNode: RuntimeNode | null = null;
  let hoveredLink: RuntimeLink | null = null;
  let selectedNode: RuntimeNode | null = null;
  let selectedLink: RuntimeLink | null = null;
  let frame = 0;
  let disposed = false;

  /**
   * Read the theme the stylesheet declares.
   *
   * The canvas carries `--wiki-graph-scheme: dark` under the dark palette, so
   * one custom property keeps the canvas colours and the CSS in step without
   * duplicating a media query here.
   */
  function readPalette(): void {
    try {
      const probe = win
        .getComputedStyle?.(canvas)
        ?.getPropertyValue("--wiki-graph-scheme");
      palette = String(probe).trim() === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
    } catch {
      palette = LIGHT_PALETTE;
    }
  }

  function applyVisibility(): void {
    for (const node of nodes) {
      const connected = links.some(
        (link) =>
          visibleStyles.has(link.style) &&
          (link.source === node || link.target === node),
      );
      node.visible = connected || showIsolated;
    }
    for (const link of links) {
      link.visible =
        visibleStyles.has(link.style) &&
        link.source.visible &&
        link.target.visible;
    }
    if (hoveredNode && !hoveredNode.visible) hoveredNode = null;
    if (selectedNode && !selectedNode.visible) selectedNode = null;
    if (hoveredLink && !hoveredLink.visible) hoveredLink = null;
    if (selectedLink && !selectedLink.visible) selectedLink = null;
  }

  function animating(): boolean {
    return (
      autoRotate ||
      Math.abs(yawVelocity) > 0.00002 ||
      Math.abs(pitchVelocity) > 0.00002 ||
      Math.abs(flatten - flattenTarget) > 0.001
    );
  }

  function schedule(): void {
    if (disposed || frame) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      draw();
      if (animating()) schedule();
    });
  }

  function resize(): void {
    const ratio = Math.min(2, Number(win.devicePixelRatio) || 1);
    const width = Math.max(320, Math.round(canvas.clientWidth || 900));
    const height = Math.max(240, Math.round(canvas.clientHeight || 560));
    const nextWidth = Math.round(width * ratio);
    const nextHeight = Math.round(height * ratio);
    if (canvas.width !== nextWidth) canvas.width = nextWidth;
    if (canvas.height !== nextHeight) canvas.height = nextHeight;
  }

  /** Rotate by yaw/pitch, then project through a perspective camera. */
  function projectPoint(
    x: number,
    y: number,
    z: number,
    centerX: number,
    centerY: number,
    focal: number,
    cameraDistance: number,
    out: { x: number; y: number; scale: number; depth: number },
  ): void {
    const depthScale = 1 - flatten;
    const z0 = z * depthScale;
    const pitchNow = pitch * depthScale;
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const x1 = x * cosYaw + z0 * sinYaw;
    const z1 = -x * sinYaw + z0 * cosYaw;
    const cosPitch = Math.cos(pitchNow);
    const sinPitch = Math.sin(pitchNow);
    const y2 = y * cosPitch - z1 * sinPitch;
    const z2 = y * sinPitch + z1 * cosPitch;
    // Flattening removes depth as well as the z axis, so 2D mode is a true
    // orthographic plane: every node draws at the same scale.
    const depth = Math.max(60, cameraDistance - z2 * depthScale);
    const scale = (focal / depth) * zoom;
    out.x = centerX + x1 * scale + panX;
    out.y = centerY + y2 * scale + panY;
    out.scale = scale;
    out.depth = depth;
  }

  function nodeColor(node: RuntimeNode): string {
    return palette.groups[node.group % palette.groups.length];
  }

  /** Far geometry fades into the background: cheap fog, real depth cue. */
  function depthAlpha(depth: number, cameraDistance: number): number {
    const normalized =
      (depth - (cameraDistance - BASE_RADIUS)) / (BASE_RADIUS * 2.2);
    return clamp(1.05 - normalized * 0.85, 0.16, 1);
  }

  const scratch = { x: 0, y: 0, scale: 0, depth: 0 };
  const control = { x: 0, y: 0, scale: 0, depth: 0 };

  function draw(): void {
    const context = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!context) return;
    resize();
    const width = canvas.width;
    const height = canvas.height;
    const ratio = width / Math.max(1, canvas.clientWidth || width);

    if (autoRotate) yaw += 0.0032;
    yaw += yawVelocity;
    pitch = clamp(pitch + pitchVelocity, -1.4, 1.4);
    yawVelocity *= 0.93;
    pitchVelocity *= 0.93;
    if (Math.abs(yawVelocity) < 0.00002) yawVelocity = 0;
    if (Math.abs(pitchVelocity) < 0.00002) pitchVelocity = 0;
    flatten = mix(flatten, flattenTarget, 0.12);
    if (Math.abs(flatten - flattenTarget) < 0.001) flatten = flattenTarget;

    context.setTransform(1, 0, 0, 1, 0, 0);
    const gradient = context.createRadialGradient(
      width * 0.5,
      height * 0.42,
      Math.min(width, height) * 0.05,
      width * 0.5,
      height * 0.5,
      Math.max(width, height) * 0.8,
    );
    gradient.addColorStop(0, palette.background);
    gradient.addColorStop(1, palette.backgroundEdge);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const viewWidth = width / ratio;
    const viewHeight = height / ratio;
    const centerX = viewWidth / 2;
    const centerY = viewHeight / 2;
    const focal = Math.min(viewWidth, viewHeight) * 1.25;
    const cameraDistance = BASE_RADIUS * 3;

    const active: RuntimeNode[] = [];
    for (const node of nodes) {
      if (!node.visible) continue;
      projectPoint(
        node.x,
        node.y,
        node.z,
        centerX,
        centerY,
        focal,
        cameraDistance,
        scratch,
      );
      node.sx = scratch.x;
      node.sy = scratch.y;
      node.sr = Math.max(1.6, node.radius * scratch.scale);
      node.depth = scratch.depth;
      active.push(node);
    }

    context.lineCap = "round";
    const drawable = links.filter((link) => link.visible);
    drawable.sort(
      (a, b) =>
        (b.source.depth + b.target.depth) / 2 -
        (a.source.depth + a.target.depth) / 2,
    );
    for (const link of drawable) {
      const a = link.source;
      const b = link.target;
      const focused =
        link === hoveredLink ||
        link === selectedLink ||
        hoveredNode === a ||
        hoveredNode === b ||
        selectedNode === a ||
        selectedNode === b;
      const alpha =
        depthAlpha((a.depth + b.depth) / 2, cameraDistance) *
        (focused ? 1 : 0.68);
      // Bow the link away from the origin so parallel relations stay legible
      // and the space reads as curved rather than as a wire cage.
      projectPoint(
        (a.x + b.x) * 0.57,
        (a.y + b.y) * 0.57,
        (a.z + b.z) * 0.57,
        centerX,
        centerY,
        focal,
        cameraDistance,
        control,
      );
      link.cx = control.x;
      link.cy = control.y;
      context.globalAlpha = alpha;
      context.strokeStyle =
        link.tone === "conflict" ? palette.conflict : palette.neutral;
      context.lineWidth = clamp(
        (0.7 + link.strength * 0.45) * (focused ? 2.2 : 1),
        0.6,
        5,
      );
      context.setLineDash?.(link.style === "dashed" ? [4, 5] : []);
      context.beginPath();
      context.moveTo(a.sx, a.sy);
      context.quadraticCurveTo(link.cx, link.cy, b.sx, b.sy);
      context.stroke();
    }
    context.setLineDash?.([]);
    context.globalAlpha = 1;

    active.sort((a, b) => b.depth - a.depth);
    const labels: RuntimeNode[] = [];
    const taken: Array<[number, number, number, number]> = [];
    for (const node of active) {
      const alpha =
        depthAlpha(node.depth, cameraDistance) * (node.dim ? 0.45 : 1);
      const focused = node === hoveredNode || node === selectedNode;
      const linked =
        (hoveredLink !== null &&
          (hoveredLink.source === node || hoveredLink.target === node)) ||
        (selectedLink !== null &&
          (selectedLink.source === node || selectedLink.target === node));
      context.globalAlpha = focused || linked ? 1 : alpha;
      const color = nodeColor(node);
      const sphere = context.createRadialGradient(
        node.sx - node.sr * 0.34,
        node.sy - node.sr * 0.4,
        node.sr * 0.12,
        node.sx,
        node.sy,
        node.sr,
      );
      sphere.addColorStop(0, palette.halo);
      sphere.addColorStop(0.45, color);
      sphere.addColorStop(1, color);
      context.beginPath();
      context.fillStyle = sphere;
      context.arc(node.sx, node.sy, node.sr, 0, Math.PI * 2);
      context.fill();
      if (focused || linked) {
        context.beginPath();
        context.strokeStyle = color;
        context.lineWidth = 1.6;
        context.arc(node.sx, node.sy, node.sr + 4.5, 0, Math.PI * 2);
        context.stroke();
      }
      if (focused || linked) labels.push(node);
    }

    // Naming every document at once is a wall of text, but a size threshold
    // would leave a library of evenly cited papers with no captions at all.
    // So the most prominent handful always qualify, and collision below thins
    // whatever still cannot fit.
    const budget = active
      .filter((node) => !labels.includes(node))
      .sort((a, b) => b.sr - a.sr)
      .slice(0, LABEL_BUDGET);
    labels.push(...budget);

    // Labels last, nearest first, and a label that would land on one already
    // drawn is dropped. Text in a 3D scene cannot be spaced by the layout, so
    // the only way to keep it legible is to draw fewer of them.
    labels.sort((a, b) => a.depth - b.depth);
    context.textAlign = "center";
    context.textBaseline = "top";
    for (const node of labels) {
      const focused = node === hoveredNode || node === selectedNode;
      context.font = `${focused ? 12 : 11.5}px "Times New Roman", "Microsoft YaHei", sans-serif`;
      const label = node.input.label;
      const text = label.length > 16 ? `${label.slice(0, 15)}…` : label;
      const width2 = context.measureText(text).width;
      const left = node.sx - width2 / 2 - 4;
      const top = node.sy + node.sr + 3;
      const right = left + width2 + 8;
      const bottom = top + 16;
      const collides = taken.some(
        (box) =>
          left < box[2] && box[0] < right && top < box[3] && box[1] < bottom,
      );
      if (collides && !focused) continue;
      taken.push([left, top, right, bottom]);
      // A small paper plate behind the caption. Without it the text lands on
      // whatever spheres and links happen to be behind it and stops being
      // readable, which is the one thing a label has to be.
      context.globalAlpha = focused ? 0.94 : 0.82;
      context.fillStyle = palette.background;
      context.beginPath();
      if (typeof (context as any).roundRect === "function") {
        (context as any).roundRect(left, top, right - left, bottom - top, 4);
      } else {
        context.rect(left, top, right - left, bottom - top);
      }
      context.fill();
      context.globalAlpha = focused ? 1 : 0.92;
      context.fillStyle = focused ? palette.text : palette.muted;
      context.fillText(text, node.sx, top + 1);
    }
    context.globalAlpha = 1;
  }

  function pickNode(x: number, y: number): RuntimeNode | null {
    let best: RuntimeNode | null = null;
    for (const node of nodes) {
      if (!node.visible) continue;
      if (Math.hypot(node.sx - x, node.sy - y) > node.sr + 5) continue;
      if (!best || node.depth < best.depth) best = node;
    }
    return best;
  }

  /** Links are pickable too: the relation between two papers is the point. */
  function pickLink(x: number, y: number): RuntimeLink | null {
    let best: RuntimeLink | null = null;
    let bestDistance = 7;
    for (const link of links) {
      if (!link.visible) continue;
      const distance = distanceToCurve(
        x,
        y,
        link.source.sx,
        link.source.sy,
        link.cx,
        link.cy,
        link.target.sx,
        link.target.sy,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = link;
      }
    }
    return best;
  }

  function localPoint(clientX: number, clientY: number): [number, number] {
    const bounds = canvas.getBoundingClientRect();
    return [clientX - bounds.left, clientY - bounds.top];
  }

  function showTooltip(
    lines: string[] | null,
    clientX: number,
    clientY: number,
  ): void {
    const tooltip = options.tooltip;
    if (!tooltip) return;
    if (!lines) {
      tooltip.hidden = true;
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    tooltip.hidden = false;
    tooltip.replaceChildren();
    const [title, ...rest] = lines;
    const heading = doc.createElement("strong");
    heading.textContent = title;
    tooltip.append(heading);
    for (const line of rest) {
      if (!line) continue;
      const detail = doc.createElement("span");
      detail.textContent = line;
      tooltip.append(detail);
    }
    // A transform keeps the overlay off the layout path, so hovering a node
    // never reflows the graph pane.
    tooltip.style.transform = `translate(${Math.round(clientX - bounds.left + 14)}px, ${Math.round(clientY - bounds.top + 14)}px)`;
  }

  const onMouseDown = (event: MouseEvent) => {
    dragging = event.button === 0 && !event.shiftKey ? "orbit" : "pan";
    dragMoved = false;
    lastX = event.clientX;
    lastY = event.clientY;
    yawVelocity = 0;
    pitchVelocity = 0;
    event.preventDefault();
  };

  const onMouseMove = (event: MouseEvent) => {
    if (dragging) {
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
      if (dragging === "orbit") {
        yawVelocity = dx * 0.0045;
        pitchVelocity = flattenTarget === 1 ? 0 : dy * 0.0035;
      } else {
        panX += dx;
        panY += dy;
      }
      schedule();
      return;
    }
    const [x, y] = localPoint(event.clientX, event.clientY);
    const node = pickNode(x, y);
    const link = node ? null : pickLink(x, y);
    if (node) {
      showTooltip(
        [node.input.label, node.input.detail ?? ""],
        event.clientX,
        event.clientY,
      );
    } else if (link) {
      showTooltip(
        [
          `${link.source.input.label} ↔ ${link.target.input.label}`,
          link.style === "dashed"
            ? "同属一个知识条目"
            : `共享 ${link.strength} 条论断${link.tone === "conflict" ? " · 含分歧" : ""}`,
        ],
        event.clientX,
        event.clientY,
      );
    } else {
      showTooltip(null, 0, 0);
    }
    if (node === hoveredNode && link === hoveredLink) return;
    hoveredNode = node;
    hoveredLink = link;
    canvas.style.cursor = node || link ? "pointer" : "grab";
    schedule();
  };

  const onMouseUp = () => {
    dragging = null;
  };

  const onMouseLeave = () => {
    dragging = null;
    if (hoveredNode || hoveredLink) {
      hoveredNode = null;
      hoveredLink = null;
      schedule();
    }
    showTooltip(null, 0, 0);
  };

  const onClick = (event: MouseEvent) => {
    if (dragMoved) return;
    const [x, y] = localPoint(event.clientX, event.clientY);
    const node = pickNode(x, y);
    if (node) {
      selectedNode = node;
      selectedLink = null;
      schedule();
      options.onSelectNode?.(node.input);
      return;
    }
    const link = pickLink(x, y);
    if (link) {
      selectedLink = link;
      selectedNode = null;
      schedule();
      options.onSelectLink?.(link.input);
      return;
    }
    selectedNode = null;
    selectedLink = null;
    schedule();
    options.onSelectNode?.(null);
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    zoom = clamp(zoom * (event.deltaY > 0 ? 0.92 : 1.08), 0.28, 4.5);
    schedule();
  };

  const onContextMenu = (event: Event) => event.preventDefault();

  canvas.addEventListener("mousedown", onMouseDown as EventListener);
  canvas.addEventListener("mousemove", onMouseMove as EventListener);
  canvas.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener("mouseleave", onMouseLeave);
  canvas.addEventListener("click", onClick as EventListener);
  canvas.addEventListener(
    "wheel",
    onWheel as EventListener,
    {
      passive: false,
    } as any,
  );
  canvas.addEventListener("contextmenu", onContextMenu);
  canvas.style.cursor = "grab";

  let observer: any = null;
  try {
    observer = new win.ResizeObserver(() => schedule());
    observer.observe(canvas);
  } catch {
    // Older hosts without ResizeObserver still redraw on interaction.
    observer = null;
  }

  readPalette();

  return {
    setData(data: GraphData) {
      let minWeight = Infinity;
      let maxWeight = -Infinity;
      for (const input of data.nodes) {
        const weight = input.weight ?? 1;
        minWeight = Math.min(minWeight, weight);
        maxWeight = Math.max(maxWeight, weight);
      }
      const range = Math.max(1e-6, maxWeight - minWeight);
      nodes = data.nodes.map((input) => {
        const normalized = ((input.weight ?? 1) - minWeight) / range;
        const node: RuntimeNode = {
          input,
          shell: mix(SHELL[0], SHELL[1], clamp(input.depth ?? 0.5, 0, 1)),
          radius: mix(
            NODE_RADIUS[0],
            NODE_RADIUS[1],
            clamp(Math.sqrt(normalized), 0, 1),
          ),
          group: Math.max(0, Math.round(input.group ?? 0)),
          dim: input.dim === true,
          degree: 0,
          x: 0,
          y: 0,
          z: 0,
          vx: 0,
          vy: 0,
          vz: 0,
          sx: 0,
          sy: 0,
          sr: NODE_RADIUS[0],
          depth: 0,
          visible: true,
        };
        return node;
      });
      byId = new Map(nodes.map((node) => [node.input.id, node]));
      links = [];
      for (const input of data.links) {
        const source = byId.get(input.source);
        const target = byId.get(input.target);
        if (!source || !target || source === target) continue;
        source.degree += 1;
        target.degree += 1;
        links.push({
          input,
          source,
          target,
          style: input.style ?? "solid",
          tone: input.tone ?? "neutral",
          strength: clamp(input.strength ?? 1, 0.2, 8),
          cx: 0,
          cy: 0,
          visible: true,
        });
      }
      hoveredNode = null;
      hoveredLink = null;
      selectedNode = null;
      selectedLink = null;
      applyVisibility();
      layout(nodes, links);
      readPalette();
      schedule();
    },
    setMode(mode: GraphMode) {
      flattenTarget = mode === "2d" ? 1 : 0;
      if (mode === "2d") pitchVelocity = 0;
      schedule();
    },
    getMode() {
      return flattenTarget === 1 ? "2d" : "3d";
    },
    setAutoRotate(on: boolean) {
      autoRotate = on;
      schedule();
    },
    isAutoRotate() {
      return autoRotate;
    },
    setVisibleLinkStyles(styles: readonly GraphLinkStyle[]) {
      visibleStyles = new Set(styles);
      applyVisibility();
      schedule();
    },
    getVisibleLinkStyles() {
      return Array.from(visibleStyles);
    },
    setShowIsolated(show: boolean) {
      showIsolated = show;
      applyVisibility();
      schedule();
    },
    isShowingIsolated() {
      return showIsolated;
    },
    selectNode(id: string | null) {
      selectedNode = id === null ? null : (byId.get(id) ?? null);
      selectedLink = null;
      schedule();
    },
    resetView() {
      yaw = 0.6;
      pitch = flattenTarget === 1 ? 0 : -0.32;
      yawVelocity = 0;
      pitchVelocity = 0;
      zoom = 1;
      panX = 0;
      panY = 0;
      schedule();
    },
    refreshTheme() {
      readPalette();
      schedule();
    },
    invalidate() {
      schedule();
    },
    dispose() {
      disposed = true;
      if (frame) win.cancelAnimationFrame?.(frame);
      frame = 0;
      observer?.disconnect?.();
      canvas.removeEventListener("mousedown", onMouseDown as EventListener);
      canvas.removeEventListener("mousemove", onMouseMove as EventListener);
      canvas.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("mouseleave", onMouseLeave);
      canvas.removeEventListener("click", onClick as EventListener);
      canvas.removeEventListener("wheel", onWheel as EventListener);
      canvas.removeEventListener("contextmenu", onContextMenu);
    },
  };
}
