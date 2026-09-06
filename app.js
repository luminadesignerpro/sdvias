/**
 * UrbanCAD Studio — Intelligent Traffic Simulation with:
 * - Timed Traffic Lights with live digital countdown (cars stop on red/yellow, accelerate on green)
 * - Physical Speed Bumps: cars physically brake and crawl over the bump before accelerating
 * - Realistic Day / Night Cycle with realistic dark atmosphere
 * - Actionable Street Lights: user can toggle lights on/off (with illumination halos in the dark)
 */

const ROAD_PROFILES = {
  'highway-twin': {
    name: 'Rodovia de Pista Dupla (4 Faixas)',
    width: 52,
    asphaltColor: '#383d46',
    shoulderWidth: 8,
    shoulderColor: '#6c5b4c',
    dividerColor: '#ffffff',
    lanes: 4,
    hasShoulder: true,
    elevation: 0,
    costPerMeter: 1200
  },
  'viaduct-real': {
    name: 'Viaduto Elevado (4 Faixas)',
    width: 48,
    asphaltColor: '#475569',
    shoulderWidth: 4,
    shoulderColor: '#38bdf8',
    dividerColor: '#ffffff',
    lanes: 4,
    hasShoulder: true,
    elevation: 1,
    costPerMeter: 4800
  },
  'avenue-real': {
    name: 'Avenida Central 4 Faixas',
    width: 54,
    asphaltColor: '#27272a',
    shoulderWidth: 6,
    shoulderColor: '#15803d',
    dividerColor: '#facc15',
    lanes: 4,
    hasShoulder: true,
    hasMedian: true,
    elevation: 0,
    costPerMeter: 950
  },
  'street-real': {
    name: 'Rua Urbana de Bairro (2 Faixas)',
    width: 26,
    asphaltColor: '#3f3f46',
    shoulderWidth: 4,
    shoulderColor: '#94a3b8',
    dividerColor: '#ffffff',
    lanes: 2,
    hasShoulder: true,
    elevation: 0,
    costPerMeter: 400
  }
};

const EQUIPMENT_DEFS = {
  'traffic-light': { name: 'Semáforo com Cronômetro', icon: '🚦', cost: 8000 },
  'speed-bump': { name: 'Lombada de Freada', icon: '〰️', cost: 900 },
  'light-pole': { name: 'Poste Iluminação LED', icon: '💡', cost: 1500 },
  'crosswalk': { name: 'Faixa Pedestre', icon: '🦓', cost: 1200 },
  'sign-speed': { name: 'Placa Velocidade', icon: '🛑', cost: 350 },
  'tree': { name: 'Árvore Urbana', icon: '🌳', cost: 250 }
};

// Simulation State
const cad = {
  mode: 'select', // 'select' (Seta livre padrão) | 'draw-road' | 'edit-nodes' | 'place-equipment' | 'erase'
  roadType: 'highway-twin',
  roadDirection: 'two-way', // 'two-way' | 'one-way'
  equipType: 'traffic-light',
  targetLane: 'all', // 'all' | 'right' | 'left'
  curveType: 'bezier',

  // Day/Night & Lighting State
  isNight: false,
  lightsOn: true,
  speedMultiplier: 1.0,
  signalTimerSeconds: 8, // seconds per phase

  // Map and Satellite State
  mapMode: 'sat', // 'sat' | 'osm' | 'cad'
  mapCenter: [-3.9711, -38.5284], // Default: Itaitinga / CE
  mapZoom: 18,

  // Geometry
  roads: [],
  equipments: [],
  cars: [],

  // Interaction
  activePoints: [],
  mouseWorld: { x: 0, y: 0 },
  snapTarget: null,
  selectedRoad: null,
  selectedEquip: null,
  draggingNodeIndex: -1,

  // Camera
  zoom: 1.0,
  panX: 0,
  panY: 0,
  isPanning: false,
  panStartX: 0,
  panStartY: 0,

  undoStack: [],
  redoStack: []
};

const canvas = document.getElementById('realistic-canvas');
const ctx = canvas.getContext('2d');
const wrapper = document.getElementById('canvas-wrapper');

function resizeCanvas() {
  canvas.width = wrapper.clientWidth;
  canvas.height = wrapper.clientHeight;
  render();
}
window.addEventListener('resize', resizeCanvas);

function screenToWorld(sx, sy) {
  return {
    x: (sx - cad.panX) / cad.zoom,
    y: (sy - cad.panY) / cad.zoom
  };
}

function worldToScreen(wx, wy) {
  return {
    x: wx * cad.zoom + cad.panX,
    y: wy * cad.zoom + cad.panY
  };
}

function dist(p1, p2) {
  return Math.hypot(p2.x - p1.x, p2.y - p1.y);
}

function distToSegment(p, v, w) {
  const l2 = (v.x - w.x)**2 + (v.y - w.y)**2;
  if (l2 === 0) return dist(p, v);
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) });
}

// -------------------------------------------------------------
// Spline Geometry Engine & Accurate Road Point Sampling
// -------------------------------------------------------------
function evalQuadratic(p0, p1, p2, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y
  };
}

function getSampledRoadPoints(road) {
  if (!road || !road.points || road.points.length < 2) {
    return road?.points || [];
  }
  if (road._cachedSampled && road._cachedSampled.length > 1) {
    return road._cachedSampled;
  }

  const raw = road.points;
  const sampled = [];

  if (cad.curveType !== 'bezier' || raw.length <= 2) {
    for (let i = 0; i < raw.length - 1; i++) {
      const p1 = raw[i];
      const p2 = raw[i + 1];
      const d = dist(p1, p2);
      const steps = Math.max(1, Math.ceil(d / 8));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        sampled.push({
          x: p1.x + (p2.x - p1.x) * t,
          y: p1.y + (p2.y - p1.y) * t
        });
      }
    }
    sampled.push({ x: raw[raw.length - 1].x, y: raw[raw.length - 1].y });
  } else {
    // Piecewise quadratic bezier spline matching HTML5 Canvas quadraticCurveTo
    sampled.push({ x: raw[0].x, y: raw[0].y });

    for (let i = 1; i < raw.length - 1; i++) {
      const pStart = (i === 1) 
        ? raw[0] 
        : { x: (raw[i - 1].x + raw[i].x) / 2, y: (raw[i - 1].y + raw[i].y) / 2 };
      const pCtrl = raw[i];
      const pEnd = (i === raw.length - 2)
        ? { x: (raw[i].x + raw[i + 1].x) / 2, y: (raw[i].y + raw[i + 1].y) / 2 }
        : { x: (raw[i].x + raw[i + 1].x) / 2, y: (raw[i].y + raw[i + 1].y) / 2 };

      const estChord = dist(pStart, pCtrl) + dist(pCtrl, pEnd);
      const steps = Math.max(8, Math.ceil(estChord / 6));

      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        sampled.push(evalQuadratic(pStart, pCtrl, pEnd, t));
      }
    }

    const lastMid = {
      x: (raw[raw.length - 2].x + raw[raw.length - 1].x) / 2,
      y: (raw[raw.length - 2].y + raw[raw.length - 1].y) / 2
    };
    const pLast = raw[raw.length - 1];
    const lastLen = dist(lastMid, pLast);
    const lastSteps = Math.max(2, Math.ceil(lastLen / 6));
    for (let s = 1; s <= lastSteps; s++) {
      const t = s / lastSteps;
      sampled.push({
        x: lastMid.x + (pLast.x - lastMid.x) * t,
        y: lastMid.y + (pLast.y - lastMid.y) * t
      });
    }
  }

  road._cachedSampled = sampled;
  return sampled;
}

// -------------------------------------------------------------
// Road Network, Snapping & Junction System
// -------------------------------------------------------------
function getSnapPoint(worldPos, snapDist = 32, ignoreRoadId = null) {
  let best = null;
  let minDist = snapDist / cad.zoom;
  const currentElev = ROAD_PROFILES[cad.roadType]?.elevation || 0;

  for (const road of cad.roads) {
    if (road.id === ignoreRoadId) continue;
    const prof = ROAD_PROFILES[road.type];
    if ((prof?.elevation || 0) !== currentElev) continue;
    const pts = road.points;
    if (!pts || pts.length < 2) continue;

    // Check endpoints first (higher priority for exact corner snapping)
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const d = Math.hypot(worldPos.x - p.x, worldPos.y - p.y);
      if (d < minDist) {
        minDist = d;
        best = {
          x: p.x,
          y: p.y,
          road: road,
          pointIdx: i,
          type: (i === 0 || i === pts.length - 1) ? 'endpoint' : 'node',
          roadName: road.name || prof.name
        };
      }
    }

    // Check along segments
    for (let i = 0; i < pts.length - 1; i++) {
      const pA = pts[i];
      const pB = pts[i + 1];
      const l2 = (pB.x - pA.x)**2 + (pB.y - pA.y)**2;
      if (l2 < 1) continue;
      let t = ((worldPos.x - pA.x) * (pB.x - pA.x) + (worldPos.y - pA.y) * (pB.y - pA.y)) / l2;
      t = Math.max(0, Math.min(1, t));
      const projX = pA.x + t * (pB.x - pA.x);
      const projY = pA.y + t * (pB.y - pA.y);
      const d = Math.hypot(worldPos.x - projX, worldPos.y - projY);
      if (d < minDist) {
        minDist = d;
        best = {
          x: projX,
          y: projY,
          road: road,
          segIdx: i,
          progress: t,
          type: 'segment',
          roadName: road.name || prof.name
        };
      }
    }
  }

  return best;
}

function findConnectedRoadAt(x, y, currentRoad, threshold = 55) {
  if (!currentRoad) return null;
  const currentElev = ROAD_PROFILES[currentRoad.type]?.elevation || 0;
  const currentProf = ROAD_PROFILES[currentRoad.type] || ROAD_PROFILES['highway-twin'];
  const connections = [];

  for (const road of cad.roads) {
    if (road === currentRoad || road.id === currentRoad.id) continue;
    const prof = ROAD_PROFILES[road.type];
    if ((prof?.elevation || 0) !== currentElev) continue;

    const pts = getSampledRoadPoints(road);
    if (!pts || pts.length < 2) continue;

    const maxDist = Math.max(threshold, (prof.width + currentProf.width) * 0.7);

    for (let i = 0; i < pts.length - 1; i++) {
      const pA = pts[i];
      const pB = pts[i + 1];
      const l2 = (pB.x - pA.x)**2 + (pB.y - pA.y)**2;
      if (l2 < 0.1) continue;

      let t = ((x - pA.x) * (pB.x - pA.x) + (y - pA.y) * (pB.y - pA.y)) / l2;
      t = Math.max(0, Math.min(1, t));
      const px = pA.x + t * (pB.x - pA.x);
      const py = pA.y + t * (pB.y - pA.y);
      const d = Math.hypot(x - px, y - py);

      if (d <= maxDist) {
        connections.push({
          road: road,
          segIdx: i,
          progress: t,
          dist: d,
          point: { x: px, y: py }
        });
      }
    }
  }

  connections.sort((a, b) => a.dist - b.dist);
  return connections.length > 0 ? connections[0] : null;
}

function findNetworkJunctions() {
  const junctions = [];
  const groundRoads = cad.roads.filter(r => (ROAD_PROFILES[r.type]?.elevation || 0) === 0);

  for (let i = 0; i < groundRoads.length; i++) {
    const rA = groundRoads[i];
    const profA = ROAD_PROFILES[rA.type] || ROAD_PROFILES['highway-twin'];
    const ptsA = getSampledRoadPoints(rA);
    if (!ptsA || ptsA.length < 2) continue;

    const endpoints = [
      { ep: ptsA[0], prev: ptsA[1], isStart: true },
      { ep: ptsA[ptsA.length - 1], prev: ptsA[ptsA.length - 2], isStart: false }
    ];

    for (let j = 0; j < groundRoads.length; j++) {
      if (i === j) continue;
      const rB = groundRoads[j];
      const profB = ROAD_PROFILES[rB.type] || ROAD_PROFILES['highway-twin'];
      const ptsB = getSampledRoadPoints(rB);
      if (!ptsB || ptsB.length < 2) continue;

      const connThreshold = Math.max(36, (profA.width + profB.width) * 0.7);

      for (const { ep, prev, isStart } of endpoints) {
        for (let s = 0; s < ptsB.length - 1; s++) {
          const pA = ptsB[s];
          const pB = ptsB[s + 1];
          const l2 = (pB.x - pA.x)**2 + (pB.y - pA.y)**2;
          if (l2 < 0.1) continue;

          let t = ((ep.x - pA.x) * (pB.x - pA.x) + (ep.y - pA.y) * (pB.y - pA.y)) / l2;
          t = Math.max(0, Math.min(1, t));
          const projX = pA.x + t * (pB.x - pA.x);
          const projY = pA.y + t * (pB.y - pA.y);
          const d = Math.hypot(ep.x - projX, ep.y - projY);

          if (d <= connThreshold) {
            // Tangent direction of road A arriving at junction
            const adx = isStart ? (prev.x - ep.x) : (ep.x - prev.x);
            const ady = isStart ? (prev.y - ep.y) : (ep.y - prev.y);
            const alen = Math.hypot(adx, ady) || 1;
            const uDirA = { x: adx / alen, y: ady / alen };
            const uNormA = { x: -uDirA.y, y: uDirA.x };

            // Direction of road B
            const bdx = pB.x - pA.x;
            const bdy = pB.y - pA.y;
            const blen = Math.hypot(bdx, bdy) || 1;
            const uDirB = { x: bdx / blen, y: bdy / blen };
            const uNormB = { x: -uDirB.y, y: uDirB.x };

            // Side of road B that road A is arriving on
            const sideB = ((ep.x - projX) * uNormB.x + (ep.y - projY) * uNormB.y >= 0) ? 1 : -1;

            junctions.push({
              roadA: rA,
              roadB: rB,
              isStart,
              ep,
              connPt: { x: projX, y: projY },
              uDirA,
              uNormA,
              uDirB,
              uNormB,
              sideB,
              profA,
              profB,
              asphaltColor: profA.asphaltColor || '#27272a'
            });
            break;
          }
        }
      }
    }
  }

  return junctions;
}

// -------------------------------------------------------------
// History Management
// -------------------------------------------------------------
function pushHistoryState() {
  cad.undoStack.push({
    roads: JSON.parse(JSON.stringify(cad.roads)),
    equipments: JSON.parse(JSON.stringify(cad.equipments))
  });
  if (cad.undoStack.length > 50) cad.undoStack.shift();
  cad.redoStack = [];
}

function undo() {
  if (cad.undoStack.length === 0) return;
  cad.redoStack.push({
    roads: JSON.parse(JSON.stringify(cad.roads)),
    equipments: JSON.parse(JSON.stringify(cad.equipments))
  });
  const prev = cad.undoStack.pop();
  cad.roads = prev.roads;
  cad.equipments = prev.equipments;
  cad.selectedRoad = null;
  cad.activePoints = [];
  rebuildTraffic();
  updateInfrastructureStats();
  render();
}

function redo() {
  if (cad.redoStack.length === 0) return;
  cad.undoStack.push({
    roads: JSON.parse(JSON.stringify(cad.roads)),
    equipments: JSON.parse(JSON.stringify(cad.equipments))
  });
  const next = cad.redoStack.pop();
  cad.roads = next.roads;
  cad.equipments = next.equipments;
  rebuildTraffic();
  updateInfrastructureStats();
  render();
}

function rebuildTraffic() {
  cad.cars = [];
  for (const r of cad.roads) {
    delete r._cachedSampled;
    spawnRealisticCars(r);
  }
}

// -------------------------------------------------------------
// Inter-Road Traffic Routing: Vehicles Transfer Between Connected Roads
// -------------------------------------------------------------
function handleCarReachingRoadBoundary(car, boundaryType) {
  const conn = findConnectedRoadAt(car.x, car.y, car.road);
  if (conn) {
    const targetRoad = conn.road;
    const targetProf = ROAD_PROFILES[targetRoad.type] || ROAD_PROFILES['highway-twin'];
    const numLanes = targetProf.lanes || 4;
    const lw = targetProf.width / numLanes;
    const isTwoWay = (targetRoad.direction !== 'one-way');

    const origRoad = car.road;
    // Transfer car to the connected road
    car.road = targetRoad;
    car.segIdx = conn.segIdx;
    car.progress = conn.progress;

    // Check custom lane links configured by the user
    let chosenTargetLane = null;
    if (origRoad.laneLinks && origRoad.laneLinks.length > 0) {
      const origProf = ROAD_PROFILES[origRoad.type] || ROAD_PROFILES['highway-twin'];
      const origLanes = origProf.lanes || 4;
      const origLw = origProf.width / origLanes;
      const derivedFrom = Math.max(0, Math.min(origLanes - 1, Math.round((car.laneOffset / origLw) + (origLanes - 1) / 2)));
      const link = origRoad.laneLinks.find(l => l.targetRoadId === targetRoad.id && (l.fromLane === derivedFrom || l.fromLane === car.laneIndex));
      if (link && link.toLane !== undefined && link.toLane >= 0) {
        chosenTargetLane = link.toLane;
      }
    }

    if (chosenTargetLane !== null) {
      car.laneIndex = chosenTargetLane;
      car.laneOffset = (chosenTargetLane - (numLanes - 1) / 2) * lw;
      if (isTwoWay) {
        car.dir = (chosenTargetLane >= numLanes / 2) ? 1 : -1;
      } else {
        car.dir = 1;
      }
    } else {
      // Determine direction on target road by default heuristics
      if (isTwoWay) {
        if (conn.progress < 0.25) {
          car.dir = 1;
        } else if (conn.progress > 0.75) {
          car.dir = -1;
        } else {
          car.dir = Math.random() < 0.5 ? 1 : -1;
        }
        if (numLanes === 4) {
          const laneIdx = Math.floor(Math.random() * 2);
          car.laneOffset = (car.dir === 1) ? (0.5 + laneIdx) * lw : -(0.5 + laneIdx) * lw;
        } else {
          car.laneOffset = (car.dir === 1) ? 0.5 * lw : -0.5 * lw;
        }
      } else {
        car.dir = 1;
        const laneIdx = Math.floor(Math.random() * numLanes);
        car.laneOffset = (laneIdx - (numLanes - 1) / 2) * lw;
      }
    }

    // Nudge car into movement direction so it cleanly enters the new road
    car.progress = Math.max(0.02, Math.min(0.98, car.progress + (car.dir * 0.04)));
    car.lastTransferTime = Date.now();

    // Smooth angle turn into new road
    const targetPts = getSampledRoadPoints(targetRoad);
    const nA = targetPts[conn.segIdx] || targetPts[0];
    const nB = targetPts[conn.segIdx + 1] || targetPts[1];
    if (nA && nB) {
      const targetVec = { x: nB.x - nA.x, y: nB.y - nA.y };
      const baseAngle = Math.atan2(targetVec.y, targetVec.x);
      car.targetAngle = (car.dir === -1) ? (baseAngle + Math.PI) : baseAngle;
    }
  } else {
    // Dead end with no connection: U-turn!
    car.dir *= -1;
    car.laneOffset = -car.laneOffset;
    car.progress = (boundaryType === 'end') ? 0.98 : 0.02;
    car.lastTransferTime = Date.now();
  }
}

function checkMidRoadJunctionTurn(car, curX, curY) {
  if (Date.now() - (car.lastTransferTime || 0) < 6000) return;
  const currentElev = ROAD_PROFILES[car.road.type]?.elevation || 0;

  for (const otherRoad of cad.roads) {
    if (otherRoad === car.road) continue;
    const otherProf = ROAD_PROFILES[otherRoad.type];
    if ((otherProf?.elevation || 0) !== currentElev) continue;

    const oPts = getSampledRoadPoints(otherRoad);
    if (!oPts || oPts.length < 2) continue;

    const threshold = 34;
    const dStart = Math.hypot(curX - oPts[0].x, curY - oPts[0].y);
    const dEnd = Math.hypot(curX - oPts[oPts.length - 1].x, curY - oPts[oPts.length - 1].y);

    let targetEnd = null;
    if (dStart < threshold) targetEnd = 'start';
    else if (dEnd < threshold) targetEnd = 'end';

    if (targetEnd && Math.random() < 0.35) {
      car.road = otherRoad;
      const numLanes = otherProf.lanes || 4;
      const lw = otherProf.width / numLanes;
      const isTwoWay = (otherRoad.direction !== 'one-way');

      if (targetEnd === 'start') {
        car.segIdx = 0;
        car.progress = 0.04;
        car.dir = 1;
        car.laneOffset = isTwoWay ? 0.5 * lw : 0;
        const nA = oPts[0], nB = oPts[1];
        car.targetAngle = Math.atan2(nB.y - nA.y, nB.x - nA.x);
      } else {
        car.segIdx = Math.max(0, oPts.length - 2);
        car.progress = 0.96;
        car.dir = -1;
        car.laneOffset = isTwoWay ? -0.5 * lw : 0;
        const nA = oPts[car.segIdx], nB = oPts[car.segIdx + 1];
        car.targetAngle = Math.atan2(nA.y - nB.y, nA.x - nB.x);
      }
      car.lastTransferTime = Date.now();
      break;
    }
  }
}

// -------------------------------------------------------------
// Real-Time Traffic Simulation with Lights & Speed Bumps Physics
// -------------------------------------------------------------
function updateSimulation() {
  const now = Date.now();

  // 1. Update Traffic Lights Countdown Timer with INDIVIDUAL durations
  for (const eq of cad.equipments) {
    if (eq.type === 'traffic-light') {
      if (!eq.phaseStartTime) eq.phaseStartTime = now;
      const elapsed = (now - eq.phaseStartTime) / 1000;
      const gPeriod = eq.greenDuration || eq.duration || cad.signalTimerSeconds || 8;
      const rPeriod = eq.redDuration || eq.duration || cad.signalTimerSeconds || 8;
      const yPeriod = eq.yellowDuration || 2.5;

      if (eq.state === 'green') {
        eq.timer = Math.max(0, Math.ceil(gPeriod - elapsed));
        if (elapsed >= gPeriod) {
          eq.state = 'yellow';
          eq.phaseStartTime = now;
          eq.timer = Math.ceil(yPeriod);
        }
      } else if (eq.state === 'yellow') {
        eq.timer = Math.max(0, Math.ceil(yPeriod - elapsed));
        if (elapsed >= yPeriod) {
          eq.state = 'red';
          eq.phaseStartTime = now;
          eq.timer = Math.ceil(rPeriod);
        }
      } else { // red
        eq.timer = Math.max(0, Math.ceil(rPeriod - elapsed));
        if (elapsed >= rPeriod) {
          eq.state = 'green';
          eq.phaseStartTime = now;
          eq.timer = Math.ceil(gPeriod);
        }
      }
    }
  }

  // 2. Realistic Vehicle Physics: Speed, Full Stop at Red Lights & Queueing
  for (let ci = 0; ci < cad.cars.length; ci++) {
    const car = cad.cars[ci];
    const pts = getSampledRoadPoints(car.road);
    if (!pts || pts.length < 2) continue;

    if (car.segIdx >= pts.length - 1) {
      car.segIdx = Math.max(0, pts.length - 2);
    }
    const pA = pts[car.segIdx];
    const pB = pts[car.segIdx + 1];
    if (!pA || !pB) continue;

    const segVec = { x: pB.x - pA.x, y: pB.y - pA.y };
    const segDist = Math.hypot(segVec.x, segVec.y);
    if (segDist < 0.1) continue;
    const uDir = { x: segVec.x / segDist, y: segVec.y / segDist };
    const uNorm = { x: -uDir.y, y: uDir.x };

    // Centerline point along segment
    const cx = pA.x + segVec.x * car.progress;
    const cy = pA.y + segVec.y * car.progress;

    // Actual vehicle position taking lane offset into account
    const curX = cx + uNorm.x * (car.laneOffset || 0);
    const curY = cy + uNorm.y * (car.laneOffset || 0);
    car.x = curX;
    car.y = curY;

    // Heading angle: smooth turning interpolation when changing roads
    const segAngle = Math.atan2(segVec.y, segVec.x);
    const nominalAngle = (car.dir === -1) ? (segAngle + Math.PI) : segAngle;

    if (car.targetAngle !== undefined) {
      let diff = car.targetAngle - (car.angle || nominalAngle);
      while (diff < -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      if (Math.abs(diff) > 0.05) {
        car.angle = (car.angle || nominalAngle) + diff * 0.22;
      } else {
        car.angle = nominalAngle;
        delete car.targetAngle;
      }
    } else {
      car.angle = nominalAngle;
    }

    // Movement unit vector
    const moveDir = { x: uDir.x * (car.dir || 1), y: uDir.y * (car.dir || 1) };

    let targetSpeed = car.baseSpeed * cad.speedMultiplier;
    car.isBraking = false;
    const roadElev = ROAD_PROFILES[car.road.type]?.elevation || 0;

    // A) Interaction with Traffic Lights: 100% COMPLETE STOP AT RED/YELLOW
    for (const eq of cad.equipments) {
      if (eq.type === 'traffic-light') {
        // Only ground roads react to ground traffic lights
        if (roadElev > 0) continue;

        // Check if light is targeted to specific lane/direction
        const tLane = eq.targetLane || 'all';
        if (tLane === 'right' && (car.dir === -1 || (car.laneOffset || 0) < 0)) continue;
        if (tLane === 'left' && (car.dir === 1 || (car.laneOffset || 0) > 0)) continue;

        const toLight = { x: eq.x - curX, y: eq.y - curY };
        const alongDist = toLight.x * moveDir.x + toLight.y * moveDir.y;
        const crossDist = Math.abs(-toLight.x * moveDir.y + toLight.y * moveDir.x);

        // Within 32 meters laterally
        if (crossDist <= 32) {
          if (eq.state === 'red' || eq.state === 'yellow') {
            // Approaching red light (10m to 70m ahead) -> decelerate smoothly
            if (alongDist > 10 && alongDist <= 70) {
              const brakeFactor = Math.max(0, (alongDist - 10) / 60);
              targetSpeed = Math.min(targetSpeed, brakeFactor * car.baseSpeed * cad.speedMultiplier * 0.4);
              car.isBraking = true;
            } 
            // Reached stop line before light -> TOTAL COMPLETE STOP!
            else if (alongDist <= 10 && alongDist >= -8) {
              targetSpeed = 0;
              car.currentSpeed = 0; // FULL STOP: velocity is strictly 0!
              car.isBraking = true;
            }
          }
        }
      }
    }

    // B) Interaction with Speed Bumps (Lombadas): Smooth Braking and Crawl
    for (const eq of cad.equipments) {
      if (eq.type === 'speed-bump') {
        if (roadElev > 0) continue;

        // Check if bump is targeted to specific lane/direction
        const tLane = eq.targetLane || 'all';
        if (tLane === 'right' && (car.dir === -1 || (car.laneOffset || 0) < 0)) continue;
        if (tLane === 'left' && (car.dir === 1 || (car.laneOffset || 0) > 0)) continue;

        const toBump = { x: eq.x - curX, y: eq.y - curY };
        const alongDist = toBump.x * moveDir.x + toBump.y * moveDir.y;
        const crossDist = Math.abs(-toBump.x * moveDir.y + toBump.y * moveDir.x);

        if (crossDist <= 26 && alongDist > -10 && alongDist < 40) {
          if (alongDist > 8) {
            targetSpeed = Math.min(targetSpeed, 0.45 * cad.speedMultiplier);
            car.isBraking = true;
          } else {
            targetSpeed = Math.min(targetSpeed, 0.22 * cad.speedMultiplier);
            car.isBraking = true;
          }
        }
      }
    }

    // C) Vehicle-to-Vehicle Queueing & Intersection Yielding
    for (let oj = 0; oj < cad.cars.length; oj++) {
      if (oj === ci) continue;
      const otherCar = cad.cars[oj];

      // Cross-traffic check at intersections: don't collide with vehicles on crossing roads!
      if (otherCar.road !== car.road) {
        const toOther = { x: otherCar.x - curX, y: otherCar.y - curY };
        const oDist = Math.hypot(toOther.x, toOther.y);
        const oAlong = toOther.x * moveDir.x + toOther.y * moveDir.y;
        if (oDist < 22 && oAlong > 0) {
          targetSpeed = Math.min(targetSpeed, 0.15);
          car.isBraking = true;
        }
        continue;
      }

      if (otherCar.dir !== car.dir) continue; // Cars in opposite direction do not block each other!

      // Same or adjacent lane check
      const laneDiff = Math.abs((otherCar.laneOffset || 0) - (car.laneOffset || 0));
      if (laneDiff > 7) continue;

      const toOther = { x: otherCar.x - curX, y: otherCar.y - curY };
      const oAlong = toOther.x * moveDir.x + toOther.y * moveDir.y;
      const oCross = Math.abs(-toOther.x * moveDir.y + toOther.y * moveDir.x);

      // In front of this vehicle in the same lane
      if (oCross < 6 && oAlong > 0 && oAlong < 45) {
        if (oAlong <= 18) {
          targetSpeed = 0;
          if (otherCar.currentSpeed < 0.2) {
            car.currentSpeed = 0; // TOTAL STOP in traffic queue behind car in front!
          }
          car.isBraking = true;
        } else if (oAlong < 36) {
          targetSpeed = Math.min(targetSpeed, otherCar.currentSpeed * 0.7);
          car.isBraking = true;
        }
      }
    }

    // Smooth physics integration
    if (targetSpeed === 0) {
      car.currentSpeed = Math.max(0, car.currentSpeed - 0.15);
      if (car.currentSpeed < 0.04) car.currentSpeed = 0;
    } else {
      car.currentSpeed += (targetSpeed - car.currentSpeed) * 0.12;
    }

    // Advance vehicle position according to its direction (1 = forward, -1 = reverse)
    if (car.currentSpeed > 0.0001) {
      if (car.dir === -1) {
        car.progress -= car.currentSpeed / segDist;
        if (car.progress <= 0) {
          if (car.segIdx > 0) {
            car.segIdx--;
            car.progress = 1;
          } else {
            // Reached start of this road: transfer to connected road or U-turn!
            handleCarReachingRoadBoundary(car, 'start');
          }
        }
      } else {
        car.progress += car.currentSpeed / segDist;
        if (car.progress >= 1) {
          if (car.segIdx < pts.length - 2) {
            car.segIdx++;
            car.progress = 0;
          } else {
            // Reached end of this road: transfer to connected road or U-turn!
            handleCarReachingRoadBoundary(car, 'end');
          }
        }
      }

      // Allow vehicles along the road to turn into connected side streets!
      checkMidRoadJunctionTurn(car, curX, curY);
    }
  }

  // Update selected traffic light live timer readout if open
  if (cad.selectedEquip && cad.selectedEquip.type === 'traffic-light') {
    const lenEl = document.getElementById('sel-len');
    if (lenEl) {
      const stateName = cad.selectedEquip.state === 'green' ? 'VERDE' : (cad.selectedEquip.state === 'red' ? 'VERMELHO' : 'AMARELO');
      lenEl.innerText = `Fase Atual: ${stateName} (${cad.selectedEquip.timer}s restantes)`;
    }
  }

  render();
  requestAnimationFrame(updateSimulation);
}

// -------------------------------------------------------------
// Rendering Pipeline: Realistic Graphics & Day/Night Atmosphere
// -------------------------------------------------------------
function render() {
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.translate(cad.panX, cad.panY);
  ctx.scale(cad.zoom, cad.zoom);

  // 1. Terrain
  drawRealisticTerrain();

  // 2. All Ground Road Shoulders / Sidewalks (drawn first so they never overlap asphalt!)
  for (const road of cad.roads) {
    if ((ROAD_PROFILES[road.type]?.elevation || 0) === 0) drawRoadShoulders(road);
  }

  // 3. All Ground Road Asphalt Surfaces (drawn together so they merge seamlessly!)
  for (const road of cad.roads) {
    if ((ROAD_PROFILES[road.type]?.elevation || 0) === 0) drawRoadAsphalt(road);
  }

  // 4. Ground Road Junction Aprons (smooth intersection curves and fills!)
  drawJunctionAprons();

  // 5. All Ground Road Markings & Lane Dividers
  for (const road of cad.roads) {
    if ((ROAD_PROFILES[road.type]?.elevation || 0) === 0) drawRoadMarkings(road);
  }

  // 6. Elevated Viaducts (Level +1 with 3D Shadow and Pillars)
  for (const road of cad.roads) {
    if ((ROAD_PROFILES[road.type]?.elevation || 0) > 0) drawRealisticRoad(road);
  }

  // 4. Urban Equipments (Lights, Traffic Lights, Speed Bumps)
  drawEquipments();

  // 5. Vehicles
  drawRealisticVehicles();

  // 6. Night Ambient Darkness Overlay & Street Illumination Cones!
  if (cad.isNight) {
    drawNightAtmosphereAndLighting();
  }

  // 7. Active Drawing Preview
  drawLiveConstructionPreview();

  // 8. Edit Nodes & Selection
  drawEditNodesAndSelection();

  ctx.restore();
  updateHud();
}

function drawRealisticTerrain() {
  if (cad.mapMode === 'cad') {
    ctx.fillStyle = cad.isNight ? '#0b0f14' : '#262c33';
    ctx.fillRect(-3000, -3000, 6000, 6000);

    // Subtle grid
    ctx.beginPath();
    ctx.strokeStyle = cad.isNight ? 'rgba(255,255,255,0.015)' : 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1 / cad.zoom;
    for (let x = -2000; x <= 2000; x += 60) {
      ctx.moveTo(x, -2000); ctx.lineTo(x, 2000);
    }
    for (let y = -2000; y <= 2000; y += 60) {
      ctx.moveTo(-2000, y); ctx.lineTo(2000, y);
    }
    ctx.stroke();
  } else {
    // In Satellite or Streets mode: leave canvas transparent so real map shines through!
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1 / cad.zoom;
    for (let x = -2000; x <= 2000; x += 100) {
      ctx.moveTo(x, -2000); ctx.lineTo(x, 2000);
    }
    for (let y = -2000; y <= 2000; y += 100) {
      ctx.moveTo(-2000, y); ctx.lineTo(2000, y);
    }
    ctx.stroke();
  }
}

function tracePoints(pts) {
  if (!pts || pts.length === 0) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i].x, pts[i].y);
  }
}

function traceOffsetPoints(pts, offsetDist) {
  if (!pts || pts.length < 2) return;
  const offPts = [];

  for (let i = 0; i < pts.length; i++) {
    let nx = 0, ny = 0;
    if (i === 0) {
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      const d = Math.hypot(dx, dy) || 1;
      nx = -dy / d; ny = dx / d;
    } else if (i === pts.length - 1) {
      const dx = pts[i].x - pts[i - 1].x;
      const dy = pts[i].y - pts[i - 1].y;
      const d = Math.hypot(dx, dy) || 1;
      nx = -dy / d; ny = dx / d;
    } else {
      const dx = pts[i + 1].x - pts[i - 1].x;
      const dy = pts[i + 1].y - pts[i - 1].y;
      const d = Math.hypot(dx, dy) || 1;
      nx = -dy / d; ny = dx / d;
    }
    offPts.push({ x: pts[i].x + nx * offsetDist, y: pts[i].y + ny * offsetDist });
  }

  tracePoints(offPts);
}

function getTrimmedPoints(pts, trimStartDist, trimEndDist) {
  if (!pts || pts.length < 2) return pts;
  let newPts = pts.map(p => ({ x: p.x, y: p.y }));

  if (trimStartDist > 0) {
    let remaining = trimStartDist;
    while (newPts.length >= 2 && remaining > 0) {
      const segLen = dist(newPts[0], newPts[1]);
      if (segLen <= remaining) {
        remaining -= segLen;
        newPts.shift();
      } else {
        const t = remaining / segLen;
        newPts[0] = {
          x: newPts[0].x + (newPts[1].x - newPts[0].x) * t,
          y: newPts[0].y + (newPts[1].y - newPts[0].y) * t
        };
        remaining = 0;
      }
    }
  }

  if (trimEndDist > 0) {
    let remaining = trimEndDist;
    while (newPts.length >= 2 && remaining > 0) {
      const last = newPts.length - 1;
      const segLen = dist(newPts[last - 1], newPts[last]);
      if (segLen <= remaining) {
        remaining -= segLen;
        newPts.pop();
      } else {
        const t = 1 - (remaining / segLen);
        newPts[last] = {
          x: newPts[last - 1].x + (newPts[last].x - newPts[last - 1].x) * t,
          y: newPts[last - 1].y + (newPts[last].y - newPts[last - 1].y) * t
        };
        remaining = 0;
      }
    }
  }

  return newPts.length >= 2 ? newPts : pts;
}

function getRoadJunctionTrim(road) {
  const sampledPts = getSampledRoadPoints(road);
  let trimStart = 0;
  let trimEnd = 0;
  let trimAsphaltStart = 0;
  let trimAsphaltEnd = 0;
  let trimMarkingsStart = 0;
  let trimMarkingsEnd = 0;
  let trimMedianStart = 0;
  let trimMedianEnd = 0;
  let startTargetRoad = null;
  let endTargetRoad = null;

  if (sampledPts && sampledPts.length >= 2) {
    const connStart = findConnectedRoadAt(sampledPts[0].x, sampledPts[0].y, road, 55);
    if (connStart) {
      const targetProf = ROAD_PROFILES[connStart.road.type] || ROAD_PROFILES['highway-twin'];
      trimAsphaltStart = targetProf.width * 0.5;
      trimStart = targetProf.width * 0.5 + (targetProf.shoulderWidth || 6) * 0.8;
      trimMarkingsStart = targetProf.width * 0.5 + 2;
      trimMedianStart = targetProf.width * 0.5 + 14;
      startTargetRoad = connStart.road;
    }

    const connEnd = findConnectedRoadAt(sampledPts[sampledPts.length - 1].x, sampledPts[sampledPts.length - 1].y, road, 55);
    if (connEnd) {
      const targetProf = ROAD_PROFILES[connEnd.road.type] || ROAD_PROFILES['highway-twin'];
      trimAsphaltEnd = targetProf.width * 0.5;
      trimEnd = targetProf.width * 0.5 + (targetProf.shoulderWidth || 6) * 0.8;
      trimMarkingsEnd = targetProf.width * 0.5 + 2;
      trimMedianEnd = targetProf.width * 0.5 + 14;
      endTargetRoad = connEnd.road;
    }
  }

  return {
    trimStart, trimEnd,
    trimAsphaltStart, trimAsphaltEnd,
    trimMarkingsStart, trimMarkingsEnd,
    trimMedianStart, trimMedianEnd,
    startTargetRoad, endTargetRoad
  };
}

function drawRoadShoulders(road) {
  const sampledPts = getSampledRoadPoints(road);
  if (!sampledPts || sampledPts.length < 2) return;
  const prof = ROAD_PROFILES[road.type] || ROAD_PROFILES['highway-twin'];
  if (!prof.hasShoulder) return;

  const trim = getRoadJunctionTrim(road);
  const drawPts = (trim.trimStart > 0 || trim.trimEnd > 0)
    ? getTrimmedPoints(sampledPts, trim.trimStart, trim.trimEnd)
    : sampledPts;

  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = cad.isNight ? '#3d342c' : prof.shoulderColor;
  ctx.lineWidth = prof.width + prof.shoulderWidth * 2;
  ctx.lineCap = 'butt'; // CORTE RETO LIMPO!
  ctx.lineJoin = 'round';
  tracePoints(drawPts);
  ctx.stroke();
  ctx.restore();
}

function drawRoadAsphalt(road) {
  const sampledPts = getSampledRoadPoints(road);
  if (!sampledPts || sampledPts.length < 2) return;
  const prof = ROAD_PROFILES[road.type] || ROAD_PROFILES['highway-twin'];

  const trim = getRoadJunctionTrim(road);
  const drawPts = (trim.trimAsphaltStart > 0 || trim.trimAsphaltEnd > 0)
    ? getTrimmedPoints(sampledPts, trim.trimAsphaltStart, trim.trimAsphaltEnd)
    : sampledPts;

  ctx.save();
  // Guardrail / Guias de Borda
  ctx.beginPath();
  ctx.strokeStyle = '#1e2229';
  ctx.lineWidth = prof.width + 3;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  tracePoints(drawPts);
  ctx.stroke();

  // Asphalt Surface
  ctx.beginPath();
  ctx.strokeStyle = cad.isNight ? '#1b2028' : prof.asphaltColor;
  ctx.lineWidth = prof.width;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  tracePoints(drawPts);
  ctx.stroke();
  ctx.restore();
}

function drawCornerFillet(cornerPt, uDirA, uNormA, uDirB, uNormB, cornerSign, R, profA, profB) {
  const pRoadA = {
    x: cornerPt.x - uDirA.x * R,
    y: cornerPt.y - uDirA.y * R
  };

  const dotB = uNormA.x * uDirB.x + uNormA.y * uDirB.y;
  const dirB_Sign = (cornerSign * dotB >= 0) ? 1 : -1;

  const pRoadB = {
    x: cornerPt.x + uDirB.x * (dirB_Sign * R),
    y: cornerPt.y + uDirB.y * (dirB_Sign * R)
  };

  // 1. Asphalt blend in corner fillet
  ctx.beginPath();
  ctx.fillStyle = cad.isNight ? '#1b2028' : (profA.asphaltColor || '#27272a');
  ctx.moveTo(cornerPt.x, cornerPt.y);
  ctx.lineTo(pRoadA.x, pRoadA.y);
  ctx.quadraticCurveTo(cornerPt.x, cornerPt.y, pRoadB.x, pRoadB.y);
  ctx.closePath();
  ctx.fill();

  // 2. Concrete curb guide along fillet curve
  ctx.beginPath();
  ctx.strokeStyle = '#1e2229';
  ctx.lineWidth = 2.5 / cad.zoom;
  ctx.moveTo(pRoadA.x, pRoadA.y);
  ctx.quadraticCurveTo(cornerPt.x, cornerPt.y, pRoadB.x, pRoadB.y);
  ctx.stroke();
}

function drawJunctionAprons() {
  const junctions = findNetworkJunctions();
  if (!junctions || junctions.length === 0) return;

  for (const j of junctions) {
    const { roadA, roadB, ep, connPt, uDirA, uNormA, uDirB, uNormB, sideB, profA, profB } = j;
    if (!uDirA || !uDirB) continue;

    const wA = profA.width;
    const wB = profB.width;

    // Center point of the curb line of Road B where Road A connects
    const curbPtB = {
      x: connPt.x + uNormB.x * (sideB * wB * 0.5),
      y: connPt.y + uNormB.y * (sideB * wB * 0.5)
    };

    // Mouth corners of Road A
    const cornerL = { x: curbPtB.x - uNormA.x * (wA * 0.5), y: curbPtB.y - uNormA.y * (wA * 0.5) };
    const cornerR = { x: curbPtB.x + uNormA.x * (wA * 0.5), y: curbPtB.y + uNormA.y * (wA * 0.5) };

    // Fused asphalt mouth trapezoid
    ctx.save();
    ctx.beginPath();
    ctx.fillStyle = cad.isNight ? '#1b2028' : (profA.asphaltColor || '#27272a');
    ctx.moveTo(cornerL.x, cornerL.y);
    ctx.lineTo(cornerR.x, cornerR.y);
    ctx.lineTo(cornerR.x - uDirA.x * 6, cornerR.y - uDirA.y * 6);
    ctx.lineTo(cornerL.x - uDirA.x * 6, cornerL.y - uDirA.y * 6);
    ctx.closePath();
    ctx.fill();

    // Corner Curb Returns (Curvas de Concordância)
    const R = Math.min(20, Math.max(12, wA * 0.35));

    drawCornerFillet(cornerL, uDirA, uNormA, uDirB, uNormB, -1, R, profA, profB);
    drawCornerFillet(cornerR, uDirA, uNormA, uDirB, uNormB, 1, R, profA, profB);

    ctx.restore();
  }
}

function drawStopBars(road, markingsPts, trim) {
  const prof = ROAD_PROFILES[road.type] || ROAD_PROFILES['highway-twin'];
  const isTwoWay = (road.direction !== 'one-way');

  const renderBarAt = (pEnd, pPrev, isEndConn) => {
    const dx = pEnd.x - pPrev.x, dy = pEnd.y - pPrev.y;
    const len = Math.hypot(dx, dy) || 1;
    const uDir = { x: dx / len, y: dy / len };
    const uNorm = { x: -uDir.y, y: uDir.x };

    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3.6 / cad.zoom;
    ctx.lineCap = 'butt';
    ctx.beginPath();

    if (isTwoWay) {
      // Incoming lanes (ida em direção à via destino)
      const startOff = prof.hasMedian ? 5.2 : 1.0;
      const endOff = prof.width / 2 - 2.5;
      ctx.moveTo(pEnd.x + uNorm.x * startOff, pEnd.y + uNorm.y * startOff);
      ctx.lineTo(pEnd.x + uNorm.x * endOff, pEnd.y + uNorm.y * endOff);
    } else {
      const startOff = -prof.width / 2 + 2.5;
      const endOff = prof.width / 2 - 2.5;
      ctx.moveTo(pEnd.x + uNorm.x * startOff, pEnd.y + uNorm.y * startOff);
      ctx.lineTo(pEnd.x + uNorm.x * endOff, pEnd.y + uNorm.y * endOff);
    }
    ctx.stroke();
    ctx.restore();
  };

  if (trim.trimMarkingsEnd > 0 && markingsPts.length >= 2) {
    renderBarAt(markingsPts[markingsPts.length - 1], markingsPts[markingsPts.length - 2], true);
  }
  if (trim.trimMarkingsStart > 0 && markingsPts.length >= 2) {
    renderBarAt(markingsPts[0], markingsPts[1], false);
  }
}

function drawMedianNoses(road, medianPts, trim) {
  if (!medianPts || medianPts.length < 2) return;

  const drawSingleNose = (nosePt, prevPt) => {
    const dx = nosePt.x - prevPt.x;
    const dy = nosePt.y - prevPt.y;
    const d = Math.hypot(dx, dy) || 1;
    const uDir = { x: dx / d, y: dy / d };
    const uNorm = { x: -uDir.y, y: uDir.x };
    const noseAngle = Math.atan2(uDir.y, uDir.x);

    ctx.save();
    // Rounded green island nose
    ctx.beginPath();
    ctx.fillStyle = '#15803d';
    ctx.arc(nosePt.x, nosePt.y, 4.2, noseAngle - Math.PI / 2, noseAngle + Math.PI / 2);
    ctx.closePath();
    ctx.fill();

    // Yellow curb border
    ctx.beginPath();
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 2.0 / cad.zoom;
    ctx.arc(nosePt.x, nosePt.y, 4.2, noseAngle - Math.PI / 2, noseAngle + Math.PI / 2);
    ctx.stroke();

    // Yellow chevron markings (zebrado canalizador)
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 1.6 / cad.zoom;
    for (let k = 1; k <= 3; k++) {
      const pC = { x: nosePt.x + uDir.x * (k * 3.5), y: nosePt.y + uDir.y * (k * 3.5) };
      ctx.beginPath();
      ctx.moveTo(pC.x - uNorm.x * 3.6, pC.y - uNorm.y * 3.6);
      ctx.lineTo(pC.x + uNorm.x * 3.6, pC.y + uNorm.y * 3.6);
      ctx.stroke();
    }
    ctx.restore();
  };

  if (trim.trimMedianEnd > 0) {
    drawSingleNose(medianPts[medianPts.length - 1], medianPts[medianPts.length - 2]);
  }
  if (trim.trimMedianStart > 0) {
    drawSingleNose(medianPts[0], medianPts[1]);
  }
}

function drawRoadMarkings(road) {
  const sampledPts = getSampledRoadPoints(road);
  if (!sampledPts || sampledPts.length < 2) return;
  const prof = ROAD_PROFILES[road.type] || ROAD_PROFILES['highway-twin'];
  const isTwoWay = (road.direction !== 'one-way');
  const numLanes = prof.lanes || 4;
  const lw = (prof.width - (prof.hasMedian ? 10 : 2)) / numLanes;

  const trim = getRoadJunctionTrim(road);
  const markingsPts = (trim.trimMarkingsStart > 0 || trim.trimMarkingsEnd > 0)
    ? getTrimmedPoints(sampledPts, trim.trimMarkingsStart, trim.trimMarkingsEnd)
    : sampledPts;

  const medianPts = (trim.trimMedianStart > 0 || trim.trimMedianEnd > 0)
    ? getTrimmedPoints(sampledPts, trim.trimMedianStart, trim.trimMedianEnd)
    : sampledPts;

  ctx.save();
  // White Solid Edge Lines (Faixas Contínuas de Bordo)
  const edgeDist = prof.width / 2 - 1.8;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.0 / cad.zoom;
  ctx.lineCap = 'butt';
  ctx.beginPath(); traceOffsetPoints(markingsPts, -edgeDist); ctx.stroke();
  ctx.beginPath(); traceOffsetPoints(markingsPts, edgeDist); ctx.stroke();

  // 4 FAÍXAS DEMARCADAS & DIVISOR CENTRAL
  if (numLanes === 4) {
    if (isTwoWay) {
      if (prof.hasMedian) {
        // Canteiro central verde: recuado antes da interseção!
        ctx.strokeStyle = '#15803d';
        ctx.lineWidth = 8;
        ctx.lineCap = 'butt';
        ctx.beginPath(); tracePoints(medianPts); ctx.stroke();

        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 1.6 / cad.zoom;
        ctx.beginPath(); traceOffsetPoints(medianPts, -4.2); ctx.stroke();
        ctx.beginPath(); traceOffsetPoints(medianPts, 4.2); ctx.stroke();

        // Cabeceira arredondada do canteiro
        drawMedianNoses(road, medianPts, trim);
      } else {
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 1.6 / cad.zoom;
        ctx.lineCap = 'butt';
        ctx.beginPath(); traceOffsetPoints(medianPts, -1.8); ctx.stroke();
        ctx.beginPath(); traceOffsetPoints(medianPts, 1.8); ctx.stroke();
      }

      ctx.beginPath();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.8 / cad.zoom;
      ctx.lineCap = 'butt';
      ctx.setLineDash([14 / cad.zoom, 12 / cad.zoom]);
      traceOffsetPoints(markingsPts, -lw);
      ctx.stroke();

      ctx.beginPath();
      traceOffsetPoints(markingsPts, lw);
      ctx.stroke();
      ctx.setLineDash([]);

    } else {
      ctx.beginPath();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.8 / cad.zoom;
      ctx.lineCap = 'butt';
      ctx.setLineDash([14 / cad.zoom, 12 / cad.zoom]);
      traceOffsetPoints(markingsPts, -lw);
      ctx.stroke();

      ctx.beginPath();
      tracePoints(markingsPts);
      ctx.stroke();

      ctx.beginPath();
      traceOffsetPoints(markingsPts, lw);
      ctx.stroke();
      ctx.setLineDash([]);
    }

  } else {
    // 2 FAIXAS
    if (isTwoWay) {
      ctx.beginPath();
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 1.8 / cad.zoom;
      ctx.lineCap = 'butt';
      tracePoints(medianPts);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.8 / cad.zoom;
      ctx.lineCap = 'butt';
      ctx.setLineDash([14 / cad.zoom, 12 / cad.zoom]);
      tracePoints(markingsPts);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();

  // Faixa de Retenção branca na embocadura da interseção
  drawStopBars(road, markingsPts, trim);

  // Setas Direcionais Pintadas no Asfalto
  drawLaneDirectionArrows(road, numLanes, lw, isTwoWay);

  // Traçado Visual da Ligação de Faixas
  drawLaneConnectionOverlay(road);
}

function drawLaneConnectionOverlay(road) {
  if (!road || !road.points || road.points.length < 2) return;
  const isSelected = (cad.selectedRoad && cad.selectedRoad.id === road.id);
  const isLaneConnectMode = (cad.mode === 'lane-connect');

  if (!isSelected && !isLaneConnectMode && (!road.laneLinks || road.laneLinks.length === 0)) return;

  const pts = road.points;
  const prof = ROAD_PROFILES[road.type] || ROAD_PROFILES['highway-twin'];
  const numLanes = prof.lanes || 4;
  const lw = prof.width / numLanes;

  const connEnd = findConnectedRoadAt(pts[pts.length - 1].x, pts[pts.length - 1].y, road, 50);
  const connStart = findConnectedRoadAt(pts[0].x, pts[0].y, road, 50);
  const conn = connEnd || connStart;
  if (!conn) return;

  const targetRoad = conn.road;
  const targetProf = ROAD_PROFILES[targetRoad.type] || ROAD_PROFILES['highway-twin'];
  const targetNumLanes = targetProf.lanes || 4;
  const targetLw = targetProf.width / targetNumLanes;

  const isEnd = !!connEnd;
  const ep = isEnd ? pts[pts.length - 1] : pts[0];
  const prevEp = isEnd ? pts[pts.length - 2] : pts[1];

  const dx = ep.x - prevEp.x;
  const dy = ep.y - prevEp.y;
  const len = Math.hypot(dx, dy) || 1;
  const uDir = { x: dx / len, y: dy / len };
  const uNorm = { x: -uDir.y, y: uDir.x };

  const tPts = targetRoad.points;
  const tA = tPts[conn.segIdx];
  const tB = tPts[conn.segIdx + 1];
  const tdx = tB.x - tA.x;
  const tdy = tB.y - tA.y;
  const tlen = Math.hypot(tdx, tdy) || 1;
  const tuDir = { x: tdx / tlen, y: tdy / tlen };
  const tuNorm = { x: -tuDir.y, y: tuDir.x };
  const centerTarget = { x: tA.x + tuDir.x * (conn.progress * tlen), y: tA.y + tuDir.y * (conn.progress * tlen) };

  ctx.save();

  if (isLaneConnectMode || isSelected) {
    for (let f = 0; f < numLanes; f++) {
      const laneOff = (f - (numLanes - 1) / 2) * lw;
      const lx = ep.x + uNorm.x * laneOff;
      const ly = ep.y + uNorm.y * laneOff;

      ctx.beginPath();
      ctx.fillStyle = '#0284c7';
      ctx.arc(lx, ly, 8 / cad.zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5 / cad.zoom;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.max(8, 9 / cad.zoom)}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${f + 1}`, lx, ly);
    }
  }

  if (road.laneLinks && road.laneLinks.length > 0) {
    for (const link of road.laneLinks) {
      if (link.targetRoadId !== targetRoad.id) continue;
      if (link.toLane === undefined || link.toLane < 0) continue;

      const f = link.fromLane;
      const t = link.toLane;

      const fromOff = (f - (numLanes - 1) / 2) * lw;
      const startPt = { x: ep.x + uNorm.x * fromOff, y: ep.y + uNorm.y * fromOff };

      const toOff = (t - (targetNumLanes - 1) / 2) * targetLw;
      const endPt = { x: centerTarget.x + tuNorm.x * toOff, y: centerTarget.y + tuNorm.y * toOff };

      const ctrlDist = Math.max(14, dist(startPt, endPt) * 0.45);
      const cp1 = { x: startPt.x + uDir.x * ctrlDist, y: startPt.y + uDir.y * ctrlDist };
      const cp2 = { x: endPt.x - tuDir.x * ctrlDist * 0.5, y: endPt.y - tuDir.y * ctrlDist * 0.5 };

      ctx.beginPath();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2.5 / cad.zoom;
      ctx.moveTo(startPt.x, startPt.y);
      ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, endPt.x, endPt.y);
      ctx.stroke();

      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.arc(endPt.x, endPt.y, 4 / cad.zoom, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

function drawRealisticRoad(road, isPreview = false) {
  const pts = road.points;
  if (!pts || pts.length < 2) return;
  const prof = ROAD_PROFILES[road.type] || ROAD_PROFILES['highway-twin'];
  const isElevated = prof.elevation > 0;

  if (isElevated) {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
    ctx.shadowBlur = 22 * cad.zoom;
    ctx.shadowOffsetX = 12;
    ctx.shadowOffsetY = 16;
  }

  drawRoadShoulders(road);
  drawRoadAsphalt(road);

  if (isElevated) {
    ctx.restore();
    for (const p of pts) {
      ctx.fillStyle = '#64748b';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2 / cad.zoom;
      ctx.fillRect(p.x - 7, p.y - 7, 14, 14);
      ctx.strokeRect(p.x - 7, p.y - 7, 14, 14);
    }
  }

  drawRoadMarkings(road);
}

function drawLaneDirectionArrows(road, numLanes, lw, isTwoWay) {
  const pts = getSampledRoadPoints(road);
  if (!pts || pts.length < 2) return;

  const step = Math.max(12, Math.floor(110 / 8));
  for (let i = Math.floor(step / 2); i < pts.length - 1; i += step) {
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const uDir = { x: Math.cos(angle), y: Math.sin(angle) };
    const uNorm = { x: -uDir.y, y: uDir.x };

    if (numLanes === 4) {
      const laneOffsets = [-1.5 * lw, -0.5 * lw, 0.5 * lw, 1.5 * lw];
      laneOffsets.forEach((off, idx) => {
        const ax = p1.x + uNorm.x * off;
        const ay = p1.y + uNorm.y * off;
        const isReverse = (isTwoWay && idx < 2);
        drawSingleAsphaltArrow(ax, ay, isReverse ? angle + Math.PI : angle);
      });
    } else {
      const laneOffsets = [-0.5 * lw, 0.5 * lw];
      laneOffsets.forEach((off, idx) => {
        const ax = p1.x + uNorm.x * off;
        const ay = p1.y + uNorm.y * off;
        const isReverse = (isTwoWay && idx === 0);
        drawSingleAsphaltArrow(ax, ay, isReverse ? angle + Math.PI : angle);
      });
    }
  }
}

function drawSingleAsphaltArrow(x, y, angle) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.beginPath();
  ctx.moveTo(6, 0);
  ctx.lineTo(-4, -4);
  ctx.lineTo(-2, 0);
  ctx.lineTo(-4, 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawEquipments() {
  for (const eq of cad.equipments) {
    ctx.save();
    ctx.translate(eq.x, eq.y);
    ctx.rotate(eq.angle || 0);

    const isSelected = (cad.selectedEquip && cad.selectedEquip.id === eq.id);

    // Selected highlight halo
    if (isSelected) {
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, 18, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // A) TRAFFIC LIGHT WITH LIVE DIGITAL COUNTDOWN & LANE TARGET
    if (eq.type === 'traffic-light') {
      const isRed = eq.state === 'red';
      const isYellow = eq.state === 'yellow';
      const isGreen = eq.state === 'green';
      const tLane = eq.targetLane || 'all';

      // Faixa de Retenção branca na pista de acordo com a faixa selecionada
      ctx.save();
      ctx.fillStyle = '#ffffff';
      if (tLane === 'right') {
        // Faixa da Direita (Sentido Ida)
        ctx.fillRect(0, -1.8, 24, 3.6);
      } else if (tLane === 'left') {
        // Faixa da Esquerda (Sentido Volta)
        ctx.fillRect(-24, -1.8, 24, 3.6);
      } else {
        // Todas as faixas
        ctx.fillRect(-24, -1.8, 48, 3.6);
      }
      ctx.restore();

      // Housing do Semáforo
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(-4, -11, 8, 22);
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 1;
      ctx.strokeRect(-4, -11, 8, 22);

      // Red
      ctx.fillStyle = isRed ? '#ef4444' : '#450a0a';
      ctx.beginPath(); ctx.arc(0, -6.5, 2.2, 0, Math.PI * 2); ctx.fill();
      if (isRed) {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.45)';
        ctx.beginPath(); ctx.arc(0, -6.5, 6, 0, Math.PI * 2); ctx.fill();
      }

      // Yellow
      ctx.fillStyle = isYellow ? '#eab308' : '#422006';
      ctx.beginPath(); ctx.arc(0, 0, 2.2, 0, Math.PI * 2); ctx.fill();
      if (isYellow) {
        ctx.fillStyle = 'rgba(234, 179, 8, 0.45)';
        ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
      }

      // Green
      ctx.fillStyle = isGreen ? '#22c55e' : '#052e16';
      ctx.beginPath(); ctx.arc(0, 6.5, 2.2, 0, Math.PI * 2); ctx.fill();
      if (isGreen) {
        ctx.fillStyle = 'rgba(34, 197, 94, 0.45)';
        ctx.beginPath(); ctx.arc(0, 6.5, 6, 0, Math.PI * 2); ctx.fill();
      }

      // DIGITAL COUNTDOWN BADGE (Sleek Mini OLED)
      ctx.fillStyle = '#020617';
      ctx.fillRect(6, -6, 14, 12);
      ctx.strokeStyle = isRed ? '#ef4444' : (isYellow ? '#eab308' : '#22c55e');
      ctx.lineWidth = 1;
      ctx.strokeRect(6, -6, 14, 12);

      ctx.fillStyle = isRed ? '#ef4444' : (isYellow ? '#eab308' : '#22c55e');
      ctx.font = 'bold 8px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${eq.timer || 8}s`, 13, 0);

      // Selo de Indicação da Faixa
      if (tLane !== 'all') {
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(-16, -20, 32, 8);
        ctx.strokeStyle = '#38bdf8';
        ctx.strokeRect(-16, -20, 32, 8);
        ctx.fillStyle = '#38bdf8';
        ctx.font = 'bold 6px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(tLane === 'right' ? '➡️ IDA' : '⬅️ VOLTA', 0, -14);
      }

    // B) PHYSICAL SPEED BUMP WITH YELLOW STRIPES & LANE TARGET
    } else if (eq.type === 'speed-bump') {
      const tLane = eq.targetLane || 'all';
      let bStartX = -22, bWidth = 44;
      if (tLane === 'right') { bStartX = 0; bWidth = 24; }
      else if (tLane === 'left') { bStartX = -24; bWidth = 24; }

      ctx.fillStyle = '#1e293b';
      ctx.fillRect(bStartX, -4, bWidth, 8);
      ctx.fillStyle = '#facc15';
      for (let x = bStartX + 2; x < bStartX + bWidth - 2; x += 6) {
        ctx.fillRect(x, -4, 3, 8);
      }
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 6.5px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(tLane === 'right' ? 'LOMBADA (IDA)' : (tLane === 'left' ? 'LOMBADA (VOLTA)' : 'LOMBADA'), bStartX + bWidth / 2, -6);

    // C) LIGHT POLES WITH DUAL FIXTURES
    } else if (eq.type === 'light-pole') {
      ctx.fillStyle = '#94a3b8';
      ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(14, 0); ctx.stroke();

      const lit = cad.lightsOn;
      ctx.fillStyle = lit ? '#fef08a' : '#475569';
      ctx.fillRect(-16, -2, 4, 4);
      ctx.fillRect(12, -2, 4, 4);

      // Glow when lights are active
      if (lit) {
        ctx.fillStyle = 'rgba(254, 240, 138, 0.18)';
        ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2); ctx.fill();
      }

    } else if (eq.type === 'crosswalk') {
      ctx.fillStyle = '#ffffff';
      for (let x = -14; x <= 14; x += 5) ctx.fillRect(x, -6, 2.8, 12);
    } else if (eq.type === 'sign-speed') {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 6px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('60', 0, 0);
    } else if (eq.type === 'tree') {
      ctx.fillStyle = '#15803d';
      ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#22c55e';
      ctx.beginPath(); ctx.arc(-2, -2, 4, 0, Math.PI * 2); ctx.fill();
    }

    ctx.restore();
  }
}

function drawRealisticVehicles() {
  for (const car of cad.cars) {
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);

    // Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(-9, -4.5, 18, 9);

    // Car Body
    ctx.fillStyle = car.color;
    ctx.beginPath();
    ctx.roundRect(-8, -4, 16, 8, 2);
    ctx.fill();

    // Windshield
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(-2, -3.2, 7, 6.4);

    // Headlights (Beam cones illuminated at night!)
    if (cad.isNight) {
      ctx.fillStyle = 'rgba(254, 240, 138, 0.35)';
      ctx.beginPath();
      ctx.moveTo(8, -2);
      ctx.lineTo(45, -12);
      ctx.lineTo(45, 12);
      ctx.lineTo(8, 2);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = '#fef08a';
    ctx.fillRect(7, -3.5, 2, 2);
    ctx.fillRect(7, 1.5, 2, 2);

    // Brake Lights (Turn intensely red when braking or stopped at red light!)
    const isStopping = car.isBraking || car.currentSpeed < 0.1;
    ctx.fillStyle = isStopping ? '#ff1111' : (cad.isNight ? '#ef4444' : '#7f1d1d');
    ctx.fillRect(-8.5, -3.5, isStopping ? 2.5 : 1.5, 2);
    ctx.fillRect(-8.5, 1.5, isStopping ? 2.5 : 1.5, 2);

    if (isStopping) {
      ctx.fillStyle = 'rgba(255, 17, 17, 0.45)';
      ctx.beginPath(); ctx.arc(-8.5, -2.5, 4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(-8.5, 2.5, 4, 0, Math.PI * 2); ctx.fill();
    }

    ctx.restore();
  }
}

/**
 * NIGHT ATMOSPHERE & LIGHTING OVERLAY:
 * Creates realistic dark night mood with bright warm lighting cones around poles!
 */
function drawNightAtmosphereAndLighting() {
  ctx.save();
  // Semi-transparent night darkness
  ctx.fillStyle = 'rgba(8, 14, 24, 0.72)';
  ctx.fillRect(-3000, -3000, 6000, 6000);

  // If user turned on street lights, cut out glowing light halos
  if (cad.lightsOn) {
    ctx.globalCompositeOperation = 'lighter';
    for (const eq of cad.equipments) {
      if (eq.type === 'light-pole') {
        const rad = 75;
        const grad = ctx.createRadialGradient(eq.x, eq.y, 10, eq.x, eq.y, rad);
        grad.addColorStop(0, 'rgba(254, 240, 138, 0.55)');
        grad.addColorStop(0.5, 'rgba(253, 224, 71, 0.25)');
        grad.addColorStop(1, 'rgba(253, 224, 71, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(eq.x, eq.y, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

function drawLiveConstructionPreview() {
  const curPos = cad.mouseWorld;

  if (cad.mode === 'draw-road') {
    const effectivePos = cad.snapTarget ? { x: cad.snapTarget.x, y: cad.snapTarget.y } : curPos;

    if (cad.activePoints.length > 0) {
      const pts = [...cad.activePoints, effectivePos];
      drawRealisticRoad({ points: pts, type: cad.roadType }, true);

      ctx.beginPath();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2 / cad.zoom;
      ctx.setLineDash([8 / cad.zoom, 6 / cad.zoom]);
      tracePoints(pts);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Indicador Visual de Conexão Magnética (Snap Ring & Badge)
    if (cad.snapTarget) {
      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 3 / cad.zoom;
      ctx.arc(cad.snapTarget.x, cad.snapTarget.y, 16 / cad.zoom, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = 'rgba(34, 197, 94, 0.45)';
      ctx.beginPath();
      ctx.arc(cad.snapTarget.x, cad.snapTarget.y, 8 / cad.zoom, 0, Math.PI * 2);
      ctx.fill();

      // Badge visual "🔗 Ligar à [Via]"
      const badgeText = `🔗 Ligar à ${cad.snapTarget.road?.name || 'Via'}`;
      ctx.font = `bold ${Math.max(11, 13 / cad.zoom)}px Inter, sans-serif`;
      const tMetrics = ctx.measureText(badgeText);
      const pad = 8 / cad.zoom;
      const bw = tMetrics.width + pad * 2;
      const bh = 24 / cad.zoom;
      const bx = cad.snapTarget.x + 18 / cad.zoom;
      const by = cad.snapTarget.y - 12 / cad.zoom;

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 1.5 / cad.zoom;
      ctx.strokeRect(bx, by, bw, bh);

      ctx.fillStyle = '#4ade80';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(badgeText, bx + pad, by + bh / 2);
      ctx.restore();
    }

  } else if (cad.mode === 'place-equipment') {
    const def = EQUIPMENT_DEFS[cad.equipType];
    if (!def) return;
    ctx.save();
    ctx.translate(curPos.x, curPos.y);
    ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
    ctx.beginPath(); ctx.arc(0, 0, 14 / cad.zoom, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5 / cad.zoom;
    ctx.stroke();
    ctx.font = `${Math.max(14, 16 / cad.zoom)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def.icon, 0, 0);
    ctx.restore();
  }
}

function drawEditNodesAndSelection() {
  if (cad.selectedRoad) {
    const road = cad.selectedRoad;
    const prof = ROAD_PROFILES[road.type];

    ctx.beginPath();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = prof.width + 10 / cad.zoom;
    ctx.lineCap = 'round';
    tracePoints(road.points);
    ctx.stroke();

    for (let i = 0; i < road.points.length; i++) {
      const p = road.points[i];
      ctx.fillStyle = (i === cad.draggingNodeIndex) ? '#f59e0b' : '#38bdf8';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2 / cad.zoom;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7 / cad.zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

// -------------------------------------------------------------
// Mouse & Interactive Handlers
// -------------------------------------------------------------
let lastClickTime = 0;
let lastClickPos = { x: 0, y: 0 };

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 1 || e.altKey || (e.button === 0 && e.shiftKey)) {
    cad.isPanning = true;
    cad.panStartX = e.clientX - cad.panX;
    cad.panStartY = e.clientY - cad.panY;
    canvas.style.cursor = 'grabbing';
    return;
  }

  if (e.button === 0) {
    const now = Date.now();
    const clickPos = cad.mouseWorld;

    const isDoubleClick = (now - lastClickTime < 320) && (dist(clickPos, lastClickPos) < 25);
    lastClickTime = now;
    lastClickPos = { x: clickPos.x, y: clickPos.y };

    // DOUBLE CLICK TO CONCLUDE
    if (isDoubleClick && cad.mode === 'draw-road' && cad.activePoints.length >= 2) {
      finishRoad();
      return;
    }

    // CHECK EDIT NODE DRAG
    if (cad.selectedRoad && (cad.mode === 'edit-nodes' || cad.mode === 'select')) {
      for (let i = 0; i < cad.selectedRoad.points.length; i++) {
        if (dist(clickPos, cad.selectedRoad.points[i]) <= 12 / cad.zoom) {
          cad.draggingNodeIndex = i;
          return;
        }
      }
    }

    // ERASE
    if (cad.mode === 'erase') {
      const hit = getItemUnderPoint(clickPos);
      if (hit) {
        pushHistoryState();
        if (hit.type === 'road') cad.roads.splice(hit.index, 1);
        else if (hit.type === 'equipment') cad.equipments.splice(hit.index, 1);
        rebuildTraffic();
        updateInfrastructureStats();
        render();
      }
      return;
    }

    // PLACE EQUIPMENT: Traffic Light, Speed Bump, Light Pole
    if (cad.mode === 'place-equipment') {
      const existingNear = cad.equipments.find(e => dist(e, clickPos) < 16);
      if (existingNear) {
        cad.selectedEquip = existingNear;
        cad.selectedRoad = null;
        updateSelectedPropertyPanel({ type: 'equipment', item: existingNear });
        render();
        return;
      }

      pushHistoryState();
      const defaultSec = cad.signalTimerSeconds || 8;
      cad.equipments.push({
        id: 'eq_' + Date.now(),
        type: cad.equipType,
        x: clickPos.x,
        y: clickPos.y,
        angle: 0,
        state: 'green',
        targetLane: cad.targetLane || 'all',
        phaseStartTime: Date.now(),
        greenDuration: defaultSec,
        redDuration: defaultSec,
        yellowDuration: 2,
        timer: defaultSec,
        duration: defaultSec
      });
      updateInfrastructureStats();
      render();
      const insEl = document.getElementById('instruction-text');
      if (insEl) {
        insEl.innerHTML = `Equipamento <strong>${EQUIPMENT_DEFS[cad.equipType].name}</strong> instalado! Os veículos reagem em tempo real!`;
      }
      return;
    }

    // SELECT / EDIT ROAD
    if (cad.mode === 'select' || cad.mode === 'edit-nodes') {
      const hit = getItemUnderPoint(clickPos);
      if (hit && hit.type === 'road') {
        cad.selectedRoad = hit.item;
        cad.selectedEquip = null;
        updateSelectedPropertyPanel(hit);
        document.getElementById('instruction-text').innerHTML = 
          `📐 Arraste os pontos azuis com o mouse para mudar as curvas da pista!`;
      } else if (hit && hit.type === 'equipment') {
        cad.selectedEquip = hit.item;
        cad.selectedRoad = null;
        updateSelectedPropertyPanel(hit);
        if (hit.item.type === 'traffic-light') {
          const ins = document.getElementById('instruction-text');
          if (ins) ins.innerHTML = `🚦 Semáforo selecionado! Altere o <strong>Tempo no Verde/Vermelho</strong> no painel direito e clique em Salvar.`;
        }
      } else {
        cad.selectedRoad = null;
        cad.selectedEquip = null;
        updateSelectedPropertyPanel(null);
      }
      render();
      return;
    }

    // DRAW ROAD
    if (cad.mode === 'draw-road') {
      // If user hasn't started drawing and clicks directly on an equipment, select it!
      if (cad.activePoints.length === 0) {
        const hit = getItemUnderPoint(clickPos);
        if (hit && hit.type === 'equipment') {
          cad.selectedEquip = hit.item;
          cad.selectedRoad = null;
          updateSelectedPropertyPanel(hit);
          render();
          const ins = document.getElementById('instruction-text');
          if (ins && hit.item.type === 'traffic-light') {
            ins.innerHTML = `🚦 Semáforo selecionado! Você pode ajustar o <strong>Tempo no Verde e Vermelho</strong> dele no painel à direita!`;
          }
          return;
        }
      }
      const targetPos = cad.snapTarget ? { x: cad.snapTarget.x, y: cad.snapTarget.y } : clickPos;
      cad.activePoints.push({ x: targetPos.x, y: targetPos.y });
      const finishGroup = document.getElementById('finish-btn-group');
      if (finishGroup) finishGroup.style.display = 'flex';
      document.getElementById('instruction-text').innerHTML = 
        `Construindo <strong>${ROAD_PROFILES[cad.roadType].name}</strong>: Dê 2 cliques rápidos ou clique no botão verde para concluir!`;
      render();
    }
  }
});

window.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  if (cad.isPanning) {
    const prevPanX = cad.panX;
    const prevPanY = cad.panY;
    cad.panX = e.clientX - cad.panStartX;
    cad.panY = e.clientY - cad.panStartY;

    if (leafletMap && cad.mapMode !== 'cad') {
      const dx = cad.panX - prevPanX;
      const dy = cad.panY - prevPanY;
      leafletMap.panBy([-dx, -dy], { animate: false });
    }

    render();
    return;
  }

  cad.mouseWorld = screenToWorld(sx, sy);

  if (cad.mode === 'draw-road') {
    const snapThreshold = 36 / cad.zoom;
    cad.snapTarget = getSnapPoint(cad.mouseWorld, snapThreshold);
  } else {
    cad.snapTarget = null;
  }

  if (cad.draggingNodeIndex >= 0 && cad.selectedRoad) {
    const snapThreshold = 36 / cad.zoom;
    const snap = getSnapPoint(cad.mouseWorld, snapThreshold, cad.selectedRoad.id);
    const targetPt = snap ? { x: snap.x, y: snap.y } : cad.mouseWorld;
    cad.selectedRoad.points[cad.draggingNodeIndex] = { x: targetPt.x, y: targetPt.y };
    let len = 0;
    for (let i = 0; i < cad.selectedRoad.points.length - 1; i++) {
      len += dist(cad.selectedRoad.points[i], cad.selectedRoad.points[i + 1]);
    }
    cad.selectedRoad.length = len;
    document.getElementById('sel-len').innerText = `Comprimento: ${len.toFixed(1)} metros`;
    updateInfrastructureStats();
    render();
  } else if (!cad.isPanning) {
    // Seta do mouse inteligente: se estiver sobre um elemento no modo seleção, vira pointer
    if (cad.mode === 'select') {
      const hit = getItemUnderPoint(cad.mouseWorld);
      canvas.style.cursor = hit ? 'pointer' : 'default';
    } else if (cad.mode === 'erase') {
      canvas.style.cursor = 'not-allowed';
    } else {
      canvas.style.cursor = 'default';
    }
  }
});

window.addEventListener('mouseup', () => {
  cad.isPanning = false;
  cad.draggingNodeIndex = -1;
  canvas.style.cursor = (cad.mode === 'erase' ? 'not-allowed' : 'default');
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  const zoomFactor = 1.15;
  const oldZoom = cad.zoom;
  if (e.deltaY < 0) cad.zoom = Math.min(6.0, cad.zoom * zoomFactor);
  else cad.zoom = Math.max(0.2, cad.zoom / zoomFactor);

  cad.panX = sx - (sx - cad.panX) * (cad.zoom / oldZoom);
  cad.panY = sy - (sy - cad.panY) * (cad.zoom / oldZoom);

  if (leafletMap && cad.mapMode !== 'cad') {
    if (e.deltaY < 0 && cad.zoom > 1.25 && leafletMap.getZoom() < 19) {
      leafletMap.zoomIn();
    } else if (e.deltaY > 0 && cad.zoom < 0.8 && leafletMap.getZoom() > 14) {
      leafletMap.zoomOut();
    }
  }

  render();
}, { passive: false });

function getItemUnderPoint(pt) {
  for (let i = cad.equipments.length - 1; i >= 0; i--) {
    if (dist(pt, cad.equipments[i]) <= 22 / cad.zoom) {
      return { type: 'equipment', item: cad.equipments[i], index: i };
    }
  }

  for (let i = cad.roads.length - 1; i >= 0; i--) {
    const road = cad.roads[i];
    const prof = ROAD_PROFILES[road.type];
    const threshold = prof.width / 2 + 8 / cad.zoom;

    for (let j = 0; j < road.points.length - 1; j++) {
      if (distToSegment(pt, road.points[j], road.points[j + 1]) <= threshold) {
        return { type: 'road', item: road, index: i };
      }
    }
  }
  return null;
}

function finishRoad() {
  if (cad.activePoints.length < 2) {
    cad.activePoints = [];
    setMode('select');
    return;
  }
  pushHistoryState();

  if (cad.snapTarget && cad.activePoints.length > 0) {
    const lastIdx = cad.activePoints.length - 1;
    if (dist(cad.activePoints[lastIdx], cad.snapTarget) < 45 / cad.zoom) {
      cad.activePoints[lastIdx] = { x: cad.snapTarget.x, y: cad.snapTarget.y };
    }
  }

  let totalLength = 0;
  for (let i = 0; i < cad.activePoints.length - 1; i++) {
    totalLength += dist(cad.activePoints[i], cad.activePoints[i + 1]);
  }

  const newRoad = {
    id: 'road_' + Date.now(),
    name: ROAD_PROFILES[cad.roadType].name,
    type: cad.roadType,
    direction: cad.roadDirection || 'two-way',
    points: [...cad.activePoints],
    length: totalLength
  };

  cad.roads.push(newRoad);
  cad.activePoints = [];

  autoPlaceLightingPoles(newRoad);
  spawnRealisticCars(newRoad);

  updateInfrastructureStats();
  setMode('select');
  document.getElementById('instruction-text').innerHTML = 
    `✅ <strong>Pista concluída!</strong> Seta do mouse livre. Para criar outra pista ou colocar equipamentos, clique na ferramenta desejada.`;
  render();
}
function autoPlaceLightingPoles(road) {
  const pts = getSampledRoadPoints(road);
  if (!pts || pts.length < 2) return;
  const step = Math.max(12, Math.floor(110 / 8));
  for (let i = 0; i < pts.length - 1; i += step) {
    const p1 = pts[i];
    const p2 = pts[Math.min(pts.length - 1, i + 1)];
    cad.equipments.push({
      id: 'pole_' + Math.random(),
      type: 'light-pole',
      x: p1.x,
      y: p1.y,
      angle: Math.atan2(p2.y - p1.y, p2.x - p1.x) + Math.PI / 2
    });
  }
}

function spawnRealisticCars(road) {
  const pts = getSampledRoadPoints(road);
  if (!pts || pts.length < 2) return;
  const photoColors = ['#ffffff', '#0f172a', '#ef4444', '#94a3b8', '#f8fafc', '#2563eb', '#dc2626', '#334155'];
  const prof = ROAD_PROFILES[road.type] || ROAD_PROFILES['highway-twin'];
  const numLanes = prof.lanes || 4;
  const isTwoWay = (road.direction !== 'one-way');
  const lw = (prof.width - (prof.hasMedian ? 10 : 2)) / numLanes;

  let laneOffsets = [];
  if (numLanes === 4) {
    laneOffsets = [-1.5 * lw, -0.5 * lw, 0.5 * lw, 1.5 * lw];
  } else {
    laneOffsets = [-0.5 * lw, 0.5 * lw];
  }

  // Spawn cars across all lanes so all 4 lanes are visibly populated!
  laneOffsets.forEach((offset, idx) => {
    const carsPerLane = 2;
    for (let k = 0; k < carsPerLane; k++) {
      const isReverse = isTwoWay && (numLanes === 4 ? idx < 2 : idx === 0);
      const dir = isReverse ? -1 : 1;
      const progress = (k * 0.48 + Math.random() * 0.35) % 1.0;
      const segIdx = Math.floor(Math.random() * (pts.length - 1));

      const pA = pts[segIdx];
      const pB = pts[segIdx + 1];
      const segVec = { x: pB.x - pA.x, y: pB.y - pA.y };
      const segDist = Math.hypot(segVec.x, segVec.y) || 1;
      const uNorm = { x: -segVec.y / segDist, y: segVec.x / segDist };
      const cx = pA.x + segVec.x * progress;
      const cy = pA.y + segVec.y * progress;
      const segAngle = Math.atan2(segVec.y, segVec.x);
      const angle = (dir === -1) ? (segAngle + Math.PI) : segAngle;

      cad.cars.push({
        road: road,
        segIdx: segIdx,
        progress: progress,
        laneOffset: offset,
        laneIndex: idx,
        dir: dir,
        x: cx + uNorm.x * offset,
        y: cy + uNorm.y * offset,
        angle: angle,
        baseSpeed: 1.4 + Math.random() * 0.8,
        currentSpeed: 1.4,
        isBraking: false,
        color: photoColors[Math.floor(Math.random() * photoColors.length)]
      });
    }
  });
}

// -------------------------------------------------------------
// Photo-Realistic Highway Preset matching User Photo
// -------------------------------------------------------------
function loadPhotoRealisticPreset() {
  pushHistoryState();
  cad.roads = [];
  cad.equipments = [];
  cad.cars = [];

  const mainHighway = {
    id: 'photo_hway',
    name: 'Rodovia Estadual (Pista Dupla 4 Faixas)',
    type: 'highway-twin',
    direction: 'two-way',
    points: [{ x: 0, y: -450 }, { x: 0, y: 450 }],
    length: 900
  };
  cad.roads.push(mainHighway);

  const viaduct = {
    id: 'photo_viaduct',
    name: 'Viaduto Elevado (4 Faixas)',
    type: 'viaduct-real',
    direction: 'two-way',
    points: [{ x: -350, y: 0 }, { x: 350, y: 0 }],
    length: 700
  };
  cad.roads.push(viaduct);

  // Curved diagonal Avenue connecting directly to the main highway
  const diagonalAvenue = {
    id: 'photo_avenue',
    name: 'Avenida Central 4 Faixas',
    type: 'avenue-real',
    direction: 'two-way',
    points: [{ x: -380, y: -220 }, { x: -160, y: -190 }, { x: 0, y: -90 }],
    length: 450,
    laneLinks: [
      { targetRoadId: 'photo_hway', fromLane: 2, toLane: 2 },
      { targetRoadId: 'photo_hway', fromLane: 3, toLane: 3 }
    ]
  };
  cad.roads.push(diagonalAvenue);
  spawnRealisticCars(diagonalAvenue);

  // Place poles
  for (let y = -400; y <= 400; y += 90) {
    cad.equipments.push({ id: 'pole_' + y, type: 'light-pole', x: 0, y: y, angle: 0 });
  }

  // Place Traffic Light with countdown timer at the intersection
  cad.equipments.push({
    id: 'tl_1',
    type: 'traffic-light',
    x: 30,
    y: -30,
    angle: 0,
    state: 'green',
    targetLane: 'all',
    phaseStartTime: Date.now(),
    greenDuration: 8,
    redDuration: 8,
    yellowDuration: 2,
    timer: 8,
    duration: 8
  });

  // Place Speed Bump with braking physics on the highway
  cad.equipments.push({
    id: 'bump_1',
    type: 'speed-bump',
    x: 0,
    y: 220,
    angle: 0,
    targetLane: 'all'
  });

  spawnRealisticCars(mainHighway);
  spawnRealisticCars(viaduct);

  cad.panX = canvas.width / 2;
  cad.panY = canvas.height / 2;
  cad.zoom = 1.0;

  updateInfrastructureStats();
  render();
}

// -------------------------------------------------------------
// UI Bindings & Button Wiring
// -------------------------------------------------------------
function updateSelectedPropertyPanel(hit) {
  const empty = document.getElementById('empty-state-text');
  const card = document.getElementById('selected-card');
  const tlBox = document.getElementById('sel-traffic-light-box');
  const equipLaneBox = document.getElementById('sel-equip-lane-box');
  const equipLaneSelect = document.getElementById('select-equip-target-lane');
  const btnToggleDir = document.getElementById('btn-toggle-road-dir');

  if (!hit) {
    if (empty) empty.style.display = 'block';
    if (card) card.style.display = 'none';
    if (tlBox) tlBox.style.display = 'none';
    if (equipLaneBox) equipLaneBox.style.display = 'none';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (card) card.style.display = 'block';

  const title = document.getElementById('sel-title');
  const len = document.getElementById('sel-len');
  const cost = document.getElementById('sel-cost');

  const roadLanesBox = document.getElementById('sel-road-lanes-box');

  if (hit.type === 'road') {
    if (tlBox) tlBox.style.display = 'none';
    if (equipLaneBox) equipLaneBox.style.display = 'none';
    const prof = ROAD_PROFILES[hit.item.type];
    const isTwoWay = (hit.item.direction !== 'one-way');
    if (title) title.innerText = `${hit.item.name || prof.name}`;
    if (len) len.innerText = `Comprimento: ${hit.item.length.toFixed(1)} metros | ${isTwoWay ? '⇄ Mão Dupla (Ida e Volta)' : '➔ Sentido Único'}`;
    if (cost) cost.innerText = `Custo estimado: ${(hit.item.length * prof.costPerMeter).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`;
    const selType = document.getElementById('select-change-type');
    if (selType) selType.value = hit.item.type;
    if (btnToggleDir) {
      btnToggleDir.innerText = isTwoWay ? '➔ Mudar p/ Sentido Único' : '⇄ Mudar p/ Mão Dupla';
    }

    // Configuração de Faixas Conectadas
    if (roadLanesBox) {
      const conn = findConnectedRoadAt(hit.item.points[0].x, hit.item.points[0].y, hit.item, 60) ||
                   findConnectedRoadAt(hit.item.points[hit.item.points.length - 1].x, hit.item.points[hit.item.points.length - 1].y, hit.item, 60);
      if (conn) {
        roadLanesBox.style.display = 'block';
        const targetRoad = conn.road;
        const targetProf = ROAD_PROFILES[targetRoad.type] || ROAD_PROFILES['highway-twin'];
        const targetNumLanes = targetProf.lanes || 4;

        const stEl = document.getElementById('lane-conn-status');
        if (stEl) stEl.innerText = `Ligada à ${targetRoad.name || 'Via'}`;

        const infoEl = document.getElementById('lane-conn-info');
        if (infoEl) infoEl.innerText = `Selecione para onde cada faixa desta via entra na ${targetRoad.name || 'Via'}:`;

        const matrixEl = document.getElementById('lane-link-matrix');
        if (matrixEl) {
          matrixEl.innerHTML = '';
          const numLanes = prof.lanes || 4;
          if (!hit.item.laneLinks) hit.item.laneLinks = [];

          for (let f = 0; f < numLanes; f++) {
            const existingLink = hit.item.laneLinks.find(l => l.targetRoadId === targetRoad.id && l.fromLane === f);
            const currentToLane = existingLink ? existingLink.toLane : (f % targetNumLanes);

            const row = document.createElement('div');
            row.className = 'lane-link-row';

            let optionsHtml = `<option value="-1">❌ Não Conectar</option>`;
            for (let t = 0; t < targetNumLanes; t++) {
              const isSelected = (currentToLane === t) ? 'selected' : '';
              optionsHtml += `<option value="${t}" ${isSelected}>Faixa ${t + 1} (${t < targetNumLanes / 2 ? 'Esq' : 'Dir'})</option>`;
            }

            row.innerHTML = `
              <div style="display: flex; align-items: center; gap: 6px;">
                <span class="lane-badge lane-badge-orig">Faixa ${f + 1}</span>
                <span style="color: #38bdf8; font-size: 10px;">➔</span>
              </div>
              <select class="lane-select-input" data-from-lane="${f}">
                ${optionsHtml}
              </select>
            `;

            row.querySelector('select').addEventListener('change', (e) => {
              const toL = parseInt(e.target.value);
              hit.item.laneLinks = hit.item.laneLinks.filter(l => !(l.targetRoadId === targetRoad.id && l.fromLane === f));
              if (toL >= 0) {
                hit.item.laneLinks.push({ targetRoadId: targetRoad.id, fromLane: f, toLane: toL });
              }
              pushHistoryState();
              render();
            });

            matrixEl.appendChild(row);
          }
        }
      } else {
        roadLanesBox.style.display = 'none';
      }
    }
  } else if (hit.type === 'equipment') {
    if (roadLanesBox) roadLanesBox.style.display = 'none';
    const def = EQUIPMENT_DEFS[hit.item.type];
    if (title) title.innerText = `${def.icon} ${def.name}`;
    if (cost) cost.innerText = `Valor Unitário: ${def.cost.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`;

    // Show target lane box for traffic lights and speed bumps
    if (hit.item.type === 'traffic-light' || hit.item.type === 'speed-bump') {
      if (equipLaneBox) {
        equipLaneBox.style.display = 'block';
        if (equipLaneSelect) equipLaneSelect.value = hit.item.targetLane || 'all';
      }
    } else {
      if (equipLaneBox) equipLaneBox.style.display = 'none';
    }

    if (hit.item.type === 'traffic-light') {
      const stateName = hit.item.state === 'green' ? 'VERDE' : (hit.item.state === 'red' ? 'VERMELHO' : 'AMARELO');
      const laneInfo = hit.item.targetLane === 'right' ? ' [Faixa IDA]' : (hit.item.targetLane === 'left' ? ' [Faixa VOLTA]' : ' [Todas as Faixas]');
      if (len) len.innerText = `Fase: ${stateName} (${hit.item.timer || 8}s restantes)${laneInfo}`;

      if (tlBox) {
        tlBox.style.display = 'block';
        const greenIn = document.getElementById('input-sel-green-timer');
        const redIn = document.getElementById('input-sel-red-timer');
        const yellowIn = document.getElementById('input-sel-yellow-timer');
        if (greenIn) greenIn.value = hit.item.greenDuration || hit.item.duration || 8;
        if (redIn) redIn.value = hit.item.redDuration || hit.item.duration || 8;
        if (yellowIn) yellowIn.value = hit.item.yellowDuration || 2;
      }
    } else if (hit.item.type === 'speed-bump') {
      const laneInfo = hit.item.targetLane === 'right' ? ' [Faixa IDA]' : (hit.item.targetLane === 'left' ? ' [Faixa VOLTA]' : ' [Todas as Faixas]');
      if (len) len.innerText = `Lombada Ativa${laneInfo}`;
      if (tlBox) tlBox.style.display = 'none';
    } else {
      if (len) len.innerText = 'Equipamento Ativo';
      if (tlBox) tlBox.style.display = 'none';
    }
  }
}

function updateInfrastructureStats() {
  let signals = 0, bumps = 0, lights = 0;
  for (const eq of cad.equipments) {
    if (eq.type === 'traffic-light') signals++;
    if (eq.type === 'speed-bump') bumps++;
    if (eq.type === 'light-pole') lights++;
  }

  document.getElementById('sum-cars-count').innerText = cad.cars.length;
  document.getElementById('sum-signals-count').innerText = signals;
  document.getElementById('sum-bumps-count').innerText = bumps;
  document.getElementById('sum-lights-count').innerText = lights;
}

function updateHud() {
  const hudCoords = document.getElementById('hud-coords');
  if (hudCoords) {
    hudCoords.innerText = `X: ${cad.mouseWorld.x.toFixed(1)} m | Y: ${cad.mouseWorld.y.toFixed(1)} m`;
  }
  const scaleBar = document.querySelector('.scale-bar .bar');
  if (scaleBar) {
    const scale50mScreen = 50 * cad.zoom;
    scaleBar.style.width = `${Math.max(20, scale50mScreen)}px`;
  }
}

function setMode(newMode) {
  cad.mode = newMode;
  document.querySelectorAll('.tool-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === newMode);
  });
  const eraseBtn = document.getElementById('btn-quick-erase');
  if (eraseBtn) eraseBtn.classList.toggle('active', newMode === 'erase');

  // Controla exibição dos botões de concluir/cancelar traçado
  const finishGroup = document.getElementById('finish-btn-group');
  if (finishGroup) {
    finishGroup.style.display = (newMode === 'draw-road' && cad.activePoints.length > 0) ? 'flex' : 'none';
  }

  const ins = document.getElementById('instruction-text');
  if (ins) {
    if (newMode === 'draw-road') {
      canvas.style.cursor = 'default';
      ins.innerHTML = `Modo <strong>Criar Via</strong>: Clique no mapa para marcar o <strong>1º ponto</strong> da pista. Dê <strong>2 cliques rápidos</strong> ou clique em Concluir quando terminar. (Pressione <strong>Esc</strong> para voltar à Seta).`;
    } else if (newMode === 'edit-nodes') {
      canvas.style.cursor = 'default';
      ins.innerHTML = `Modo <strong>Editar Via</strong>: Clique em uma pista para ver os pontos azuis e <strong>arraste as curvas</strong> com a seta do mouse. (Pressione <strong>Esc</strong> para voltar à Seta).`;
    } else if (newMode === 'place-equipment') {
      canvas.style.cursor = 'default';
      ins.innerHTML = `Modo <strong>Instalar Equipamento</strong>: Clique no local da via para posicionar <strong>${EQUIPMENT_DEFS[cad.equipType]?.name || 'Equipamento'}</strong>. (Pressione <strong>Esc</strong> para voltar à Seta).`;
    } else if (newMode === 'select') {
      canvas.style.cursor = 'default';
      ins.innerHTML = `Modo <strong>Seta do Mouse Livre</strong>: Navegue à vontade. Para criar algo, basta <strong>clicar no que você deseja fazer</strong> no menu à esquerda!`;
    } else if (newMode === 'erase') {
      canvas.style.cursor = 'not-allowed';
      ins.innerHTML = `Modo <strong>Borracha</strong>: Clique em qualquer via, semáforo ou poste para apagar.`;
    }
  }
  render();
}

let leafletMap = null;
let tileLayerSat = null;
let tileLayerOsm = null;
let locationMarker = null;

function initLeafletMap() {
  const mapEl = document.getElementById('satellite-map');
  if (!mapEl || typeof L === 'undefined') return;

  try {
    leafletMap = L.map('satellite-map', {
      center: cad.mapCenter,
      zoom: cad.mapZoom,
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false
    });

    // High resolution Satellite imagery (Esri World Imagery)
    tileLayerSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19
    });

    // OpenStreetMap standard street tiles
    tileLayerOsm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19
    });

    setMapLayer(cad.mapMode || 'sat');
  } catch (err) {
    console.warn('Leaflet map init warning:', err);
  }
}

function setMapLayer(mode) {
  cad.mapMode = mode;
  const mapEl = document.getElementById('satellite-map');

  document.querySelectorAll('.layer-pill').forEach(pill => {
    pill.classList.toggle('active', pill.dataset.layer === mode);
  });

  if (mode === 'cad') {
    if (mapEl) mapEl.style.display = 'none';
  } else {
    if (mapEl) mapEl.style.display = 'block';
    if (leafletMap) {
      if (tileLayerSat) leafletMap.removeLayer(tileLayerSat);
      if (tileLayerOsm) leafletMap.removeLayer(tileLayerOsm);

      if (mode === 'sat' && tileLayerSat) {
        tileLayerSat.addTo(leafletMap);
      } else if (mode === 'osm' && tileLayerOsm) {
        tileLayerOsm.addTo(leafletMap);
      }
      setTimeout(() => leafletMap && leafletMap.invalidateSize(), 50);
    }
  }
  render();
}

async function searchLocation() {
  const input = document.getElementById('input-search-location');
  if (!input) return;
  const query = input.value.trim();
  if (!query) return;

  const btn = document.getElementById('btn-search-place');
  const oldText = btn ? btn.innerText : '📍 Ir';
  if (btn) btn.innerText = '⏳ Buscando...';

  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`, {
      headers: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
    });
    const data = await res.json();
    if (data && data.length > 0) {
      const place = data[0];
      const lat = parseFloat(place.lat);
      const lon = parseFloat(place.lon);
      cad.mapCenter = [lat, lon];
      const roadName = place.display_name.split(',')[0] || query;

      // Switch to satellite layer if in CAD so user sees the real location
      if (cad.mapMode === 'cad') {
        setMapLayer('sat');
      }

      if (leafletMap) {
        leafletMap.setView([lat, lon], 18, { animate: true });

        if (locationMarker) leafletMap.removeLayer(locationMarker);
        locationMarker = L.marker([lat, lon], { title: roadName }).addTo(leafletMap);
        locationMarker.bindPopup(`<strong>📍 ${roadName}</strong><br><small>${place.display_name}</small>`).openPopup();
      }

      // Reset camera to center canvas
      cad.panX = canvas.width / 2;
      cad.panY = canvas.height / 2;
      cad.zoom = 1.0;

      const ins = document.getElementById('instruction-text');
      if (ins) {
        ins.innerHTML = `📍 Local encontrado: <strong>${roadName}</strong>! A imagem de satélite está ativa no fundo para projetar vias reais.`;
      }
      render();
    } else {
      alert(`Local "${query}" não encontrado. Tente digitar o nome da rua e cidade.`);
    }
  } catch (e) {
    console.warn('Geocoding error:', e);
    alert('Erro ao buscar localização. Verifique sua conexão.');
  } finally {
    if (btn) btn.innerText = oldText;
  }
}

function setupUI() {
  // Modes
  const modeButtons = [
    { id: 'btn-mode-draw', mode: 'draw-road' },
    { id: 'btn-mode-edit', mode: 'edit-nodes' },
    { id: 'btn-mode-equip', mode: 'place-equipment' },
    { id: 'btn-mode-select', mode: 'select' },
    { id: 'btn-mode-lane-connect', mode: 'lane-connect' }
  ];

  modeButtons.forEach(({ id, mode }) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', () => setMode(mode));
    }
  });

  // Road options
  document.querySelectorAll('.road-option').forEach(opt => {
    opt.addEventListener('click', () => {
      document.querySelectorAll('.road-option').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      cad.roadType = opt.dataset.roadType;
      setMode('draw-road');
    });
  });

  // Equipment options
  document.querySelectorAll('.equip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.equip-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      cad.equipType = btn.dataset.equip;
      setMode('place-equipment');
    });
  });

  // Search Place button and Enter key
  const searchBtn = document.getElementById('btn-search-place');
  const searchInput = document.getElementById('input-search-location');
  if (searchBtn) searchBtn.addEventListener('click', searchLocation);
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') searchLocation();
    });
  }

  // Map layer toggle buttons
  document.querySelectorAll('.layer-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      setMapLayer(pill.dataset.layer);
    });
  });

  // Curve Buttons
  const curveStraight = document.getElementById('btn-curve-straight');
  const curveBezier = document.getElementById('btn-curve-bezier');
  if (curveStraight) {
    curveStraight.addEventListener('click', () => {
      curveStraight.classList.add('active');
      if (curveBezier) curveBezier.classList.remove('active');
      cad.curveType = 'straight';
      render();
    });
  }
  if (curveBezier) {
    curveBezier.addEventListener('click', () => {
      curveBezier.classList.add('active');
      if (curveStraight) curveStraight.classList.remove('active');
      cad.curveType = 'bezier';
      render();
    });
  }

  // Road Traffic Direction (Mão Dupla vs Sentido Único)
  const dirTwoWay = document.getElementById('btn-dir-twoway');
  const dirOneWay = document.getElementById('btn-dir-oneway');
  if (dirTwoWay) {
    dirTwoWay.addEventListener('click', () => {
      dirTwoWay.classList.add('active');
      if (dirOneWay) dirOneWay.classList.remove('active');
      cad.roadDirection = 'two-way';
      const ins = document.getElementById('instruction-text');
      if (ins) ins.innerHTML = `Modo <strong>Mão Dupla</strong>: As pistas terão sentido duplo (ida e volta) com canteiro/faixas centrais!`;
    });
  }
  if (dirOneWay) {
    dirOneWay.addEventListener('click', () => {
      dirOneWay.classList.add('active');
      if (dirTwoWay) dirTwoWay.classList.remove('active');
      cad.roadDirection = 'one-way';
      const ins = document.getElementById('instruction-text');
      if (ins) ins.innerHTML = `Modo <strong>Sentido Único</strong>: Todas as 4 faixas fluirão para frente com divisórias brancas!`;
    });
  }

  // Equipment Lane Target (Todas vs Ida vs Volta)
  const targetAll = document.getElementById('btn-target-all');
  const targetRight = document.getElementById('btn-target-right');
  const targetLeft = document.getElementById('btn-target-left');
  const targetButtons = [
    { btn: targetAll, val: 'all', desc: 'em todas as faixas' },
    { btn: targetRight, val: 'right', desc: 'somente na faixa da direita (Ida)' },
    { btn: targetLeft, val: 'left', desc: 'somente na faixa da esquerda (Volta)' }
  ];
  targetButtons.forEach(({ btn, val, desc }) => {
    if (btn) {
      btn.addEventListener('click', () => {
        targetButtons.forEach(b => { if (b.btn) b.btn.classList.remove('active'); });
        btn.classList.add('active');
        cad.targetLane = val;
        const ins = document.getElementById('instruction-text');
        if (ins) ins.innerHTML = `Equipamento configurado para instalar <strong>${desc}</strong>!`;
      });
    }
  });

  // Finish & Cancel Road
  const finishBtn = document.getElementById('btn-finish-drawing');
  if (finishBtn) finishBtn.addEventListener('click', finishRoad);

  const cancelBtn = document.getElementById('btn-cancel-drawing');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      cad.activePoints = [];
      setMode('select');
      const ins = document.getElementById('instruction-text');
      if (ins) ins.innerHTML = `Traçado cancelado. Seta do mouse livre.`;
    });
  }

  // Tecla Escape para sair de qualquer modo de construção e voltar para a Seta
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cad.activePoints = [];
      setMode('select');
      const ins = document.getElementById('instruction-text');
      if (ins) ins.innerHTML = `Modo cancelado. Seta do mouse livre.`;
    }
  });

  // Botão direito do mouse cancela desenho atual e volta para a Seta
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (cad.activePoints.length > 0) {
      cad.activePoints = [];
    }
    setMode('select');
  });

  // Day / Night Toggle Button
  const dayNightBtn = document.getElementById('btn-toggle-day-night');
  if (dayNightBtn) {
    dayNightBtn.addEventListener('click', () => {
      cad.isNight = !cad.isNight;
      const icon = document.getElementById('day-night-icon');
      const text = document.getElementById('day-night-text');
      const hudEnv = document.getElementById('hud-env-status');
      if (icon) icon.innerText = cad.isNight ? '🌙' : '☀️';
      if (text) text.innerText = cad.isNight ? 'Modo Noite' : 'Modo Dia';
      if (hudEnv) hudEnv.innerText = cad.isNight ? '🌙 Noite' : '☀️ Dia';
      wrapper.style.background = cad.isNight ? '#0b0f14' : '#20262d';
      render();
    });
  }

  // Street Lights Toggle Button (Acender ou Apagar)
  const lightsBtn = document.getElementById('btn-toggle-lights');
  if (lightsBtn) {
    lightsBtn.addEventListener('click', () => {
      cad.lightsOn = !cad.lightsOn;
      const icon = document.getElementById('lights-icon');
      const text = document.getElementById('lights-text');
      const hudLight = document.getElementById('hud-light-status');
      if (icon) icon.innerText = cad.lightsOn ? '💡' : '🌑';
      if (text) text.innerText = cad.lightsOn ? 'Postes: Acesos' : 'Postes: Apagados';
      if (hudLight) {
        hudLight.innerText = cad.lightsOn ? 'Acesa' : 'Apagada';
        hudLight.style.color = cad.lightsOn ? '#facc15' : '#94a3b8';
      }
      render();
    });
  }

  // Traffic Speed Slider
  const speedSlider = document.getElementById('traffic-speed-slider');
  if (speedSlider) {
    speedSlider.addEventListener('input', (e) => {
      cad.speedMultiplier = parseFloat(e.target.value);
      const valEl = document.getElementById('speed-multiplier-val');
      if (valEl) valEl.innerText = `${cad.speedMultiplier.toFixed(1)}x`;
    });
  }

  // General Signal Timer change (Novos Semáforos e Aplicar a Todos)
  const applyTimerBtn = document.getElementById('btn-apply-timer');
  if (applyTimerBtn) {
    applyTimerBtn.addEventListener('click', () => {
      const input = document.getElementById('input-signal-timer');
      const val = parseInt(input ? input.value : 8) || 8;
      cad.signalTimerSeconds = val;
      for (const eq of cad.equipments) {
        if (eq.type === 'traffic-light') {
          eq.greenDuration = val;
          eq.redDuration = val;
          eq.duration = val;
          eq.timer = val;
        }
      }
      alert(`Tempo padrão de ${val} segundos aplicado a todos os semáforos!`);
      render();
    });
  }

  // Individual Selected Traffic Light Timer Save
  const saveSelSignalBtn = document.getElementById('btn-save-sel-signal-timer');
  if (saveSelSignalBtn) {
    saveSelSignalBtn.addEventListener('click', () => {
      if (!cad.selectedEquip || cad.selectedEquip.type !== 'traffic-light') {
        alert('Selecione um semáforo primeiro clicando nele!');
        return;
      }
      const greenInput = document.getElementById('input-sel-green-timer');
      const redInput = document.getElementById('input-sel-red-timer');
      const yellowInput = document.getElementById('input-sel-yellow-timer');

      const g = Math.max(2, parseInt(greenInput ? greenInput.value : 8) || 8);
      const r = Math.max(2, parseInt(redInput ? redInput.value : 8) || 8);
      const y = Math.max(1, parseInt(yellowInput ? yellowInput.value : 2) || 2);

      cad.selectedEquip.greenDuration = g;
      cad.selectedEquip.redDuration = r;
      cad.selectedEquip.yellowDuration = y;
      cad.selectedEquip.duration = g;
      cad.selectedEquip.phaseStartTime = Date.now();
      cad.selectedEquip.timer = (cad.selectedEquip.state === 'green' ? g : (cad.selectedEquip.state === 'red' ? r : y));

      updateSelectedPropertyPanel({ type: 'equipment', item: cad.selectedEquip });
      render();

      const ins = document.getElementById('instruction-text');
      if (ins) {
        ins.innerHTML = `⏱️ <strong>Semáforo atualizado com sucesso!</strong> Verde: <strong>${g}s</strong> | Vermelho: <strong>${r}s</strong> | Amarelo: <strong>${y}s</strong>.`;
      }
      alert(`Tempo configurado com sucesso para este semáforo:\n• Verde: ${g}s\n• Vermelho: ${r}s\n• Amarelo: ${y}s`);
    });
  }

  // Change road type
  const applyRoadBtn = document.getElementById('btn-apply-road-type');
  if (applyRoadBtn) {
    applyRoadBtn.addEventListener('click', () => {
      if (!cad.selectedRoad) {
        alert('Selecione uma via primeiro!');
        return;
      }
      pushHistoryState();
      const select = document.getElementById('select-change-type');
      const newType = select ? select.value : 'highway-twin';
      cad.selectedRoad.type = newType;
      cad.selectedRoad.name = ROAD_PROFILES[newType].name;
      updateSelectedPropertyPanel({ type: 'road', item: cad.selectedRoad });
      render();
      alert(`Via alterada para: ${ROAD_PROFILES[newType].name}!`);
    });
  }

  // Toggle road direction (Mão Dupla <-> Sentido Único)
  const toggleRoadDirBtn = document.getElementById('btn-toggle-road-dir');
  if (toggleRoadDirBtn) {
    toggleRoadDirBtn.addEventListener('click', () => {
      if (!cad.selectedRoad) {
        alert('Selecione uma via primeiro na tela!');
        return;
      }
      pushHistoryState();
      cad.selectedRoad.direction = (cad.selectedRoad.direction === 'one-way' ? 'two-way' : 'one-way');
      rebuildTraffic();
      updateSelectedPropertyPanel({ type: 'road', item: cad.selectedRoad });
      render();
      const isNowTwoWay = (cad.selectedRoad.direction !== 'one-way');
      const ins = document.getElementById('instruction-text');
      if (ins) {
        ins.innerHTML = `Via alterada para <strong>${isNowTwoWay ? '⇄ Mão Dupla (Ida e Volta)' : '➔ Sentido Único'}</strong>! Faixas e trânsito atualizados.`;
      }
    });
  }

  // Target Lane Selection on Equipment in Property Panel
  const equipTargetLaneSelect = document.getElementById('select-equip-target-lane');
  if (equipTargetLaneSelect) {
    equipTargetLaneSelect.addEventListener('change', (e) => {
      if (!cad.selectedEquip) return;
      pushHistoryState();
      cad.selectedEquip.targetLane = e.target.value;
      updateSelectedPropertyPanel({ type: 'equipment', item: cad.selectedEquip });
      render();
      const ins = document.getElementById('instruction-text');
      if (ins) {
        const laneDesc = e.target.value === 'right' ? 'Faixa da Direita (IDA)' : (e.target.value === 'left' ? 'Faixa da Esquerda (VOLTA)' : 'Todas as Faixas');
        ins.innerHTML = `Equipamento agora atua na: <strong>${laneDesc}</strong>!`;
      }
    });
  }

  // Delete Element
  const deleteBtn = document.getElementById('btn-delete-element');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      pushHistoryState();
      if (cad.selectedRoad) {
        cad.roads = cad.roads.filter(r => r.id !== cad.selectedRoad.id);
        cad.selectedRoad = null;
      } else if (cad.selectedEquip) {
        cad.equipments = cad.equipments.filter(e => e.id !== cad.selectedEquip.id);
        cad.selectedEquip = null;
      }
      updateSelectedPropertyPanel(null);
      rebuildTraffic();
      updateInfrastructureStats();
      render();
    });
  }

  // Preset
  const presetBtn = document.getElementById('btn-preset-photo');
  if (presetBtn) presetBtn.addEventListener('click', loadPhotoRealisticPreset);

  // Floating Zoom Controls
  const zoomIn = document.getElementById('fbtn-zoom-in');
  if (zoomIn) {
    zoomIn.addEventListener('click', () => {
      cad.zoom = Math.min(6.0, cad.zoom * 1.25);
      if (leafletMap && cad.mapMode !== 'cad' && leafletMap.getZoom() < 19) {
        leafletMap.zoomIn();
      }
      render();
    });
  }
  const zoomOut = document.getElementById('fbtn-zoom-out');
  if (zoomOut) {
    zoomOut.addEventListener('click', () => {
      cad.zoom = Math.max(0.2, cad.zoom / 1.25);
      if (leafletMap && cad.mapMode !== 'cad' && leafletMap.getZoom() > 14) {
        leafletMap.zoomOut();
      }
      render();
    });
  }
  const zoomFit = document.getElementById('fbtn-fit');
  if (zoomFit) {
    zoomFit.addEventListener('click', () => {
      cad.panX = canvas.width / 2;
      cad.panY = canvas.height / 2;
      cad.zoom = 1.0;
      if (leafletMap && cad.mapCenter) {
        leafletMap.setView(cad.mapCenter, 18);
      }
      render();
    });
  }

  // Undo / Redo / Clear / Erase
  const undoBtn = document.getElementById('btn-undo');
  if (undoBtn) undoBtn.addEventListener('click', undo);

  const redoBtn = document.getElementById('btn-redo');
  if (redoBtn) redoBtn.addEventListener('click', redo);

  const eraseBtn = document.getElementById('btn-quick-erase');
  if (eraseBtn) {
    eraseBtn.addEventListener('click', () => {
      setMode(cad.mode === 'erase' ? 'draw-road' : 'erase');
    });
  }

  const clearBtn = document.getElementById('btn-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (confirm('Deseja limpar todos os elementos?')) {
        pushHistoryState();
        cad.roads = [];
        cad.equipments = [];
        cad.cars = [];
        cad.selectedRoad = null;
        cad.selectedEquip = null;
        updateInfrastructureStats();
        render();
      }
    });
  }

  const saveBtn = document.getElementById('btn-save-project');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      localStorage.setItem('urbancad_sim_save', JSON.stringify({
        roads: cad.roads,
        equipments: cad.equipments
      }));
      alert('Projeto salvo com sucesso no navegador!');
    });
  }

  // Lane Connector Preset Actions
  const btnAutoLink = document.getElementById('btn-auto-link-lanes');
  if (btnAutoLink) {
    btnAutoLink.addEventListener('click', () => {
      if (!cad.selectedRoad) return;
      const conn = findConnectedRoadAt(cad.selectedRoad.points[0].x, cad.selectedRoad.points[0].y, cad.selectedRoad, 60) ||
                   findConnectedRoadAt(cad.selectedRoad.points[cad.selectedRoad.points.length - 1].x, cad.selectedRoad.points[cad.selectedRoad.points.length - 1].y, cad.selectedRoad, 60);
      if (!conn) return;
      pushHistoryState();
      const numL = (ROAD_PROFILES[cad.selectedRoad.type] || ROAD_PROFILES['highway-twin']).lanes || 4;
      const targetL = (ROAD_PROFILES[conn.road.type] || ROAD_PROFILES['highway-twin']).lanes || 4;
      cad.selectedRoad.laneLinks = [];
      for (let f = 0; f < numL; f++) {
        cad.selectedRoad.laneLinks.push({ targetRoadId: conn.road.id, fromLane: f, toLane: f % targetL });
      }
      updateSelectedPropertyPanel({ type: 'road', item: cad.selectedRoad });
      render();
    });
  }

  const btnRightLink = document.getElementById('btn-right-link-lanes');
  if (btnRightLink) {
    btnRightLink.addEventListener('click', () => {
      if (!cad.selectedRoad) return;
      const conn = findConnectedRoadAt(cad.selectedRoad.points[0].x, cad.selectedRoad.points[0].y, cad.selectedRoad, 60) ||
                   findConnectedRoadAt(cad.selectedRoad.points[cad.selectedRoad.points.length - 1].x, cad.selectedRoad.points[cad.selectedRoad.points.length - 1].y, cad.selectedRoad, 60);
      if (!conn) return;
      pushHistoryState();
      const numL = (ROAD_PROFILES[cad.selectedRoad.type] || ROAD_PROFILES['highway-twin']).lanes || 4;
      const targetL = (ROAD_PROFILES[conn.road.type] || ROAD_PROFILES['highway-twin']).lanes || 4;
      cad.selectedRoad.laneLinks = [];
      for (let f = 0; f < numL; f++) {
        cad.selectedRoad.laneLinks.push({ targetRoadId: conn.road.id, fromLane: f, toLane: targetL - 1 });
      }
      updateSelectedPropertyPanel({ type: 'road', item: cad.selectedRoad });
      render();
    });
  }

  const btnClearLink = document.getElementById('btn-clear-link-lanes');
  if (btnClearLink) {
    btnClearLink.addEventListener('click', () => {
      if (!cad.selectedRoad) return;
      pushHistoryState();
      cad.selectedRoad.laneLinks = [];
      updateSelectedPropertyPanel({ type: 'road', item: cad.selectedRoad });
      render();
    });
  }

  // UrbanAI Drawer & Quick Actions
  const btnOpenAi = document.getElementById('btn-open-urban-ai');
  if (btnOpenAi) btnOpenAi.addEventListener('click', openUrbanAiDrawer);

  const btnCloseAi = document.getElementById('btn-close-urban-ai');
  if (btnCloseAi) btnCloseAi.addEventListener('click', closeUrbanAiDrawer);

  const actAutoConnect = document.getElementById('ai-act-autoconnect');
  if (actAutoConnect) actAutoConnect.addEventListener('click', urbanAiAutoConnect);

  const actRoundabout = document.getElementById('ai-act-roundabout');
  if (actRoundabout) actRoundabout.addEventListener('click', urbanAiCreateRoundabout);

  const actBalance = document.getElementById('ai-act-balance');
  if (actBalance) actBalance.addEventListener('click', urbanAiOptimizeTraffic);

  const actRamp = document.getElementById('ai-act-ramp');
  if (actRamp) actRamp.addEventListener('click', urbanAiCreateRamp);

  // Quick prompt chips
  document.querySelectorAll('.ai-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const cmd = chip.dataset.cmd;
      const input = document.getElementById('ai-prompt-input');
      if (input) input.value = chip.innerText;
      if (cmd === 'autoconnect' || cmd === 'clean') urbanAiAutoConnect();
      else if (cmd === 'roundabout') urbanAiCreateRoundabout();
      else if (cmd === 'greenwave') urbanAiOptimizeTraffic();
      else if (cmd === 'link-right') urbanAiExecutePrompt('conectar na faixa da direita');
    });
  });

  const btnSendPrompt = document.getElementById('btn-send-ai-prompt');
  const inputPrompt = document.getElementById('ai-prompt-input');
  if (btnSendPrompt && inputPrompt) {
    btnSendPrompt.addEventListener('click', () => {
      const val = inputPrompt.value.trim();
      if (val) {
        urbanAiExecutePrompt(val);
        inputPrompt.value = '';
      }
    });
    inputPrompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = inputPrompt.value.trim();
        if (val) {
          urbanAiExecutePrompt(val);
          inputPrompt.value = '';
        }
      }
    });
  }
}

// -------------------------------------------------------------
// UrbanAI — Road Engineering & Traffic Optimization Copilot
// -------------------------------------------------------------
function openUrbanAiDrawer() {
  const drawer = document.getElementById('urban-ai-drawer');
  if (drawer) drawer.style.display = 'flex';
}

function closeUrbanAiDrawer() {
  const drawer = document.getElementById('urban-ai-drawer');
  if (drawer) drawer.style.display = 'none';
}

function appendAiChatMessage(sender, text) {
  const history = document.getElementById('ai-chat-history');
  if (!history) return;
  const msg = document.createElement('div');
  msg.className = sender === 'user' ? 'ai-msg ai-msg-user' : 'ai-msg ai-msg-ai';
  msg.innerHTML = sender === 'user' ? `<strong>Você:</strong> ${text}` : `<strong>UrbanAI:</strong> ${text}`;
  history.appendChild(msg);
  history.scrollTop = history.scrollHeight;
}

function urbanAiAutoConnect() {
  pushHistoryState();
  let connectedCount = 0;

  for (let i = 0; i < cad.roads.length; i++) {
    const rA = cad.roads[i];
    const ptsA = rA.points;
    if (!ptsA || ptsA.length < 2) continue;

    for (let j = 0; j < cad.roads.length; j++) {
      if (i === j) continue;
      const rB = cad.roads[j];
      const ptsB = rB.points;
      if (!ptsB || ptsB.length < 2) continue;

      const profB = ROAD_PROFILES[rB.type] || ROAD_PROFILES['highway-twin'];

      // Check start of rA
      const connStart = findConnectedRoadAt(ptsA[0].x, ptsA[0].y, rA, 70);
      if (connStart && connStart.road.id === rB.id) {
        const pB1 = ptsB[connStart.segIdx];
        const pB2 = ptsB[connStart.segIdx + 1];
        const t = connStart.progress;
        ptsA[0] = { x: pB1.x + (pB2.x - pB1.x) * t, y: pB1.y + (pB2.y - pB1.y) * t };
        if (!rA.laneLinks) rA.laneLinks = [];
        const numL = (ROAD_PROFILES[rA.type] || ROAD_PROFILES['highway-twin']).lanes || 4;
        const targetL = profB.lanes || 4;
        for (let l = 0; l < numL; l++) {
          if (!rA.laneLinks.some(link => link.targetRoadId === rB.id && link.fromLane === l)) {
            rA.laneLinks.push({ targetRoadId: rB.id, fromLane: l, toLane: l % targetL });
          }
        }
        connectedCount++;
      }

      // Check end of rA
      const lastIdx = ptsA.length - 1;
      const connEnd = findConnectedRoadAt(ptsA[lastIdx].x, ptsA[lastIdx].y, rA, 70);
      if (connEnd && connEnd.road.id === rB.id) {
        const pB1 = ptsB[connEnd.segIdx];
        const pB2 = ptsB[connEnd.segIdx + 1];
        const t = connEnd.progress;
        ptsA[lastIdx] = { x: pB1.x + (pB2.x - pB1.x) * t, y: pB1.y + (pB2.y - pB1.y) * t };
        if (!rA.laneLinks) rA.laneLinks = [];
        const numL = (ROAD_PROFILES[rA.type] || ROAD_PROFILES['highway-twin']).lanes || 4;
        const targetL = profB.lanes || 4;
        for (let l = 0; l < numL; l++) {
          if (!rA.laneLinks.some(link => link.targetRoadId === rB.id && link.fromLane === l)) {
            rA.laneLinks.push({ targetRoadId: rB.id, fromLane: l, toLane: l % targetL });
          }
        }
        connectedCount++;
      }
    }
  }

  rebuildTraffic();
  updateInfrastructureStats();
  render();

  appendAiChatMessage('ai', `🛠️ <strong>Auto-Conexão de Vias Concluída!</strong> Foram ajustadas com sucesso as conexões. As pontas redondas foram eliminadas através de corte reto, o asfalto foi nivelado na junção e as faixas foram interligadas. Os veículos já estão circulando entre as pistas!`);
}

function urbanAiCreateRoundabout() {
  pushHistoryState();
  const center = cad.selectedRoad ? cad.selectedRoad.points[0] : { x: 0, y: 0 };
  const radius = 55;
  const numPts = 12;
  const roundPts = [];

  for (let i = 0; i <= numPts; i++) {
    const angle = (i / numPts) * Math.PI * 2;
    roundPts.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius
    });
  }

  const roundRoad = {
    id: 'roundabout_' + Date.now(),
    name: 'Rotatória Urbana Circular',
    type: 'avenue-real',
    direction: 'one-way',
    points: roundPts,
    length: Math.PI * 2 * radius
  };

  cad.roads.push(roundRoad);
  spawnRealisticCars(roundRoad);
  updateInfrastructureStats();
  render();

  appendAiChatMessage('ai', `🔄 <strong>Rotatória Moderna Gerada!</strong> Criada rotatória de 4 faixas com raio de 55m em sentido único contínuo. As vias confluentes podem agora ser engatadas diretamente nas bordas da rotatória!`);
}

function urbanAiOptimizeTraffic() {
  pushHistoryState();
  cad.speedMultiplier = 1.2;
  const speedSlider = document.getElementById('traffic-speed-slider');
  if (speedSlider) speedSlider.value = '1.2';
  const valEl = document.getElementById('speed-multiplier-val');
  if (valEl) valEl.innerText = '1.2x';

  // Synchronize all traffic lights for a green wave
  let offset = 0;
  cad.equipments.forEach(eq => {
    if (eq.type === 'traffic-light') {
      eq.greenDuration = 10;
      eq.redDuration = 10;
      eq.yellowDuration = 2;
      eq.duration = 10;
      eq.phaseStartTime = Date.now() - (offset * 1000);
      offset = (offset + 4) % 10;
    }
  });

  // Rebalance lane connections for all roads
  cad.roads.forEach(r => {
    if (r.laneLinks) {
      const prof = ROAD_PROFILES[r.type];
      const lanes = prof.lanes || 4;
      r.laneLinks.forEach(l => {
        l.toLane = Math.min(lanes - 1, Math.max(0, l.toLane));
      });
    }
  });

  rebuildTraffic();
  render();
  appendAiChatMessage('ai', `⚖️ <strong>Otimização de Tráfego Aplicada!</strong> Velocidade de fluxo calibrada para 1.2x, semáforos sincronizados com Onda Verde progressiva (10s) e faixas balanceadas para eliminar gargalos.`);
}

function urbanAiCreateRamp() {
  pushHistoryState();
  const center = cad.selectedRoad ? cad.selectedRoad.points[0] : { x: -100, y: 0 };
  const rampPts = [
    { x: center.x - 140, y: center.y - 80 },
    { x: center.x - 60, y: center.y - 40 },
    { x: center.x + 40, y: center.y + 20 },
    { x: center.x + 140, y: center.y + 60 }
  ];

  const ramp = {
    id: 'ramp_' + Date.now(),
    name: 'Alça de Acesso / Concordância',
    type: 'street-real',
    direction: 'one-way',
    points: rampPts,
    length: 320
  };

  cad.roads.push(ramp);
  spawnRealisticCars(ramp);
  updateInfrastructureStats();
  render();

  appendAiChatMessage('ai', `🌉 <strong>Alça de Acesso Criada!</strong> Nova via de concordância suave adicionada para escoamento do tráfego entre diferentes pistas.`);
}

function urbanAiExecutePrompt(rawText) {
  const text = (rawText || '').toLowerCase().trim();
  if (!text) return;

  appendAiChatMessage('user', rawText);

  if (text.includes('ponta') || text.includes('redonda') || text.includes('nivelar') || text.includes('corte')) {
    urbanAiAutoConnect();
  } else if (text.includes('rotat') || text.includes('girador') || text.includes('circular')) {
    urbanAiCreateRoundabout();
  } else if (text.includes('onda verde') || text.includes('semaforo') || text.includes('semáforo') || text.includes('otimiz') || text.includes('trafego') || text.includes('tráfego')) {
    urbanAiOptimizeTraffic();
  } else if (text.includes('alca') || text.includes('alça') || text.includes('rampa') || text.includes('trevo')) {
    urbanAiCreateRamp();
  } else if (text.includes('direita') || text.includes('faixa')) {
    if (cad.selectedRoad) {
      const prof = ROAD_PROFILES[cad.selectedRoad.type];
      const numL = prof.lanes || 4;
      const conn = findConnectedRoadAt(cad.selectedRoad.points[cad.selectedRoad.points.length - 1].x, cad.selectedRoad.points[cad.selectedRoad.points.length - 1].y, cad.selectedRoad, 60);
      if (conn) {
        cad.selectedRoad.laneLinks = [];
        for (let l = 0; l < numL; l++) {
          cad.selectedRoad.laneLinks.push({ targetRoadId: conn.road.id, fromLane: l, toLane: (ROAD_PROFILES[conn.road.type]?.lanes || 4) - 1 });
        }
        rebuildTraffic();
        render();
        appendAiChatMessage('ai', `➡️ <strong>Faixas Conectadas à Direita!</strong> Todas as faixas de rolamento da via selecionada agora entram diretamente na faixa da direita da via conectada.`);
        return;
      }
    }
    urbanAiAutoConnect();
  } else {
    urbanAiAutoConnect();
  }
}

// Initial Bootstrapping
window.addEventListener('DOMContentLoaded', () => {
  resizeCanvas();
  setupUI();
  initLeafletMap();
  loadPhotoRealisticPreset();
  setMode('select');
  requestAnimationFrame(updateSimulation);
});
