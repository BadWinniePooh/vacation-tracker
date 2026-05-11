// Leaflet map wrapper for React. Exposes a singleton-ish map instance the
// React app can drive imperatively.

const { useEffect, useRef, useMemo } = React;

function mixColor(t, palette) {
  if (t <= 0) return palette[0];
  if (t >= 1) return palette[2];
  const c = mixColor._ctx || (mixColor._ctx = (() => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    return cv.getContext('2d', { willReadFrequently: true });
  })());
  const lerp = (a, b, x) => {
    c.fillStyle = a; c.fillRect(0,0,1,1);
    const A = c.getImageData(0,0,1,1).data;
    c.fillStyle = b; c.fillRect(0,0,1,1);
    const B = c.getImageData(0,0,1,1).data;
    const m = (i) => Math.round(A[i]*(1-x) + B[i]*x);
    return `rgb(${m(0)}, ${m(1)}, ${m(2)})`;
  };
  if (t < 0.5) return lerp(palette[0], palette[1], t*2);
  return lerp(palette[1], palette[2], (t-0.5)*2);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const NAME_ALIASES = {
  "United States": "United States of America",
  "USA": "United States of America",
  "US": "United States of America",
  "UK": "United Kingdom",
  "Britain": "United Kingdom",
  "Great Britain": "United Kingdom",
  "England": "United Kingdom",
  "Czech Republic": "Czechia",
  "South Korea": "South Korea",
  "Republic of Korea": "South Korea",
  "Korea, South": "South Korea",
  "North Korea": "North Korea",
  "Russian Federation": "Russia",
  "UAE": "United Arab Emirates",
  "Burma": "Myanmar",
  "Ivory Coast": "Côte d'Ivoire",
  "Cote d'Ivoire": "Côte d'Ivoire",
  "Cape Verde": "Cabo Verde",
  "Swaziland": "Eswatini",
  "Macedonia": "North Macedonia",
  "Republic of Serbia": "Serbia",
  "Republic of the Congo": "Congo",
  "Democratic Republic of the Congo": "DR Congo",
  "Dem. Rep. Congo": "DR Congo",
  "Bosnia and Herz.": "Bosnia and Herzegovina",
  "Dominican Rep.": "Dominican Republic",
  "Eq. Guinea": "Equatorial Guinea",
  "Central African Rep.": "Central African Republic",
  "S. Sudan": "South Sudan",
  "W. Sahara": "Western Sahara",
  "Falkland Is.": "Falkland Islands",
  "Solomon Is.": "Solomon Islands",
  "Taiwan": "Taiwan",
  "Palestine": "Palestine"
};

function normalizeCountry(name) {
  if (!name) return name;
  return NAME_ALIASES[name] || name;
}
window.normalizeCountry = normalizeCountry;

function WorldMap({ state, palette, colorByType, types, tr, selectedCity, onSelectCity, onCountryClick }) {
  const mapRef = useRef(null);
  const markersLayerRef = useRef(null);
  const countryLayerRef = useRef(null);

  useEffect(() => {
    if (mapRef.current) return;
    const map = L.map('map', {
      center: [25, 10],
      zoom: 2,
      minZoom: 2,
      maxZoom: 7,
      worldCopyJump: false,
      attributionControl: true,
      zoomControl: true,
      preferCanvas: false,
    });
    map.attributionControl.setPrefix('');
    mapRef.current = map;

    markersLayerRef.current = L.layerGroup().addTo(map);

    const topoUrl = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json';
    fetch(topoUrl)
      .then(r => r.json())
      .then(topo => {
        const geo = window.topojson.feature(topo, topo.objects.countries);
        function shift(coords) {
          if (typeof coords[0] === 'number') {
            return [coords[0] < -100 ? coords[0] + 360 : coords[0], coords[1]];
          }
          return coords.map(shift);
        }
        for (const f of geo.features) {
          const n = f.properties.name;
          if (n === 'Russia' || n === 'Fiji') {
            f.geometry.coordinates = shift(f.geometry.coordinates);
          }
        }
        const layer = L.geoJSON(geo, {
          style: () => ({
            fillColor: cssVar('--land-empty'),
            fillOpacity: 0.85,
            color: cssVar('--bg-card'),
            weight: 0.8,
          }),
          onEachFeature: (feature, l) => {
            const name = normalizeCountry(feature.properties.name);
            l.feature.properties._normalizedName = name;
            l.on('click', () => onCountryClickRef.current && onCountryClickRef.current(name));
            l.on('mouseover', (e) => { e.target.setStyle({ weight: 1.4 }); });
            l.on('mouseout', (e) => { e.target.setStyle({ weight: 0.8 }); });
          }
        }).addTo(map);
        layer.eachLayer(l => l.options.className = 'country-path');
        countryLayerRef.current = layer;
        repaintCountries();
      })
      .catch(err => console.warn('Map data failed', err));
  }, []);

  const onCountryClickRef = useRef(onCountryClick);
  const onSelectCityRef = useRef(onSelectCity);
  useEffect(() => { onCountryClickRef.current = onCountryClick; });
  useEffect(() => { onSelectCityRef.current = onSelectCity; });

  const ratios = useMemo(() => {
    const out = {};
    for (const [country, c] of Object.entries(state.countries || {})) {
      const planned = (c.cities || []).length;
      if (planned === 0) { out[country] = null; continue; }
      const visited = (c.cities || []).filter(name => {
        const city = state.cities[name];
        return city && city.visited;
      }).length;
      out[country] = visited / planned;
    }
    return out;
  }, [state]);

  function repaintCountries() {
    const layer = countryLayerRef.current;
    if (!layer) return;
    const pal = [cssVar('--wanted'), cssVar('--partial'), cssVar('--visited')];
    layer.eachLayer(l => {
      const name = l.feature.properties._normalizedName;
      const r = ratios[name];
      const fill = r == null ? cssVar('--land-empty') : mixColor(r, pal);
      l.setStyle({
        fillColor: fill,
        fillOpacity: r == null ? 0.6 : 0.85,
        color: cssVar('--bg-card'),
        weight: 0.8,
      });
    });
  }
  useEffect(() => { repaintCountries(); }, [ratios, palette]);

  useEffect(() => {
    const layer = markersLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    const typeMap = {};
    (types || []).forEach(t => { typeMap[t.id] = t; });
    for (const city of Object.values(state.cities)) {
      const lat = city.latitude ?? city.lat;
      const lng = city.longitude ?? city.lng;
      if (lat == null || lng == null) continue;
      const visited = !!city.visited;
      const sel = selectedCity === city.name;
      const vt = city.type && typeMap[city.type];
      const dotColor = colorByType && vt ? vt.color : '';
      const dotStyle = dotColor ? ` style="background:${dotColor}"` : '';
      const glyph = vt ? `<span class="city-glyph" style="color:${vt.color}">${vt.glyph}</span>` : '';
      const html = `<div class="city-marker ${sel ? 'selected' : ''} ${visited ? 'is-visited' : 'is-wanted'}">
        <div class="city-dot ${visited ? 'visited' : 'wanted'}"${dotStyle}></div>
        ${glyph}
      </div>`;
      const icon = L.divIcon({ className: '', html, iconSize: [14, 14], iconAnchor: [7, 7] });
      const m = L.marker([lat, lng], { icon, riseOnHover: true });
      const trf = tr || ((k) => k);
      const photoCount = (city.photos && city.photos.length) || 0;
      const lines = [];
      lines.push(`<div class="tip-name">${city.name}</div>`);
      lines.push(`<div class="tip-country">${city.country}</div>`);
      // Use label directly for custom types; i18n key for built-ins
      if (vt) {
        const typeName = vt._custom ? vt.label : trf(vt.key);
        lines.push(`<div class="tip-type"><span style="color:${vt.color}">${vt.glyph}</span> ${typeName}</div>`);
      }
      if (visited) {
        lines.push(`<div class="tip-meta">${trf('detailVisited')}${city.visitDate ? ' · ' + city.visitDate : ''}</div>`);
      } else {
        lines.push(`<div class="tip-meta">${trf('detailWishlist')}</div>`);
      }
      if (photoCount) lines.push(`<div class="tip-meta">${photoCount} ${photoCount === 1 ? trf('photo') : trf('photos')}</div>`);
      m.bindTooltip(lines.join(''), {
        className: 'city-tip',
        direction: 'top',
        offset: [0, -10],
        permanent: sel,
        sticky: false,
      });
      m.on('click', () => onSelectCityRef.current && onSelectCityRef.current(city.name));
      m.addTo(layer);
    }
  }, [state.cities, selectedCity, colorByType]);

  useEffect(() => {
    if (!selectedCity || !mapRef.current) return;
    const c = state.cities[selectedCity];
    if (!c) return;
    const lat = c.latitude ?? c.lat;
    const lng = c.longitude ?? c.lng;
    if (lat == null) return;
    mapRef.current.flyTo([lat, lng], Math.max(mapRef.current.getZoom(), 4), { duration: 0.8 });
  }, [selectedCity]);

  return null;
}

window.WorldMap = WorldMap;
