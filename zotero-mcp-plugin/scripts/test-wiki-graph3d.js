/* eslint-env node */

/**
 * Drives the knowledge-space renderer over a recording canvas.
 *
 * The old graph was a ring of circles: one radius, straight chords, no depth.
 * These tests pin the three properties that make the replacement a real 3D
 * view rather than a restyled flat one.
 *
 *   1. Depth exists. Nodes that share a kind and a weight - and therefore
 *      share a modelled radius - still draw at different screen radii, which
 *      can only happen if they sit at different distances from the camera.
 *   2. Flattening removes it. In 2D mode the same nodes collapse to a single
 *      screen radius, so the mode switch is a projection change, not a restyle.
 *   3. Relations are drawn. Every visible edge emits a curve, so the picture
 *      carries the network and not just its vertices.
 *
 * A filter pass and a click round-trip cover the controls the panel exposes.
 */

import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-ext-hooks.mjs", import.meta.url);

const { createGraph3D } = await import("../src/modules/wiki/graph3D.ts");

// --- Recording canvas -----------------------------------------------------

function createContext() {
  const record = { arcs: [], curves: [], labels: [], lines: 0, fills: 0 };
  const gradient = { addColorStop() {} };
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
    moveTo() {},
    lineTo() {
      record.lines += 1;
    },
    quadraticCurveTo(cx, cy, x, y) {
      record.curves.push({ cx, cy, x, y });
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

// --- Data -----------------------------------------------------------------

/** Same kind, same weight, so any radius spread has to come from depth. */
function uniformPages(count) {
  const nodes = [];
  const edges = [];
  for (let index = 0; index < count; index += 1) {
    nodes.push({
      id: `page:${index}`,
      kind: "page",
      label: `页面 ${index}`,
      weight: 1,
      payload: { kind: "page", pageId: index },
    });
    if (index) {
      edges.push({
        source: `page:${index - 1}`,
        target: `page:${index}`,
        kind: "supports",
        strength: 1,
      });
    }
  }
  return { nodes, edges };
}

function spread(values) {
  return Math.max(...values) - Math.min(...values);
}

// --- 1. The space has depth ----------------------------------------------

{
  const win = createWin();
  const canvas = createCanvas();
  const graph = createGraph3D({ win, canvas });
  graph.setData(uniformPages(40));
  win.flush();

  const radii = canvas.context.record.arcs.map((arc) => arc.radius);
  assert.equal(radii.length, 40, "every node must be drawn once per frame");
  assert.ok(
    spread(radii) > 1,
    "identical nodes must draw at different screen radii, which only a real z axis produces",
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

  // Labels are dropped rather than stacked: forty page nodes crowded into the
  // inner shell must not print forty overlapping captions.
  const labels = canvas.context.record.labels;
  assert.ok(labels.length > 0, "page nodes must be named on the canvas");
  assert.ok(
    labels.length < 40,
    "colliding labels must be dropped, not drawn on top of each other",
  );
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const a = labels[i];
      const b = labels[j];
      const halfA = (String(a.text).length * 6) / 2 + 4;
      const halfB = (String(b.text).length * 6) / 2 + 4;
      const apart =
        Math.abs(a.x - b.x) >= halfA + halfB || Math.abs(a.y - b.y) >= 16;
      assert.ok(apart, `labels "${a.text}" and "${b.text}" overlap`);
    }
  }
  graph.dispose();
}

// --- 2. Flattening is a projection change, not a restyle ------------------

{
  const win = createWin();
  const canvas = createCanvas();
  const graph = createGraph3D({ win, canvas });
  graph.setData(uniformPages(40));
  win.flush();
  const before = spread(canvas.context.record.arcs.map((arc) => arc.radius));

  graph.setMode("2d");
  win.flush();
  assert.equal(graph.getMode(), "2d");
  canvas.context.record.arcs.length = 0;
  graph.invalidate();
  win.flush();
  const after = spread(canvas.context.record.arcs.map((arc) => arc.radius));
  assert.ok(before > 1, "3D mode must vary the drawn radius");
  assert.ok(
    after < 0.001,
    `2D mode must collapse every node to one scale (spread ${after})`,
  );

  graph.setMode("3d");
  win.flush();
  assert.equal(graph.getMode(), "3d");
  canvas.context.record.arcs.length = 0;
  graph.invalidate();
  win.flush();
  assert.ok(
    spread(canvas.context.record.arcs.map((arc) => arc.radius)) > 1,
    "switching back must restore depth",
  );
  graph.dispose();
}

// --- 3. Orbit, zoom and reset move the camera -----------------------------

{
  const win = createWin();
  const canvas = createCanvas();
  const graph = createGraph3D({ win, canvas });
  graph.setData(uniformPages(24));
  win.flush();
  const home = canvas.context.record.arcs.map((arc) => `${arc.x}:${arc.y}`);

  canvas.dispatch("mousedown", { clientX: 500, clientY: 300 });
  canvas.dispatch("mousemove", { clientX: 620, clientY: 340 });
  canvas.dispatch("mouseup");
  win.flush();
  canvas.context.record.arcs.length = 0;
  graph.invalidate();
  win.flush();
  const orbited = canvas.context.record.arcs.map((arc) => `${arc.x}:${arc.y}`);
  assert.notDeepEqual(orbited, home, "dragging must rotate the space");

  canvas.dispatch("wheel", { deltaY: -120 });
  win.flush();
  canvas.context.record.arcs.length = 0;
  graph.invalidate();
  win.flush();
  const zoomed = canvas.context.record.arcs.map((arc) => arc.radius);
  graph.resetView();
  win.flush();
  canvas.context.record.arcs.length = 0;
  graph.invalidate();
  win.flush();
  const reset = canvas.context.record.arcs.map((arc) => arc.radius);
  assert.notDeepEqual(zoomed, reset, "reset must undo the zoom");

  graph.setAutoRotate(true);
  assert.equal(graph.isAutoRotate(), true);
  graph.setAutoRotate(false);
  assert.equal(graph.isAutoRotate(), false);
  graph.dispose();
}

// --- 4. Filters hide a whole layer ---------------------------------------

{
  const win = createWin();
  const canvas = createCanvas();
  const graph = createGraph3D({ win, canvas });
  graph.setData({
    nodes: [
      { id: "page:1", kind: "page", label: "页面", weight: 2 },
      { id: "claim:1", kind: "claim", label: "论断", weight: 2 },
      { id: "claim:2", kind: "claim", label: "论断", weight: 1 },
      { id: "item:A", kind: "evidence", label: "ITEMA", weight: 1 },
    ],
    edges: [
      { source: "page:1", target: "claim:1", kind: "structure" },
      { source: "page:1", target: "claim:2", kind: "structure" },
      { source: "claim:1", target: "item:A", kind: "supports" },
      { source: "claim:2", target: "item:A", kind: "contradicts" },
    ],
  });
  win.flush();
  assert.equal(canvas.context.record.arcs.length, 4);
  assert.equal(canvas.context.record.curves.length, 4);

  graph.setVisibleKinds(["page", "claim"]);
  win.flush();
  canvas.context.record.arcs.length = 0;
  canvas.context.record.curves.length = 0;
  graph.invalidate();
  win.flush();
  assert.equal(
    canvas.context.record.arcs.length,
    3,
    "hiding the evidence layer must drop its nodes",
  );
  assert.equal(
    canvas.context.record.curves.length,
    2,
    "an edge with a hidden endpoint must not be drawn",
  );
  assert.deepEqual(graph.getVisibleKinds().sort(), ["claim", "page"]);
  graph.dispose();
}

// --- 5. Clicking a node reports it back to the panel ----------------------

{
  const win = createWin();
  const canvas = createCanvas();
  const picked = [];
  const graph = createGraph3D({
    win,
    canvas,
    onSelect: (node) => picked.push(node),
  });
  graph.setData(uniformPages(12));
  win.flush();
  const target = canvas.context.record.arcs[0];

  canvas.dispatch("click", { clientX: target.x, clientY: target.y });
  assert.equal(picked.length, 1, "a click on a node must report a selection");
  assert.equal(picked[0].kind, "page");
  assert.ok(picked[0].payload, "the panel payload must survive the round trip");

  canvas.dispatch("click", { clientX: 4, clientY: 4 });
  assert.equal(picked.length, 2);
  assert.equal(picked[1], null, "a click on empty space must clear the selection");
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
  const edges = [];
  for (let index = 0; index < 240; index += 1) {
    const kind = index < 20 ? "page" : index < 140 ? "claim" : "evidence";
    nodes.push({ id: `${kind}:${index}`, kind, label: `n${index}`, weight: 1 });
    if (index > 20) {
      edges.push({
        source: nodes[index - 1].id,
        target: nodes[index].id,
        kind: "related",
        strength: 1,
      });
    }
  }
  const started = Date.now();
  graph.setData({ nodes, edges });
  win.flush();
  const elapsed = Date.now() - started;
  assert.equal(canvas.context.record.arcs.length, 240);
  assert.ok(
    elapsed < 6000,
    `a 240-node space must settle promptly (took ${elapsed}ms)`,
  );
  graph.dispose();
}

console.log("wiki 3D graph tests passed");
