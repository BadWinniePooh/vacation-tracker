// Main React app for Atlas vacation tracker.
const { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } = React;

// === Persistence keys (localStorage fallback only) ===
const STORAGE_KEY_V4 = 'atlas-vacation-tracker-v4';
const CURRENT_USER_KEY = 'atlas-current-user';
const STORAGE_KEY_V3 = 'atlas-vacation-tracker-v3';
const STORAGE_KEY_V2 = 'atlas-vacation-tracker-v2';
const CACHE_KEY = 'atlas-search-cache-v1';

const USER_COLORS = [
  "oklch(58% 0.14 28)",
  "oklch(58% 0.14 200)",
  "oklch(60% 0.13 280)",
  "oklch(62% 0.14 145)",
  "oklch(68% 0.13 60)",
  "oklch(55% 0.16 305)",
];

const CUSTOM_TYPE_COLORS = [
  "oklch(65% 0.15 180)",
  "oklch(60% 0.16 320)",
  "oklch(70% 0.14 100)",
  "oklch(55% 0.16 220)",
  "oklch(65% 0.18 40)",
  "oklch(50% 0.10 270)",
];
const CUSTOM_TYPE_GLYPHS = ["✦","◉","✺","❀","♨","☀","♪","☂","⚑","☘","♛","✈"];

function uid() { return Math.random().toString(36).slice(2, 9); }

function makeUser(name, color) {
  return { id: uid(), name, color, _ts: Date.now() };
}

function isValidState(data) {
  return data && data.v === 4 && data.users && Object.keys(data.users).length > 0 &&
    typeof data.cities === 'object' && typeof data.countries === 'object';
}

function loadCurrentUser(state) {
  const stored = localStorage.getItem(CURRENT_USER_KEY);
  if (stored && state.users[stored]) return stored;
  return Object.keys(state.users)[0];
}

function mergeRoots(base, incoming) {
  if (!base) return incoming;
  if (!incoming) return base;

  const users = { ...base.users };
  for (const [id, u] of Object.entries(incoming.users || {})) {
    if (!users[id] || (u._ts || 0) >= (users[id]._ts || 0)) users[id] = u;
  }

  const cities = { ...base.cities };
  for (const [k, c] of Object.entries(incoming.cities || {})) {
    if (!cities[k] || (c._ts || 0) >= (cities[k]._ts || 0)) cities[k] = c;
  }

  const ctById = {};
  for (const t of [...(base.customTypes || []), ...(incoming.customTypes || [])]) {
    if (!ctById[t.id] || (t._ts || 0) >= (ctById[t.id]._ts || 0)) ctById[t.id] = t;
  }

  const countries = {};
  for (const c of Object.values(cities)) {
    if (!countries[c.country]) countries[c.country] = { cities: [] };
    if (!countries[c.country].cities.includes(c.name)) countries[c.country].cities.push(c.name);
  }

  return {
    ...incoming,
    users,
    cities,
    countries,
    customTypes: Object.values(ctById),
    currentUser: base.currentUser,
    settings: base.settings,
  };
}

// Fallback: read from localStorage (migration path from prototype)
function loadLocalOrDefault() {
  try {
    const raw4 = localStorage.getItem(STORAGE_KEY_V4);
    if (raw4) return JSON.parse(raw4);
    const raw3 = localStorage.getItem(STORAGE_KEY_V3);
    if (raw3) return migrateV3(JSON.parse(raw3));
    const raw2 = localStorage.getItem(STORAGE_KEY_V2);
    if (raw2) return migrateV3({
      currentUser: 'legacy',
      users: { legacy: { id: 'legacy', name: 'You', color: USER_COLORS[0], data: JSON.parse(raw2) } }
    });
  } catch (e) { console.warn('localStorage load failed', e); }
  return defaultRoot();
}

function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
  catch (e) { return {}; }
}
function saveCache(c) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); }
  catch (e) { /* quota */ }
}

// Merge per-user v3 stores into a shared v4 store.
function migrateV3(v3) {
  const root = {
    v: 4,
    currentUser: v3.currentUser,
    users: {},
    cities: {},
    countries: {},
    customTypes: [],
  };
  for (const u of Object.values(v3.users || {})) {
    root.users[u.id] = { id: u.id, name: u.name, color: u.color };
    const d = u.data || {};
    for (const [k, c] of Object.entries(d.cities || {})) {
      if (!root.cities[k]) {
        root.cities[k] = { ...c, participants: [u.id] };
      } else {
        const e = root.cities[k];
        root.cities[k] = {
          ...e,
          visited: e.visited || c.visited,
          visitDate: e.visitDate || c.visitDate,
          notes: e.notes || c.notes,
          type: e.type || c.type,
          photos: [...(e.photos || []), ...(c.photos || [])],
          participants: Array.from(new Set([...(e.participants || []), u.id])),
        };
      }
    }
  }
  for (const c of Object.values(root.cities)) {
    if (!root.countries[c.country]) root.countries[c.country] = { cities: [] };
    if (!root.countries[c.country].cities.includes(c.name)) {
      root.countries[c.country].cities.push(c.name);
    }
  }
  return root;
}

function defaultRoot() {
  const u = makeUser('You', USER_COLORS[0]);
  const root = {
    v: 4,
    currentUser: u.id,
    users: { [u.id]: u },
    cities: {},
    countries: {},
    customTypes: [],
  };
  const typeMap = {
    "Paris": "city", "Rome": "cultural", "Florence": "cultural",
    "Venice": "cultural", "Lisbon": "city", "Tokyo": "city",
    "Kyoto": "cultural", "Mexico City": "food", "Reykjavik": "nature",
    "New York": "city",
  };
  for (const s of (window.SEED_CITIES || [])) {
    root.cities[s.name] = {
      name: s.name, country: s.country,
      latitude: s.latitude, longitude: s.longitude,
      visited: !!s.visited, visitDate: s.visitDate || "",
      notes: s.notes || "", photos: [], type: typeMap[s.name] || "",
      participants: [u.id],
    };
    if (!root.countries[s.country]) root.countries[s.country] = { cities: [] };
    root.countries[s.country].cities.push(s.name);
  }
  return root;
}

// === Tweaks ===
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "palette": "classic",
  "language": "en",
  "collapseVisited": false,
  "colorByType": false
}/*EDITMODE-END*/;

const PALETTES = {
  classic: { wanted: "oklch(64% 0.17 28)",  partial: "oklch(75% 0.13 80)",  visited: "oklch(58% 0.14 145)" },
  pastel:  { wanted: "oklch(75% 0.10 28)",  partial: "oklch(85% 0.09 80)",  visited: "oklch(75% 0.09 145)" },
  bold:    { wanted: "oklch(55% 0.20 28)",  partial: "oklch(70% 0.18 70)",  visited: "oklch(50% 0.18 145)" },
  duotone: { wanted: "oklch(55% 0.16 260)", partial: "oklch(65% 0.10 320)", visited: "oklch(60% 0.18 18)" },
};
function applyPalette(name) {
  const p = PALETTES[name] || PALETTES.classic;
  document.documentElement.style.setProperty('--wanted', p.wanted);
  document.documentElement.style.setProperty('--partial', p.partial);
  document.documentElement.style.setProperty('--visited', p.visited);
}

// === Helpers ===
function countryVisitedRatio(country, data) {
  const c = data.countries[country];
  if (!c || !c.cities.length) return null;
  const v = c.cities.filter(n => data.cities[n] && data.cities[n].visited).length;
  return v / c.cities.length;
}
function countryColor(ratio) {
  if (ratio == null) return 'var(--line)';
  if (ratio <= 0) return 'var(--wanted)';
  if (ratio >= 1) return 'var(--visited)';
  if (ratio < 0.5) return `color-mix(in oklch, var(--partial) ${Math.round(ratio*200)}%, var(--wanted))`;
  return `color-mix(in oklch, var(--visited) ${Math.round((ratio-0.5)*200)}%, var(--partial))`;
}

// === i18n ===
function useI18n(lang) {
  return useCallback((key, ...args) => {
    const dict = (window.I18N && window.I18N[lang]) || window.I18N.en;
    const fallback = window.I18N.en;
    const v = dict[key] ?? fallback[key] ?? key;
    return typeof v === 'function' ? v(...args) : v;
  }, [lang]);
}

// Build the merged list of built-in + user-defined vacation types.
function useEffectiveTypes(customTypes) {
  return useMemo(() => {
    const builtin = window.VACATION_TYPES || [];
    const custom = (customTypes || []).map(t => ({
      id: t.id, key: t.id, label: t.label,
      color: t.color, glyph: t.glyph, _custom: true,
    }));
    return [...builtin, ...custom];
  }, [customTypes]);
}

// === Nominatim search ===
async function searchCities(query, lang) {
  const q = query.trim();
  if (q.length < 2) return [];
  const cache = loadCache();
  const key = lang + ':' + q.toLowerCase();
  if (cache[key]) return cache[key];

  const url = `https://nominatim.openstreetmap.org/search?` + new URLSearchParams({
    q, format: 'json', addressdetails: '1', limit: '8',
    'accept-language': lang === 'de' ? 'de' : 'en',
  });
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('Search failed');
  const raw = await res.json();
  const allowedTypes = new Set(['city','town','village','administrative','hamlet','municipality','suburb']);
  const allowedClasses = new Set(['place','boundary']);
  const seen = new Set();
  const results = [];
  for (const r of raw) {
    if (!allowedClasses.has(r.class) || !allowedTypes.has(r.type)) continue;
    const a = r.address || {};
    const name = a.city || a.town || a.village || a.municipality || a.hamlet ||
      (r.display_name || '').split(',')[0].trim();
    const code = (a.country_code || '').toLowerCase();
    const country = (window.COUNTRY_CODE_TO_ENGLISH && window.COUNTRY_CODE_TO_ENGLISH[code]) || a.country;
    if (!name || !country) continue;
    const id = name + '|' + country;
    if (seen.has(id)) continue;
    seen.add(id);
    results.push({ name, country, latitude: parseFloat(r.lat), longitude: parseFloat(r.lon) });
  }
  cache[key] = results;
  saveCache(cache);
  return results;
}

// === App ===
function App() {
  const [root, setRoot] = useState(null);
  const [tab, setTab] = useState('plan');
  const [selectedCity, setSelectedCity] = useState(null);
  const [lightboxSrc, setLightboxSrc] = useState(null);
  const [typeFilter, setTypeFilter] = useState(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [t, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
  const tr = useI18n(t.language);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const saveTimerRef = useRef(null);
  const settingsAppliedRef = useRef(false);
  const clientIdRef = useRef(Math.random().toString(36).slice(2, 10));
  const didAutoSwitchRef = useRef(false);

  const [authStatus, setAuthStatus] = useState('loading');
  const [authUser, setAuthUser] = useState(null); // { id, username, role } | null
  const [showLogin, setShowLogin] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showChangePwd, setShowChangePwd] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const isAuth = authStatus === 'authenticated';
  const isAdmin = isAuth && authUser?.role === 'admin';

  function refreshState() {
    return fetch('/api/state')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (isValidState(data)) {
          setRoot(prev => ({ ...data, currentUser: (prev && prev.currentUser) || loadCurrentUser(data) }));
        }
      })
      .catch(() => {});
  }

  // Load auth status and state in parallel on mount.
  // currentUser is device-local: injected from localStorage, never from DB.
  useEffect(() => {
    Promise.all([
      fetch('/api/auth/status').then(r => r.json()).catch(() => ({ authenticated: false })),
      fetch('/api/state').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([authData, stateData]) => {
      setAuthStatus(authData.authenticated ? 'authenticated' : 'unauthenticated');
      if (authData.authenticated) {
        setAuthUser({ id: authData.id, username: authData.username, role: authData.role, travellerIds: authData.travellerIds || [] });
      }
      if (isValidState(stateData)) {
        setRoot({ ...stateData, currentUser: loadCurrentUser(stateData) });
      } else {
        setRoot(loadLocalOrDefault());
      }
    });
  }, []);

  async function handleLogin(username, password) {
    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const d = await res.json();
      if (res.ok) {
        didAutoSwitchRef.current = false;
        setAuthStatus('authenticated');
        setAuthUser({ id: d.id, username: d.username, role: d.role, travellerIds: d.travellerIds || [] });
        setShowLogin(false);
        await refreshState();
      } else {
        setLoginError(d.error || 'Invalid username or password');
      }
    } catch (e) {
      setLoginError('Connection error');
    }
    setLoginLoading(false);
  }

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    didAutoSwitchRef.current = false;
    setAuthStatus('unauthenticated');
    setAuthUser(null);
    await refreshState();
  }

  // Persist currentUser to localStorage (device-local, never sent to DB)
  useEffect(() => {
    if (root?.currentUser) localStorage.setItem(CURRENT_USER_KEY, root.currentUser);
  }, [root?.currentUser]);

  // Debounced save to Postgres via API — currentUser excluded, it's device-local
  useEffect(() => {
    if (!root) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const { currentUser: _cu, ...toSave } = root;
      fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientIdRef.current },
        body: JSON.stringify(toSave),
      }).catch(e => console.warn('Save failed:', e));
    }, 800);
  }, [root]);

  // Apply saved settings from DB on first root load
  useEffect(() => {
    if (!root || settingsAppliedRef.current) return;
    settingsAppliedRef.current = true;
    if (root.settings) setTweak(root.settings);
  }, [root]);

  // Keep settings in root so they're included in DB saves
  useEffect(() => {
    if (!root) return;
    setRoot(prev => prev ? { ...prev, settings: t } : prev);
  }, [t]);

  // Real-time sync: merge state pushed by other devices into local state
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      let payload;
      try { payload = JSON.parse(e.data); } catch { return; }
      if (payload.clientId === clientIdRef.current) return;
      fetch('/api/state')
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (isValidState(d)) setRoot(prev => mergeRoots(prev, d)); })
        .catch(() => {});
    };
    return () => es.close();
  }, []);

  // Auto-switch to the user's linked traveller once per login session.
  // Inline setRoot rather than calling switchUser (which is defined after the early return).
  useEffect(() => {
    if (didAutoSwitchRef.current || !isAuth || !root || !authUser?.travellerIds?.length) return;
    const linked = authUser.travellerIds.filter(tid => root.users[tid]);
    if (linked.length === 0 || linked.includes(root.currentUser)) return;
    didAutoSwitchRef.current = true;
    setRoot(prev => prev ? { ...prev, currentUser: linked[0] } : prev);
  }, [isAuth, root, authUser]);

  // useLayoutEffect so CSS vars are set before child effects (repaintCountries) read them
  useLayoutEffect(() => { applyPalette(t.palette); }, [t.palette]);
  useEffect(() => { document.documentElement.lang = t.language; }, [t.language]);

  // Authenticated users only see travellers linked to their account.
  const linkedTravellers = useMemo(() => {
    if (!root) return {};
    if (!isAuth) return root.users || {};          // unauthenticated: all visible
    if (!authUser?.travellerIds?.length) return {}; // authenticated, no links: nothing visible
    const tids = new Set(authUser.travellerIds);
    return Object.fromEntries(Object.entries(root.users || {}).filter(([id]) => tids.has(id)));
  }, [root?.users, isAuth, authUser?.travellerIds]);

  // Derive from root (safe to read as null — hooks below guard on currentUser)
  const currentUser = root
    ? (linkedTravellers[root.currentUser] ?? Object.values(linkedTravellers)[0] ?? null)
    : null;
  const customTypes = root ? (root.customTypes || []) : [];
  const effectiveTypes = useEffectiveTypes(customTypes);

  useEffect(() => {
    if (currentUser) {
      document.documentElement.style.setProperty('--user-accent', currentUser.color);
    }
  }, [currentUser?.color]);

  // Visible cities = those where currentUser is a participant.
  const data = useMemo(() => {
    const cities = {};
    const countries = {};
    if (!currentUser || !root) return { cities, countries };
    for (const [k, c] of Object.entries(root.cities || {})) {
      if ((c.participants || []).includes(currentUser.id)) {
        cities[k] = c;
        if (!countries[c.country]) countries[c.country] = { cities: [] };
        countries[c.country].cities.push(c.name);
      }
    }
    return { cities, countries };
  }, [root?.cities, currentUser?.id]);

  const stats = useMemo(() => {
    const cities = Object.values(data.cities);
    const cv = cities.filter(c => c.visited).length;
    const countries = Object.keys(data.countries);
    const cnv = countries.filter(c => countryVisitedRatio(c, data) === 1).length;
    return { cities: { v: cv, t: cities.length }, countries: { v: cnv, t: countries.length } };
  }, [data]);

  const selected = selectedCity ? data.cities[selectedCity] : null;

  const filteredData = useMemo(() => {
    if (!typeFilter) return data;
    const cities = {};
    for (const [k, c] of Object.entries(data.cities)) {
      const ct = c.type || "";
      if (typeFilter === "_none" ? !ct : ct === typeFilter) cities[k] = c;
    }
    const countries = {};
    for (const c of Object.values(cities)) {
      if (!countries[c.country]) countries[c.country] = { cities: [] };
      countries[c.country].cities.push(c.name);
    }
    return { cities, countries };
  }, [data, typeFilter]);

  // All hooks above this line — safe to bail out for loading state now
  if (!root) {
    return <div className="app-loading">Loading…</div>;
  }

  // Selects a city and closes mobile sidebar so the detail panel is visible
  function selectCity(name) {
    setSelectedCity(name);
    if (name != null) setSidebarOpen(false);
  }

  // === Root mutators ===
  function patchRoot(fn) { setRoot(prev => fn(prev)); }

  // === User mutators ===
  function addUser(name) {
    const slug = (name || '').trim().toLowerCase();
    // Link to an existing traveller with the same name rather than creating a duplicate.
    const existing = Object.entries(root.users).find(([, u]) => u.name.trim().toLowerCase() === slug);
    if (existing) {
      const [existingId] = existing;
      setRoot(prev => ({ ...prev, currentUser: existingId }));
      if (isAuth && authUser && !(authUser.travellerIds || []).includes(existingId)) {
        updateMyTravellers([...(authUser.travellerIds || []), existingId]);
      }
      setSelectedCity(null);
      return;
    }
    const used = new Set(Object.values(root.users).map(u => u.color));
    const color = USER_COLORS.find(c => !used.has(c)) || USER_COLORS[Object.keys(root.users).length % USER_COLORS.length];
    const u = makeUser(name || 'New traveller', color);
    setRoot(prev => ({ ...prev, currentUser: u.id, users: { ...prev.users, [u.id]: u } }));
    if (isAuth && authUser) {
      updateMyTravellers([...(authUser.travellerIds || []), u.id]);
    }
    setSelectedCity(null);
  }
  function removeUser(id) {
    const linkedIds = Object.keys(linkedTravellers);
    if (linkedIds.length <= 1) { alert(tr('cantRemoveLast')); return; }
    const nextLinked = linkedIds.find(tid => tid !== id);
    setRoot(prev => {
      const users = { ...prev.users }; delete users[id];
      const cities = {};
      for (const [k, c] of Object.entries(prev.cities || {})) {
        const p = (c.participants || []).filter(x => x !== id);
        if (p.length > 0) cities[k] = { ...c, participants: p };
      }
      const countries = {};
      for (const c of Object.values(cities)) {
        if (!countries[c.country]) countries[c.country] = { cities: [] };
        countries[c.country].cities.push(c.name);
      }
      const nextCurrent = prev.currentUser === id ? (nextLinked || Object.keys(users)[0]) : prev.currentUser;
      return { ...prev, currentUser: nextCurrent, users, cities, countries };
    });
    if (isAuth && authUser) {
      updateMyTravellers((authUser.travellerIds || []).filter(x => x !== id));
    }
    setSelectedCity(null);
  }
  function renameUser(id, name) {
    setRoot(prev => ({ ...prev, users: { ...prev.users, [id]: { ...prev.users[id], name } } }));
  }
  function switchUser(id) {
    setRoot(prev => ({ ...prev, currentUser: id }));
    setSelectedCity(null);
    setUserMenuOpen(false);
  }

  async function updateMyTravellers(travellerIds) {
    const res = await fetch('/api/auth/travellers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ travellerIds }),
    });
    if (res.ok) {
      setAuthUser(prev => prev ? { ...prev, travellerIds } : prev);
    }
  }

  // === City mutators (shared store) ===
  function rebuildCountries(cities) {
    const countries = {};
    for (const c of Object.values(cities)) {
      if (!countries[c.country]) countries[c.country] = { cities: [] };
      if (!countries[c.country].cities.includes(c.name)) countries[c.country].cities.push(c.name);
    }
    return countries;
  }
  function addCity(rec) {
    patchRoot(prev => {
      const existingKey = Object.keys(prev.cities).find(k =>
        prev.cities[k].name === rec.name && prev.cities[k].country === rec.country);
      if (existingKey) {
        const c = prev.cities[existingKey];
        if ((c.participants || []).includes(prev.currentUser)) return prev;
        const cities = { ...prev.cities, [existingKey]: { ...c, participants: [...(c.participants || []), prev.currentUser] } };
        return { ...prev, cities, countries: rebuildCountries(cities) };
      }
      let displayName = rec.name;
      if (prev.cities[displayName] && prev.cities[displayName].country !== rec.country) {
        displayName = `${rec.name}, ${rec.country}`;
      }
      const city = {
        name: displayName, country: rec.country,
        latitude: rec.latitude, longitude: rec.longitude,
        visited: false, visitDate: "", notes: "", photos: [], type: "",
        participants: [prev.currentUser],
        _ts: Date.now(),
      };
      const cities = { ...prev.cities, [displayName]: city };
      return { ...prev, cities, countries: rebuildCountries(cities) };
    });
  }
  function removeCityFromCurrent(name) {
    patchRoot(prev => {
      const c = prev.cities[name]; if (!c) return prev;
      const p = (c.participants || []).filter(x => x !== prev.currentUser);
      const cities = { ...prev.cities };
      if (p.length === 0) delete cities[name];
      else cities[name] = { ...c, participants: p };
      return { ...prev, cities, countries: rebuildCountries(cities) };
    });
    if (selectedCity === name) setSelectedCity(null);
  }
  function updateCity(name, patch) {
    patchRoot(prev => {
      const c = prev.cities[name]; if (!c) return prev;
      return { ...prev, cities: { ...prev.cities, [name]: { ...c, ...patch, _ts: Date.now() } } };
    });
  }
  function toggleVisited(name) {
    const c = data.cities[name]; if (!c) return;
    updateCity(name, {
      visited: !c.visited,
      visitDate: !c.visited && !c.visitDate ? new Date().toISOString().slice(0, 7) : c.visitDate,
    });
  }
  function addPhoto(name, dataUrl) {
    const c = data.cities[name]; if (!c) return;
    updateCity(name, { photos: [...(c.photos || []), { id: Date.now() + Math.random(), src: dataUrl }] });
  }
  function removePhoto(name, photoId) {
    const c = data.cities[name]; if (!c) return;
    updateCity(name, { photos: (c.photos || []).filter(p => p.id !== photoId) });
  }
  function toggleParticipant(cityName, userId) {
    const c = root.cities[cityName]; if (!c) return;
    const p = c.participants || [];
    const has = p.includes(userId);
    if (has && p.length === 1) { alert(tr('cantRemoveLastParticipant')); return; }
    if (has && userId === root.currentUser) {
      if (!confirm(tr('confirmRemoveSelf'))) return;
    }
    const np = has ? p.filter(x => x !== userId) : [...p, userId];
    patchRoot(prev => {
      const cities = { ...prev.cities, [cityName]: { ...prev.cities[cityName], participants: np } };
      return { ...prev, cities, countries: rebuildCountries(cities) };
    });
    if (has && userId === root.currentUser && selectedCity === cityName) setSelectedCity(null);
  }

  // === Custom type mutators ===
  function addCustomType(rec) {
    patchRoot(prev => {
      const id = 'custom-' + uid();
      const ct = { id, label: rec.label, color: rec.color, glyph: rec.glyph, _ts: Date.now() };
      return { ...prev, customTypes: [...(prev.customTypes || []), ct] };
    });
  }
  function removeCustomType(id) {
    patchRoot(prev => {
      const cities = { ...prev.cities };
      for (const k of Object.keys(cities)) {
        if (cities[k].type === id) cities[k] = { ...cities[k], type: "" };
      }
      return { ...prev, customTypes: (prev.customTypes || []).filter(t => t.id !== id), cities };
    });
  }
  function updateCustomType(id, patch) {
    patchRoot(prev => ({
      ...prev,
      customTypes: (prev.customTypes || []).map(t => t.id === id ? { ...t, ...patch } : t),
    }));
  }

  return (
    <div className="app" data-sidebar={sidebarOpen ? 'open' : 'closed'}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            {tr('brand').split('—').flatMap((part, i) =>
              i > 0 ? [<em key={i}>{'—'}</em>, part] : [part]
            )}
          </div>
          <div className="brand-tag">{tr('tag')}</div>
        </div>

        <div className="topbar-right">
          <div className="stats">
            <div className="stat">
              <div className="stat-value">{stats.cities.v}<span className="frac">/{stats.cities.t}</span></div>
              <div className="stat-label">{tr('statCities')}</div>
            </div>
            <div className="stat">
              <div className="stat-value">{stats.countries.v}<span className="frac">/{stats.countries.t}</span></div>
              <div className="stat-label">{tr('statCountries')}</div>
            </div>
          </div>
          {isAuth ? (
            <UserSwitcher
              tr={tr}
              users={linkedTravellers}
              currentUser={currentUser}
              open={userMenuOpen}
              onToggle={() => setUserMenuOpen(o => !o)}
              onClose={() => setUserMenuOpen(false)}
              onSwitch={switchUser}
              onAdd={addUser}
              onRemove={removeUser}
              onRename={renameUser}
            />
          ) : (
            <button className="auth-btn" onClick={() => setShowLogin(true)}>Sign in</button>
          )}
          {isAuth && authUser && (
            <span className="topbar-user-label" title={`Signed in as ${authUser.username}`}>
              {authUser.username}
            </span>
          )}
          {isAdmin && (
            <button
              className="topbar-icon-btn"
              title="User management"
              onClick={() => setShowAdmin(true)}
            >👥</button>
          )}
          {isAuth && (
            <button
              className="topbar-icon-btn"
              title="Change password"
              onClick={() => setShowChangePwd(true)}
            >🔑</button>
          )}
          <button
            className={`mob-sidebar-btn${sidebarOpen ? ' is-open' : ''}`}
            aria-label="Toggle city list"
            onClick={() => setSidebarOpen(o => !o)}
          >{sidebarOpen ? '✕' : '☰'}</button>
          {isAuth && (
            <button
              className="settings-btn"
              title="Settings & tweaks"
              onClick={() => window.postMessage({ type: '__activate_edit_mode' }, '*')}
            >⚙</button>
          )}
          {isAuth && (
            <button className="auth-btn auth-btn-out" title="Sign out" onClick={handleLogout}>⏻</button>
          )}
        </div>
      </header>

      <div className="map-wrap">
        <div id="map"></div>
        <window.WorldMap
          state={filteredData}
          palette={t.palette}
          colorByType={t.colorByType}
          types={effectiveTypes}
          tr={tr}
          selectedCity={selectedCity}
          onSelectCity={selectCity}
          onCountryClick={(name) => {
            const c = filteredData.countries[name];
            if (c && c.cities.length) selectCity(c.cities[0]);
          }}
        />

        <div className="map-legend">
          <div className="legend-title">{tr('legendTitle')}</div>
          <div className="legend-bar"></div>
          <div className="legend-labels">
            <span>{tr('legend0')}</span>
            <span>{tr('legend100')}</span>
          </div>
          {!t.colorByType && (<>
            <div className="legend-row"><span className="legend-swatch" style={{background:'var(--visited)'}}></span> {tr('legendVisited')}</div>
            <div className="legend-row"><span className="legend-swatch" style={{background:'var(--wanted)'}}></span> {tr('legendWanted')}</div>
          </>)}
          {t.colorByType && (
            <div className="legend-types">
              {effectiveTypes.map(vt => (
                <div key={vt.id} className="legend-row">
                  <span className="legend-swatch" style={{background: vt.color}}></span>
                  {vt._custom ? vt.label : tr(vt.key)}
                </div>
              ))}
            </div>
          )}
        </div>

        {selected && (
          <DetailPanel
            tr={tr}
            city={selected}
            users={linkedTravellers}
            currentUserId={root.currentUser}
            types={effectiveTypes}
            customTypes={customTypes}
            isAuth={isAuth}
            onClose={() => setSelectedCity(null)}
            onToggleVisited={() => toggleVisited(selected.name)}
            onUpdate={(patch) => updateCity(selected.name, patch)}
            onAddPhoto={(d) => addPhoto(selected.name, d)}
            onRemovePhoto={(id) => removePhoto(selected.name, id)}
            onRemove={() => removeCityFromCurrent(selected.name)}
            onOpenPhoto={(src) => setLightboxSrc(src)}
            onToggleParticipant={(uid) => toggleParticipant(selected.name, uid)}
            onAddCustomType={addCustomType}
          />
        )}
      </div>

      <aside className="sidebar">
        <div className="side-tabs">
          <button className={`side-tab ${tab === 'plan' ? 'active' : ''}`} onClick={() => setTab('plan')}>{tr('tabPlan')}</button>
          <button className={`side-tab ${tab === 'visited' ? 'active' : ''}`} onClick={() => setTab('visited')}>{tr('tabVisited')}</button>
          <button className={`side-tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>{tr('tabAll')}</button>
        </div>
        <div className="side-body">
          {isAuth && <CityComposer tr={tr} lang={t.language} onAdd={addCity} existing={data.cities} />}
          <TypeFilter
            tr={tr}
            types={effectiveTypes}
            value={typeFilter}
            counts={countByType(data.cities)}
            onChange={setTypeFilter}
          />
          <CountryList
            tr={tr}
            data={filteredData}
            allCities={root.cities}
            users={linkedTravellers}
            currentUserId={root.currentUser}
            filter={tab}
            types={effectiveTypes}
            selectedCity={selectedCity}
            onSelectCity={selectCity}
            onToggleVisited={toggleVisited}
            onRemoveCity={removeCityFromCurrent}
            collapseVisited={t.collapseVisited}
            isAuth={isAuth}
          />
        </div>
      </aside>

      {lightboxSrc && (
        <div className="lightbox" onClick={() => setLightboxSrc(null)}>
          <img src={lightboxSrc} alt="" />
        </div>
      )}

      <window.TweaksPanel title="Tweaks">
        <window.TweakSection label={tr('tweaksLanguage')} />
        <window.TweakRadio
          label={tr('tweaksLanguageLabel')}
          value={t.language}
          options={[{ value: 'en', label: 'English' }, { value: 'de', label: 'Deutsch' }]}
          onChange={(v) => setTweak('language', v)}
        />
        <window.TweakSection label={tr('tweaksMapPalette')} />
        <window.TweakSelect
          label={tr('tweaksColorScheme')}
          value={t.palette}
          onChange={(v) => setTweak('palette', v)}
          options={Object.keys(PALETTES).map(k => ({ value: k, label: tr('pal' + k[0].toUpperCase() + k.slice(1)) }))}
        />
        <window.TweakToggle
          label={tr('vacationType') + ' → ' + tr('legendVisited').toLowerCase()}
          value={t.colorByType}
          onChange={(v) => setTweak('colorByType', v)}
        />
        <window.TweakSection label={tr('customTypes')} />
        <CustomTypeManager
          tr={tr}
          customTypes={customTypes}
          onAdd={addCustomType}
          onRemove={removeCustomType}
          onUpdate={updateCustomType}
        />
        <window.TweakSection label={tr('tweaksSidebar')} />
        <window.TweakToggle
          label={tr('tweaksCollapse')}
          value={t.collapseVisited}
          onChange={(v) => setTweak('collapseVisited', v)}
        />
        {isAdmin && <>
          <window.TweakSection label={tr('tweaksData')} />
          <window.TweakButton label={tr('tweaksReset')} secondary onClick={() => {
            if (confirm(tr('confirmReset'))) setRoot(defaultRoot());
          }} />
          <window.TweakButton label={tr('tweaksClear')} secondary onClick={() => {
            if (confirm(tr('confirmClear'))) {
              patchRoot(prev => ({ ...prev, cities: {}, countries: {} }));
            }
          }} />
        </>}
      </window.TweaksPanel>

      {sidebarOpen && (
        <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      )}

      {showLogin && (
        <LoginModal
          onClose={() => { setShowLogin(false); setLoginError(''); }}
          onLogin={handleLogin}
          error={loginError}
          loading={loginLoading}
        />
      )}

      {showAdmin && (
        <AdminPanel
          onClose={() => setShowAdmin(false)}
          currentUserId={authUser?.id}
          travellers={root.users}
        />
      )}

      {showChangePwd && (
        <ChangePasswordModal onClose={() => setShowChangePwd(false)} />
      )}
    </div>
  );
}

function countByType(cities) {
  const out = { _all: 0, _none: 0 };
  for (const c of Object.values(cities)) {
    out._all++;
    const k = c.type || "_none";
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// === User Switcher ===
function UserSwitcher({ tr, users, currentUser, open, onToggle, onClose, onSwitch, onAdd, onRemove, onRename }) {
  const [renaming, setRenaming] = useState(null);
  const [newName, setNewName] = useState("");
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e) { if (rootRef.current && !rootRef.current.contains(e.target)) onClose(); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const userList = Object.values(users);

  return (
    <div className="user-switcher" ref={rootRef}>
      <button className="user-chip" onClick={onToggle}>
        {currentUser ? (
          <>
            <span className="user-avatar" style={{ background: currentUser.color }}>
              {currentUser.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="user-name">{currentUser.name}</span>
          </>
        ) : (
          <span className="user-name">No traveller</span>
        )}
        <span className="user-caret">▾</span>
      </button>
      {open && (
        <div className="user-menu">
          <div className="user-menu-head">{tr('travellers')}</div>
          {userList.length === 0 ? (
            <div className="user-menu-empty">No linked travellers</div>
          ) : userList.map(u => (
            <div key={u.id} className={`user-row ${u.id === currentUser?.id ? 'is-current' : ''}`}>
              <span className="user-avatar sm" style={{ background: u.color }}>
                {u.name.slice(0, 1).toUpperCase()}
              </span>
              {renaming === u.id ? (
                <input
                  className="user-rename"
                  value={newName}
                  autoFocus
                  onChange={(e) => setNewName(e.target.value)}
                  onBlur={() => {
                    if (newName.trim()) onRename(u.id, newName.trim());
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.target.blur();
                    if (e.key === 'Escape') { setRenaming(null); }
                  }}
                />
              ) : (
                <span
                  className="user-row-name"
                  onClick={() => onSwitch(u.id)}
                  onDoubleClick={() => { setRenaming(u.id); setNewName(u.name); }}
                  title={tr('switchTo') + ' ' + u.name}
                >{u.name}</span>
              )}
              {userList.length > 1 && (
                <button className="user-row-del" onClick={() => {
                  if (confirm(tr('confirmRemoveUser', u.name))) onRemove(u.id);
                }} title={tr('removeTraveller')}>×</button>
              )}
            </div>
          ))}
          <button className="user-add-btn" onClick={() => {
            const name = prompt(tr('travellerName') + ':', '');
            if (name && name.trim()) onAdd(name.trim());
          }}>+ {tr('addTraveller')}</button>
        </div>
      )}
    </div>
  );
}

// === Type filter ===
function TypeFilter({ tr, types, value, counts, onChange }) {
  if (!types) return null;
  return (
    <div className="type-filter">
      <div className="type-filter-label">{tr('filterByType')}</div>
      <div className="type-chips">
        <button
          className={`type-chip ${value == null ? 'active' : ''}`}
          onClick={() => onChange(null)}
        >
          {tr('typeAll')} <span className="chip-count">{counts._all || 0}</span>
        </button>
        {types.map(vt => {
          const count = counts[vt.id] || 0;
          if (count === 0) return null;
          return (
            <button
              key={vt.id}
              className={`type-chip ${value === vt.id ? 'active' : ''}`}
              onClick={() => onChange(value === vt.id ? null : vt.id)}
              style={value === vt.id ? { '--chip-color': vt.color } : {}}
            >
              <span className="chip-glyph" style={{ color: vt.color }}>{vt.glyph}</span>
              {vt._custom ? vt.label : tr(vt.key)}
              <span className="chip-count">{count}</span>
            </button>
          );
        })}
        {counts._none > 0 && (
          <button
            className={`type-chip ${value === '_none' ? 'active' : ''}`}
            onClick={() => onChange(value === '_none' ? null : '_none')}
          >
            {tr('typeNone')} <span className="chip-count">{counts._none}</span>
          </button>
        )}
      </div>
    </div>
  );
}

// === City Composer ===
function CityComposer({ tr, lang, onAdd, existing }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const reqIdRef = useRef(0);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) { setResults([]); setLoading(false); return; }
    setLoading(true);
    const myId = ++reqIdRef.current;
    const handle = setTimeout(async () => {
      try {
        const r = await searchCities(query, lang);
        if (myId !== reqIdRef.current) return;
        setResults(r);
      } catch (e) {
        if (myId !== reqIdRef.current) return;
        setResults([]);
      } finally {
        if (myId === reqIdRef.current) setLoading(false);
      }
    }, 380);
    return () => clearTimeout(handle);
  }, [q, lang]);

  function pickMatch(m) {
    const aliases = window.COUNTRY_ALIASES || {};
    const country = aliases[m.country] || m.country;
    onAdd({ ...m, country });
    setQ("");
    setResults([]);
    setActive(0);
  }
  function handleAdd() { if (results.length) pickMatch(results[active]); }

  const showDropdown = focused && q.trim().length >= 2;

  return (
    <div className="add-row">
      <input
        className="add-input"
        type="text"
        placeholder={tr('addPlaceholder')}
        value={q}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 180)}
        onChange={(e) => { setQ(e.target.value); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, results.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); handleAdd(); }
        }}
      />
      <button className="add-btn" onClick={handleAdd} disabled={!results.length}>{tr('addBtn')}</button>
      {showDropdown && (
        <div className="suggest">
          {loading && <div className="suggest-empty">{tr('searching')}</div>}
          {!loading && results.length === 0 && (
            <div className="suggest-empty">{tr('noMatches')}</div>
          )}
          {!loading && results.map((m, i) => {
            const dup = Object.values(existing).some(c => c.name === m.name && c.country === (window.COUNTRY_ALIASES?.[m.country] || m.country));
            return (
              <div key={i}
                  className={`suggest-item ${i === active ? 'active' : ''} ${dup ? 'is-dup' : ''}`}
                  onMouseDown={() => !dup && pickMatch(m)}>
                <span>{m.name}{dup ? ' ✓' : ''}</span>
                <span className="suggest-country">{m.country}</span>
              </div>
            );
          })}
          {!loading && results.length > 0 && (
            <div className="suggest-hint">{tr('apiHint')}</div>
          )}
        </div>
      )}
    </div>
  );
}

// === Country list ===
function CountryList({ tr, data, allCities, users, currentUserId, filter, types, selectedCity, onSelectCity, onToggleVisited, onRemoveCity, collapseVisited, isAuth }) {
  const [collapsed, setCollapsed] = useState({});
  const typeById = useMemo(() => Object.fromEntries((types || []).map(t => [t.id, t])), [types]);

  const countries = useMemo(() => {
    return Object.entries(data.countries)
      .map(([name, c]) => ({ name, ...c, ratio: countryVisitedRatio(name, data) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  if (countries.length === 0) {
    return (
      <div className="empty-state">
        <div className="hint">{tr('emptyHeadline')}</div>
        <div className="sub">{tr('emptySub')}</div>
      </div>
    );
  }

  return (
    <div>
      {countries.map(country => {
        const cities = country.cities.map(n => data.cities[n]).filter(Boolean);
        let filtered = cities;
        if (filter === 'plan') filtered = cities.filter(c => !c.visited);
        else if (filter === 'visited') filtered = cities.filter(c => c.visited);
        if (filter !== 'all' && filtered.length === 0) return null;

        const isCollapsed = collapsed[country.name] ?? (collapseVisited && country.ratio === 1);
        const pct = country.ratio == null ? 0 : Math.round(country.ratio * 100);

        return (
          <div key={country.name} className="country-group">
            <div className="country-head" onClick={() => setCollapsed(s => ({ ...s, [country.name]: !isCollapsed }))}>
              <span className="country-flag-disc" style={{ background: countryColor(country.ratio) }}></span>
              <span className="country-name">{country.name}</span>
              <span className="country-pct">{pct}%</span>
            </div>
            <div className="country-bar">
              <div className="country-bar-fill" style={{ width: pct + '%', background: countryColor(country.ratio) }}></div>
            </div>
            {!isCollapsed && (
              <ul className="city-list">
                {filtered.map(city => {
                  const vt = city.type && typeById[city.type];
                  const others = (city.participants || []).filter(id => id !== currentUserId);
                  return (
                    <li
                      key={city.name}
                      className={`city-item ${selectedCity === city.name ? 'selected' : ''}`}
                      onClick={() => onSelectCity(city.name)}
                    >
                      <span
                        className={`city-check ${city.visited ? 'checked' : ''}${!isAuth ? ' readonly' : ''}`}
                        onClick={isAuth ? (e) => { e.stopPropagation(); onToggleVisited(city.name); } : (e) => e.stopPropagation()}
                      ></span>
                      <span className={`city-label ${city.visited ? 'visited' : ''}`}>{city.name}</span>
                      {isAuth && vt && (
                        <span className="city-type-glyph" style={{ color: vt.color }} title={vt._custom ? vt.label : tr(vt.key)}>{vt.glyph}</span>
                      )}
                      {isAuth && others.length > 0 && (
                        <span className="city-shared" title={tr('sharedWith', others.length)}>
                          {others.slice(0, 3).map(id => {
                            const u = users[id]; if (!u) return null;
                            return <span key={id} className="shared-dot" style={{ background: u.color }} title={u.name}></span>;
                          })}
                          {others.length > 3 && <span className="shared-more">+{others.length - 3}</span>}
                        </span>
                      )}
                      {city.photos && city.photos.length > 0 && (
                        <span className="city-photo-count">{city.photos.length} ph</span>
                      )}
                      {isAuth && <span className="city-del" onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(tr('confirmRemoveShort', city.name))) onRemoveCity(city.name);
                      }}>×</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

// === Participants picker ===
function ParticipantsPicker({ tr, city, users, currentUserId, onToggle }) {
  const userList = Object.values(users);
  const participants = city.participants || [];
  return (
    <div className="participants">
      {userList.map(u => {
        const active = participants.includes(u.id);
        const self = u.id === currentUserId;
        return (
          <button
            key={u.id}
            className={`participant ${active ? 'active' : ''} ${self ? 'is-self' : ''}`}
            onClick={() => onToggle(u.id)}
            title={(active ? tr('removeFromTrip') : tr('addParticipant')) + ' — ' + u.name}
          >
            <span className="participant-avatar" style={{ background: u.color }}>
              {u.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="participant-name">{u.name}{self ? ' (you)' : ''}</span>
            <span className="participant-check">{active ? '✓' : '+'}</span>
          </button>
        );
      })}
    </div>
  );
}

// === Custom type manager (in Tweaks) ===
// Supports adding, removing, and editing the label (slug) of custom types.
function CustomTypeManager({ tr, customTypes, onAdd, onRemove, onUpdate }) {
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [color, setColor] = useState(CUSTOM_TYPE_COLORS[0]);
  const [glyph, setGlyph] = useState(CUSTOM_TYPE_GLYPHS[0]);
  const [editingId, setEditingId] = useState(null);
  const [editLabel, setEditLabel] = useState("");

  function submit() {
    if (!label.trim()) return;
    onAdd({ label: label.trim(), color, glyph });
    setLabel(""); setColor(CUSTOM_TYPE_COLORS[0]); setGlyph(CUSTOM_TYPE_GLYPHS[0]);
    setCreating(false);
  }

  function submitEdit(id) {
    if (editLabel.trim()) onUpdate(id, { label: editLabel.trim() });
    setEditingId(null);
  }

  return (
    <div className="ctype-manager">
      {(customTypes || []).map(t => (
        <div key={t.id} className="ctype-row">
          <span className="ctype-glyph" style={{ color: t.color, borderColor: t.color }}>{t.glyph}</span>
          {editingId === t.id ? (
            <input
              className="ctype-input ctype-edit-input"
              value={editLabel}
              autoFocus
              onChange={(e) => setEditLabel(e.target.value)}
              onBlur={() => submitEdit(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.target.blur(); }
                if (e.key === 'Escape') setEditingId(null);
              }}
            />
          ) : (
            <span className="ctype-label">{t.label}</span>
          )}
          <button
            className="ctype-edit-btn"
            onClick={() => { setEditingId(t.id); setEditLabel(t.label); }}
            title={tr('editType')}
          >✎</button>
          <button className="ctype-del" onClick={() => {
            if (confirm(tr('confirmDeleteType', t.label))) onRemove(t.id);
          }} title={tr('deleteType')}>×</button>
        </div>
      ))}

      {!creating && (
        <button className="ctype-add-btn" onClick={() => setCreating(true)}>+ {tr('newType')}</button>
      )}
      {creating && (
        <div className="ctype-form">
          <input
            className="ctype-input"
            placeholder={tr('typeLabelPh')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setCreating(false); }}
          />
          <div className="ctype-pick-row">
            <div className="ctype-pick-label">{tr('color')}</div>
            <div className="ctype-swatches">
              {CUSTOM_TYPE_COLORS.map(c => (
                <button key={c}
                  className={`ctype-swatch ${color === c ? 'active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)} />
              ))}
            </div>
          </div>
          <div className="ctype-pick-row">
            <div className="ctype-pick-label">{tr('glyph')}</div>
            <div className="ctype-glyphs">
              {CUSTOM_TYPE_GLYPHS.map(g => (
                <button key={g}
                  className={`ctype-gpick ${glyph === g ? 'active' : ''}`}
                  style={glyph === g ? { color, borderColor: color } : {}}
                  onClick={() => setGlyph(g)}>{g}</button>
              ))}
            </div>
          </div>
          <div className="ctype-form-actions">
            <button className="ctype-cancel" onClick={() => setCreating(false)}>{tr('cancel')}</button>
            <button className="ctype-submit" onClick={submit} disabled={!label.trim()}>{tr('create')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// === Detail panel ===
function DetailPanel({ tr, city, users, currentUserId, types, customTypes, isAuth, onClose, onToggleVisited, onUpdate, onAddPhoto, onRemovePhoto, onRemove, onOpenPhoto, onToggleParticipant, onAddCustomType }) {
  const fileRef = useRef(null);
  const [showInlineType, setShowInlineType] = useState(false);
  const [inlineLabel, setInlineLabel] = useState("");
  const [inlineColor, setInlineColor] = useState(CUSTOM_TYPE_COLORS[0]);
  const [inlineGlyph, setInlineGlyph] = useState(CUSTOM_TYPE_GLYPHS[0]);

  function handleFiles(files) {
    Array.from(files).forEach(file => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const max = 1200;
          let w = img.width, h = img.height;
          if (w > max || h > max) {
            const r = Math.min(max / w, max / h);
            w = Math.round(w * r); h = Math.round(h * r);
          }
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          onAddPhoto(cv.toDataURL('image/jpeg', 0.82));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function submitInline() {
    if (!inlineLabel.trim()) return;
    onAddCustomType({ label: inlineLabel.trim(), color: inlineColor, glyph: inlineGlyph });
    setInlineLabel(""); setShowInlineType(false);
  }

  const lat = city.latitude, lng = city.longitude;
  const photoCount = (city.photos || []).length;

  return (
    <div className="detail">
      <div className="detail-head">
        <button className="detail-close" onClick={onClose}>×</button>
        <div className="detail-country">{city.country}</div>
        <div className="detail-city">{city.name}</div>
        {lat != null && (
          <div className="detail-coords">
            {Math.abs(lat).toFixed(3)}° {lat >= 0 ? 'N' : 'S'} ·&nbsp;
            {Math.abs(lng).toFixed(3)}° {lng >= 0 ? 'E' : 'W'}
          </div>
        )}
      </div>
      <div className="detail-body">
        <div
          className={`detail-toggle ${city.visited ? 'is-visited' : ''}${!isAuth ? ' readonly' : ''}`}
          onClick={isAuth ? onToggleVisited : undefined}
        >
          {city.visited ? tr('detailVisited') : tr('detailWishlist')}
          {isAuth && <span className="pill">{city.visited ? tr('tapToUndo') : tr('tapToVisit')}</span>}
        </div>

        {isAuth && (
          <div className="field-block">
            <div className="field-label">{tr('participants')}</div>
            <ParticipantsPicker
              tr={tr}
              city={city}
              users={users}
              currentUserId={currentUserId}
              onToggle={onToggleParticipant}
            />
          </div>
        )}

        {isAuth && <div className="field-block">
          <div className="field-label">{tr('vacationType')}</div>
          <div className="type-picker">
            <button
              className={`type-pick ${!city.type ? 'active' : ''}`}
              onClick={() => onUpdate({ type: "" })}
            >{tr('typeNone')}</button>
            {types.map(vt => (
              <button
                key={vt.id}
                className={`type-pick ${city.type === vt.id ? 'active' : ''}`}
                style={city.type === vt.id ? { borderColor: vt.color, background: `color-mix(in oklch, ${vt.color} 12%, var(--bg-card))` } : {}}
                onClick={() => onUpdate({ type: vt.id })}
                title={vt._custom ? tr('custom') : ''}
              >
                <span className="type-glyph" style={{ color: vt.color }}>{vt.glyph}</span>
                {vt._custom ? vt.label : tr(vt.key)}
                {vt._custom && <span className="type-custom-tag">·</span>}
              </button>
            ))}
            {!showInlineType && (
              <button className="type-pick type-pick-new" onClick={() => setShowInlineType(true)}>
                + {tr('newType')}
              </button>
            )}
          </div>
          {showInlineType && (
            <div className="inline-type-form">
              <input
                className="ctype-input"
                placeholder={tr('typeLabelPh')}
                value={inlineLabel}
                onChange={(e) => setInlineLabel(e.target.value)}
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') submitInline(); if (e.key === 'Escape') setShowInlineType(false); }}
              />
              <div className="ctype-pick-row compact">
                <div className="ctype-swatches">
                  {CUSTOM_TYPE_COLORS.map(c => (
                    <button key={c} className={`ctype-swatch ${inlineColor === c ? 'active' : ''}`} style={{ background: c }} onClick={() => setInlineColor(c)} />
                  ))}
                </div>
              </div>
              <div className="ctype-pick-row compact">
                <div className="ctype-glyphs">
                  {CUSTOM_TYPE_GLYPHS.map(g => (
                    <button key={g} className={`ctype-gpick ${inlineGlyph === g ? 'active' : ''}`} style={inlineGlyph === g ? { color: inlineColor, borderColor: inlineColor } : {}} onClick={() => setInlineGlyph(g)}>{g}</button>
                  ))}
                </div>
              </div>
              <div className="ctype-form-actions">
                <button className="ctype-cancel" onClick={() => setShowInlineType(false)}>{tr('cancel')}</button>
                <button className="ctype-submit" onClick={submitInline} disabled={!inlineLabel.trim()}>{tr('create')}</button>
              </div>
            </div>
          )}
        </div>}

        {city.visited && (
          <div className="field-block">
            <div className="field-label">{tr('whenVisited')}</div>
            {isAuth
              ? <input className="field-input" type="month" value={city.visitDate || ""}
                       onChange={(e) => onUpdate({ visitDate: e.target.value })} />
              : <div className="field-input-ro">{city.visitDate || '—'}</div>
            }
          </div>
        )}

        <div className="field-block">
          <div className="field-label">{tr('notes')}</div>
          {isAuth
            ? <textarea className="field-textarea" value={city.notes || ""}
                placeholder={city.visited ? tr('notesPlaceholderVisited') : tr('notesPlaceholderWanted')}
                onChange={(e) => onUpdate({ notes: e.target.value })} />
            : <div className="field-textarea-ro">{city.notes || <span className="field-empty">—</span>}</div>
          }
        </div>

        {(isAuth || photoCount > 0) && (
          <div className="field-block">
            <div className="field-label">{tr('memories')} — {photoCount} {photoCount === 1 ? tr('photo') : tr('photos')}</div>
            <div className="photo-grid">
              {(city.photos || []).map(p => (
                <div key={p.id} className="photo-tile">
                  <img src={p.src} alt="" onClick={() => onOpenPhoto(p.src)} />
                  {isAuth && <button className="photo-del" onClick={() => onRemovePhoto(p.id)}>×</button>}
                </div>
              ))}
              {isAuth && (
                <label className="photo-add">
                  <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
                    onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }} />
                  <span className="plus">+</span>
                  <span>{tr('addPhoto')}</span>
                </label>
              )}
            </div>
          </div>
        )}

        {isAuth && (
          <div className="danger-row">
            <button className="danger-btn" onClick={() => {
              if (confirm(tr('confirmRemove', city.name))) onRemove();
            }}>{tr('removeCity')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

// === Login modal ===
function LoginModal({ onClose, onLogin, error, loading }) {
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState('');
  const pwRef = useRef(null);
  function submit() { if (username.trim() && pw) onLogin(username.trim(), pw); }
  return (
    <div className="login-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="login-modal">
        <button className="login-close" onClick={onClose}>×</button>
        <div className="login-title">Sign in to edit</div>
        <div className="login-sub">Enter your credentials to add or change places.</div>
        <input
          className="login-input"
          type="text"
          placeholder="Username"
          value={username}
          autoFocus
          autoComplete="username"
          onChange={e => setUsername(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && username.trim()) pwRef.current?.focus();
            if (e.key === 'Escape') onClose();
          }}
        />
        <input
          ref={pwRef}
          className="login-input"
          type="password"
          placeholder="Password"
          value={pw}
          autoComplete="current-password"
          onChange={e => setPw(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); }}
        />
        {error && <div className="login-error">{error}</div>}
        <div className="login-actions">
          <button className="login-btn" onClick={submit} disabled={loading || !username.trim() || !pw}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
          <button className="login-guest" onClick={onClose}>Continue as guest</button>
        </div>
      </div>
    </div>
  );
}

// === Traveller picker (used in admin panel) ===
function TravellerPicker({ travellers, selected, onChange }) {
  const list = Object.values(travellers || {});
  if (list.length === 0) return <div className="admin-state-msg" style={{padding:'4px 0'}}>No travellers in map yet.</div>;
  return (
    <div className="admin-traveller-picker">
      {list.map(t => (
        <label key={t.id} className={`admin-traveller-opt ${selected.includes(t.id) ? 'is-checked' : ''}`}>
          <input
            type="checkbox"
            checked={selected.includes(t.id)}
            onChange={e => onChange(e.target.checked ? [...selected, t.id] : selected.filter(x => x !== t.id))}
          />
          <span className="user-avatar sm" style={{ background: t.color }}>{t.name.slice(0,1).toUpperCase()}</span>
          <span className="admin-traveller-name">{t.name}</span>
        </label>
      ))}
    </div>
  );
}

// === Admin panel: user management ===
function AdminPanel({ onClose, currentUserId, travellers }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [creating, setCreating] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('user');
  const [newTravellerIds, setNewTravellerIds] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editPassword, setEditPassword] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editTravellerIds, setEditTravellerIds] = useState([]);

  useEffect(() => { loadUsers(); }, []);

  async function loadUsers() {
    try {
      const res = await fetch('/api/admin/users');
      if (!res.ok) { setError('Failed to load users'); return; }
      setUsers(await res.json());
    } catch (e) { setError('Connection error'); }
  }

  function clearMessages() { setError(''); setSuccess(''); }
  function cancelEdit() { setEditingId(null); setEditPassword(''); setEditRole(''); setEditTravellerIds([]); }

  function startEdit(u) {
    setEditingId(u.id);
    setEditRole(u.role);
    setEditPassword('');
    setEditTravellerIds(u.traveller_ids || []);
    clearMessages();
  }

  async function createUser() {
    clearMessages();
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole, travellerIds: newTravellerIds }),
    });
    const d = await res.json();
    if (!res.ok) { setError(d.error); return; }
    setCreating(false);
    setNewUsername(''); setNewPassword(''); setNewRole('user'); setNewTravellerIds([]);
    setSuccess(`User "${d.username}" created.`);
    loadUsers();
  }

  async function updateUser(id) {
    clearMessages();
    const body = { travellerIds: editTravellerIds };
    if (editPassword) body.password = editPassword;
    if (editRole) body.role = editRole;
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    if (!res.ok) { setError(d.error); return; }
    cancelEdit();
    setSuccess('User updated.');
    loadUsers();
  }

  async function deleteUser(id, username) {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    clearMessages();
    const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    const d = await res.json();
    if (!res.ok) { setError(d.error); return; }
    setSuccess(`User "${username}" deleted.`);
    loadUsers();
  }

  return (
    <div className="login-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="admin-modal">
        <button className="login-close" onClick={onClose}>×</button>
        <div className="login-title">User Management</div>

        {error && <div className="login-error">{error}</div>}
        {success && <div className="admin-success">{success}</div>}

        <div className="admin-user-list">
          {users === null ? (
            <div className="admin-state-msg">Loading…</div>
          ) : users.length === 0 ? (
            <div className="admin-state-msg">No users found.</div>
          ) : users.map(u => {
            const linkedTravellers = (u.traveller_ids || []).map(tid => (travellers || {})[tid]).filter(Boolean);
            return (
              <div key={u.id} className="admin-user-row">
                <div className="admin-user-info">
                  <span className="user-avatar sm" style={{ background: u.id === currentUserId ? 'var(--accent)' : 'var(--ink-mute)' }}>
                    {u.username.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="admin-username">{u.username}</span>
                  <span className={`admin-role-badge admin-role-${u.role}`}>{u.role}</span>
                  {linkedTravellers.length > 0 && (
                    <span className="admin-linked-travellers">
                      {linkedTravellers.map(t => (
                        <span key={t.id} className="user-avatar sm" style={{ background: t.color }} title={t.name}>
                          {t.name.slice(0, 1).toUpperCase()}
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="admin-created">{new Date(u.created_at).toLocaleDateString()}</span>
                </div>
                {editingId === u.id ? (
                  <div className="admin-edit-form">
                    <input
                      className="login-input"
                      type="password"
                      placeholder="New password (leave blank to keep)"
                      value={editPassword}
                      autoFocus
                      autoComplete="new-password"
                      onChange={e => setEditPassword(e.target.value)}
                    />
                    <div className="admin-role-row">
                      <label className="admin-role-label">Role:</label>
                      <select className="admin-role-select" value={editRole} onChange={e => setEditRole(e.target.value)}>
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    </div>
                    <div className="admin-traveller-section">
                      <div className="admin-role-label">Linked travellers:</div>
                      <TravellerPicker travellers={travellers} selected={editTravellerIds} onChange={setEditTravellerIds} />
                    </div>
                    <div className="admin-actions-row">
                      <button className="login-btn admin-save-btn" onClick={() => updateUser(u.id)}>Save</button>
                      <button className="login-guest" onClick={cancelEdit}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="admin-row-btns">
                    <button className="admin-edit-btn" onClick={() => startEdit(u)}>Edit</button>
                    {u.id !== currentUserId && (
                      <button className="admin-del-btn" onClick={() => deleteUser(u.id, u.username)}>Delete</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="admin-footer">
          {!creating ? (
            <button className="ctype-add-btn" onClick={() => { setCreating(true); clearMessages(); }}>+ Add user</button>
          ) : (
            <div className="admin-create-form">
              <div className="admin-create-title">New user</div>
              <input
                className="login-input"
                type="text"
                placeholder="Username (2–32 chars)"
                value={newUsername}
                autoFocus
                autoComplete="username"
                onChange={e => setNewUsername(e.target.value)}
              />
              <input
                className="login-input"
                type="password"
                placeholder="Password (min 8 chars)"
                value={newPassword}
                autoComplete="new-password"
                onChange={e => setNewPassword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && newUsername.trim().length >= 2 && newPassword.length >= 8) createUser(); }}
              />
              <div className="admin-role-row">
                <label className="admin-role-label">Role:</label>
                <select className="admin-role-select" value={newRole} onChange={e => setNewRole(e.target.value)}>
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select>
              </div>
              <div className="admin-traveller-section">
                <div className="admin-role-label">Linked travellers:</div>
                <TravellerPicker travellers={travellers} selected={newTravellerIds} onChange={setNewTravellerIds} />
              </div>
              <div className="admin-actions-row">
                <button
                  className="login-btn admin-save-btn"
                  onClick={createUser}
                  disabled={newUsername.trim().length < 2 || newPassword.length < 8}
                >Create user</button>
                <button className="login-guest" onClick={() => { setCreating(false); setNewUsername(''); setNewPassword(''); setNewRole('user'); setNewTravellerIds([]); }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// === Change password modal (all authenticated users) ===
function ChangePasswordModal({ onClose }) {
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const newPwRef = useRef(null);

  async function submit() {
    if (!currentPw || !newPw) return;
    if (newPw.length < 8) { setError('New password must be at least 8 characters'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      const d = await res.json();
      if (res.ok) {
        setSuccess('Password changed successfully.');
        setCurrentPw(''); setNewPw('');
      } else {
        setError(d.error || 'Failed to change password');
      }
    } catch (e) { setError('Connection error'); }
    setLoading(false);
  }

  return (
    <div className="login-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="login-modal">
        <button className="login-close" onClick={onClose}>×</button>
        <div className="login-title">Change Password</div>
        <input
          className="login-input"
          type="password"
          placeholder="Current password"
          value={currentPw}
          autoFocus
          autoComplete="current-password"
          onChange={e => setCurrentPw(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && currentPw) newPwRef.current?.focus(); if (e.key === 'Escape') onClose(); }}
        />
        <input
          ref={newPwRef}
          className="login-input"
          type="password"
          placeholder="New password (min 8 chars)"
          value={newPw}
          autoComplete="new-password"
          onChange={e => setNewPw(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); }}
        />
        {error && <div className="login-error">{error}</div>}
        {success && <div className="admin-success">{success}</div>}
        <div className="login-actions">
          <button className="login-btn" onClick={submit} disabled={loading || !currentPw || !newPw}>
            {loading ? 'Saving…' : 'Change password'}
          </button>
          <button className="login-guest" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
