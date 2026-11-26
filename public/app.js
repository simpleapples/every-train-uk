// Browser side: keeps a copy of every train's current segment (pushed over
// SSE) and animates each one along the track between its timing points.

const FRAME_MS = 250;
const RAIL_ATTRIBUTION = 'Contains information of Network Rail Infrastructure Limited licensed under the Network Rail data feeds licence. Stations: NaPTAN (OGL).';
// Great Britain's railway, for the opening view.
const GB_BOUNDS = [[-6.3, 50.0], [1.8, 58.6]];
// How far the map may be dragged: well past Britain on every side, so any
// corner of it can be moved clear of the search bar, the card or the sheet.
const MAX_BOUNDS = [[-30, 40], [22, 68]];
const DELAY_COLORS = { ontime: '#1a9e6f', minor: '#e8a317', major: '#d9412b' };
// National Rail plus TfL's networks; each can be switched on and off.
const NETWORKS = ['rail', 'tube', 'overground', 'elizabeth-line', 'dlr'];
const NET_LABELS = { rail: 'National Rail', tube: 'Tube', overground: 'Overground', 'elizabeth-line': 'Elizabeth line', dlr: 'DLR' };
const NET_COLORS = { rail: '#1a9e6f', tube: '#E32017', overground: '#EE7C0E', 'elizabeth-line': '#6950A1', dlr: '#00A4A7' };
const KMH_PER_MPH = 1.609344;
// Rows the Layers menu shows per list before "All".
const SHORT_LIST = 6;

const trains = new Map();
const paths = new Map(); // "line|from>to" -> { coords, cum } once loaded, null while loading or unavailable
// Which way each train last faced, kept while it stands at a station.
const headings = new Map();
let clockOffset = 0; // server clock minus browser clock
let selectedId = null;
let detail = null; // /api/train response for the selected train
let detailStamp = null; // which train state `detail` was fetched for
let pendingFit = false; // zoom to the selected train's route when its detail arrives
let following = false; // keep the selected train centred
let allStops = false; // the whole stop list, not just around the train
let lastStatus = null;
let streamOk = false; // false while the SSE connection to our server is down
let haveSnapshot = false; // trains have arrived at least once
let shown = new Set(NETWORKS);
// Lines ("tfl:central") and operators ("rail:LNER") switched off.
let hiddenLines = new Set();
let railLines = true; // railway lines overlay
let speedUnit = 'kmh'; // or 'mph'
let layersOpen = false;
const moreRows = { ops: false, lines: false }; // Layers lists shown in full
// The card (computer) or bottom sheet (phone): 'detail', 'nearby' or null.
let sheetMode = null;
let sheetFull = false; // phone sheet swiped up
let peekPx = 0; // phone sheet height when it only peeks
// Your position, once shared: { lon, lat, acc }.
let me = null;
let locating = false;
let watchId = null;

const $ = (id) => document.getElementById(id);
const sheet = $('sheet');
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
const hhmm = (ms) => (ms ? timeFmt.format(ms) : '');
const serverNow = () => Date.now() + clockOffset;
const isNarrow = () => window.innerWidth <= 640;
const coarse = matchMedia('(pointer: coarse)');

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

// Only touch the DOM when an element's markup really changed (keeps open
// <details>, focus and scroll positions).
const drawn = new Map();
function setHtml(el, html) {
  if (drawn.get(el) === html) return false;
  drawn.set(el, html);
  el.innerHTML = html;
  return true;
}

// Light or dark, as the system is set. The map's own colours follow; switching
// reloads the page, as the map's layers would otherwise need rebuilding.
const darkScheme = matchMedia('(prefers-color-scheme: dark)');
darkScheme.addEventListener('change', () => location.reload());
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const THEME = darkScheme.matches
  ? {
    style: 'https://tiles.openfreemap.org/styles/dark',
    ink: '#f2f4f7', inkPassed: '#98a2b3', halo: '#161b26', casing: '#0c111d', railLine: '#5b6578', me: '#5b8cff',
    // OpenRailwayMap's dark lines, lifted to grey to show on a dark map.
    rail: { 'raster-opacity': 0.22, 'raster-saturation': -1, 'raster-brightness-min': 0.3, 'raster-contrast': 0.1 }, railFocused: 0.1,
  }
  : {
    style: 'https://tiles.openfreemap.org/styles/positron',
    ink: '#1d2330', inkPassed: '#667085', halo: '#ffffff', casing: '#ffffff', railLine: '#8d97ab', me: '#2f6fed',
    rail: { 'raster-opacity': 0.45, 'raster-saturation': -1, 'raster-contrast': 0.15 }, railFocused: 0.2,
  };
const motion = (ms) => (reduceMotion.matches ? 0 : ms);

const map = new maplibregl.Map({
  container: 'map',
  style: THEME.style,
  bounds: GB_BOUNDS,
  fitBoundsOptions: { padding: mapPadding() },
  minZoom: 4,
  maxBounds: MAX_BOUNDS,
  // Added below, with the data sources' credits.
  attributionControl: false,
});

/**
 * Map padding that keeps routes and trains clear of the search bar, the card
 * (computer) or the sheet as it peeks (phone).
 */
function mapPadding() {
  const top = (isNarrow() ? 8 : 12) + 44 + 20;
  if (isNarrow()) return { top, right: 20, left: 20, bottom: (sheetMode ? peekPx : 48) + 20 };
  const left = sheetMode ? sheet.offsetLeft + sheet.offsetWidth + 40 : 40;
  return { top, right: 70, bottom: 60, left };
}

// ---- Train helpers ----

// National Rail trains, freight included, are coloured by lateness.
function category(t) {
  if (t.mode) return 'tfl';
  if (t.delayMin >= 5) return 'major';
  if (t.delayMin >= 1) return 'minor';
  return 'ontime';
}

const colorOf = (t) => t.color ?? DELAY_COLORS[category(t)];

// Lines and operators are shown as colour badges with short codes: compact,
// and no logos (the Network Rail data licence bars operator logos, and TfL's
// roundel and National Rail's double arrow are registered trade marks).
const TFL_LINES = {
  tube: { bakerloo: 'BAK', central: 'CEN', circle: 'CIR', district: 'DIS', 'hammersmith-city': 'H&C', jubilee: 'JUB', metropolitan: 'MET', northern: 'NOR', piccadilly: 'PIC', victoria: 'VIC', 'waterloo-city': 'W&C' },
  overground: { liberty: 'LIB', lioness: 'LIO', mildmay: 'MIL', suffragette: 'SUF', weaver: 'WEA', windrush: 'WIN' },
  'elizabeth-line': { elizabeth: 'EL' },
  dlr: { dlr: 'DLR' },
};
const TFL_COLORS = {
  bakerloo: '#B36305', central: '#E32017', circle: '#FFD300', district: '#00782A', 'hammersmith-city': '#F3A9BB', jubilee: '#A0A5A9',
  metropolitan: '#9B0056', northern: '#000000', piccadilly: '#003688', victoria: '#0098D4', 'waterloo-city': '#95CDBA',
  liberty: '#61686B', lioness: '#FAA61A', mildmay: '#006FE6', suffragette: '#18A95D', weaver: '#893B67', windrush: '#DC241F',
  elizabeth: '#6950A1', dlr: '#00A4A7',
};
const TFL_LINE_NAMES = {
  'hammersmith-city': 'Hammersmith & City', 'waterloo-city': 'Waterloo & City', elizabeth: 'Elizabeth line', dlr: 'DLR',
};
const lineName = (line) => TFL_LINE_NAMES[line] ?? `${line[0].toUpperCase()}${line.slice(1)}`;
// Train operators by name, with a short code and a colour for the badge.
const OPERATOR_BADGES = {
  LNER: ['LNER', '#CE0E2D'], 'Great Northern': ['GN', '#5C2D91'], 'Avanti West Coast': ['AWC', '#004354'], GWR: ['GWR', '#0A493E'],
  'East Midlands Railway': ['EMR', '#4C2A85'], Southeastern: ['SE', '#00AFE8'], 'Greater Anglia': ['GA', '#D70428'], Southern: ['SN', '#5D8A2C'],
  'South Western Railway': ['SWR', '#24398C'], 'TransPennine Express': ['TPE', '#09A4EC'], Northern: ['NT', '#262262'], CrossCountry: ['XC', '#660F21'],
  'Transport for Wales': ['TfW', '#C8102E'], ScotRail: ['SR', '#1E467D'], Freightliner: ['FL', '#B26E00'], 'DB Cargo': ['DB', '#EC0016'],
  // Live feed. Govia Thameslink is what TRUST says when the schedule (which
  // tells Thameslink, Southern, Great Northern and Gatwick Express apart) is not known.
  Thameslink: ['TL', '#E9438D'], 'Gatwick Express': ['GX', '#D6001C'], 'Govia Thameslink Railway': ['GTR', '#D5017A'],
  'West Midlands Trains': ['WMT', '#E07709'], 'Chiltern Railways': ['CH', '#1B9AD6'], c2c: ['c2c', '#B7007C'], Merseyrail: ['ME', '#FFCD00'],
  'Hull Trains': ['HT', '#DE005C'], 'Grand Central': ['GC', '#333333'], Lumo: ['LUMO', '#2B6CB0'], 'Caledonian Sleeper': ['CS', '#1F3A4D'],
  'Heathrow Express': ['HX', '#532E63'], 'Tyne and Wear Metro': ['TWM', '#FDB813'], Supertram: ['ST', '#0F4C81'], Eurostar: ['ES', '#F4C300'],
  'GB Railfreight': ['GBRf', '#F37021'], 'Direct Rail Services': ['DRS', '#0B3D91'], 'Colas Rail': ['COL', '#E8B400'],
  'Rail Operations Group': ['ROG', '#3E3E3E'], 'Balfour Beatty Rail': ['BBR', '#00467F'], 'Network Rail': ['NR', '#F5A100'],
  'West Coast Railways': ['WCR', '#7A1E2B'], 'Island Line': ['IL', '#2A7AB0'], 'North Yorkshire Moors Railway': ['NYMR', '#2F4F4F'],
  'Locomotive Services': ['LSL', '#4A4A4A'],
  // Shown as rail only when the TfL feed is off.
  'London Overground': ['LO', '#EE7C0E'], 'Elizabeth line': ['EL', '#6950A1'], 'Bakerloo line': ['BAK', '#B36305'], 'District line': ['DIS', '#00782A'],
};

/** A code for an operator without a badge of its own: its initials ("Serco Rail Operations" -> SRO). */
function initials(name) {
  const words = name.split(/[\s&-]+/).filter((w) => w && !/^(and|of|the)$/i.test(w));
  // Acronyms stay whole: "SB Rail" -> SBR, not SR (ScotRail).
  return words.length > 1 ? words.map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w[0].toUpperCase())).join('').slice(0, 4) : name.slice(0, 4).toUpperCase();
}

const netOfLine = (line) => NETWORKS.find((n) => TFL_LINES[n]?.[line]);
const tflBadge = (line) => ({ key: `tfl:${line}`, code: TFL_LINES[netOfLine(line)]?.[line] ?? line, color: TFL_COLORS[line] ?? '#475467', name: lineName(line) });

/** The line (TfL) or operator (National Rail) a train belongs to, as a badge. */
function badgeOf(t) {
  if (t.mode) return { ...tflBadge(t.line), color: t.color ?? TFL_COLORS[t.line], name: t.operator };
  const name = t.operator ?? `Operator ${t.toc || '?'}`;
  const [code, color] = OPERATOR_BADGES[name] ?? [t.operator ? initials(t.operator) : t.toc || '?', '#475467'];
  return { key: `rail:${name}`, code, color, name };
}

/** Dark text on light colours (Circle, H&C, Waterloo & City, Lioness, amber). */
const inks = new Map();
function textOn(hex) {
  let ink = inks.get(hex);
  if (!ink) {
    const n = parseInt(hex.slice(1), 16);
    const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    ink = lum > 0.62 ? '#101828' : '#ffffff';
    inks.set(hex, ink);
  }
  return ink;
}

/** A colour badge with the full name on hover; `cls` is 'lg' (titles) or 'fixed' (columns). */
function badgeHtml(b, cls = '') {
  return `<span class="lb${cls ? ` ${cls}` : ''}" style="background:${escapeHtml(b.color)};color:${textOn(b.color)}" data-tip="${escapeHtml(b.name)}">${escapeHtml(b.code)}</span>`;
}

/** Whether the train's network, and its line or operator, are switched on. */
const visible = (t) => shown.has(t.mode ?? 'rail') && !hiddenLines.has(badgeOf(t).key);

/** TfL's current disruption on a line, if any. */
const lineStatusOf = (line) => lastStatus?.sources?.tfl?.lines?.[line];

// Equirectangular metres are accurate enough over a few kilometres of track.
function metres(a, b) {
  const kx = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180) * 111320;
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110574);
}

/** Compass bearing from a to b in degrees, or null if they are the same point. */
function bearingOf(a, b) {
  const dx = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  const dy = b[1] - a[1];
  if (!dx && !dy) return null;
  return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
}

// Sections still to fetch: request item ("from>to" or "from>to@line") -> cache key.
const pathQueue = new Map();
let pathTimer = null;
const PATHS_PER_REQUEST = 100;

/** Track between two places; TfL trains use their own line's track. Null until it has loaded. */
function trackPath(from, to, line) {
  const key = `${line ?? ''}|${from}>${to}`;
  if (paths.has(key)) return paths.get(key);
  paths.set(key, null);
  pathQueue.set(line ? `${from}>${to}@${line}` : `${from}>${to}`, key);
  // Collect a frame's worth of sections into one request.
  pathTimer ??= setTimeout(fetchPaths, 30);
  return null;
}

function fetchPaths() {
  pathTimer = null;
  const items = [...pathQueue];
  pathQueue.clear();
  for (let i = 0; i < items.length; i += PATHS_PER_REQUEST) {
    const batch = items.slice(i, i + PATHS_PER_REQUEST);
    // no-store: earlier builds sent cacheable responses, possibly straight lines.
    fetch(`/api/paths?q=${encodeURIComponent(batch.map(([item]) => item).join(','))}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        for (const [item, key] of batch) {
          const coords = d.paths?.[item];
          if (!coords || coords.length < 2) continue;
          const cum = [0];
          for (let j = 1; j < coords.length; j++) cum.push(cum[j - 1] + metres(coords[j - 1], coords[j]));
          paths.set(key, { coords, cum });
        }
      })
      // Ask again next time these sections are needed.
      .catch(() => { for (const [, key] of batch) paths.delete(key); });
  }
}

/** The point a fraction f along a path, and the direction of travel there. */
function along(path, f) {
  const target = f * path.cum[path.cum.length - 1];
  let lo = 1;
  let hi = path.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (path.cum[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  const a = path.coords[lo - 1];
  const b = path.coords[lo];
  const span = path.cum[lo] - path.cum[lo - 1];
  const t = span ? (target - path.cum[lo - 1]) / span : 0;
  return { pos: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing: bearingOf(a, b) };
}

const progressOf = (t, now) => Math.min(1, Math.max(0, (now - t.departedAt) / t.runMs));

/** Where a train is now, and which way it faces (null until it has moved). */
function locate(t, now) {
  if (t.state !== 'moving' || !t.to) {
    let bearing = headings.get(t.id) ?? null;
    // Not seen moving yet: face along the track to where it goes next.
    if (bearing === null && t.state === 'stopped' && t.toward) {
      const path = trackPath(t.from.key, t.toward, t.line);
      if (path) bearing = along(path, 0).bearing;
    }
    return { pos: [t.from.lon, t.from.lat], bearing };
  }
  const f = progressOf(t, now);
  const path = trackPath(t.from.key, t.to.key, t.line);
  const here = path
    ? along(path, f)
    : {
      pos: [t.from.lon + (t.to.lon - t.from.lon) * f, t.from.lat + (t.to.lat - t.from.lat) * f],
      bearing: bearingOf([t.from.lon, t.from.lat], [t.to.lon, t.to.lat]),
    };
  if (here.bearing === null) here.bearing = headings.get(t.id) ?? null;
  else headings.set(t.id, here.bearing);
  return here;
}

const positionOf = (t, now) => locate(t, now).pos;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function delayLabel(t) {
  if (t.delayMin > 0) return `+${t.delayMin} min`;
  if (t.freight) return '';
  if (t.delayMin < 0) return `${-t.delayMin} min early`;
  return 'On time';
}

/** Short text name (search sorting, plain-text contexts). */
function nameOf(t) {
  if (t.mode) return t.destination ? `${t.operator} → ${t.destination}` : t.operator;
  return [t.headcode, t.operator].filter(Boolean).join(' · ');
}

/** Headcode (rail) and destination, as text. */
function shortText(t) {
  const to = t.destination ? `→ ${t.destination}` : '';
  return (t.mode ? to || t.operator : [t.headcode, to].filter(Boolean).join(' ')) ?? '';
}

/** Badge plus the shortest useful text (map tooltip). */
function shortHtml(t) {
  return `${badgeHtml(badgeOf(t))}<span class="short-text">${escapeHtml(shortText(t))}</span>`;
}

/** Title row: badge, then headcode and lateness for rail, line name for TfL. */
function titleHtml(t) {
  const badge = badgeHtml(badgeOf(t), 'lg');
  if (t.mode) return `${badge}<span class="hc">${escapeHtml(t.operator)}</span>`;
  const delay = delayLabel(t);
  return `${badge}<span class="hc">${escapeHtml(t.headcode)}</span>${delay ? `<span class="pill ${category(t)}">${escapeHtml(delay)}</span>` : ''}`;
}

// ---- Units ----

const fmtSpeed = (kmh) => (speedUnit === 'mph' ? `${Math.round(kmh / KMH_PER_MPH)} mph` : `${Math.round(kmh)} km/h`);
const NEAR_METRES = () => (speedUnit === 'mph' ? 2 * 1609.344 : 3000);
const NEAR_LABEL = () => (speedUnit === 'mph' ? '2 miles' : '3 km');
function fmtDistance(m) {
  if (speedUnit === 'mph') return m < 400 ? `${Math.round(m / 0.9144 / 10) * 10} yd` : `${(m / 1609.344).toFixed(1)} mi`;
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

// No public feed gives real speeds (no GPS), so the figure is an average over
// the section; the tooltip says how it was worked out.
function speedOf(t) {
  if (t.state !== 'moving') return null;
  const measured = t.measuredKmh ? `Measured ${fmtSpeed(t.measuredKmh)} over ${t.measuredSection}, from actual report times.` : '';
  const top = t.topKmh ? `Never shown above its top speed, ${fmtSpeed(t.topKmh)}.` : '';
  if (t.speedKmh) {
    const how = t.mode ? 'Average over this section, from TfL arrival predictions.' : 'Average over this section, from its scheduled running time.';
    return { text: `≈ ${fmtSpeed(t.speedKmh)}`, tip: [how, measured, top].filter(Boolean).join(' ') };
  }
  return t.measuredKmh ? { text: fmtSpeed(t.measuredKmh), tip: [measured, top].filter(Boolean).join(' ') } : null;
}

// ---- Icons ----

const svg = (body, extra = '') => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;
const ICONS = {
  train: svg('<rect x="4.5" y="2.5" width="11" height="11.5" rx="2.5"/><path d="M4.5 8.5h11M7.5 11.25h.01M12.5 11.25h.01M7 14l-2 3.5M13 14l2 3.5"/>'),
  pin: svg('<path d="M10 17.5s5.5-5 5.5-9.25a5.5 5.5 0 0 0-11 0C4.5 12.5 10 17.5 10 17.5z"/><circle cx="10" cy="8.25" r="2"/>'),
  route: svg('<circle cx="5" cy="15" r="2"/><circle cx="15" cy="5" r="2"/><path d="M7 15h5.5a2.75 2.75 0 0 0 0-5.5h-5a2.75 2.75 0 0 1 0-5.5H13"/>'),
  recent: svg('<path d="M3.5 10a6.5 6.5 0 1 0 1.9-4.6M3.5 3.5v3h3"/><path d="M10 6.5V10l2.5 1.5"/>'),
  track: svg('<path d="M7.5 2.5 6 17.5M12.5 2.5 14 17.5M5.6 6h8.8M5.2 10h9.6M4.8 14h10.4"/>'),
  // An arrow pointing up and right: where am I.
  locate: svg('<path d="M16.5 3.5 3.5 9l5.5 2 2 5.5z"/>'),
};
const TRAIN_GLYPH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="2" width="9" height="9.5" rx="2"/><path d="M3.5 7h9M6 13.5 5 15M10 13.5l1 1.5"/></svg>';
const TFL_MARK = `<span class="tfl-mark" aria-hidden="true">${['tube', 'overground', 'elizabeth-line', 'dlr'].map((n) => `<i style="background:${NET_COLORS[n]}"></i>`).join('')}</span>`;

// ---- Train type: a side view of the kind of train, its class, and facility icons ----

const WHITE = 'fill="#fff" fill-opacity=".85"';
const wheels = (xs) => xs.map((x) => `<circle cx="${x}" cy="21.5" r="2" fill="#1d2330"/>`).join('');
const pantograph = (x) => `<path d="M${x} 7l5-4.5 5 4.5M${x + 2} 2.5h6" fill="none" stroke="#1d2330" stroke-width="1.2" stroke-linejoin="round"/>`;
const coach = (x, w) => `<rect x="${x}" y="7" width="${w}" height="12" rx="2"/><rect x="${x + 4}" y="10" width="${w - 8}" height="3.2" rx="1" ${WHITE}/>`;

/** Front to the right; drawn in the operator's colour. 112 x 26. */
function trainArt(s, freight) {
  const electric = s.traction === 'electric' && !s.thirdRail;
  if (s.kind === 'loco') {
    const loco = `<path d="M66 6h37a3 3 0 0 1 3 3v10H66z"/><rect x="101.5" y="8.5" width="3" height="4" rx=".8" ${WHITE}/>`
      + `<rect x="67.5" y="8.5" width="3" height="4" rx=".8" ${WHITE}/><rect x="74" y="9" width="22" height="2" rx="1" fill="#fff" fill-opacity=".3"/>`
      + wheels([71, 77, 95, 101]) + (electric ? pantograph(80) : '');
    const hauled = freight
      ? [2, 34].map((x) => `<rect x="${x}" y="16" width="29" height="3" fill="#475467"/><rect x="${x + 2}" y="9" width="25" height="7" rx="1" fill="#98a2b3"/>`).join('') + wheels([7, 26, 39, 58])
      : coach(2, 29) + coach(34, 29) + wheels([7, 26, 39, 58]);
    return hauled + loco;
  }
  if (s.kind === 'tube') {
    // Deep-level Tube trains: the round-topped profile of the tunnels they run in.
    return `<path d="M2 19v-6.5C2 9.5 5 7 9 7h36c4 0 7 2.5 7 5.5V19z"/><rect x="7" y="10" width="40" height="3.2" rx="1" ${WHITE}/>`
      + `<path d="M55 19v-6.5c0-3 3-5.5 7-5.5h38c3.5 0 6 2.8 6 6v6z"/><rect x="60" y="10" width="37" height="3.2" rx="1" ${WHITE}/><rect x="101.5" y="9.5" width="3" height="4" rx=".8" ${WHITE}/>`
      + wheels([9, 15, 39, 45, 62, 68, 92, 98]);
  }
  const lead = s.kind === 'high-speed'
    ? `<path d="M55 7h33c8 0 15 4 20 10v2H55z"/><rect x="59" y="10" width="27" height="3.2" rx="1" ${WHITE}/><path d="M92 9.2c4.3.9 8 3.2 10.6 6.3H96z" ${WHITE}/>`
    : `<path d="M55 7h47a4 4 0 0 1 4 4v8H55z"/><rect x="59" y="10" width="38" height="3.2" rx="1" ${WHITE}/><rect x="101.5" y="9.5" width="3" height="4" rx=".8" ${WHITE}/>`;
  const roof = electric ? pantograph(68) : s.traction === 'diesel' && s.kind !== 'high-speed' ? '<rect x="74" y="5" width="4" height="2" rx=".5"/>' : '';
  return coach(2, 50) + lead + roof + wheels([9, 15, 39, 45, 62, 68, 92, 98]);
}

// Facility icons, 16 x 16, stroked.
const FACILITY_ICONS = {
  cup: 'M3 6h8v3.5A3.5 3.5 0 0 1 7.5 13h-1A3.5 3.5 0 0 1 3 9.5zM11 7.5h1a1.75 1.75 0 0 1 0 3.5h-1.2M5.5 2.5V4M8.5 2.5V4',
  cutlery: 'M4.5 2v4a1.5 1.5 0 0 0 3 0V2M6 6v8M11.5 14V2c-1.7 1-2.5 3-2.5 5.5 0 1 .5 1.5 1.5 1.5h1',
  bed: 'M1.5 12.5V4M1.5 9.5h13v3M14.5 9.5v-1a2 2 0 0 0-2-2H7v3M4.25 6.25a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5',
  ticket: 'M2 4h12v2.5a1.5 1.5 0 0 0 0 3V12H2V9.5a1.5 1.5 0 0 0 0-3zM9.5 4.5v1.5M9.5 7.25v1.5M9.5 10v1.5',
  snow: 'M8 1.5v13M2.4 4.75l11.2 6.5M2.4 11.25l11.2-6.5M6.2 2.6 8 4l1.8-1.4M6.2 13.4 8 12l1.8 1.4',
  bike: 'M4 13.25a2.75 2.75 0 1 1 0-5.5 2.75 2.75 0 0 1 0 5.5M12 13.25a2.75 2.75 0 1 1 0-5.5 2.75 2.75 0 0 1 0 5.5M4 10.5 6.5 6h4.5l1 4.5M6.5 6l2 4.5L11 6M5.5 4.5h2',
};
const ICON_OF = { buffet: 'cup', trolley: 'cup', 'hot-food': 'cup', restaurant: 'cutlery', meal: 'cutlery', sleeper: 'bed', reservations: 'ticket', bike: 'bike', 'air-con': 'snow' };

function facilitiesHtml(features) {
  const icons = new Map(); // icon -> labels, so a buffet and a trolley share one cup
  let first = '';
  for (const f of features) {
    if (f.id === 'first') first = '<span class="fac-first" data-tip="First class" aria-label="First class">1st</span>';
    else if (ICON_OF[f.id]) icons.set(ICON_OF[f.id], [...(icons.get(ICON_OF[f.id]) ?? []), f.label]);
  }
  return first + [...icons].map(([icon, labels]) => {
    const label = escapeHtml(labels.join(', '));
    return `<span class="fac" role="img" aria-label="${label}" data-tip="${label}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="${FACILITY_ICONS[icon]}"/></svg></span>`;
  }).join('');
}

/** "Class 220/221 Voyager" -> "Class 220/221"; the fleet name stays in the tooltip. */
function shortStock(stock) {
  if (!stock.startsWith('Class ')) return stock;
  const words = stock.slice(6).split(' ').filter((w) => /^[\d/]+$/.test(w) || w === 'or');
  while (words.at(-1) === 'or') words.pop();
  return words.length ? `Class ${words.join(' ')}` : stock;
}

/** One line under the route: a small side view, class, top speed, facilities. */
function metaHtml(t, s) {
  if (!s) return '';
  const color = badgeOf(t).color;
  const art = s.kind ? `<svg class="mini-art" viewBox="0 0 112 26" style="color:${escapeHtml(color)}" aria-hidden="true"><g fill="currentColor">${trainArt(s, t.freight)}</g></svg>` : '';
  const parts = [];
  if (s.stock) parts.push(`<span data-tip="${escapeHtml(s.stock)}">${escapeHtml(shortStock(s.stock))}</span>`);
  if (s.maxMph) parts.push(`<span>Top speed ${fmtSpeed(s.maxMph * KMH_PER_MPH)}</span>`);
  if (s.tonnes) parts.push(`<span>${s.tonnes.toLocaleString('en-GB')} t</span>`);
  const facilities = facilitiesHtml(s.features);
  return art + parts.join('<span class="m-sep">·</span>') + (facilities ? `<span class="m-fac">${facilities}</span>` : '');
}

function detailFor(t) {
  return detail?.train.id === t.id ? detail : null;
}

/** "Origin → Destination" when the whole route is known. */
function routeLabel(t) {
  // Rail: first and last passenger stops, from the train's schedule.
  if (t.origin && t.destination) return t.origin === t.destination ? `Round trip from ${t.origin}` : `${t.origin} → ${t.destination}`;
  const d = detailFor(t);
  if (!d?.stops.length) return t.destination ? `To ${t.destination}` : '';
  if (!d.timetabled) return `From ${d.stops[0].name}`;
  return `${d.stops[0].name} → ${d.stops[d.stops.length - 1].name}`;
}

/** Where the train is, in a few words (search results, hover labels, the chooser). */
function whereLabel(t) {
  const d = detailFor(t);
  if (t.state === 'terminated') return `Terminated at ${t.from.name}`;
  if (t.state === 'stopped') return `At ${t.from.name}`;
  return `${d?.previous?.name ?? t.from.name} – ${d?.next?.name ?? t.to.name}`;
}

/** How busy the train usually is here: four bars, then the word and a head count. */
const LOAD_COLORS = ['#1a9e6f', '#86b41f', '#f79009', '#d9412b'];
function loadHtml(load) {
  if (!load) return '';
  const bars = [0, 1, 2, 3].map((i) => `<s style="height:${4 + i * 2}px${i <= load.level ? `;background:${LOAD_COLORS[load.level]}` : ''}"></s>`).join('');
  const tip = escapeHtml(`About ${load.people} people on board. ${load.basis}.`);
  return `<span class="co-load" data-tip="${tip}"><em class="meter">${bars}</em>${escapeHtml(load.label)} · ~${Number(load.people).toLocaleString('en-GB')} people</span>`;
}

/** Platform, how busy (TfL), and the report's age once it is old. */
function extraHtml(t, d, now) {
  const parts = [];
  if (t.platform) parts.push(`<span>${escapeHtml(t.mode ? t.platform : `Platform ${t.platform}`)}</span>`);
  if (d?.load) parts.push(loadHtml(d.load));
  if (now - t.reportedAt > 3 * 60_000) parts.push(`<span>Reported ${ago(now - t.reportedAt)}</span>`);
  return parts.join('');
}

function expectedOf(s, delayMin) {
  if (s.expectedArr) return s.expectedArr;
  const planned = s.plannedArr ?? s.plannedDep;
  return planned ? planned + Math.max(0, delayMin) * 60_000 : undefined;
}

const minutesUntil = (ms, now) => Math.max(0, Math.round((ms - now) / 60_000));
/** "9 min" when it is soon, the clock time when it is not. */
const untilLabel = (ms, now) => (ms - now < 60 * 60_000 ? `${minutesUntil(ms, now)} min` : hhmm(ms));

/** Phones: next stop, when, and speed, in the sheet as it peeks. */
function nextHtml(t, d, now) {
  if (t.state === 'terminated') return `<span class="mut">Terminated at</span> <b>${escapeHtml(t.from.name)}</b>`;
  if (t.state === 'stopped') return `<span class="mut">At</span> <b>${escapeHtml((d?.current ?? d?.previous)?.name ?? t.from.name)}</b>`;
  const next = d?.next?.name ?? t.to?.name;
  if (!next) return '';
  const exp = d?.next && expectedOf(d.next, t.delayMin);
  const speed = speedOf(t);
  const late = !t.mode && t.delayMin > 0;
  return `<span class="mut">Next</span> <b>${escapeHtml(next)}</b>`
    + (exp ? ` <span class="mut">·</span> <span class="${late ? 'late' : 'soon'}">${untilLabel(exp, now)}</span>` : '')
    + (speed ? ` <span class="mut">· ${speed.text}</span>` : '');
}

/** A line disruption that opens to show TfL's explanation. */
function disruptionHtml(line, s, withBadge) {
  const badge = withBadge ? badgeHtml(tflBadge(line), 'fixed') : '';
  const reason = s.reason ? `<p>${escapeHtml(s.reason)}</p>` : '';
  const text = withBadge ? `${lineName(line)} · ${s.summary}` : s.summary;
  return `<details class="disruption${s.closed ? ' closed' : ''}"><summary>${badge}<span>${escapeHtml(text)}</span></summary>${reason}</details>`;
}

// ---- Selection: route highlight and the train card ----

function select(id) {
  const t = trains.get(id);
  if (!t) return;
  closePops();
  selectedId = id;
  detail = null;
  detailStamp = null;
  allStops = false;
  // Zoom to the whole route once its detail arrives, even if a newer request
  // for the same train replaces the first one.
  pendingFit = true;
  setFollow(false);
  setRoute(null);
  $('d-calls').replaceChildren();
  $('d-more').hidden = true;
  setHtml($('d-note'), '');
  setHtml($('d-meta'), '');
  openSheet('detail');
  renderDetailHead(t);
  setFocusStyle();
  remember(t);
  loadDetail(id);
  render();
}

function clearSelection() {
  selectedId = null;
  detail = null;
  detailStamp = null;
  pendingFit = false;
  setFollow(false);
  setRoute(null);
  setFocusStyle();
  openSheet(locating && me ? 'nearby' : null);
}

/** While a train is selected, fade everything else so its route stands out. */
function setFocusStyle() {
  if (!map.getLayer('trains')) return;
  const focused = Boolean(selectedId);
  const dim = (v) => (focused ? ['case', ['==', ['get', 'selected'], true], 1, v] : 1);
  map.setPaintProperty('trains', 'icon-opacity', dim(0.15));
  map.setPaintProperty('train-labels', 'text-opacity', dim(0));
  map.setPaintProperty('openrailwaymap', 'raster-opacity', focused ? THEME.railFocused : THEME.rail['raster-opacity']);
}

function setFollow(on) {
  following = on;
  $('d-follow').setAttribute('aria-pressed', String(on));
  const t = on && selectedId && trains.get(selectedId);
  if (t) map.easeTo({ center: positionOf(t, serverNow()), zoom: Math.max(map.getZoom(), 11), padding: mapPadding(), duration: motion(600) });
}

const stampOf = (t) => `${t.id}|${t.from.key}|${t.state}`;

async function loadDetail(id) {
  const t = trains.get(id);
  if (!t) return;
  const stamp = stampOf(t);
  detailStamp = stamp;
  let d;
  try {
    const r = await fetch(`/api/train?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!r.ok) return;
    d = await r.json();
  } catch {
    return;
  }
  if (selectedId !== id || detailStamp !== stamp) return;
  setClock(d.serverTime);
  detail = d;
  setRoute(d);
  renderDetail(d);
  if (pendingFit) {
    pendingFit = false;
    fitRoute();
  }
}

/** Stations on the selected route; the line itself is drawn by drawRouteLine. */
function setRoute(d) {
  const source = map.getSource('route');
  if (!source) return;
  const features = [];
  for (const s of d?.stops ?? []) {
    if (!s.call || s.lat === undefined) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { name: s.name, status: s.status, color: d.train.color ?? '#2856d6' },
    });
  }
  source.setData({ type: 'FeatureCollection', features });
  drawRouteLine(serverNow());
}

/**
 * The first `dist` metres of a line, and the rest. Both share the cut point.
 */
function splitLine(coords, dist) {
  let done = 0;
  for (let i = 1; i < coords.length; i++) {
    const step = metres(coords[i - 1], coords[i]);
    if (done + step >= dist) {
      const f = step ? (dist - done) / step : 0;
      const a = coords[i - 1];
      const b = coords[i];
      const cut = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      return [[...coords.slice(0, i), cut], [cut, ...coords.slice(i)]];
    }
    done += step;
  }
  return [coords, coords.slice(-1)];
}

/**
 * The selected train's route in its colour: covered track pale, the rest
 * solid, split where the train is now rather than at its last station.
 */
function drawRouteLine(now) {
  const source = map.getSource('route-line');
  if (!source) return;
  const t = selectedId && trains.get(selectedId);
  const d = t && detailFor(t);
  if (!d) {
    source.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  let behind = d.pathBehind;
  let ahead = d.pathAhead;
  // The path ahead starts with the section the train is on, along the same
  // track the train is drawn on; cut it at the train.
  const section = t.state === 'moving' && t.to ? trackPath(t.from.key, t.to.key, t.line) : null;
  if (section && ahead.length > 1 && metres(section.coords[0], ahead[0]) < 50) {
    const [covered, rest] = splitLine(ahead, progressOf(t, now) * section.cum[section.cum.length - 1]);
    behind = behind.length ? [...behind, ...covered.slice(1)] : covered;
    ahead = rest;
  }
  const color = d.train.color ?? '#2856d6';
  const features = [];
  if (behind.length > 1) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: behind }, properties: { part: 'behind', color } });
  if (ahead.length > 1) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: ahead }, properties: { part: 'ahead', color } });
  source.setData({ type: 'FeatureCollection', features });
}

function fitRoute() {
  if (!detail) return;
  const coords = [...detail.pathBehind, ...detail.pathAhead];
  if (coords.length < 2) return;
  setFollow(false);
  if (sheetFull) setSheetFull(false);
  const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  map.fitBounds(bounds, { padding: mapPadding(), maxZoom: 12, duration: motion(800) });
}

function renderDetailHead(t) {
  setHtml($('d-title'), titleHtml(t));
  const route = $('d-route');
  if (setHtml(route, escapeHtml(routeLabel(t)))) {
    route.scrollLeft = 0;
    route.classList.remove('at-end');
  }
  route.classList.toggle('overflow', route.scrollWidth > route.clientWidth + 1);
}
$('d-route').addEventListener('scroll', (e) => {
  const el = e.target;
  el.classList.toggle('at-end', el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
}, { passive: true });

/** Next stop, platform and the like: change as the train runs, so redrawn every frame. */
function renderLive(t, now) {
  const d = detailFor(t);
  const changed = setHtml($('d-next'), nextHtml(t, d, now)) | setHtml($('d-extra'), extraHtml(t, d, now));
  if (changed) updatePeek();
}

// ---- Callout: beside the selected train on the map ----

const callout = document.createElement('div');
callout.className = 'callout';
let calloutMarker = null;

function calloutHtml(t, d, now) {
  // Phones: the sheet says the rest; just name the train.
  if (isNarrow()) return `<b>${escapeHtml(t.mode ? badgeOf(t).code : t.headcode)}</b>`;
  if (t.state === 'terminated') return `<b>Terminated</b><span>${escapeHtml(t.from.name)}</span>`;
  if (t.state === 'stopped') return `<b>Standing</b><span>${escapeHtml((d?.current ?? d?.previous)?.name ?? t.from.name)}</span>${loadHtml(d?.load)}`;
  const speed = speedOf(t);
  const next = d?.next?.name ?? t.to?.name;
  const exp = d?.next && expectedOf(d.next, t.delayMin);
  const when = exp ? untilLabel(exp, now) : '';
  return (speed ? `<b data-tip="${escapeHtml(speed.tip)}">${speed.text}</b>` : '')
    + (next ? `<span>→ ${escapeHtml(next)}${when ? ` · <i${!t.mode && t.delayMin > 0 ? ' class="late"' : ''}>${when}</i>` : ''}</span>` : '')
    + loadHtml(d?.load);
}

function renderCallout(t, now) {
  if (!t || !visible(t)) {
    calloutMarker?.remove();
    calloutMarker = null;
    return;
  }
  const pos = positionOf(t, now);
  if (!calloutMarker) calloutMarker = new maplibregl.Marker({ element: callout, anchor: 'left', offset: [14, 0] }).setLngLat(pos).addTo(map);
  else calloutMarker.setLngLat(pos);
  callout.classList.toggle('tag-only', isNarrow());
  setHtml(callout, calloutHtml(t, detailFor(t), now));
}

// ---- Stops ----

function timeOf(s, kind) {
  if (kind === 'actual') return s.actualDep ?? s.actualArr;
  return s.plannedDep ?? s.plannedArr;
}

// Beside a stop the map cannot show: its route stops short of it.
const NO_POSITION = '<svg class="c-nopos" viewBox="0 0 16 16" data-tip="Not on the map: no published position" aria-label="Not on the map"><path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 0 0-8.6-1.8M3.6 6.9C4 9.9 8 14 8 14M2.5 2.5l11 11"/></svg>';

function renderDetail(d) {
  const t = trains.get(d.train.id) ?? d.train;
  renderDetailHead(t);
  setHtml($('d-meta'), metaHtml(t, d.service));
  const status = t.mode ? lineStatusOf(t.line) : null;
  setHtml($('d-note'), status
    ? disruptionHtml(t.line, status, false)
    : !t.mode && !d.timetabled ? '<p class="note">Only stops reported so far (no timetable feed).</p>' : '');
  renderCalls(d, t, serverNow());
  renderLive(t, serverNow());
  updatePeek();
}

/**
 * The stops, around the train unless the whole list is open: the stop it
 * left, then the train itself on the line, then the next three.
 */
function renderCalls(d, t, now) {
  const tfl = Boolean(t.mode);
  // Only where the train stops. The places it runs through stay in d.stops:
  // they place it on the map and draw its route, but are not listed.
  const stops = d.stops.filter((s) => s.call);
  const here = t.state !== 'moving' ? stops.findIndex((s) => s.status === 'current') : -1;
  const lastDone = stops.findLastIndex((s) => s.status !== 'upcoming');
  const next = stops.findIndex((s) => s.status === 'upcoming');
  // Between stops: after `lastDone`, unless it has not left the first one yet.
  const between = here < 0 && lastDone >= 0 && lastDone < stops.length - 1 ? lastDone : -1;

  let from = 0;
  let to = stops.length;
  // A phone sheet swiped up has room for them all.
  const roomy = isNarrow() && sheetFull;
  const compact = !allStops && !roomy && stops.length > 6;
  if (compact) {
    from = Math.max(0, (here >= 0 ? here : Math.max(lastDone, 0)) - (here >= 0 ? 1 : 0));
    to = Math.min(stops.length, from + 5);
    from = Math.max(0, to - 5);
  }

  const color = badgeOf(t).color;
  const trainMark = `<span class="c-train" style="background:${escapeHtml(color)};color:${textOn(color)}">${TRAIN_GLYPH}</span>`;
  const items = [];
  for (let i = from; i < to; i++) {
    const s = stops[i];
    let left = '';
    let right = '';
    let rclass = '';
    if (tfl) {
      if (s.status === 'upcoming' && s.expectedArr) left = `${minutesUntil(s.expectedArr, now)} min`;
    } else {
      const planned = timeOf(s, 'planned');
      const actual = timeOf(s, 'actual');
      left = hhmm(planned);
      if (actual) {
        right = hhmm(actual);
        if (planned && actual - planned >= 60_000) rclass = 'late';
      } else if (i === next) {
        const exp = expectedOf(s, t.delayMin);
        if (exp) {
          right = untilLabel(exp, now);
          rclass = t.delayMin > 0 ? 'late' : 'soon';
        }
      } else if (s.status === 'upcoming' && planned && t.delayMin > 0) {
        right = hhmm(expectedOf(s, t.delayMin));
        rclass = 'late';
      }
    }
    const cls = [s.status, i === 0 && 'first', i === stops.length - 1 && 'last', i === here && 'here', i === next && 'next'].filter(Boolean).join(' ');
    items.push(`<li class="call ${escapeHtml(cls)}">
      <span class="c-time">${escapeHtml(left)}</span>
      ${i === here ? trainMark : '<span class="c-dot"></span>'}
      <span class="c-name">${escapeHtml(s.name)}${s.lat === undefined && !tfl ? NO_POSITION : ''}</span>
      <span class="c-rt ${rclass}">${escapeHtml(right)}</span>
    </li>`);
    // The train itself, on the line between the stop it left and the next one.
    if (i === between) items.push(`<li class="call now" aria-label="The train is here"><span></span>${trainMark}<span></span><span></span></li>`);
  }
  $('d-calls').innerHTML = items.join('');
  const more = $('d-more');
  more.hidden = stops.length <= 6 || roomy;
  more.textContent = allStops ? 'Fewer stops' : `All ${stops.length} stops`;
}

$('d-more').addEventListener('click', () => {
  allStops = !allStops;
  if (detail) renderDetail(detail);
});

// ---- Recent trains (on this device) ----

function remember(t) {
  const recent = store.get('recent', []).filter((r) => r.id !== t.id);
  recent.unshift({ id: t.id, text: `${t.mode ? t.operator : t.headcode} · ${routeLabel(t) || shortText(t)}` });
  store.set('recent', recent.slice(0, 5));
}

// ---- Search ----
//
// Headcode, line, operator or destination, matched here; and a station a train
// calls at, with or without a time ("Paddington 08:00"), asked of the server,
// which has the timetables.

let results = []; // { t, sub }
let activeResult = -1;
let stationHits = [];
let stationTimer = null;
let stationPending = false;
const TIME_IN_QUERY = /\b([01]?\d|2[0-3])[:.]?[0-5]\d\b/;
const input = $('search-input');

function searchTrains(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const t of trains.values()) {
    if (!visible(t)) continue;
    const hc = (t.headcode || '').toLowerCase();
    const has = (s) => Boolean(s) && s.toLowerCase().includes(q);
    // Headcode, then line or operator, then destination, then where it is now.
    let score = 0;
    if (hc && hc === q) score = 5;
    else if (hc && hc.startsWith(q)) score = 4;
    else if (has(t.operator) || badgeOf(t).code.toLowerCase() === q) score = 3;
    else if (has(t.destination) || has(t.origin)) score = 2;
    else if (has(t.from?.name) || has(t.to?.name)) score = 1;
    if (score) scored.push({ t, score });
  }
  scored.sort((a, b) => b.score - a.score || nameOf(a.t).localeCompare(nameOf(b.t)));
  return scored.slice(0, 8).map((s) => s.t);
}

/** The trains to list for a query: local matches, then trains calling at a station. */
function searchResults(query) {
  // With a time in it, the query is a station and a time.
  const local = TIME_IN_QUERY.test(query) ? [] : searchTrains(query).map((t) => ({ t, sub: whereLabel(t) }));
  const seen = new Set(local.map((r) => r.t.id));
  const calling = stationHits.flatMap((h) => {
    const t = trains.get(h.id);
    if (!t || seen.has(h.id) || !visible(t)) return [];
    seen.add(h.id);
    return [{ t, sub: `${h.kind === 'dep' ? 'Departs' : 'Arrives'} ${h.station} ${hhmm(h.at)}` }];
  });
  return [...local, ...calling].slice(0, 8);
}

function lookUpStations(query) {
  clearTimeout(stationTimer);
  const q = query.trim();
  stationHits = [];
  stationPending = q.length >= 3;
  if (!stationPending) return;
  stationTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (input.value.trim() !== q) return;
      stationHits = res.ok ? (await res.json()).results : [];
    } catch { /* the local matches stand */ }
    if (input.value.trim() !== q) return;
    stationPending = false;
    results = searchResults(q);
    activeResult = results.length ? Math.max(0, activeResult) : -1;
    renderSearch();
  }, 200);
}

const resultRow = (t, title, sub, i) => `<li class="result" role="option" id="result-${i}" data-id="${escapeHtml(t.id)}" aria-selected="${i === activeResult}">`
  + `${badgeHtml(badgeOf(t), 'fixed')}<span class="r-main"><span class="r-title">${escapeHtml(title)}</span><span class="r-sub">${escapeHtml(sub)}</span></span>`
  + `${!t.mode && t.delayMin > 0 ? `<span class="r-badge">+${Number(t.delayMin)}</span>` : '<span></span>'}</li>`;

/** With nothing typed: what you can search for, with live examples, and recent trains. */
function hintsHtml() {
  const now = serverNow();
  const express = [...trains.values()].find((t) => !t.mode && visible(t) && /^1/.test(t.headcode) && t.destination && t.state === 'moving');
  const [h, m] = timeFmt.format(now).split(':').map(Number);
  const slot = m < 30 ? `${String(h).padStart(2, '0')}:30` : `${String((h + 1) % 24).padStart(2, '0')}:00`;
  const hint = (q, icon, label) => `<li class="result hint" role="option" data-q="${escapeHtml(q)}"><span class="r-ic">${icon}</span><span class="r-main"><span class="r-title">${escapeHtml(q)}</span><span class="r-sub">${escapeHtml(label)}</span></span><span></span></li>`;
  let html = '<li class="hint-h" role="presentation">Try</li>'
    + hint(express?.headcode ?? '1A01', ICONS.train, "A train's headcode")
    + hint(`Paddington ${slot}`, ICONS.pin, 'Trains calling at a station, at a time')
    + hint('Victoria', ICONS.route, 'A line, operator or destination');
  const recent = store.get('recent', []).filter((r) => trains.has(r.id));
  if (recent.length) {
    html += '<li class="hint-h" role="presentation">Recent</li>'
      + recent.map((r) => `<li class="result hint" role="option" data-id="${escapeHtml(r.id)}"><span class="r-ic">${ICONS.recent}</span><span class="r-main"><span class="r-title">${escapeHtml(r.text)}</span></span><span></span></li>`).join('');
  }
  return html;
}

function renderSearch() {
  const list = $('search-results');
  const q = input.value.trim();
  $('search').classList.toggle('has-text', Boolean(q));
  $('search-clear').hidden = !q;
  if (!q) {
    list.innerHTML = hintsHtml();
  } else if (!results.length) {
    // Station searches only see trains on the map: say so, or a later time looks broken.
    const time = TIME_IN_QUERY.exec(q)?.[0];
    const empty = stationPending ? 'Searching…'
      : time ? `No train on the map calls there around ${time}. Only trains running now are found; later ones appear once they set off.`
        : 'No train on the map matches. Try a headcode, a line or operator, or a station.';
    list.innerHTML = `<li class="result empty" role="option" aria-disabled="true">${escapeHtml(empty)}</li>`;
  } else {
    list.innerHTML = results.map(({ t, sub }, i) => resultRow(t, shortText(t), sub, i)).join('');
  }
  $('search-pop').hidden = false;
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-activedescendant', activeResult >= 0 ? `result-${activeResult}` : '');
}

function hideResults() {
  $('search-pop').hidden = true;
  input.setAttribute('aria-expanded', 'false');
  activeResult = -1;
}

function onSearchInput() {
  lookUpStations(input.value);
  results = searchResults(input.value);
  activeResult = results.length ? 0 : -1;
  renderSearch();
}

input.addEventListener('input', onSearchInput);
input.addEventListener('focus', () => {
  closeLayers();
  closeChooser();
  if (isNarrow() && sheetFull) setSheetFull(false);
  renderSearch();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!results.length || !input.value.trim()) return;
    e.preventDefault();
    activeResult = (activeResult + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
    renderSearch();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const r = input.value.trim() && results[Math.max(0, activeResult)];
    if (r) choose(r.t.id);
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    if (input.value) {
      input.value = '';
      onSearchInput();
    } else {
      input.blur();
    }
  }
});
input.addEventListener('blur', () => setTimeout(() => {
  if (document.activeElement !== input) hideResults();
}, 150));
// mousedown keeps focus in the input until the click lands.
$('search-pop').addEventListener('mousedown', (e) => e.preventDefault());
$('search-results').addEventListener('click', (e) => {
  const li = e.target.closest('.result');
  if (li?.dataset.id) choose(li.dataset.id);
  else if (li?.dataset.q) {
    input.value = li.dataset.q;
    onSearchInput();
    input.focus();
  }
});
$('search-clear').addEventListener('mousedown', (e) => e.preventDefault());
$('search-clear').addEventListener('click', () => {
  input.value = '';
  onSearchInput();
  input.focus();
});

function choose(id) {
  input.value = '';
  $('search').classList.remove('has-text');
  $('search-clear').hidden = true;
  input.blur();
  hideResults();
  select(id);
}

// ---- Rendering loop ----

let lastNearby = 0;
let lastLayers = 0;

function render() {
  const source = map.getSource('trains');
  const now = serverNow();
  const features = [];
  const counts = { ontime: 0, minor: 0, major: 0 };
  const perNet = {};
  for (const t of trains.values()) {
    if (!visible(t)) continue;
    const cat = category(t);
    if (cat !== 'tfl') counts[cat]++;
    const net = t.mode ?? 'rail';
    perNet[net] = (perNet[net] ?? 0) + 1;
    const { pos, bearing } = locate(t, now);
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pos },
      properties: {
        id: t.id,
        // TfL train numbers mean little to riders; label rail headcodes only.
        label: t.mode ? '' : t.headcode,
        // Drawn by trainImage; a plain dot until we know which way it faces.
        icon: `train:${colorOf(t)}:${bearing === null ? 'dot' : 'arrow'}`,
        bearing: bearing ?? 0,
        selected: t.id === selectedId,
      },
    });
  }
  source?.setData({ type: 'FeatureCollection', features });
  renderKey(now, counts, perNet);

  const sel = selectedId && trains.get(selectedId);
  if (sel) {
    renderLive(sel, now);
    drawRouteLine(now);
    if (following && !map.isMoving()) map.jumpTo({ center: positionOf(sel, now), padding: mapPadding() });
  }
  renderCallout(sel, now);
  // Lists that redraw as numbers change hold still while a button or row is
  // pressed, or the press and release land on different elements and the click is lost.
  if (!pressing) {
    if (sheetMode === 'nearby' && now - lastNearby > 1000) renderNearby();
    if (layersOpen && now - lastLayers > 2000) renderLayers();
  }
}

let pressing = false;
document.addEventListener('pointerdown', () => { pressing = true; }, { capture: true, passive: true });
for (const type of ['pointerup', 'pointercancel']) window.addEventListener(type, () => { pressing = false; }, { capture: true, passive: true });

/** Bottom left: live or not, the clock, then the colour key with counts. */
function renderKey(now, counts, perNet) {
  const s = lastStatus;
  const live = streamOk
    ? `<span id="k-live" class="k-live"><i class="conn-dot ok"></i>Live ${hhmm(now)}</span>`
    : `<span id="k-live" class="k-live bad"><i class="conn-dot bad"></i>${s ? 'Reconnecting…' : 'Connecting…'}</span>`;
  const tags = [];
  if (s?.feed === 'demo') tags.push('<span class="tag demo" data-tip="National Rail trains are simulated in demo mode; TfL trains are live.">Rail simulated</span>');
  else if (s && !s.connected) tags.push(`<span class="tag down" data-tip="${escapeHtml(s.detail)}">Rail offline</span>`);
  const tfl = s?.sources?.tfl;
  if (tfl && !tfl.connected) tags.push(`<span class="tag down" data-tip="${escapeHtml(tfl.detail)}">TfL offline</span>`);

  let cells;
  if (!haveSnapshot) {
    cells = '<span class="k-loading">Loading trains…</span>';
  } else {
    const cell = (n, label, color) => `<span class="kc" data-tip="${escapeHtml(`${n.toLocaleString('en-GB')} ${label}`)}"><i class="dot" style="background:${color}"></i><b>${n.toLocaleString('en-GB')}</b><span class="kl">${label}</span></span>`;
    const list = [];
    if (shown.has('rail')) {
      list.push(cell(counts.ontime, 'on time', DELAY_COLORS.ontime), cell(counts.minor, '1–4 min late', DELAY_COLORS.minor), cell(counts.major, '5+ min late', DELAY_COLORS.major));
    } else {
      for (const net of NETWORKS) if (shown.has(net)) list.push(cell(perNet[net] ?? 0, NET_LABELS[net], NET_COLORS[net]));
    }
    cells = list.length ? list.join('') : '<span>All networks hidden</span>';
  }
  setHtml($('key'), `${live}${tags.join('')}<span class="k-sep"></span>${cells}`);
  const last = s?.stats?.lastMessageAt;
  $('k-live').dataset.tip = streamOk ? `Last update ${last ? ago(now - last) : '—'} · London time` : 'Connecting to the server';
}

function applyStatus(s) {
  lastStatus = s;
  // Disrupted TfL lines, on the Layers button.
  const lines = Object.values(s.sources?.tfl?.lines ?? {});
  const badge = $('layers-count');
  badge.hidden = !lines.length;
  badge.textContent = String(lines.length);
  badge.classList.toggle('closed', lines.some((l) => l.closed));
  badge.title = `${lines.length} TfL line${lines.length === 1 ? '' : 's'} disrupted`;
  if (layersOpen) renderLayers();
}

function setClock(serverTime) {
  if (serverTime) clockOffset = serverTime - Date.now();
}

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    streamOk = true;
    haveSnapshot = true;
    setClock(d.serverTime);
    trains.clear();
    for (const t of d.trains) trains.set(t.id, t);
    for (const id of headings.keys()) if (!trains.has(id)) headings.delete(id);
    applyStatus(d.status);
    if (selectedId && !trains.has(selectedId)) clearSelection();
  });
  es.addEventListener('delta', (e) => {
    const d = JSON.parse(e.data);
    setClock(d.serverTime);
    for (const id of d.removals) {
      trains.delete(id);
      headings.delete(id);
    }
    for (const t of d.upserts) trains.set(t.id, t);
    if (!selectedId) return;
    const sel = trains.get(selectedId);
    if (!sel) clearSelection();
    else if (stampOf(sel) !== detailStamp) loadDetail(selectedId);
    // Same section: refresh times ("in 3 min") and delay.
    else if (detail) renderDetail(detail);
    else renderDetailHead(sel);
  });
  es.addEventListener('status', (e) => applyStatus(JSON.parse(e.data)));
  es.onerror = () => {
    streamOk = false;
    // EventSource retries by itself, except after an HTTP error response
    // (e.g. a proxy 502 during a restart), when it gives up for good.
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 5000);
  };
}

// ---- Map layers ----

// One icon per train, dot and arrow together, so where trains bunch up each
// one covers the ones beneath it (separate dot and arrow layers would draw
// every arrow over every dot).
const TRAIN_ICON_PX = 24;
const TRAIN_ICON_SCALE = 3;

/** A dot in the train's colour with a white rim and, if it has one, an arrow pointing north. */
function trainImage(color, arrow) {
  const s = TRAIN_ICON_PX * TRAIN_ICON_SCALE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - 1 - 0.07 * s, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  if (arrow) {
    const u = s / 72;
    ctx.beginPath();
    ctx.moveTo(36 * u, 17 * u);
    ctx.lineTo(49 * u, 50 * u);
    ctx.lineTo(36 * u, 43 * u);
    ctx.lineTo(23 * u, 50 * u);
    ctx.closePath();
    ctx.fillStyle = textOn(color);
    ctx.fill();
  }
  return ctx.getImageData(0, 0, s, s);
}

// Icons are made the first time a colour shows up ("train:#E32017:arrow").
map.on('styleimagemissing', (e) => {
  const m = /^train:(#[0-9a-fA-F]{6}):(arrow|dot)$/.exec(e.id);
  if (m && !map.hasImage(e.id)) map.addImage(e.id, trainImage(m[1], m[2] === 'arrow'), { pixelRatio: TRAIN_ICON_SCALE });
});

function applyRailLines() {
  if (!map.getLayer('openrailwaymap')) return;
  for (const id of ['openrailwaymap', 'rail-emphasis']) map.setLayoutProperty(id, 'visibility', railLines ? 'visible' : 'none');
}

const EMPTY = { type: 'FeatureCollection', features: [] };

map.on('load', () => {
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

  // Track overview at every zoom, in neutral grey so it never competes with
  // train colours. OpenRailwayMap's public tiles are fine for a prototype; a
  // production site should host its own.
  map.addSource('openrailwaymap', {
    type: 'raster',
    tiles: ['https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png'],
    tileSize: 256,
    maxzoom: 19,
    attribution: '<a href="https://www.openrailwaymap.org/">OpenRailwayMap</a> (CC-BY-SA)',
  });
  map.addLayer({
    id: 'openrailwaymap',
    type: 'raster',
    source: 'openrailwaymap',
    paint: THEME.rail,
  }, firstSymbol);

  // Basemap's own rail geometry: crisper once zoomed in (it starts around z8.5).
  map.addLayer({
    id: 'rail-emphasis',
    type: 'line',
    source: 'openmaptiles',
    'source-layer': 'transportation',
    filter: ['all', ['==', ['get', 'class'], 'rail'], ['!', ['has', 'service']]],
    paint: {
      'line-color': THEME.railLine,
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 9, 1.4, 14, 3],
      'line-opacity': 0.8,
    },
  }, firstSymbol);

  // Selected train's route in its colour: covered track pale, track ahead solid.
  map.addSource('route-line', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'route-casing',
    type: 'line',
    source: 'route-line',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': THEME.casing, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 9, 12, 15] },
  });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route-line',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      // Over the white casing, a translucent line reads as a pale tint.
      'line-opacity': ['match', ['get', 'part'], 'behind', 0.35, 1],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 5, 12, 10],
    },
  });
  // Stations: small hollow markers, so they never look like trains.
  map.addSource('route', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'route-stops',
    type: 'circle',
    source: 'route',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 12, 4.5],
      'circle-color': THEME.casing,
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-opacity': ['match', ['get', 'status'], 'passed', 0.45, 1],
      'circle-stroke-width': 1.5,
    },
  });
  map.addLayer({
    id: 'route-labels',
    type: 'symbol',
    source: 'route',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
      'text-radial-offset': 0.8,
      'text-justify': 'auto',
    },
    paint: {
      'text-color': ['match', ['get', 'status'], 'passed', THEME.inkPassed, THEME.ink],
      'text-halo-color': THEME.halo,
      'text-halo-width': 1.6,
    },
  });

  map.addSource('trains', { type: 'geojson', data: EMPTY });
  // Trains: filled dots with an arrow for the direction of travel, clearly
  // bigger than station markers; the selected one also gets a dark ring.
  map.addLayer({
    id: 'trains-selected',
    type: 'circle',
    source: 'trains',
    filter: ['==', ['get', 'selected'], true],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 7, 8, 11.5, 12, 15.5],
      'circle-color': 'rgba(0, 0, 0, 0)',
      'circle-stroke-color': THEME.ink,
      'circle-stroke-width': 2.5,
    },
  });
  // TfL trains in their line's colour; National Rail by lateness.
  map.addLayer({
    id: 'trains',
    type: 'symbol',
    source: 'trains',
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      // 24 px icon: about 7 px across for all of Britain, 20 px in a city.
      'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.3, 6, 0.46, 8, 0.6, 12, 0.85, 15, 1],
      // The selected train on top of any it overlaps.
      'symbol-sort-key': ['case', ['get', 'selected'], 1, 0],
    },
  });
  map.addLayer({
    id: 'train-labels',
    type: 'symbol',
    source: 'trains',
    minzoom: 9,
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Bold'],
      'text-size': 11,
      'text-offset': [0, 1.3],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    },
    paint: { 'text-color': THEME.ink, 'text-halo-color': THEME.halo, 'text-halo-width': 1.5 },
  });

  // You: a blue dot, in a pale circle as wide as the position's accuracy.
  map.addSource('me', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'me-accuracy',
    type: 'circle',
    source: 'me',
    paint: {
      'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 0, ['get', 'r0'], 22, ['*', ['get', 'r0'], 4194304]],
      'circle-color': THEME.me,
      'circle-opacity': 0.12,
      'circle-stroke-color': THEME.me,
      'circle-stroke-opacity': 0.35,
      'circle-stroke-width': 1,
    },
  });
  map.addLayer({
    id: 'me-dot',
    type: 'circle',
    source: 'me',
    paint: { 'circle-radius': 7, 'circle-color': THEME.me, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 },
  });

  map.on('click', onMapClick);
  map.on('mousemove', (e) => showTooltip(trainsAt(e.point, 8)[0]?.id, e.originalEvent));
  map.on('mouseout', () => showTooltip(null));
  // Only moves you make: following a train moves the map four times a second.
  map.on('movestart', (e) => { if (e.originalEvent) closeChooser(); });
  map.on('dragstart', () => {
    if (following) setFollow(false);
    // Moving the map means looking at it.
    if (sheetFull) setSheetFull(false);
    closeLayers();
  });
  if (detail) setRoute(detail);
  updateMeLayer();
  applyRailLines();
  setFocusStyle();
  render();
});

// ---- Picking a train on the map ----

/** Trains within `radius` px of a screen point, nearest first. */
function trainsAt(point, radius) {
  if (!map.getLayer('trains')) return [];
  const box = [[point.x - radius, point.y - radius], [point.x + radius, point.y + radius]];
  const hits = new Map();
  for (const f of map.queryRenderedFeatures(box, { layers: ['trains'] })) {
    const p = map.project(f.geometry.coordinates);
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (d <= radius && !(hits.get(f.properties.id) <= d)) hits.set(f.properties.id, d);
  }
  return [...hits].map(([id, d]) => ({ id, d })).sort((a, b) => a.d - b.d);
}

// A finger is wide: a tap takes trains within 22 px; a mouse, 8 px. If that
// catches several with none clearly nearest, ask which.
function onMapClick(e) {
  if (!$('chooser').hidden) {
    closeChooser();
    return;
  }
  const touch = coarse.matches || e.originalEvent?.pointerType === 'touch';
  const hits = trainsAt(e.point, touch ? 22 : 8);
  if (!hits.length) {
    if (layersOpen) closeLayers();
    else if (selectedId) clearSelection();
    return;
  }
  const clear = hits.length === 1 || hits[1].d - hits[0].d > (touch ? 12 : 5);
  if (clear) select(hits[0].id);
  else showChooser(hits.slice(0, 6).map((h) => h.id), e.point, hits.length);
}

function showChooser(ids, point, total) {
  const el = $('chooser');
  const rows = ids.map((id) => trains.get(id)).filter(Boolean).map((t) => `<button type="button" class="ch-row" data-id="${escapeHtml(t.id)}">`
    + `${badgeHtml(badgeOf(t), 'fixed')}<span class="r-main"><span class="r-title">${escapeHtml(shortText(t))}</span><span class="r-sub">${escapeHtml(whereLabel(t))}</span></span></button>`);
  const head = total > rows.length ? `${total} trains here; the nearest ${rows.length}, or zoom in` : `${rows.length} trains here`;
  el.innerHTML = `<div class="ch-head">${head}</div>${rows.join('')}`;
  el.hidden = false;
  const r = map.getContainer().getBoundingClientRect();
  const x = r.left + point.x;
  const y = r.top + point.y;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(x - w / 2, window.innerWidth - w - 8))}px`;
  el.style.top = `${y + 20 + h > window.innerHeight - 8 ? Math.max(8, y - h - 20) : y + 20}px`;
  el.querySelector('.ch-row')?.focus({ preventScroll: true });
}

function closeChooser() {
  $('chooser').hidden = true;
}
$('chooser').addEventListener('click', (e) => {
  const row = e.target.closest('.ch-row');
  if (!row) return;
  closeChooser();
  select(row.dataset.id);
});

function showTooltip(id, event) {
  const tip = $('tooltip');
  const t = id && trains.get(id);
  map.getCanvas().style.cursor = t ? 'pointer' : '';
  // Touch devices have no hover; the tap selects instead.
  if (!t || !event || event.pointerType === 'touch') {
    if (!tip.dataset.badge) tip.hidden = true;
    return;
  }
  const late = !t.mode && t.delayMin > 0 ? ` · +${t.delayMin} min` : '';
  // The full name behind the badge's code.
  const b = badgeOf(t);
  const who = b.name !== b.code ? `${b.name} · ` : '';
  tip.innerHTML = `<div class="tt-title">${shortHtml(t)}${escapeHtml(late)}</div><span class="tt-sub">${escapeHtml(who + whereLabel(t))}</span>`;
  delete tip.dataset.badge;
  tip.hidden = false;
  const x = Math.min(event.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = Math.min(event.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

// Anything with data-tip (badges, facility icons, counts) shows its text at
// once on hover, or for a moment when tapped: the browser's own title takes a
// second or two, and never shows on a touch screen.
let tipTimer = null;
function showTip(el) {
  const tip = $('tooltip');
  tip.textContent = el.dataset.tip;
  tip.dataset.badge = 'true';
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - tip.offsetWidth - 8))}px`;
  tip.style.top = `${r.bottom + tip.offsetHeight + 12 > window.innerHeight ? r.top - tip.offsetHeight - 6 : r.bottom + 6}px`;
}
function hideTip() {
  const tip = $('tooltip');
  if (!tip.dataset.badge) return;
  tip.hidden = true;
  delete tip.dataset.badge;
}
document.addEventListener('mouseover', (e) => {
  if (coarse.matches) return;
  const el = e.target.closest?.('[data-tip]');
  if (el) showTip(el);
  else hideTip();
});
document.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'touch' || drag?.moved || performance.now() < swallowUntil) return;
  const el = e.target.closest?.('[data-tip]');
  // A tap on a row or button does what the row does; no tooltip on top.
  if (!el || el.closest('button, .result, .n-row, .ch-row')) return;
  showTip(el);
  clearTimeout(tipTimer);
  tipTimer = setTimeout(hideTip, 2500);
});
// Whatever it was over may be redrawn or scrolled away.
document.addEventListener('scroll', hideTip, { capture: true, passive: true });
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') hideTip();
}, { capture: true, passive: true });

// ---- Layers: networks, operators, lines, disruptions, map options ----
//
// National Rail, and TfL for its four networks together (each of which can
// also go on its own). Under them, operators and TfL lines by name. A row is
// ticked only when its trains would show; ticking one while its network is
// off shows that line alone, and unticking a network's last line switches
// the network off.

const TFL_NETWORKS = NETWORKS.filter((n) => n !== 'rail');

/** Badges per network: rail operators seen on the map, then every TfL line. */
function lineGroups() {
  const operators = new Map();
  for (const t of trains.values()) {
    if (t.mode) continue;
    const b = badgeOf(t);
    operators.set(b.key, b);
  }
  return NETWORKS.map((net) => ({
    net,
    badges: net === 'rail' ? [...operators.values()] : Object.keys(TFL_LINES[net]).map(tflBadge),
  }));
}

const netOfKey = (key) => (key.startsWith('rail:') ? 'rail' : netOfLine(key.slice(4)));

function renderLayers() {
  lastLayers = serverNow();
  const el = $('layers');
  const disrupted = lastStatus?.sources?.tfl?.lines ?? {};
  const perKey = new Map();
  const perNet = {};
  for (const t of trains.values()) {
    const key = badgeOf(t).key;
    perKey.set(key, (perKey.get(key) ?? 0) + 1);
    perNet[t.mode ?? 'rail'] = (perNet[t.mode ?? 'rail'] ?? 0) + 1;
  }
  const n = (v) => (v ? v.toLocaleString('en-GB') : '');
  const row = (state, attrs, icon, name, count, cls = '', after = '') => `<button type="button" class="lrow${cls ? ` ${cls}` : ''}" role="checkbox" aria-checked="${state}" ${attrs}>`
    + `<span class="check" aria-hidden="true"></span><span class="lic">${icon}</span><span class="lname">${escapeHtml(name)}${after}</span><span class="lcount">${count}</span></button>`;

  // Networks.
  const tflOn = TFL_NETWORKS.filter((net) => shown.has(net)).length;
  const tflState = tflOn === TFL_NETWORKS.length ? 'true' : tflOn ? 'mixed' : 'false';
  let html = '<div class="lsec"><div class="lsec-h">Networks'
    + `<button type="button" class="link-btn" data-act="${shown.size ? 'none' : 'all'}" data-focus="act:all">${shown.size ? 'Hide all' : 'Show all'}</button></div>`
    + row(shown.has('rail'), 'data-nets="rail" data-focus="net:rail"', `<span class="lic rail">${ICONS.train}</span>`, 'National Rail', n(perNet.rail))
    + row(tflState, `data-nets="${TFL_NETWORKS.join(' ')}" data-focus="net:tfl"`, TFL_MARK, 'TfL', n(TFL_NETWORKS.reduce((s, net) => s + (perNet[net] ?? 0), 0)))
    + TFL_NETWORKS.map((net) => row(shown.has(net), `data-nets="${net}" data-focus="net:${net}"`, `<i class="swatch" style="background:${NET_COLORS[net]}"></i>`, NET_LABELS[net], n(perNet[net]), 'sub')).join('')
    + '</div>';

  // Operators and lines, busiest first.
  const groups = lineGroups();
  const list = (title, id, badges) => {
    if (!badges.length) return '';
    badges.sort((a, b) => (perKey.get(b.key) ?? 0) - (perKey.get(a.key) ?? 0) || a.name.localeCompare(b.name));
    const open = moreRows[id] || badges.length <= SHORT_LIST + 1;
    const rows = (open ? badges : badges.slice(0, SHORT_LIST)).map((b) => {
      // A disrupted line gets a dot; what is wrong is under Disruptions.
      const status = b.key.startsWith('tfl:') ? disrupted[b.key.slice(4)] : null;
      const flag = status ? ` <i class="flag${status.closed ? ' closed' : ''}" data-tip="${escapeHtml(status.summary)}"></i>` : '';
      const on = shown.has(netOfKey(b.key)) && !hiddenLines.has(b.key);
      return row(on, `data-key="${escapeHtml(b.key)}" data-focus="line:${escapeHtml(b.key)}"`, badgeHtml(b, 'fixed'), b.name, n(perKey.get(b.key)), '', flag);
    }).join('');
    const toggle = badges.length > SHORT_LIST + 1
      ? `<button type="button" class="link-btn" data-more="${id}" data-focus="more:${id}">${moreRows[id] ? 'Fewer' : `All ${badges.length}`}</button>`
      : '';
    return `<div class="lsec"><div class="lsec-h">${title}${toggle}</div>${rows}</div>`;
  };
  html += list('National Rail operators', 'ops', [...groups.find((g) => g.net === 'rail').badges]);
  html += list('TfL lines', 'lines', groups.filter((g) => g.net !== 'rail').flatMap((g) => g.badges));

  // Closed lines first: they explain why a line has no trains.
  const issues = Object.entries(disrupted)
    .sort(([a, s], [b, t]) => Number(t.closed) - Number(s.closed) || lineName(a).localeCompare(lineName(b)))
    .map(([line, s]) => disruptionHtml(line, s, true)).join('');
  if (issues) html += `<div class="lsec"><div class="lsec-h">Disruptions</div>${issues}</div>`;

  html += '<div class="lsec"><div class="lsec-h">Map</div>'
    + `<button type="button" class="lrow plain" role="checkbox" aria-checked="${railLines}" data-act="rails" data-focus="act:rails"><span class="check" aria-hidden="true"></span><span class="lname">Railway lines</span><span></span></button>`
    + '<div class="lrow plain unit"><span></span><span class="lname">Speeds and distances</span>'
    + `<span class="seg" role="group" aria-label="Units"><button type="button" data-unit="kmh" data-focus="unit:kmh" aria-pressed="${speedUnit === 'kmh'}">km/h</button><button type="button" data-unit="mph" data-focus="unit:mph" aria-pressed="${speedUnit === 'mph'}">mph</button></span></div>`
    + '</div>';

  // Keep keyboard focus across redraws.
  const focused = el.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  if (!setHtml(el, html)) return;
  if (focused) el.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
}

function openLayers() {
  layersOpen = true;
  hideResults();
  closeChooser();
  if (isNarrow() && sheetFull) setSheetFull(false);
  $('layers').hidden = false;
  $('layers-btn').setAttribute('aria-expanded', 'true');
  renderLayers();
}

function closeLayers() {
  if (!layersOpen) return;
  layersOpen = false;
  $('layers').hidden = true;
  $('layers-btn').setAttribute('aria-expanded', 'false');
}

$('layers-btn').addEventListener('click', () => (layersOpen ? closeLayers() : openLayers()));
// A press anywhere else closes the menu. Not the map: its click handler closes
// the menu itself, and must still see it open so the tap does not also close
// the selected train.
document.addEventListener('pointerdown', (e) => {
  if (layersOpen && !e.target.closest('#layers, #layers-btn, #map')) closeLayers();
  if (!$('chooser').hidden && !e.target.closest('#chooser, #map')) closeChooser();
});

function applyFilter(networks, hidden) {
  shown = new Set(networks.filter((n) => NETWORKS.includes(n)));
  hiddenLines = new Set(hidden);
  store.set('networks', [...shown]);
  store.set('hiddenLines', [...hiddenLines]);
  const sel = selectedId && trains.get(selectedId);
  if (sel && !visible(sel)) clearSelection();
  if (layersOpen) renderLayers();
  render();
}

/** Switches networks off if any is showing, otherwise on. */
function toggleNetworks(nets) {
  const on = nets.some((n) => shown.has(n));
  const next = new Set(shown);
  for (const n of nets) {
    if (on) next.delete(n);
    else next.add(n);
  }
  // Either way the networks come back with all their lines next time.
  applyFilter([...next], [...hiddenLines].filter((k) => !nets.includes(netOfKey(k))));
}

function toggleLine(key) {
  const net = netOfKey(key);
  const keys = lineGroups().find((g) => g.net === net)?.badges.map((b) => b.key) ?? [];
  const nets = new Set(shown);
  const hidden = new Set(hiddenLines);
  if (!nets.has(net)) {
    // Network off: show just this line.
    nets.add(net);
    for (const k of keys) if (k !== key) hidden.add(k);
    hidden.delete(key);
  } else if (hidden.has(key)) {
    hidden.delete(key);
  } else {
    hidden.add(key);
    if (keys.every((k) => hidden.has(k))) {
      nets.delete(net);
      for (const k of keys) hidden.delete(k);
    }
  }
  applyFilter([...nets], [...hidden]);
}

function setSpeedUnit(unit) {
  speedUnit = unit;
  store.set('speedUnit', unit);
  renderLayers();
  if (detail) renderDetail(detail);
  if (sheetMode === 'nearby') renderNearby();
  render();
}

$('layers').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || btn.closest('summary')) return;
  if (btn.dataset.act === 'all') applyFilter(NETWORKS, []);
  else if (btn.dataset.act === 'none') applyFilter([], []);
  else if (btn.dataset.act === 'rails') {
    railLines = !railLines;
    store.set('railLines', railLines);
    applyRailLines();
    renderLayers();
  } else if (btn.dataset.more) {
    moreRows[btn.dataset.more] = !moreRows[btn.dataset.more];
    renderLayers();
  } else if (btn.dataset.unit) setSpeedUnit(btn.dataset.unit);
  else if (btn.dataset.nets) toggleNetworks(btn.dataset.nets.split(' '));
  else if (btn.dataset.key) toggleLine(btn.dataset.key);
});

// ---- The card (computer) or bottom sheet (phone) ----

function openSheet(mode) {
  sheetMode = mode;
  $('detail').hidden = mode !== 'detail';
  $('nearby').hidden = mode !== 'nearby';
  sheet.hidden = !mode;
  sheet.setAttribute('aria-label', mode === 'nearby' ? 'Trains near you' : 'Selected train');
  document.body.classList.toggle('sheet-open', Boolean(mode));
  $('sheet-body').scrollTop = 0;
  if (mode === 'nearby') renderNearby();
  setSheetFull(false);
  updatePeek();
}

function setSheetFull(on) {
  const was = sheetFull;
  sheetFull = Boolean(on) && isNarrow() && Boolean(sheetMode);
  if (sheetFull !== was && sheetMode === 'detail' && detail) renderCalls(detail, trains.get(detail.train.id) ?? detail.train, serverNow());
  sheet.classList.toggle('full', sheetFull);
  document.body.classList.toggle('sheet-full', sheetFull);
  $('sheet-grip').setAttribute('aria-label', sheetFull ? 'Show less' : 'Show more');
  if (!sheetFull) $('sheet-body').scrollTop = 0;
  updateSheetVisible();
}

/**
 * Phones: how much of the sheet shows when it peeks. The train's name, route,
 * next stop and buttons; or the first three trains near you.
 */
function updatePeek() {
  if (!sheetMode || !isNarrow()) {
    updateSheetVisible();
    return;
  }
  let end;
  if (sheetMode === 'detail') end = $('detail').querySelector('.peek');
  else {
    const rows = $('n-list').children;
    end = rows[Math.min(2, rows.length - 1)] ?? $('nearby').querySelector('.peek');
  }
  // offsetTop is from the sheet body (position: relative), under the grip.
  // Plus the sheet's bottom padding: the iPhone home indicator's strip, which
  // would otherwise cover the buttons.
  const safe = parseFloat(getComputedStyle(sheet).paddingBottom) || 0;
  const px = Math.ceil($('sheet-grip').offsetHeight + 2 + end.offsetTop + end.offsetHeight + 10 + safe);
  if (px !== peekPx) {
    peekPx = px;
    sheet.style.setProperty('--peek', `${px}px`);
  }
  updateSheetVisible();
}

function updateSheetVisible() {
  const v = !sheetMode || !isNarrow() ? 0 : sheetFull ? sheet.offsetHeight : peekPx;
  document.documentElement.style.setProperty('--sheet-visible', `${v}px`);
}

/** Swipe down from a peeking sheet: close the train, or stop showing where you are. */
function dismissSheet() {
  if (sheetMode === 'detail') clearSelection();
  else if (sheetMode === 'nearby') stopLocating();
}

// Dragging the sheet: up for all of it, down to peek or close. While it peeks
// it drags from anywhere; swiped up, from its grip or top part (the rest scrolls).
let drag = null;
let swallowUntil = 0; // the click that ends a drag is not a tap
function onSheetDown(e) {
  if (!isNarrow() || !sheetMode || e.button > 0) return;
  if (sheetFull && !e.target.closest('.sheet-grip, .peek')) return;
  drag = { y: e.clientY, start: sheetFull ? 0 : sheet.offsetHeight - peekPx, moved: false, id: e.pointerId };
}
// On the window: a quick swipe can leave the sheet before the first move arrives.
window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dy = e.clientY - drag.y;
  if (!drag.moved) {
    if (Math.abs(dy) < 6) return;
    drag.moved = true;
    sheet.classList.add('dragging');
  }
  const y = Math.min(sheet.offsetHeight - 40, Math.max(0, drag.start + dy));
  sheet.style.transform = `translateY(${y}px)`;
});
function onSheetUp(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  if (!d.moved) return;
  sheet.classList.remove('dragging');
  sheet.style.transform = '';
  // Touch browsers can send the click well after pointerup.
  swallowUntil = performance.now() + 350;
  // A cancelled drag (the browser took over) snaps back where it was.
  if (e.type === 'pointercancel') return;
  const dy = e.clientY - d.y;
  if (dy < -40) setSheetFull(true);
  else if (dy > 40 && sheetFull) setSheetFull(false);
  else if (dy > 70 && !sheetFull) dismissSheet();
}
window.addEventListener('pointerup', onSheetUp);
window.addEventListener('pointercancel', onSheetUp);
sheet.addEventListener('click', (e) => {
  if (performance.now() > swallowUntil) return;
  e.stopPropagation();
  e.preventDefault();
}, true);
sheet.addEventListener('pointerdown', onSheetDown);
$('sheet-grip').addEventListener('click', () => setSheetFull(!sheetFull));

// ---- Your location, and the trains near you ----

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 6000);
}

function setLocateButton() {
  const btn = document.querySelector('.locate-btn');
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(locating));
  btn.classList.toggle('pending', locating && !me);
  btn.title = locating ? 'Stop showing my location' : 'Trains near me';
  btn.setAttribute('aria-label', btn.title);
}

function startLocating() {
  if (!('geolocation' in navigator)) {
    toast("This browser can't share your location.");
    return;
  }
  // Browsers only share a position with https:// pages (and localhost).
  if (!window.isSecureContext) {
    toast('Your location needs a secure connection: open this site over https://.');
    return;
  }
  locating = true;
  setLocateButton();
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 });
}

function stopLocating() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  locating = false;
  me = null;
  updateMeLayer();
  setLocateButton();
  if (sheetMode === 'nearby') openSheet(null);
}

function onPosition(p) {
  const first = !me;
  me = { lon: p.coords.longitude, lat: p.coords.latitude, acc: p.coords.accuracy };
  updateMeLayer();
  setLocateButton();
  // A train picked while waiting stays; closing it shows the trains near you.
  if (first && !selectedId) showNearby();
  else if (sheetMode === 'nearby') renderNearby();
}

function onPositionError(err) {
  // Once you have been found, a lost signal (a tunnel) or a slow fix keeps
  // the last position; only a withdrawn permission ends it.
  if (me && err.code !== err.PERMISSION_DENIED) return;
  stopLocating();
  toast(err.code === err.PERMISSION_DENIED
    ? 'Location is blocked for this site. Allow it in your browser settings to see trains near you.'
    : "Couldn't find your location. Try again in a moment.");
}

/** The trains near you, and the map around you. */
function showNearby() {
  if (selectedId) clearSelection();
  else openSheet('nearby');
  const zoom = Math.max(map.getZoom(), 12.5);
  map.easeTo({ center: [me.lon, me.lat], zoom, padding: mapPadding(), duration: motion(800) });
}

function updateMeLayer() {
  const source = map.getSource('me');
  if (!source) return;
  if (!me) {
    source.setData(EMPTY);
    return;
  }
  // Pixels per metre at zoom 0, for a circle as wide as the accuracy.
  const r0 = (Math.min(me.acc, 2000) * 512) / (40_075_016.686 * Math.cos(me.lat * Math.PI / 180));
  source.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [me.lon, me.lat] }, properties: { r0 } }] });
}

function renderNearby() {
  if (sheetMode !== 'nearby') return;
  const now = serverNow();
  lastNearby = now;
  if (!me) {
    setHtml($('n-sub'), 'Finding you…');
    setHtml($('n-list'), '');
    updatePeek();
    return;
  }
  const here = [me.lon, me.lat];
  const all = [];
  for (const t of trains.values()) {
    if (!visible(t)) continue;
    const d = metres(here, positionOf(t, now));
    if (d < 20_000) all.push({ t, d });
  }
  all.sort((a, b) => a.d - b.d);
  const within = all.filter((x) => x.d <= NEAR_METRES()).length;
  const list = all.slice(0, Math.min(15, Math.max(within, 5)));
  setHtml($('n-sub'), escapeHtml(within
    ? `${within} train${within === 1 ? '' : 's'} within ${NEAR_LABEL()}`
    : list.length ? `None within ${NEAR_LABEL()}; the nearest` : 'No trains nearby'));
  const rows = list.map(({ t, d }) => {
    let where;
    if (t.state === 'terminated') where = `Terminated at ${t.from.name}`;
    else if (t.state === 'stopped') where = `At ${t.from.name}`;
    else {
      const m = minutesUntil(t.departedAt + t.runMs, now);
      const speed = speedOf(t);
      where = m ? `${t.to.name} in ${m} min` : `Reaching ${t.to.name}`;
      if (speed && t.freight) where += ` · ${speed.text}`;
    }
    return `<li class="n-row" data-id="${escapeHtml(t.id)}">${badgeHtml(badgeOf(t), 'fixed')}`
      + `<span class="n-main"><span class="n-title">${escapeHtml(shortText(t))}</span><span class="n-where">${escapeHtml(where)}</span></span>`
      + `<span class="n-dist">${fmtDistance(d)}</span></li>`;
  }).join('');
  if (setHtml($('n-list'), rows || '<li class="n-empty">Trains show here as they come near.</li>')) updatePeek();
}

$('n-list').addEventListener('click', (e) => {
  const row = e.target.closest('.n-row');
  if (row) select(row.dataset.id);
});
$('n-close').addEventListener('click', stopLocating);

/** Map button: show where you are and the trains near you; again to stop. */
class LocateControl {
  onAdd() {
    this.el = document.createElement('div');
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.el.innerHTML = `<button type="button" class="locate-btn" aria-pressed="false" title="Trains near me" aria-label="Trains near me">${ICONS.locate}</button>`;
    this.el.querySelector('button').addEventListener('click', () => {
      if (!locating) startLocating();
      else if (me && sheetMode !== 'nearby') showNearby();
      else stopLocating();
    });
    return this.el;
  }

  onRemove() {
    this.el.remove();
  }
}

// ---- Controls and start-up ----

// Bottom right, from the bottom up: credits, zoom, your location.
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: [RAIL_ATTRIBUTION, 'Powered by TfL Open Data'] }), 'bottom-right');
{
  // Start the credits folded behind the ⓘ: open, they run under the other buttons.
  const el = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
  el?.classList.remove('maplibregl-compact-show');
  el?.removeAttribute('open');
}
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
map.addControl(new LocateControl(), 'bottom-right');

railLines = store.get('railLines', true) !== false;
speedUnit = store.get('speedUnit', 'kmh') === 'mph' ? 'mph' : 'kmh';
const savedNetworks = store.get('networks', null);
applyFilter(Array.isArray(savedNetworks) ? savedNetworks : NETWORKS, store.get('hiddenLines', []));

$('d-close').addEventListener('click', clearSelection);
$('d-fit').addEventListener('click', fitRoute);
$('d-follow').addEventListener('click', () => setFollow(!following));

function closePops() {
  hideResults();
  closeLayers();
  closeChooser();
}

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea');
  if (e.key === '/' && !typing) {
    e.preventDefault();
    input.focus();
  } else if (e.key === 'Escape' && !typing) {
    if (!$('chooser').hidden) closeChooser();
    else if (layersOpen) {
      closeLayers();
      $('layers-btn').focus();
    } else if (selectedId) clearSelection();
  }
});

function onResize() {
  map.resize();
  input.placeholder = isNarrow() ? 'Search' : 'Search trains and stations';
  if (!isNarrow() && sheetFull) setSheetFull(false);
  updatePeek();
}
window.addEventListener('resize', onResize);
onResize();

setInterval(render, FRAME_MS);
connect();
