/**
 * A dependency-free 3D renderer for the Wiki knowledge graph.
 *
 * The graph used to be a ring of circles on a 2D canvas: every node sat on one
 * circle, edges were straight chords, and nothing about the picture said which
 * concepts were central and which were peripheral. This module replaces that
 * with a real three-dimensional layout - nodes carry x/y/z, a force pass
 * settles them onto concentric shells (Page inside, Claim in the middle,
 * Evidence outside), and every frame rotates, projects and depth-sorts them
 * through a perspective camera.
 *
 * Why not Three.js: the renderer runs inside the privileged Zotero main
 * window, where a WebGL context is not guaranteed, and the whole plugin ships
 * as a single bundled script that Zotero parses at startup. Adding ~600 KB of
 * WebGL engine to every launch to draw a few hundred spheres is the wrong
 * trade, so the projection maths lives here and the drawing goes through
 * Canvas 2D, which is immediate-mode and therefore rebuilds no geometry
 * between frames.
 *
 * This module is presentation only. It never touches the Wiki store, the MCP
 * protocol or any Claim/Evidence state; it receives a plain data snapshot and
 * reports clicks back through callbacks.
 */

export type GraphMode = "2d" | "3d";

export type GraphNodeKind = "page" | "claim" | "evidence";

export type GraphEdgeKind =
  | "supports"
  | "contradicts"
  | "related"
  | "structure";

export interface GraphNodeInput {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** Second tooltip line: page title, claim status, source item key. */
  detail?: string;
  /** Relative importance; drives the drawn radius within its kind. */
  weight?: number;
  /** Marks a node whose evidence contradicts, so it reads as contested. */
  contested?: boolean;
  /** Opaque payload handed back through onSelect. */
  payload?: unknown;
}

export interface GraphEdgeInput {
  source: string;
  target: string;
  kind: GraphEdgeKind;
  strength?: number;
}

export interface GraphData {
  nodes: GraphNodeInput[];
  edges: GraphEdgeInput[];
}

export interface Graph3DOptions {
  win: any;
  canvas: HTMLCanvasElement;
  /** Absolutely positioned overlay moved with transform on hover. */
  tooltip?: HTMLElement;
  onSelect?: (node: GraphNodeInput | null) => void;
}

export interface Graph3DController {
  setData(data: GraphData): void;
  setMode(mode: GraphMode): void;
  getMode(): GraphMode;
  setAutoRotate(on: boolean): void;
  isAutoRotate(): boolean;
  setVisibleKinds(kinds: readonly GraphNodeKind[]): void;
  getVisibleKinds(): GraphNodeKind[];
  selectNode(id: string | null): void;
  resetView(): void;
  refreshTheme(): void;
  invalidate(): void;
  dispose(): void;
}

interface RuntimeNode {
  input: GraphNodeInput;
  kind: GraphNodeKind;
  shell: number;
  radius: number;
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

interface RuntimeEdge {
  source: RuntimeNode;
  target: RuntimeNode;
  kind: GraphEdgeKind;
  strength: number;
}

interface Palette {
  background: string;
  backgroundEdge: string;
  text: string;
  muted: string;
  page: string;
  claim: string;
  evidence: string;
  contested: string;
  supports: string;
  contradicts: string;
  related: string;
  structure: string;
  halo: string;
}

const BASE_RADIUS = 300;

/** Concentric shells: the depth hierarchy the design asks for, as one number. */
const SHELL: Record<GraphNodeKind, number> = {
  page: 0.26,
  claim: 0.7,
  evidence: 1.14,
};

const NODE_RADIUS: Record<GraphNodeKind, [number, number]> = {
  page: [11, 24],
  claim: [7, 14],
  evidence: [4, 7],
};

const LIGHT_PALETTE: Palette = {
  background: "#FBF9F3",
  backgroundEdge: "#DED5C1",
  text: "#25231F",
  muted: "#777168",
  page: "#536F62",
  claim: "#8C7A5C",
  evidence: "#7E8794",
  contested: "#A4574E",
  supports: "rgba(83, 111, 98, 0.52)",
  contradicts: "rgba(164, 87, 78, 0.58)",
  related: "rgba(110, 120, 135, 0.38)",
  structure: "rgba(122, 110, 90, 0.26)",
  halo: "rgba(255, 255, 255, 0.72)",
};

const DARK_PALETTE: Palette = {
  background: "#2A2823",
  backgroundEdge: "#141310",
  text: "#ECE6DA",
  muted: "#A79E90",
  page: "#8FB3A2",
  claim: "#C3A879",
  evidence: "#939DAB",
  contested: "#D98C81",
  supports: "rgba(143, 179, 162, 0.5)",
  contradicts: "rgba(217, 140, 129, 0.55)",
  related: "rgba(150, 162, 180, 0.34)",
  structure: "rgba(198, 184, 158, 0.2)",
  halo: "rgba(255, 255, 255, 0.34)",
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
 * Settle the nodes into three-dimensional shells.
 *
 * Repulsion spreads them, edge springs pull related knowledge together, and a
 * radial term keeps each kind near its own shell so the hierarchy survives the
 * simulation. Iterations are capped by node count: 500 nodes still settle in a
 * few hundred milliseconds, and the pass runs once per data load, never per
 * frame.
 */
function layout(nodes: RuntimeNode[], edges: RuntimeEdge[]): void {
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
    const jitter = 0.22;
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
    for (const edge of edges) {
      const a = edge.source;
      const b = edge.target;
      const rest = edge.kind === "structure" ? 74 : 132;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const pull = ((distance - rest) / distance) * 0.045 * edge.strength;
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

export function createGraph3D(options: Graph3DOptions): Graph3DController {
  const { win, canvas } = options;
  const doc = canvas.ownerDocument as Document;
  let palette = LIGHT_PALETTE;
  let nodes: RuntimeNode[] = [];
  let edges: RuntimeEdge[] = [];
  let byId = new Map<string, RuntimeNode>();
  let visibleKinds = new Set<GraphNodeKind>(["page", "claim", "evidence"]);

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
  let hovered: RuntimeNode | null = null;
  let selected: RuntimeNode | null = null;
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
    if (node.input.contested) return palette.contested;
    return palette[node.kind];
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
    const visibleEdges = edges.filter(
      (edge) => edge.source.visible && edge.target.visible,
    );
    visibleEdges.sort(
      (a, b) =>
        (b.source.depth + b.target.depth) / 2 -
        (a.source.depth + a.target.depth) / 2,
    );
    for (const edge of visibleEdges) {
      const a = edge.source;
      const b = edge.target;
      const focused = hovered !== null && (hovered === a || hovered === b);
      const alpha =
        depthAlpha((a.depth + b.depth) / 2, cameraDistance) *
        (focused ? 1 : 0.7);
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
      context.globalAlpha = alpha;
      context.strokeStyle = palette[edge.kind];
      context.lineWidth = clamp(
        (0.7 + edge.strength * 0.45) * (focused ? 2.1 : 1),
        0.6,
        4.5,
      );
      context.beginPath();
      context.moveTo(a.sx, a.sy);
      context.quadraticCurveTo(control.x, control.y, b.sx, b.sy);
      context.stroke();
    }
    context.globalAlpha = 1;

    active.sort((a, b) => b.depth - a.depth);
    const labels: RuntimeNode[] = [];
    const taken: Array<[number, number, number, number]> = [];
    for (const node of active) {
      const alpha = depthAlpha(node.depth, cameraDistance);
      const focused = node === hovered || node === selected;
      context.globalAlpha = focused ? 1 : alpha;
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
      if (focused) {
        context.beginPath();
        context.strokeStyle = color;
        context.lineWidth = 1.6;
        context.arc(node.sx, node.sy, node.sr + 4.5, 0, Math.PI * 2);
        context.stroke();
      }
      // Only Pages are named on the canvas. Labelling every Claim turned the
      // space into a wall of overlapping text; the rest identify themselves
      // through the hover tooltip and the detail rail instead.
      if (focused || (node.kind === "page" && node.sr > 6)) labels.push(node);
    }

    // Labels last, nearest first, and a label that would land on one already
    // drawn is dropped. Text in a 3D scene cannot be spaced by the layout, so
    // the only way to keep it legible is to draw fewer of them.
    labels.sort((a, b) => a.depth - b.depth);
    context.textAlign = "center";
    context.textBaseline = "top";
    for (const node of labels) {
      const focused = node === hovered || node === selected;
      context.font = `${focused ? 12 : 11.5}px "Times New Roman", "Microsoft YaHei", sans-serif`;
      const label = node.input.label;
      const text = label.length > 16 ? `${label.slice(0, 15)}…` : label;
      const width = context.measureText(text).width;
      const left = node.sx - width / 2 - 4;
      const top = node.sy + node.sr + 3;
      const right = left + width + 8;
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

  function pick(clientX: number, clientY: number): RuntimeNode | null {
    const bounds = canvas.getBoundingClientRect();
    const x = clientX - bounds.left;
    const y = clientY - bounds.top;
    let best: RuntimeNode | null = null;
    for (const node of nodes) {
      if (!node.visible) continue;
      if (Math.hypot(node.sx - x, node.sy - y) > node.sr + 5) continue;
      if (!best || node.depth < best.depth) best = node;
    }
    return best;
  }

  function showTooltip(
    node: RuntimeNode | null,
    clientX: number,
    clientY: number,
  ): void {
    const tooltip = options.tooltip;
    if (!tooltip) return;
    if (!node) {
      tooltip.hidden = true;
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    tooltip.hidden = false;
    tooltip.replaceChildren();
    const title = doc.createElement("strong");
    title.textContent = node.input.label;
    tooltip.append(title);
    if (node.input.detail) {
      const detail = doc.createElement("span");
      detail.textContent = node.input.detail;
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
    const node = pick(event.clientX, event.clientY);
    showTooltip(node, event.clientX, event.clientY);
    if (node === hovered) return;
    hovered = node;
    canvas.style.cursor = node ? "pointer" : "grab";
    schedule();
  };

  const onMouseUp = () => {
    dragging = null;
  };

  const onMouseLeave = () => {
    dragging = null;
    if (hovered) {
      hovered = null;
      schedule();
    }
    showTooltip(null, 0, 0);
  };

  const onClick = (event: MouseEvent) => {
    if (dragMoved) return;
    const node = pick(event.clientX, event.clientY);
    selected = node;
    schedule();
    options.onSelect?.(node ? node.input : null);
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
      const weights = new Map<GraphNodeKind, { min: number; max: number }>();
      for (const input of data.nodes) {
        const weight = input.weight ?? 1;
        const span = weights.get(input.kind) ?? { min: weight, max: weight };
        span.min = Math.min(span.min, weight);
        span.max = Math.max(span.max, weight);
        weights.set(input.kind, span);
      }
      nodes = data.nodes.map((input) => {
        const [low, high] = NODE_RADIUS[input.kind];
        const span = weights.get(input.kind)!;
        const range = Math.max(1e-6, span.max - span.min);
        const normalized = ((input.weight ?? 1) - span.min) / range;
        const node: RuntimeNode = {
          input,
          kind: input.kind,
          shell: SHELL[input.kind],
          radius: mix(low, high, clamp(normalized, 0, 1)),
          x: 0,
          y: 0,
          z: 0,
          vx: 0,
          vy: 0,
          vz: 0,
          sx: 0,
          sy: 0,
          sr: low,
          depth: 0,
          visible: visibleKinds.has(input.kind),
        };
        return node;
      });
      byId = new Map(nodes.map((node) => [node.input.id, node]));
      edges = [];
      for (const edge of data.edges) {
        const source = byId.get(edge.source);
        const target = byId.get(edge.target);
        if (!source || !target || source === target) continue;
        edges.push({
          source,
          target,
          kind: edge.kind,
          strength: clamp(edge.strength ?? 1, 0.2, 6),
        });
      }
      hovered = null;
      selected = null;
      layout(nodes, edges);
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
    setVisibleKinds(kinds: readonly GraphNodeKind[]) {
      visibleKinds = new Set(kinds);
      for (const node of nodes) node.visible = visibleKinds.has(node.kind);
      if (hovered && !hovered.visible) hovered = null;
      if (selected && !selected.visible) selected = null;
      schedule();
    },
    getVisibleKinds() {
      return Array.from(visibleKinds);
    },
    selectNode(id: string | null) {
      selected = id === null ? null : (byId.get(id) ?? null);
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
