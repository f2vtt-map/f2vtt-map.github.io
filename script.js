/* =====================================================================
   F2VTT Map — by Ghilas
   Leaflet + Supabase (Auth, Postgres, Storage)
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------------
   1. CONFIGURATION
   La clé "publishable" est faite pour être publique : la sécurité repose
   sur les règles RLS (voir supabase.sql). Ne mets JAMAIS de clé secrète ici.
   --------------------------------------------------------------------- */
const CONFIG = {
  SUPABASE_URL: 'https://bhqhbiaejcbijlprjimy.supabase.co',
  SUPABASE_KEY: 'sb_publishable_jplSlzJVE2g_TxQB3nlp1Q_hHlhEpE1',
  // Supabase Auth exige un email : on en fabrique un à partir du prénom et du nom
  // (ex. jean.dupont@f2vtt-map.com). Aucun email n'est jamais envoyé.
  EMAIL_DOMAIN: 'f2vtt-map.com',
  MIN_PASSWORD: 6,
  BUCKET: 'spot-photos',
  MAX_PHOTOS: 5,
  BOUNDS: [[50.48, 2.85], [50.82, 3.35]] // MEL
};

const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

/* ---------------------------------------------------------------------
   2. DONNÉES DE RÉFÉRENCE
   --------------------------------------------------------------------- */
const LEVELS = {
  0: ['🔘', 'Varié'],
  1: ['🟢', 'Easy'],
  2: ['🟡', 'Plutôt easy'],
  3: ['🟠', 'Moyen'],
  4: ['🔴', 'Difficile'],
  5: ['⚫', 'Hard 🔥']
};
const LEVEL_COLORS = ['#9ca3af', '#22c55e', '#eab308', '#f97316', '#ef4444', '#111827'];

const CATEGORY_ICONS = {
  'Descente': '🏔️',
  'Sentier': '🌲',
  'Pumptrack': '🔁',
  'Spot urbain': '🏙️',
  'Rampe': '📐',
  'Skatepark': '🛹',
  'Autre': '📍'
};

/* ---------------------------------------------------------------------
   3. OUTILS
   --------------------------------------------------------------------- */
const $ = id => document.getElementById(id);

let toastTimer = null;
function msg(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, isError ? 6000 : 2200);
}

const clampDiff = d => Math.min(5, Math.max(0, Number.isFinite(Number(d)) ? Number(d) : 0));

/** Transforme une erreur Supabase / réseau en phrase compréhensible pour l'utilisateur. */
function errorMessage(err, what) {
  const code = String((err && (err.code || err.statusCode)) || '');
  const text = String((err && (err.message || err.error_description)) || err || '');
  let reason;
  if (code === 'PGRST204' || /schema cache/i.test(text)) {
    const col = (text.match(/'([^']+)' column/) || [])[1];
    reason = 'la base ne connaît pas la colonne « ' + (col || '?') + ' ». Lance supabase.sql dans Supabase (SQL Editor).';
  } else if (code === 'PGRST116' || /Aucune ligne/i.test(text)) {
    reason = 'spot introuvable, ou tu n’en es pas le propriétaire.';
  } else if (code === '42501' || /row-level security|permission denied|not authorized/i.test(text)) {
    reason = 'accès refusé. Reconnecte-toi, et vérifie que c’est bien ton spot.';
  } else if (/jwt|PGRST30\d/i.test(code + ' ' + text)) {
    reason = 'ta session a expiré. Déconnecte-toi puis reconnecte-toi.';
  } else if (code === '23514' || /check constraint/i.test(text)) {
    reason = 'données refusées par la base (catégorie, difficulté ou nombre de photos).';
  } else if (/bucket not found/i.test(text)) {
    reason = 'le stockage photo « ' + CONFIG.BUCKET + ' » n’existe pas. Lance supabase.sql.';
  } else if (/maximum allowed size|payload too large|413/i.test(text)) {
    reason = 'une photo est trop lourde (5 Mo maximum).';
  } else if (/failed to fetch|network|load failed/i.test(text)) {
    reason = 'pas de connexion à Internet.';
  } else {
    reason = text ? text.slice(0, 120) : 'erreur inconnue.';
  }
  return what + ' impossible : ' + reason;
}

function inBounds(lat, lng) {
  const [[s, w], [n, e]] = CONFIG.BOUNDS;
  return lat >= s && lat <= n && lng >= w && lng <= e;
}

function gmapsUrl(lat, lng) {
  return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(lat + ',' + lng);
}

/** N'accepte que des URL https (Storage) ou data:image (anciens spots). */
function safeSrc(u) {
  return typeof u === 'string' && (/^https:\/\//i.test(u) || /^data:image\//i.test(u)) ? u : '';
}

function normalizeGeometry(g) {
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch (_) { return null; } }
  if (!g || g.type !== 'LineString' || !Array.isArray(g.coordinates)) return null;
  const coordinates = g.coordinates
    .filter(c => Array.isArray(c) && c.length >= 2 && Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1])))
    .map(c => [Number(c[0]), Number(c[1])]);
  return coordinates.length >= 2 ? { type: 'LineString', coordinates } : null;
}

/** GeoJSON [lng,lat] -> Leaflet [lat,lng] */
const geometryToLatLngs = g => g.coordinates.map(c => [c[1], c[0]]);

function fromRow(r) {
  return {
    id: r.id,
    name: r.name || 'Sans nom',
    type: r.category || 'Autre',
    diff: clampDiff(r.difficulty),
    desc: r.description || '',
    lat: Number(r.latitude),
    lng: Number(r.longitude),
    photos: Array.isArray(r.photos) ? r.photos.filter(safeSrc).slice(0, CONFIG.MAX_PHOTOS) : [],
    geometry: normalizeGeometry(r.geometry),
    createdBy: r.created_by || null,
    author: r.author_name || '',
    authorCity: r.author_city || ''
  };
}

/* ---------------------------------------------------------------------
   4. CARTE
   --------------------------------------------------------------------- */
const map = L.map('map', {
  maxBounds: CONFIG.BOUNDS,
  maxBoundsViscosity: 0.6,   // léger effet de résistance aux limites
  minZoom: 10,
  maxZoom: 18,
  zoomControl: false,
  zoomAnimation: false
});
map.fitBounds(CONFIG.BOUNDS);

const planLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

const satelliteLayer = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    maxNativeZoom: 18,
    attribution: 'Tiles &copy; Esri'
  });

L.control.layers({ '🗺️ Plan': planLayer, '🛰️ Satellite': satelliteLayer }, null,
  { collapsed: true, position: 'topright' }).addTo(map);

const spotLayer = L.layerGroup().addTo(map); // tous les marqueurs / tracés
const userLayer = L.layerGroup().addTo(map); // position de l'utilisateur

$('zoomIn').onclick = () => map.zoomIn();
$('zoomOut').onclick = () => map.zoomOut();

/* ---------------------------------------------------------------------
   5. ÉTAT
   --------------------------------------------------------------------- */
let spots = [];
let selectedId = null;       // spot affiché dans la fiche
let appStarted = false;      // true une fois connecté
let currentUser = null;      // {id, nom, prenom, ville}
let authorColumnsMissing = false; // colonnes author_* absentes de la base (SQL pas relancé)

const draw = {
  mode: null,                // 'point' | 'line' | null
  placing: false,
  point: null,               // {lat,lng}
  linePoints: [],            // [[lat,lng], ...]
  layer: null,               // aperçu (marqueur ou polyline)
  editingId: null            // id du spot en cours de modification
};
let photoItems = [];         // {url?, file?, preview}

/* ---------------------------------------------------------------------
   6. SUPABASE : accès aux données
   --------------------------------------------------------------------- */
async function loadSpots() {
  const { data, error } = await sb.from('spots').select('*').order('created_at', { ascending: true });
  if (error) {
    console.error('Erreur chargement spots :', error);
    msg(errorMessage(error, 'Chargement des spots'), true);
    return;
  }
  spots = (data || []).map(fromRow);
  render();
  if (selectedId !== null && !spots.some(s => s.id === selectedId)) closeInfo();
}

function rowPayload(d) {
  return {
    name: d.name,
    description: d.desc || '',
    category: d.type || 'Autre',
    difficulty: clampDiff(d.diff),
    latitude: d.lat,
    longitude: d.lng,
    photos: d.photos.slice(0, CONFIG.MAX_PHOTOS),
    geometry: d.geometry || null
  };
}

async function insertSpot(d) {
  // Colonnes envoyées : name, description, category, difficulty, latitude, longitude,
  // photos, geometry, author_name, author_city  (+ created_by, rempli par la base)
  const base = rowPayload(d);
  const payload = {
    ...base,
    // "Prénom N." + ville, affichés dans la fiche
    author_name: currentUser ? currentUser.prenom + ' ' + currentUser.nom.charAt(0) + '.' : null,
    author_city: currentUser ? currentUser.ville : null
  };
  authorColumnsMissing = false;
  let { data, error } = await sb.from('spots').insert(payload).select().single();

  // Colonnes « auteur » absentes (supabase.sql pas encore relancé) : on enregistre
  // quand même le spot, sans l'auteur, au lieu de bloquer l'utilisateur.
  if (error && error.code === 'PGRST204' && /author_(name|city)/.test(error.message || '')) {
    console.warn('Colonnes author_* absentes : insertion sans auteur.', error);
    authorColumnsMissing = true;
    ({ data, error } = await sb.from('spots').insert(base).select().single());
  }
  if (error) throw error;
  return fromRow(data);
}

async function updateSpot(id, d) {
  // .select().single() : échoue si aucune ligne n'a été modifiée (ex. RLS)
  const { data, error } = await sb.from('spots').update(rowPayload(d)).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

async function deleteSpot(id) {
  const { data, error } = await sb.from('spots').delete().eq('id', id).select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('Aucune ligne supprimée');
}

/* ---------------------------------------------------------------------
   7. SUPABASE : photos (Storage)
   --------------------------------------------------------------------- */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Redimensionne (max 1600 px) et compresse en JPEG avant l'envoi. */
async function compressImage(file, max = 1600, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const ratio = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * ratio));
    c.height = Math.max(1, Math.round(img.naturalHeight * ratio));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res, rej) =>
      c.toBlob(b => (b ? res(b) : rej(new Error('Compression impossible'))), 'image/jpeg', quality));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadPhoto(file) {
  const blob = await compressImage(file);
  const path = crypto.randomUUID() + '.jpg';
  const { error } = await sb.storage.from(CONFIG.BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' });
  if (error) throw error;
  return sb.storage.from(CONFIG.BUCKET).getPublicUrl(path).data.publicUrl;
}

function storagePath(url) {
  const marker = '/storage/v1/object/public/' + CONFIG.BUCKET + '/';
  const i = typeof url === 'string' ? url.indexOf(marker) : -1;
  return i === -1 ? null : decodeURIComponent(url.slice(i + marker.length).split('?')[0]);
}

/** Suppression "au mieux" : une erreur ici ne doit jamais bloquer l'utilisateur. */
async function removeFromStorage(urls) {
  const paths = urls.map(storagePath).filter(Boolean);
  if (!paths.length) return;
  try { await sb.storage.from(CONFIG.BUCKET).remove(paths); }
  catch (e) { console.warn('Nettoyage Storage impossible :', e); }
}

/* ---------------------------------------------------------------------
   8. AFFICHAGE DES SPOTS
   --------------------------------------------------------------------- */
function pinIcon(spot) {
  const color = LEVEL_COLORS[clampDiff(spot.diff)];
  const emoji = CATEGORY_ICONS[spot.type] || CATEGORY_ICONS['Autre'];
  return L.divIcon({
    className: '',
    html: '<div class="spot-pin" style="border-color:' + color + '">' + emoji + '</div>',
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });
}

function render() {
  spotLayer.clearLayers(); // évite tout doublon
  spots.forEach(s => {
    if (s.geometry) {
      const latlngs = geometryToLatLngs(s.geometry);
      const color = LEVEL_COLORS[clampDiff(s.diff)];
      const open = () => showInfo(s.id);
      // liseré blanc + trait coloré + zone invisible plus large (facile à toucher)
      L.polyline(latlngs, { color: '#fff', weight: 9, opacity: .9, interactive: false }).addTo(spotLayer);
      L.polyline(latlngs, { color, weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(spotLayer);
      L.polyline(latlngs, { color: '#000', weight: 26, opacity: 0, lineCap: 'round' }).on('click', open).addTo(spotLayer);
      L.marker(latlngs[0], { icon: pinIcon(s), title: s.name }).on('click', open).addTo(spotLayer);
    } else if (Number.isFinite(s.lat) && Number.isFinite(s.lng)) {
      L.marker([s.lat, s.lng], { icon: pinIcon(s), title: s.name })
        .on('click', () => showInfo(s.id)).addTo(spotLayer);
    }
  });
}

/* ---------------------------------------------------------------------
   9. PANNEAUX
   --------------------------------------------------------------------- */
function hidePanels() {
  ['info', 'form', 'drawChoice'].forEach(id => $(id).classList.remove('show'));
}

function closeInfo() {
  selectedId = null;
  $('info').classList.remove('show');
}

function showInfo(id) {
  const s = spots.find(x => x.id === id);
  if (!s) return;
  // pas de changement de fiche pendant un tracé ou une saisie de formulaire
  if (draw.placing || $('form').classList.contains('show')) return;
  selectedId = id;

  const l = LEVELS[clampDiff(s.diff)];
  $('infoName').textContent = '🚵 ' + s.name;
  $('infoMeta').textContent = l[0] + ' ' + l[1] + ' · ' + (CATEGORY_ICONS[s.type] || '') + ' ' + s.type +
    (s.geometry ? ' · Ligne (' + s.geometry.coordinates.length + ' points)' : '');

  const anchor = s.geometry
    ? { lat: s.geometry.coordinates[0][1], lng: s.geometry.coordinates[0][0] }
    : { lat: s.lat, lng: s.lng };
  $('infoLoc').textContent = '📍 GPS : ' + anchor.lat.toFixed(6) + ', ' + anchor.lng.toFixed(6);

  $('infoAuthor').textContent = s.author
    ? 'Ajouté par ' + s.author + (s.authorCity ? ' · ' + s.authorCity : '')
    : '';
  const mine = canEdit(s);
  $('edit').style.display = mine ? '' : 'none';
  $('delete').style.display = mine ? '' : 'none';

  $('infoDesc').textContent = s.desc || 'Aucune description.';

  const gallery = $('infoGallery');
  gallery.replaceChildren();
  s.photos.forEach(p => {
    const img = document.createElement('img');
    img.src = safeSrc(p);
    img.alt = 'Photo de ' + s.name;
    img.loading = 'lazy';
    img.onclick = () => openLightbox(img.src);
    gallery.appendChild(img);
  });
  $('infoPhotoCount').textContent = s.photos.length + ' / ' + CONFIG.MAX_PHOTOS + ' photos';

  $('googleMaps').href = gmapsUrl(anchor.lat, anchor.lng);

  hidePanels();
  $('info').classList.add('show');
}

function openLightbox(src) {
  $('lightbox').querySelector('img').src = src;
  $('lightbox').classList.add('show');
}
$('lightbox').onclick = () => $('lightbox').classList.remove('show');
$('closeInfo').onclick = closeInfo;

/* ---------------------------------------------------------------------
   10. AJOUT : choix point / ligne, placement, tracé
   --------------------------------------------------------------------- */
function resetDrawLayer() {
  if (draw.layer) { map.removeLayer(draw.layer); draw.layer = null; }
}

function resetDraw() {
  draw.mode = null;
  draw.placing = false;
  draw.point = null;
  draw.linePoints = [];
  draw.editingId = null;
  resetDrawLayer();
  map.doubleClickZoom.enable();
  $('drawBar').classList.remove('show');
  $('finishLine').classList.remove('show');
  $('undoPoint').classList.remove('show');
}

function updateDrawBar() {
  const n = draw.linePoints.length;
  $('drawBar').classList.add('show');
  $('finishLine').classList.toggle('show', draw.mode === 'line' && n >= 2);
  $('undoPoint').classList.toggle('show', draw.mode === 'line' && n >= 1);
}

$('add').onclick = () => {
  resetDraw();
  resetForm();
  hidePanels();
  closeInfo();
  $('drawChoice').classList.add('show');
};

$('cancelDrawChoice').onclick = () => { resetDraw(); $('drawChoice').classList.remove('show'); };

$('addPoint').onclick = () => {
  resetDraw();
  draw.mode = 'point';
  draw.placing = true;
  map.doubleClickZoom.disable();
  $('drawChoice').classList.remove('show');
  updateDrawBar();
  msg('Clique sur la carte à l’emplacement du spot');
};

$('addLine').onclick = () => {
  resetDraw();
  draw.mode = 'line';
  draw.placing = true;
  map.doubleClickZoom.disable();
  $('drawChoice').classList.remove('show');
  updateDrawBar();
  msg('Clique plusieurs fois sur la carte pour tracer la ligne');
};

$('cancelDraw').onclick = () => { resetDraw(); msg('Ajout annulé'); };

$('undoPoint').onclick = () => {
  if (draw.mode !== 'line' || !draw.linePoints.length) return;
  draw.linePoints.pop();
  if (draw.layer) draw.layer.setLatLngs(draw.linePoints);
  updateDrawBar();
};

map.on('click', e => {
  if (!draw.placing) return;
  const lat = Number(e.latlng.lat.toFixed(7));
  const lng = Number(e.latlng.lng.toFixed(7));
  if (!inBounds(lat, lng)) return msg('Hors de la Métropole Européenne de Lille', true);

  if (draw.mode === 'point') {
    draw.point = { lat, lng };
    draw.placing = false;
    resetDrawLayer();
    draw.layer = L.marker([lat, lng]).addTo(map);
    $('drawBar').classList.remove('show');
    openForm(false);
    return;
  }

  if (draw.mode === 'line') {
    draw.linePoints.push([lat, lng]);
    if (!draw.layer) {
      draw.layer = L.polyline(draw.linePoints, {
        color: '#188038', weight: 5, opacity: .9, lineCap: 'round', lineJoin: 'round'
      }).addTo(map);
    } else {
      draw.layer.setLatLngs(draw.linePoints);
    }
    updateDrawBar();
  }
});

$('finishLine').onclick = () => {
  if (draw.mode !== 'line' || draw.linePoints.length < 2) return msg('Ajoute au moins 2 points', true);
  draw.point = { lat: draw.linePoints[0][0], lng: draw.linePoints[0][1] };
  draw.placing = false;
  $('drawBar').classList.remove('show');
  msg('Tracé terminé ✅');
  openForm(false);
};

/* ---------------------------------------------------------------------
   11. FORMULAIRE
   --------------------------------------------------------------------- */
function releasePreviews() {
  photoItems.forEach(it => { if (it.file) URL.revokeObjectURL(it.preview); });
}

function resetForm() {
  releasePreviews();
  photoItems = [];
  $('name').value = '';
  $('desc').value = '';
  $('type').value = 'Descente';
  $('diff').value = '0';
  $('photos').value = '';
  $('save').textContent = 'Enregistrer';
  $('save').disabled = false;
  renderPreview();
}

function openForm(editing) {
  hidePanels();
  $('formTitle').textContent = editing ? '✏️ Modifier le spot' : '📍 Ajouter un spot';
  $('formHint').textContent = editing
    ? 'Modifie les informations puis enregistre. La position ne change pas.'
    : (draw.mode === 'line'
      ? 'La ligne est tracée. Remplis maintenant les informations du spot.'
      : 'Position choisie. Remplis maintenant les informations du spot.');
  $('save').textContent = editing ? 'Enregistrer les modifications' : 'Enregistrer';
  $('form').classList.add('show');
  $('form').scrollTop = 0;
}

function renderPreview() {
  const box = $('preview');
  box.replaceChildren();
  photoItems.forEach((it, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'thumb';
    const img = document.createElement('img');
    img.src = safeSrc(it.preview) || it.preview;
    img.alt = 'Photo ' + (i + 1);
    const del = document.createElement('button');
    del.type = 'button';
    del.setAttribute('aria-label', 'Supprimer cette photo');
    del.textContent = '×';
    del.onclick = () => {
      if (it.file) URL.revokeObjectURL(it.preview);
      photoItems.splice(i, 1);
      renderPreview();
    };
    wrap.append(img, del);
    box.appendChild(wrap);
  });
  $('photoHelp').textContent = photoItems.length + ' / ' + CONFIG.MAX_PHOTOS + ' photo' + (photoItems.length > 1 ? 's' : '');
}

$('photos').onchange = e => {
  const files = Array.from(e.target.files || []).filter(f => f.type.startsWith('image/'));
  const room = CONFIG.MAX_PHOTOS - photoItems.length;
  if (files.length > room) msg('Maximum 5 photos atteint', true);
  files.slice(0, Math.max(0, room)).forEach(f =>
    photoItems.push({ file: f, preview: URL.createObjectURL(f) }));
  e.target.value = '';
  renderPreview();
};

$('close').onclick = () => {
  const wasEditing = draw.editingId;
  resetDraw();
  resetForm();
  $('form').classList.remove('show');
  if (wasEditing !== null && spots.some(s => s.id === wasEditing)) showInfo(wasEditing);
};

$('save').onclick = async () => {
  const name = $('name').value.trim();
  const editing = draw.editingId !== null;
  if (!editing && !draw.point) return msg('Choisis l’emplacement sur la carte', true);
  if (!name) return msg('Ajoute un nom', true);

  const btn = $('save');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Enregistrement…';

  const uploaded = [];   // URL envoyées pendant cette sauvegarde (à nettoyer si échec)
  try {
    // 1. Envoi des nouvelles photos
    const finalPhotos = [];
    for (const it of photoItems) {
      if (it.file) {
        const url = await uploadPhoto(it.file);
        uploaded.push(url);
        finalPhotos.push(url);
      } else {
        finalPhotos.push(it.url);
      }
    }

    // 2. Enregistrement
    const base = {
      name,
      type: $('type').value,
      diff: Number($('diff').value),
      desc: $('desc').value.trim(),
      photos: finalPhotos
    };

    if (editing) {
      const current = spots.find(s => s.id === draw.editingId);
      if (!current) throw new Error('Spot introuvable');
      const saved = await updateSpot(current.id, {
        ...base, lat: current.lat, lng: current.lng, geometry: current.geometry
      });
      const kept = new Set(finalPhotos);
      await removeFromStorage(current.photos.filter(u => !kept.has(u)));
      spots = spots.map(s => (s.id === saved.id ? saved : s));
      msg('Spot modifié ✅');
      const id = saved.id;
      resetDraw(); resetForm(); $('form').classList.remove('show'); render(); showInfo(id);
      return;
    }

    let geometry = null;
    if (draw.mode === 'line' && draw.linePoints.length >= 2) {
      geometry = { type: 'LineString', coordinates: draw.linePoints.map(p => [p[1], p[0]]) };
    }
    const saved = await insertSpot({ ...base, lat: draw.point.lat, lng: draw.point.lng, geometry });
    spots.push(saved);
    msg(authorColumnsMissing
      ? 'Spot ajouté ✅ (sans auteur : lance supabase.sql dans Supabase)'
      : 'Spot ajouté ✅');
    resetDraw(); resetForm(); $('form').classList.remove('show'); render();
  } catch (err) {
    console.error('Erreur enregistrement :', err);
    await removeFromStorage(uploaded);
    msg(errorMessage(err, 'Enregistrement'), true);
    btn.disabled = false;
    btn.textContent = label;
  }
};

/* ---------------------------------------------------------------------
   12. MODIFICATION / SUPPRESSION
   --------------------------------------------------------------------- */
$('edit').onclick = () => {
  const s = spots.find(x => x.id === selectedId);
  if (!s) return;
  if (!canEdit(s)) return msg('Tu ne peux modifier que tes propres spots', true);
  resetDraw();
  resetForm();
  draw.editingId = s.id;
  $('name').value = s.name;
  $('type').value = s.type;
  $('diff').value = String(clampDiff(s.diff));
  $('desc').value = s.desc;
  photoItems = s.photos.map(u => ({ url: u, preview: u }));
  renderPreview();
  openForm(true);
};

$('delete').onclick = async () => {
  const s = spots.find(x => x.id === selectedId);
  if (!s) return;
  if (!canEdit(s)) return msg('Tu ne peux supprimer que tes propres spots', true);
  if (!confirm('Es-tu sûr de vouloir supprimer ce spot ? Cette action est irréversible.')) return;
  try {
    await deleteSpot(s.id);
    await removeFromStorage(s.photos);
    spots = spots.filter(x => x.id !== s.id);
    closeInfo();
    render();
    msg('Spot supprimé ✅');
  } catch (err) {
    console.error('Erreur suppression :', err);
    msg(errorMessage(err, 'Suppression'), true);
  }
};

/* ---------------------------------------------------------------------
   13. GÉOLOCALISATION
   --------------------------------------------------------------------- */
$('locate').onclick = () => {
  if (!navigator.geolocation) return msg('Géolocalisation indisponible', true);
  msg('Recherche de ta position…');
  navigator.geolocation.getCurrentPosition(
    p => {
      const { latitude: lat, longitude: lng, accuracy } = p.coords;
      if (!inBounds(lat, lng)) return msg('Ta position est hors de la MEL', true);
      userLayer.clearLayers();
      L.circle([lat, lng], { radius: accuracy, color: '#1a73e8', weight: 1, fillOpacity: .1, interactive: false }).addTo(userLayer);
      L.marker([lat, lng], {
        icon: L.divIcon({ className: '', html: '<div class="user-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
        interactive: false
      }).addTo(userLayer);
      map.setView([lat, lng], 15);
    },
    err => msg(err && err.code === 1
      ? 'Localisation refusée : autorise-la dans ton navigateur'
      : 'Impossible de récupérer la position', true),
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 10000 }
  );
};

/* ---------------------------------------------------------------------
   14. COMPTES (Supabase Auth)
   Inscription avec nom, prénom, mot de passe et ville. Supabase vérifie le
   mot de passe côté serveur (jamais dans le code) et garde la session dans le
   navigateur : on ne retape rien à chaque visite, sur cet appareil.
   --------------------------------------------------------------------- */
const stripAccents = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const slug = s => stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const clean = s => s.trim().replace(/\s+/g, ' ');
const titleCase = s => s.toLocaleLowerCase('fr')
  .replace(/(^|[\s'’-])(\p{L})/gu, (m, a, b) => a + b.toLocaleUpperCase('fr'));

/** prénom + nom -> email technique (même personne = même email, sans accents ni majuscules) */
function toEmail(nom, prenom) {
  return slug(prenom) + '.' + slug(nom) + '@' + CONFIG.EMAIL_DOMAIN;
}

function userFromAuth(u) {
  const m = (u && u.user_metadata) || {};
  return { id: u.id, nom: m.nom || '', prenom: m.prenom || '', ville: m.ville || '' };
}

/** On ne modifie que ses propres spots (les anciens spots sans propriétaire restent ouverts). */
function canEdit(spot) {
  return !!currentUser && (spot.createdBy === null || spot.createdBy === currentUser.id);
}

let authMode = 'signup';
function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  $('tabSignup').classList.toggle('active', signup);
  $('tabLogin').classList.toggle('active', !signup);
  $('authVilleWrap').classList.toggle('hidden', !signup);
  $('authVille').required = signup;
  $('authPassword').autocomplete = signup ? 'new-password' : 'current-password';
  $('lockSubmit').textContent = signup ? 'Créer mon compte' : 'Me connecter';
  $('lockIntro').textContent = signup
    ? 'Crée ton compte pour accéder à la carte. Le site s’en souviendra sur cet appareil.'
    : 'Reconnecte-toi avec ton nom, ton prénom et ton mot de passe.';
  $('lockError').textContent = '';
}
$('tabSignup').onclick = () => setAuthMode('signup');
$('tabLogin').onclick = () => setAuthMode('login');

function authMessage(err) {
  const t = (err && err.message) || '';
  if (/already|registered/i.test(t)) return 'Ce nom et ce prénom ont déjà un compte. Va dans « J’ai déjà un compte ».';
  if (/invalid login|credentials/i.test(t)) return 'Nom, prénom ou mot de passe incorrect.';
  if (/at least|weak|short/i.test(t)) return 'Mot de passe trop court (' + CONFIG.MIN_PASSWORD + ' caractères minimum).';
  if (/signups?.*(not allowed|disabled)|not allowed/i.test(t)) return 'Les inscriptions sont fermées sur ce site.';
  if (/email.*(invalid|address)|invalid.*email/i.test(t)) return 'Supabase refuse l’adresse technique : change EMAIL_DOMAIN dans script.js.';
  if (/rate|too many/i.test(t)) return 'Trop d’essais, réessaie dans quelques minutes.';
  return 'Connexion impossible. Réessaie.';
}

function startApp(user) {
  currentUser = userFromAuth(user);
  $('account').textContent = (currentUser.prenom || '?').charAt(0).toUpperCase();
  $('account').title = 'Connecté : ' + currentUser.prenom + ' ' + currentUser.nom;
  $('lockScreen').classList.add('hidden');
  setTimeout(() => map.invalidateSize(), 50);
  if (appStarted) return;
  appStarted = true;
  loadSpots();
  subscribeRealtime();
}

let rtTimer = null;
function subscribeRealtime() {
  try {
    sb.channel('spots-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'spots' }, () => {
        clearTimeout(rtTimer);
        rtTimer = setTimeout(loadSpots, 600); // regroupe les évènements rapprochés
      })
      .subscribe();
  } catch (e) { console.warn('Temps réel indisponible :', e); }
}

$('authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const nom = clean($('authNom').value);
  const prenom = clean($('authPrenom').value);
  const ville = clean($('authVille').value);
  const pwd = $('authPassword').value;
  const errBox = $('lockError');
  errBox.textContent = '';

  if (!slug(nom) || !slug(prenom)) { errBox.textContent = 'Entre ton nom et ton prénom.'; return; }
  if (pwd.length < CONFIG.MIN_PASSWORD) {
    errBox.textContent = 'Mot de passe : ' + CONFIG.MIN_PASSWORD + ' caractères minimum.';
    return;
  }
  if (authMode === 'signup' && !ville) { errBox.textContent = 'Entre ta ville.'; return; }

  const email = toEmail(nom, prenom);
  const btn = $('lockSubmit');
  btn.disabled = true;
  try {
    const result = authMode === 'signup'
      ? await sb.auth.signUp({
          email,
          password: pwd,
          options: { data: { nom: nom.toLocaleUpperCase('fr'), prenom: titleCase(prenom), ville: titleCase(ville) } }
        })
      : await sb.auth.signInWithPassword({ email, password: pwd });
    if (result.error) throw result.error;

    const session = result.data && result.data.session;
    if (!session) {
      errBox.textContent = 'Compte créé, mais Supabase attend une confirmation par email. Désactive « Confirm email » (voir README).';
      return;
    }
    $('authPassword').value = '';
    startApp(session.user);
  } catch (ex) {
    console.error('Erreur compte :', ex);
    errBox.textContent = authMessage(ex);
  } finally {
    btn.disabled = false;
  }
});

$('account').onclick = async () => {
  if (!currentUser) return;
  const who = (currentUser.prenom + ' ' + currentUser.nom).trim() + (currentUser.ville ? ' (' + currentUser.ville + ')' : '');
  if (!confirm('Connecté en tant que ' + who + '.\n\nTe déconnecter ?')) return;
  await sb.auth.signOut();
};

sb.auth.onAuthStateChange(event => {
  if (event === 'SIGNED_OUT') {
    appStarted = false;
    currentUser = null;
    spots = [];
    selectedId = null;
    sb.removeAllChannels();
    resetDraw();
    resetForm();
    spotLayer.clearLayers();
    userLayer.clearLayers();
    hidePanels();
    setAuthMode('login');
    $('lockScreen').classList.remove('hidden');
  }
});

(async function init() {
  setAuthMode('signup');
  try {
    const { data } = await sb.auth.getSession();
    if (data && data.session) startApp(data.session.user); // session déjà ouverte : rien à retaper
  } catch (e) {
    console.error('Session illisible :', e);
  } finally {
    $('lockScreen').classList.remove('checking');
  }
})();
