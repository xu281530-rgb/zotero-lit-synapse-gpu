/* eslint-env node */

/**
 * Drives the knowledge-space renderer over a recording canvas.
 *
 * The graph draws a network of documents: one sphere per piece of literature,
 * one curve per knowledge relation between two of them. Both are selectable,
 * because the reader either asks "what does this paper claim?" or "what do
 * these two papers conclude in common?", and the second question lives on the
 * link. These tests pin that contract plus the properties that make the view
 * genuinely three-dimensional rather than a restyled plane:
 *
 *   1. Depth exists. Documents that share a weight - and therefore a modelled
 *      radius - still draw at different screen radii, which can only happen if
 *      they sit at different distances from the camera.
 *   2. Flattening removes it. In 2D mode they collapse to a single screen
 *      radius, so the mode switch is a projection change, not a restyle.
 *   3. Relations are drawn, and can be clicked.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { createGraph3D } = await import("../src/modules/wiki/graph3D.ts");

// --- Recording canvas -----------------------------------------------------

function createContext() {
  const record = {
    arcs: [],
    curves: [],
    labels: [],
    lines: 0,
    fills: 0,
  };
  const gradient = { addColorStop() {} };
  let pen = { x: 0, y: 0 };
  let dash = [];
  return {
    record,
    canvas: null,
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    setTransform() {},
    createRadialGradient: () => gradient,
    fillRect() {},
    beginPath() {},
    moveTo(x, y) {
      pen = { x, y };
    },
    lineTo() {
      record.lines += 1;
    },
    setLineDash(pattern) {
      dash = pattern ?? [];
    },
    quadraticCurveTo(cx, cy, x, y) {
      record.curves.push({
        ax: pen.x,
        ay: pen.y,
        cx,
        cy,
        x,
        y,
        dashed: dash.length > 0,
        width: this.lineWidth,
        stroke: this.strokeStyle,
      });
    },
    stroke() {},
    fill() {
      record.fills += 1;
    },
    arc(x, y, radius) {
      record.arcs.push({ x, y, radius });
    },
    rect() {},
    roundRect() {},
    measureText: (text) => ({ width: String(text).length * 6 }),
    fillText(text, x, y) {
      record.labels.push({ text, x, y });
    },
  };
}

function createCanvas() {
  const context = createContext();
  const listeners = new Map();
  const canvas = {
    context,
    listeners,
    width: 0,
    height: 0,
    clientWidth: 1000,
    clientHeight: 600,
    style: {},
    ownerDocument: {
      createElement: () => ({
        textContent: "",
        style: {},
        append() {},
        replaceChildren() {},
      }),
    },
    getContext: () => context,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 1000,
      height: 600,
    }),
    addEventListener(type, handler) {
      const existing = listeners.get(type) ?? [];
      existing.push(handler);
      listeners.set(type, existing);
    },
    removeEventListener(type, handler) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== handler),
      );
    },
    dispatch(type, event = {}) {
      const payload = {
        button: 0,
        shiftKey: false,
        clientX: 0,
        clientY: 0,
        deltaY: 0,
        preventDefault() {},
        ...event,
      };
      for (const handler of listeners.get(type) ?? []) handler(payload);
    },
  };
  context.canvas = canvas;
  return canvas;
}

function createWin() {
  const queue = [];
  return {
    devicePixelRatio: 1,
    requestAnimationFrame(callback) {
      queue.push(callback);
      return queue.length;
    },
    cancelAnimationFrame() {},
    getComputedStyle: () => ({ getPropertyValue: () => "light" }),
    /** Run pending frames until the view stops animating. */
    flush(limit = 400) {
      let steps = 0;
      while (queue.length && steps < limit) {
        const callback = queue.shift();
        callback();
        steps += 1;
      }
      return steps;
    },
  };
}

/** Redraw once and hand back what the canvas recorded. */
function repaint(graph, canvas, win) {
  canvas.context.record.arcs.length = 0;
  canvas.context.record.curves.length = 0;
  canvas.context.record.labels.length = 0;
  graph.invalidate();
  win.flush();
  return canvas.context.record;
}

// --- Data -----------------------------------------------------------------

/** Same weight throughout, so any radius spread has to come from depth. */
function uniformDocuments(count) {
  const nodes = [];
  const links = [];
  for (let index = 0; index < count; index += 1) {
    nodes.push({
      id: `item:${index}`,
      label: `文献 ${index}`,
      detail: "Kurz 1992 · 3 条论断引用",
      weight: 1,
      depth: index / count,
      group: index % 4,
      payload: { kind: "document", itemKey: `ITEM${index}` },
    });
    if (index) {
      links.push({
        source: `item:${index - 1}`,
        target: `item:${index}`,
        style: "solid",
        tone: "neutral",
        strength: 1,
        payload: { kind: "shared-claim", a: `ITEM${index - 1}` },
      });
    }
  }
  return { nodes, links };
}

function spread(values) {
  return Math.max(...values) - Math.min(...values);
}

// --- 1. The space has depth, and draws relations --------------------------

{
  const win = createWin();
  const canvas = createCanvas();
  const graph = createGraph3D({ win, canvas });
  graph.setData(uniformDocuments(40));
  win.flush();

  const radii = canvas.context.record.arcs.map((arc) => arc.radius);
  assert.equal(radii.length, 40, "every document must be drawn once per frame");
  assert.ok(
    spread(radii) > 1,
    "identical documents must draw at different screen radii, which only a real z axis produces",
  );
  assert.equal(
    canvas.context.record.curves.length,
    39,
    "every relation must be drawn as a curve",
  );
  assert.equal(
    canvas.context.record.lines,
    0,
    "relations must curve through the space rather than run as flat chords",
  );
  assert.equal(canvas.width, 1000, "the backing store must follow the element");
  assert.equal(canvas.height, 600);

  // Captions are budgeted and then thinned, so a crowded core cannot print a
  // wall of overlapping text - but an evenly weighted library still gets some.
  const labels = canvas.context.record.labels;
  assert.ok(labels.length > 0, "documents must be named on the canvas");
  assert.ok(
    labels.length < 40,
    "colliding captions must be dropped, not stacked",
  );
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const a = labels[i];
      const b = labels[j];
      const halfA = (String(a.text).length * 6) / 2 + 4;
      const halfB = (String(b.text).length * 6) / 2 + 4;
      const apart =
        Math.abs(a.x - b.x) >= halfA + halfB || Math.abs(a.y - b.y) >= 16;
      assert.ok(apart, `captions "${a.text}" and "${b.text}" overlap`);
    }
  }
  graph.dispose();
}

// --- 2. Flattening is a projection change, not a restyle ------------------

{
  const win = createWin();
  const canvas = createCanvas();
  const graph = createGraph3D({ win, canvas });
  graph.setData(uniformDocuments(40));
  win.flush();
  const before = spread(canvas.context.record.arcs.map((arc) => arc.radius));

  graph.setMode("2d");
  win.flush();
  assert.equal(graph.getMode(), "2d");
  const flat = spread(repaint(graph, canvas, win).arcs.map((a) => a.radius));
  assert.ok(before > 1, "3D mode must vary the drawn radius");
  assert.ok(
    flat < 0.001,
    `2D mode must collapse every document to one scale (spread ${flat})`,
  );

  graph.setMode("3d");
  win.flush();
  assert.equal(graph.getMode(), "3d");
  assert.ok(
    spread(repaint(graph, canvas, win).arcs.map((a) => a.radius)) > 1,
    "switching back must restore depth",
  );
  graph.dispose();
}

// --- 3. Orbit, zoom and reset move the camera -----------------------------

{
  const win = createWin();
  const canvas = createCanvas();
  const graph = createGraph3D({ win, canvas });
  graph.setData(uniformDocuments(24));
  win.flush();
  const home = canvas.context.record.arcs.map((arc) => `${arc.x}:${arc.y}`);

  canvas.dispatch("mousedown", { clientX: 500, clientY: 300 });
  canvas.dispatch("mousemove", { clientX: 620, clientY: 340 });
  canvas.dispatch("mouseup");
  win.flush();
  const orbited = repaint(graph, canvas, win).arcs.map((a) => `${a.x}:${a.y}`);
  assert.notDeepEqual(orbited, home, "dragging must rotate the space");

  canvas.dispatch("wheel", { deltaY: -120 });
  win.flush();
  const zoomed = repaint(graph, canvas, win).arcs.map((a) => a.radius);
  graph.resetView();
  win.flush();
  const reset = repaint(graph, canvas, win).arcs.map((a) => a.radius);
  assert.notDeepEqual(zoomed, reset, "reset must undo the zoom");

  graph.setAutoRotate(true);
  assert.equal(graph.isAutoRotate(), true);
  graph.setAutoRotate(false);
  assert.equal(graph.isAutoRotate(), false);
  graph.dispose();
}

// --- 4. Relation filters and the isolated toggle --------------------------

/**
 * Four documents: A-B share a claim and disagree, B-C only share a knowledge
 * entry, and D is cited by nothing else in the library.
 */
function mixedLibrary() {
  return {
    nodes: [
      { id: "item:A", label: "定向凝固综述", weight: 4, depth: 0, group: 0 },
      { id: "item:B", label: "柱状晶生长", weight: 3, depth: 0.2, group: 0 },
      { id: "item:C", label: "热压定型", weight: 2, depth: 0.6, group: 1 },
      {
        id: "item:D",
        label: "孤立文献",
        weight: 1,
        depth: 1,
        group: 2,
        dim: true,
      },
    ],
    links: [
      {
        source: "item:A",
        target: "item:B",
        style: "solid",
        tone: "conflict",
        strength: 3,
        payload: { kind: "shared-claim", a: "A", b: "B", claimIds: [1, 2, 3] },
      },
      {
        source: "item:B",
        target: "item:C",
        style: "dashed",
        tone: "neutral",
        strength: 1,
        payload: { kind: "same-page", a: "B", b: "C", claimIds: [] },
      },
    ],
  };
}

{
  const win = createWin();
  const canvas = createCanvas();
  const graph = createGraph3D({ win, canvas });
  graph.setData(mixedLibrary());
  win.flush();
  assert.equal(canvas.context.record.arcs.length, 4);
  assert.equal(canvas.context.record.curves.length, 2);
  assert.equal(
    canvas.context.record.curves.filter((curve) => curve.dashed).length,
    1,
    "a shared knowledge entry must draw as a dashed line",
  );

  graph.setVisibleLinkStyles(["solid"]);
  win.flush();
  let frame = repaint(graph, canvas, win);
  assert.deepEqual(graph.getVisibleLinkStyles(), ["solid"]);
  assert.equal(
    frame.curves.length,
    1,
    "hiding a relation kind must drop its lines",
  );
  assert.equal(
    frame.arcs.length,
    4,
    "isolated documents stay visible while the toggle is on",
  );

  graph.setShowIsolated(false);
  win.flush();
  frame = repaint(graph, canvas, win);
  assert.equal(graph.isShowingIsolated(), false);
  assert.equal(
    frame.arcs.length,
    2,
    "hiding isolated documents must drop everything the visible relations do not reach",
  );

  graph.setVisibleLinkStyles(["solid", "dashed"]);
  graph.setShowIsolated(true);
  win.flush();
  assert.equal(repaint(graph, canvas, win).arcs.length, 4);
  graph.dispose();
}

// --- 5. Clicking a document, and clicking a relation ----------------------

{
  const win = createWin();
  const canvas = createCanvas();
  const nodePicks = [];
  const linkPicks = [];
  const graph = createGraph3D({
    win,
    canvas,
    onSelectNode: (node) => nodePicks.push(node),
    onSelectLink: (link) => linkPicks.push(link),
  });
  graph.setData(mixedLibrary());
  win.flush();

  const target = canvas.context.record.arcs[0];
  canvas.dispatch("click", { clientX: target.x, clientY: target.y });
  assert.equal(nodePicks.length, 1, "clicking a document must report it");
  assert.ok(nodePicks[0].label, "the reported document must carry its title");

  // The midpoint of a quadratic curve, which is where a reader aims.
  const curve = canvas.context.record.curves[0];
  const midX = 0.25 * curve.ax + 0.5 * curve.cx + 0.25 * curve.x;
  const midY = 0.25 * curve.ay + 0.5 * curve.cy + 0.25 * curve.y;
  canvas.dispatch("click", { clientX: midX, clientY: midY });
  assert.equal(
    linkPicks.length,
    1,
    "clicking a relation must report it - this is how shared conclusions open",
  );
  assert.ok(
    Array.isArray(linkPicks[0].payload.claimIds),
    "a relation must name the claims it is made of",
  );

  canvas.dispatch("click", { clientX: 4, clientY: 4 });
  assert.equal(nodePicks.length, 2);
  assert.equal(nodePicks[1], null, "empty space must clear the selection");

  // A hidden relation is not pickable either.
  graph.setVisibleLinkStyles([]);
  win.flush();
  repaint(graph, canvas, win);
  canvas.dispatch("click", { clientX: midX, clientY: midY });
  assert.equal(
    linkPicks.length,
    1,
    "a relation that is not drawn must not be clickable",
  );

  graph.dispose();
  assert.equal(
    canvas.listeners.get("click").length,
    0,
    "disposing must unbind every handler",
  );
}

// --- 6. A library-scale space still lays out ------------------------------

{
  const win = createWin();
  const canvas = createCanvas();
  const graph = createGraph3D({ win, canvas });
  const nodes = [];
  const links = [];
  for (let index = 0; index < 240; index += 1) {
    nodes.push({
      id: `item:${index}`,
      label: `文献 ${index}`,
      weight: 1 + (index % 6),
      depth: (index % 10) / 10,
      group: index % 8,
    });
    if (index > 1) {
      links.push({
        source: `item:${index - 1}`,
        target: `item:${index}`,
        style: index % 3 === 0 ? "dashed" : "solid",
        tone: index % 7 === 0 ? "conflict" : "neutral",
        strength: 1 + (index % 3),
      });
    }
  }
  const started = Date.now();
  graph.setData({ nodes, links });
  win.flush();
  const elapsed = Date.now() - started;
  assert.equal(canvas.context.record.arcs.length, 240);
  assert.ok(
    canvas.context.record.labels.length <= 40,
    "the caption budget must hold at library scale",
  );
  assert.ok(
    elapsed < 6000,
    `a 240-document space must settle promptly (took ${elapsed}ms)`,
  );
  graph.dispose();
}

console.log("wiki 3D graph tests passed");
