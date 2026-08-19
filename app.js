/* ============================================================
   Curated Primer Database Explorer
   Conservation Genetics Group / CEG / KMUTT
   Static, browser-only. No backend, no build step.
   ============================================================ */

/* ---------- 1. Which databases exist -----------------------
   Everything in data/ ending in _tax.tsv. To add a database,
   drop the file in data/ and add its name to this list.
   The app also tries data/index.json first, so if you prefer
   you can list files there instead and leave this alone.
----------------------------------------------------------- */
const DEFAULT_FILES = [
  '12SV5_tax.tsv',
  'fwh2_tax.tsv',
  'mlCOIint_tax.tsv',
  'Vert16S_tax.tsv'
];

const DATA_DIR = 'data/';                 // relative -> works under /repo-name/
const RANKS = ['domain','phylum','class','order','family','genus','species'];
const RANK_PREFIX = {d:'domain', p:'phylum', c:'class', o:'order', f:'family', g:'genus', s:'species'};

let PRIMERS = [];          // [{id, file}]
const CACHE = new Map();   // id -> parsed database (session cache)
const LOADING = new Map(); // id -> Promise

/* ---------- 2. Small helpers ------------------------------ */
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const num = n => n.toLocaleString('en-US');
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function bytes(b){
  if (b == null) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(2) + ' MB';
}

function toast(msg){
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}

function primerIdFromFile(f){ return f.replace(/_tax\.tsv$/i, '').replace(/\.tsv$/i, ''); }

/* ---------- 3. Taxonomy parsing ---------------------------
   Handles incomplete strings safely. Missing ranks stay ''.
   Nothing is invented.
----------------------------------------------------------- */
function parseTaxonomy(str){
  const t = {domain:'', phylum:'', class:'', order:'', family:'', genus:'', species:''};
  if (!str) return t;
  const parts = str.split(';');
  for (let i = 0; i < parts.length; i++){
    const p = parts[i].trim();
    if (p.length < 3) continue;
    if (p[1] === '_' && p[2] === '_'){
      const rank = RANK_PREFIX[p[0]];
      if (rank){
        const v = p.slice(3).trim();
        if (v && v !== 'NA' && v !== 'unknown' && v !== 'unclassified') t[rank] = v;
      }
    }
  }
  return t;
}

/* Canonical species identity = Genus + species epithet.
   Requires BOTH. Returns null otherwise.               */
function speciesKey(genus, species){
  if (!genus || !species) return null;
  return genus.toLowerCase() + '|' + species.toLowerCase();
}
function speciesLabel(genus, species){
  // if the epithet already repeats the genus, don't duplicate it
  if (species.toLowerCase().startsWith(genus.toLowerCase() + ' ')) return species;
  return genus + ' ' + species;
}

/* ---------- 4. Streaming TSV loader -----------------------
   Reads the response as a stream and parses line by line so a
   120 MB file never has to exist twice in memory as one string.
   Falls back to .text() where streams are unavailable.
----------------------------------------------------------- */
async function loadPrimer(id, onProgress){
  if (CACHE.has(id)) return CACHE.get(id);
  if (LOADING.has(id)) return LOADING.get(id);

  const p = (async () => {
    const primer = PRIMERS.find(x => x.id === id);
    const url = DATA_DIR + primer.file;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Cannot read ${url} (HTTP ${res.status})`);

    const total = Number(res.headers.get('content-length')) || 0;
    const db = newDB(id, primer.file);
    let read = 0;

    if (res.body && res.body.getReader){
      const reader = res.body.getReader();
      const dec = new TextDecoder('utf-8');
      let tail = '';
      let first = true;
      for(;;){
        const {done, value} = await reader.read();
        if (done) break;
        read += value.length;
        const chunk = tail + dec.decode(value, {stream:true});
        const lines = chunk.split('\n');
        tail = lines.pop();
        for (let i = 0; i < lines.length; i++){
          if (first){ first = false; if (isHeader(lines[i])) continue; }
          addRow(db, lines[i]);
        }
        if (onProgress) onProgress(read, total);
        await Promise.resolve(); // yield so UI stays responsive
      }
      if (tail.trim()) { if (!(first && isHeader(tail))) addRow(db, tail); }
      db.bytes = read;
    } else {
      const text = await res.text();
      db.bytes = total || text.length;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++){
        if (i === 0 && isHeader(lines[i])) continue;
        addRow(db, lines[i]);
      }
    }

    finalizeDB(db);
    CACHE.set(id, db);
    LOADING.delete(id);
    return db;
  })();

  LOADING.set(id, p);
  p.catch(() => LOADING.delete(id));
  return p;
}

function isHeader(line){
  const l = line.toLowerCase();
  return l.startsWith('feature_id') || l.startsWith('#') || l.startsWith('featureid');
}

function newDB(id, file){
  return {
    id, file, bytes:0,
    ids: [],                 // Feature IDs
    tax: [],                 // raw taxonomy strings
    rows: [],                // {c,o,f,g,s} interned strings
    sets: {domain:new Map(), phylum:new Map(), class:new Map(), order:new Map(),
           family:new Map(), genus:new Map()},   // name -> feature count
    species: new Map(),      // key -> {label, genus, species, family, order, class, phylum, count}
    quality: {withSpecies:0, genusOnly:0, noGenus:0,
              missClass:0, missOrder:0, missFamily:0, missGenus:0, missSpecies:0}
  };
}

function bump(map, key){
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function addRow(db, line){
  if (!line) return;
  const tab = line.indexOf('\t');
  let id, taxStr;
  if (tab === -1){
    id = line.trim(); taxStr = '';
    if (!id) return;
  } else {
    id = line.slice(0, tab).trim();
    taxStr = line.slice(tab + 1).trim();
  }
  if (!id) return;

  const t = parseTaxonomy(taxStr);

  db.ids.push(id);
  db.tax.push(taxStr);
  db.rows.push({c:t.class, o:t.order, f:t.family, g:t.genus, s:t.species});

  bump(db.sets.domain, t.domain);
  bump(db.sets.phylum, t.phylum);
  bump(db.sets.class,  t.class);
  bump(db.sets.order,  t.order);
  bump(db.sets.family, t.family);
  bump(db.sets.genus,  t.genus);

  const q = db.quality;
  if (!t.class)  q.missClass++;
  if (!t.order)  q.missOrder++;
  if (!t.family) q.missFamily++;
  if (!t.genus)  q.missGenus++;
  if (!t.species) q.missSpecies++;

  const key = speciesKey(t.genus, t.species);
  if (key){
    q.withSpecies++;
    let rec = db.species.get(key);
    if (!rec){
      rec = {label: speciesLabel(t.genus, t.species), genus:t.genus, species:t.species,
             family:t.family, order:t.order, class:t.class, phylum:t.phylum, count:0};
      db.species.set(key, rec);
    } else {
      // fill gaps in lineage from later records, never overwrite
      if (!rec.family && t.family) rec.family = t.family;
      if (!rec.order  && t.order)  rec.order  = t.order;
      if (!rec.class  && t.class)  rec.class  = t.class;
      if (!rec.phylum && t.phylum) rec.phylum = t.phylum;
    }
    rec.count++;
  } else if (t.genus){
    q.genusOnly++;           // genus present, species missing
  } else {
    q.noGenus++;             // no usable genus (species epithet alone does not count)
  }
}

function finalizeDB(db){
  db.total = db.ids.length;
  db.stats = {
    features: db.total,
    classes:  db.sets.class.size,
    orders:   db.sets.order.size,
    families: db.sets.family.size,
    genera:   db.sets.genus.size,
    species:  db.species.size
  };
}

/* ---------- 5. Boot --------------------------------------- */
async function discoverFiles(){
  // Optional data/index.json: ["A_tax.tsv", ...]  or {"files":[...]}
  // Absent by design in a normal install; a 404 here is expected and harmless.
  try{
    const r = await fetch(DATA_DIR + 'index.json', {cache:'no-cache'});
    if (r.ok){
      const j = await r.json();
      const list = Array.isArray(j) ? j : j.files;
      if (Array.isArray(list) && list.length) return list;
    }
  }catch(e){ /* fine — fall back to the built-in list */ }
  return DEFAULT_FILES;
}

async function init(){
  const files = await discoverFiles();
  PRIMERS = files.map(f => ({id: primerIdFromFile(f), file: f}));

  // One shared primer choice across every tab: picking a database in the
  // Overview must not leave the Taxonomy or Feature tabs showing another one.
  $$('.primer-select').forEach(sel => {
    sel.innerHTML = PRIMERS.map(p => `<option value="${esc(p.id)}">${esc(p.id)}</option>`).join('');
    sel.addEventListener('change', () => selectPrimer(sel.value));
  });

  buildSummaryTable();
  wireTabs();
  wireOverview();
  wireTaxonomy();
  wireSearch();
  wireCompare();
  wireComposition();
  wireFeatures();
  probeSizes();
}

/* HEAD requests give file sizes without downloading anything */
async function probeSizes(){
  for (const p of PRIMERS){
    try{
      const r = await fetch(DATA_DIR + p.file, {method:'HEAD'});
      const n = Number(r.headers.get('content-length'));
      if (n) { p.size = n; const el = $(`#size-${cssId(p.id)}`); if (el) el.textContent = bytes(n); }
    }catch(e){}
  }
}
const cssId = s => s.replace(/[^a-zA-Z0-9_-]/g,'_');

/* ---------- 6. Tabs --------------------------------------- */
/* Keep every tab's dropdown on the same database, then refresh
   whichever panel is currently visible. */
function selectPrimer(id){
  $$('.primer-select').forEach(s => { if (s.value !== id) s.value = id; });
  FT.page = 0;
  const active = $('.tab.active');
  const fn = active && TAB_RENDER[active.dataset.tab];
  if (fn) fn();
}

const TAB_RENDER = {
  overview: () => renderOverview(),
  search: () => runSpeciesSearch(),
  taxonomy: () => renderTaxonomy(),
  composition: () => renderComposition(),
  features: () => renderFeatures()
};

function wireTabs(){
  $$('.tab').forEach(btn => btn.addEventListener('click', () => {
    $$('.tab').forEach(b => b.classList.remove('active'));
    $$('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $('#panel-' + btn.dataset.tab).classList.add('active');
    window.scrollTo({top:0});
    // Render only once the panel is visible: a canvas inside a display:none
    // panel has zero size, which would make Chart.js draw nothing.
    const fn = TAB_RENDER[btn.dataset.tab];
    if (fn) requestAnimationFrame(fn);
  }));
}

/* Load a primer with a status line; returns db or null */
async function withDB(id, statusEl){
  if (CACHE.has(id)) { statusEl.textContent = ''; statusEl.classList.remove('err'); return CACHE.get(id); }
  statusEl.classList.remove('err');
  statusEl.innerHTML = `<span class="spinner"></span>Loading ${esc(id)}…`;
  try{
    const db = await loadPrimer(id, (read, total) => {
      statusEl.innerHTML = total
        ? `<span class="spinner"></span>Loading ${esc(id)}… ${Math.round(read/total*100)}%`
        : `<span class="spinner"></span>Loading ${esc(id)}… ${bytes(read)}`;
    });
    statusEl.textContent = `${num(db.total)} records loaded`;
    refreshSummaryRow(db);
    return db;
  }catch(err){
    statusEl.classList.add('err');
    statusEl.textContent = err.message;
    return null;
  }
}

/* ---------- 7. Summary table (Research Context) ----------- */
function buildSummaryTable(){
  const tb = $('#summary-table tbody');
  tb.innerHTML = PRIMERS.map(p => `
    <tr id="row-${cssId(p.id)}">
      <td><strong>${esc(p.id)}</strong><br><span class="muted small mono">${esc(p.file)}</span></td>
      <td class="r" colspan="6"><span class="muted small">not loaded &bull; <span id="size-${cssId(p.id)}">—</span></span></td>
      <td class="r"><button class="btn" data-load="${esc(p.id)}">Load</button></td>
    </tr>`).join('');

  tb.addEventListener('click', async e => {
    const b = e.target.closest('[data-load]');
    if (!b) return;
    b.disabled = true; b.textContent = 'Loading…';
    const db = await loadPrimer(b.dataset.load).catch(err => { toast(err.message); return null; });
    if (db) refreshSummaryRow(db); else { b.disabled = false; b.textContent = 'Retry'; }
  });

  $('#load-all').addEventListener('click', async e => {
    e.target.disabled = true; e.target.textContent = 'Loading…';
    for (const p of PRIMERS){
      try{ refreshSummaryRow(await loadPrimer(p.id)); }catch(err){ toast(err.message); }
    }
    e.target.textContent = 'All databases loaded';
  });

  for (const p of PRIMERS) if (CACHE.has(p.id)) refreshSummaryRow(CACHE.get(p.id));
}

function refreshSummaryRow(db){
  const tr = $('#row-' + cssId(db.id));
  if (!tr) return;
  const s = db.stats;
  tr.innerHTML = `
    <td><strong>${esc(db.id)}</strong><br><span class="muted small mono">${esc(db.file)}</span></td>
    <td class="r">${num(s.features)}</td>
    <td class="r">${num(s.classes)}</td>
    <td class="r">${num(s.orders)}</td>
    <td class="r">${num(s.families)}</td>
    <td class="r">${num(s.genera)}</td>
    <td class="r">${num(s.species)}</td>
    <td class="r"><span class="muted small">${bytes(db.bytes)}</span></td>`;
}

/* ---------- 8. TAB 2 — Overview --------------------------- */
let ovChart = null;

function wireOverview(){
  const sel = $('#sel-overview');
  sel.addEventListener('change', renderOverview);
}

async function renderOverview(){
  const id = $('#sel-overview').value;
  const db = await withDB(id, $('#status-overview'));
  if (!db) return;
  const s = db.stats, q = db.quality;

  $('#ov-stats').innerHTML = [
    ['Total Features', s.features], ['Unique Classes', s.classes],
    ['Unique Orders', s.orders],    ['Unique Families', s.families],
    ['Unique Genera', s.genera],    ['Unique Species', s.species]
  ].map(([t,n]) => `<div class="stat"><div class="n">${num(n)}</div><div class="t">${t}</div></div>`).join('');

  $('#ov-file').innerHTML = `
    <tr><td>Database File</td><td class="mono">${esc(db.file)}</td></tr>
    <tr><td>File Size</td><td>${bytes(db.bytes)}</td></tr>
    <tr><td>Records with Species</td><td>${num(q.withSpecies)}</td></tr>
    <tr><td>Records without Species</td><td>${num(db.total - q.withSpecies)}</td></tr>`;

  $('#ov-quality').innerHTML = `
    <tr><td>Total Features</td><td>${num(db.total)}</td></tr>
    <tr><td>Features with Species (Genus + species)</td><td>${num(q.withSpecies)}</td></tr>
    <tr><td>Features with Genus only</td><td>${num(q.genusOnly)}</td></tr>
    <tr><td>Features without Genus</td><td>${num(q.noGenus)}</td></tr>
    <tr><td>Missing Class</td><td>${num(q.missClass)}</td></tr>
    <tr><td>Missing Order</td><td>${num(q.missOrder)}</td></tr>
    <tr><td>Missing Family</td><td>${num(q.missFamily)}</td></tr>
    <tr><td>Missing Genus</td><td>${num(q.missGenus)}</td></tr>
    <tr><td>Missing Species</td><td>${num(q.missSpecies)}</td></tr>`;

  if (!chartReady($('#ov-chart'))) return;
  if (ovChart) ovChart.destroy();
  ovChart = new Chart($('#ov-chart'), {
    type:'bar',
    data:{
      labels:['Classes','Orders','Families','Genera','Species'],
      datasets:[{ label:'Unique taxa',
        data:[s.classes, s.orders, s.families, s.genera, s.species],
        backgroundColor:'#1f6f8b', borderRadius:3 }]
    },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{ y:{ beginAtZero:true, ticks:{ callback:v => num(v) } } } }
  });
}

/* ---------- 9. TAB 3 — Taxonomy Explorer -----------------
   Hierarchy is built lazily, one level at a time, from the
   row array. Nothing is precomputed for the whole tree.
----------------------------------------------------------- */
function wireTaxonomy(){
  $('#tax-filter').addEventListener('input', debounce(renderTaxonomy, 250));
}

const CHILD_OF = {c:'o', o:'f', f:'g', g:'s'};
const RANK_NAME = {c:'class', o:'order', f:'family', g:'genus', s:'species'};

/* children of a path like {c:'Insecta', o:'Diptera'} at the next rank */
function childrenAt(db, path){
  const chain = ['c','o','f','g','s'];
  let level = 0;
  while (level < chain.length && path[chain[level]] !== undefined) level++;
  const rank = chain[level];
  if (!rank) return {rank:null, items:[]};

  const counts = new Map();
  const rows = db.rows;
  for (let i = 0; i < rows.length; i++){
    const r = rows[i];
    let ok = true;
    for (let k = 0; k < level; k++){ if (r[chain[k]] !== path[chain[k]]) { ok = false; break; } }
    if (!ok) continue;
    const v = r[rank];
    if (!v) continue;
    if (rank === 's' && !r.g) continue;         // species epithet without genus is not a species
    const label = rank === 's' ? speciesLabel(r.g, v) : v;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const items = Array.from(counts, ([name, count]) => ({name, count, raw:name}))
                     .sort((a,b) => b.count - a.count || a.name.localeCompare(b.name));
  return {rank, items};
}

async function renderTaxonomy(){
  const id = $('#sel-taxonomy').value;
  const db = await withDB(id, $('#status-taxonomy'));
  if (!db) return;
  const filter = $('#tax-filter').value.trim().toLowerCase();

  const {items} = childrenAt(db, {});
  const shown = filter ? items.filter(i => i.name.toLowerCase().includes(filter)) : items;
  const host = $('#tax-tree');
  host.innerHTML = shown.length
    ? shown.map(i => nodeHTML(i, 'c', {})).join('')
    : '<p class="muted small">No matching class-level taxa.</p>';

  host.onclick = e => {
    const row = e.target.closest('.trow');
    if (!row || row.classList.contains('leaf')) return;
    const node = row.parentElement;
    const kids = node.querySelector(':scope > .kids');
    if (kids.dataset.open === '1'){
      kids.innerHTML = ''; kids.dataset.open = '0';
      row.querySelector('.caret').textContent = '\u25B8';
      return;
    }
    const path = JSON.parse(node.dataset.path);
    const {rank, items} = childrenAt(db, path);
    kids.dataset.open = '1';
    row.querySelector('.caret').textContent = '\u25BE';
    kids.innerHTML = items.length
      ? items.map(i => nodeHTML(i, rank, path)).join('')
      : '<div class="muted small" style="padding:4px 6px 4px 18px">No annotated descendants.</div>';
  };
}

function nodeHTML(item, rank, parentPath){
  const path = Object.assign({}, parentPath);
  // store the *raw* value for matching; species nodes store the epithet
  path[rank] = rank === 's' ? item.rawEpithet || item.name.split(' ').slice(1).join(' ') : item.name;
  const isLeaf = rank === 's';
  return `<div class="tnode" data-path='${esc(JSON.stringify(path))}'>
    <div class="trow${isLeaf ? ' leaf' : ''}">
      <span class="caret">${isLeaf ? '' : '\u25B8'}</span>
      <span class="name${isLeaf ? ' sci' : ''}">${esc(item.name)}</span>
      <span class="rank">${RANK_NAME[rank]}</span>
      <span class="cnt">${num(item.count)}</span>
    </div>
    <div class="kids" data-open="0"></div>
  </div>`;
}

/* ---------- 10. TAB 4 — Species Search -------------------- */
function wireSearch(){
  $('#sp-query').addEventListener('input', debounce(runSpeciesSearch, 250));
}

async function runSpeciesSearch(){
  const q = $('#sp-query').value.trim().toLowerCase();
  const out = $('#sp-results');
  if (!q){ out.innerHTML = ''; return; }
  const id = $('#sel-search').value;
  const db = await withDB(id, $('#status-search'));
  if (!db) return;

  const hits = [];
  for (const rec of db.species.values()){
    if (rec.label.toLowerCase().includes(q) ||
        rec.genus.toLowerCase().includes(q) ||
        rec.species.toLowerCase().includes(q)){
      hits.push(rec);
      if (hits.length > 400) break;
    }
  }
  hits.sort((a,b) => b.count - a.count || a.label.localeCompare(b.label));

  if (!hits.length){
    out.innerHTML = `<p class="muted" style="margin-top:14px">No reference sequence matching
      &ldquo;${esc($('#sp-query').value)}&rdquo; in the <strong>${esc(id)}</strong> database.</p>`;
    return;
  }

  out.innerHTML = `<p class="muted small" style="margin-top:14px">
      ${num(hits.length)}${hits.length > 400 ? '+' : ''} matching species in <strong>${esc(id)}</strong></p>
    <div class="reslist">` + hits.slice(0,200).map(r => `
    <div class="rescard">
      <div class="row spread" style="margin:0">
        <div class="name">${esc(r.label)}</div>
        <div class="present">&#10003; Reference sequence present</div>
      </div>
      <div class="lin">
        ${lin('Genus', r.genus)}${lin('Family', r.family)}${lin('Order', r.order)}
        ${lin('Class', r.class)}${lin('Phylum', r.phylum)}
        ${lin('Feature Count', num(r.count))}${lin('Primer', db.id)}
      </div>
    </div>`).join('') + '</div>';
}
const lin = (l,v) => `<div><div class="label">${l}</div><div>${esc(v || '—')}</div></div>`;

/* ---------- 11. TAB 5 — Primer Comparison ----------------- */
function wireCompare(){
  $('#cmp-go').addEventListener('click', runCompare);
  $('#cmp-query').addEventListener('keydown', e => { if (e.key === 'Enter') runCompare(); });
}

async function runCompare(){
  const raw = $('#cmp-query').value.trim();
  const st = $('#cmp-status'), out = $('#cmp-results');
  if (!raw){ out.innerHTML = ''; st.textContent = ''; return; }

  const q = raw.toLowerCase().replace(/\s+/g,' ');
  const rows = [];
  let present = 0;
  out.innerHTML = '';

  for (const p of PRIMERS){
    st.innerHTML = `<span class="spinner"></span>Checking ${esc(p.id)}…`;
    let db;
    try { db = await loadPrimer(p.id); }
    catch(err){ rows.push({primer:p.id, state:'error', msg:err.message}); continue; }
    refreshSummaryRow(db);

    let best = null;
    for (const rec of db.species.values()){
      const label = rec.label.toLowerCase();
      if (label === q){ best = rec; break; }
      if (!best && (label.includes(q) || (rec.genus + ' ' + rec.species).toLowerCase().includes(q))) best = rec;
    }
    if (best){ present++; rows.push({primer:p.id, state:'present', rec:best}); }
    else rows.push({primer:p.id, state:'absent'});
  }

  st.textContent = '';
  out.innerHTML = `
    <div class="statgrid" style="grid-template-columns:1fr;margin:16px 0">
      <div class="stat"><div class="n">${present} / ${PRIMERS.length}</div>
      <div class="t">Reference present in databases</div></div>
    </div>
    <div class="tablewrap"><table class="tbl">
      <thead><tr><th>Primer</th><th>Reference</th><th>Matched identity</th><th class="r">Feature count</th></tr></thead>
      <tbody>${rows.map(r => {
        if (r.state === 'error')
          return `<tr><td><strong>${esc(r.primer)}</strong></td><td class="absent">Not readable</td>
                  <td class="muted small" colspan="2">${esc(r.msg)}</td></tr>`;
        if (r.state === 'absent')
          return `<tr><td><strong>${esc(r.primer)}</strong></td><td class="absent">&#10007; Not found</td>
                  <td class="muted">—</td><td class="r muted">—</td></tr>`;
        return `<tr><td><strong>${esc(r.primer)}</strong></td><td class="present">&#10003; Present</td>
                <td class="sci">${esc(r.rec.label)}</td><td class="r">${num(r.rec.count)}</td></tr>`;
      }).join('')}</tbody>
    </table></div>
    <div class="note">Reference database presence only. A present reference sequence does not indicate
    amplification by the primer, detection in samples, occurrence at the study site, or dietary contribution.</div>`;
}

/* ---------- 12. TAB 6 — Taxonomic Composition ------------- */
let compChart = null;

function wireComposition(){
  $('#comp-rank').addEventListener('change', renderComposition);
}

async function renderComposition(){
  const id = $('#sel-composition').value;
  const rank = $('#comp-rank').value;
  const db = await withDB(id, $('#status-composition'));
  if (!db) return;

  let entries, totalFeat;
  if (rank === 'species'){
    entries = Array.from(db.species.values(), r => [r.label, r.count]);
    totalFeat = entries.reduce((a,[,c]) => a + c, 0);
  } else {
    entries = Array.from(db.sets[rank].entries());
    totalFeat = entries.reduce((a,[,c]) => a + c, 0);
  }
  entries.sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  $('#comp-meta').textContent =
    `${num(entries.length)} distinct ${rank} taxa • ${num(totalFeat)} annotated features in ${db.id}`;

  const top = entries.slice(0, 20);
  const rest = entries.slice(20).reduce((a,[,c]) => a + c, 0);
  const labels = top.map(e => e[0]).concat(rest ? ['Other (' + num(entries.length - 20) + ' taxa)'] : []);
  const values = top.map(e => e[1]).concat(rest ? [rest] : []);

  if (chartReady($('#comp-chart'))) {
  if (compChart) compChart.destroy();
  compChart = new Chart($('#comp-chart'), {
    type:'bar',
    data:{ labels, datasets:[{ label:'Features', data:values, backgroundColor:'#1f6f8b', borderRadius:3 }] },
    options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false},
        tooltip:{ callbacks:{ label: c => `${num(c.parsed.x)} features (${(c.parsed.x/totalFeat*100).toFixed(2)}%)` } } },
      scales:{ x:{ beginAtZero:true, ticks:{ callback:v => num(v) } } } }
  });
  }

  $('#comp-table tbody').innerHTML = entries.slice(0, 300).map(([name, c]) =>
    `<tr><td${rank === 'species' ? ' class="sci"' : ''}>${esc(name)}</td>
     <td class="r">${num(c)}</td><td class="r">${(c/totalFeat*100).toFixed(2)}%</td></tr>`).join('')
    + (entries.length > 300 ? `<tr><td colspan="3" class="muted small">Showing the 300 most frequent of ${num(entries.length)} taxa.</td></tr>` : '');
}

/* ---------- 13. TAB 7 — Feature Explorer ------------------ */
const FT = {rows:[], page:0, size:100, sort:null, dir:1, db:null};

function wireFeatures(){
  $('#ft-query').addEventListener('input', debounce(() => { FT.page = 0; renderFeatures(); }, 300));
  $('#ft-rank').addEventListener('change', () => { FT.page = 0; renderFeatures(); });
  $('#ft-rankval').addEventListener('input', debounce(() => { FT.page = 0; renderFeatures(); }, 300));
  $('#ft-size').addEventListener('change', e => { FT.size = +e.target.value; FT.page = 0; paintFeatures(); });
  $('#ft-prev').addEventListener('click', () => { if (FT.page > 0){ FT.page--; paintFeatures(); } });
  $('#ft-next').addEventListener('click', () => {
    if ((FT.page+1) * FT.size < FT.rows.length){ FT.page++; paintFeatures(); } });
  $('#ft-tsv').addEventListener('click', () => exportFeatures('\t','tsv'));
  $('#ft-csv').addEventListener('click', () => exportFeatures(',','csv'));

  $('#ft-table thead').addEventListener('click', e => {
    const th = e.target.closest('[data-sort]'); if (!th) return;
    const k = th.dataset.sort;
    FT.dir = (FT.sort === k) ? -FT.dir : 1;
    FT.sort = k; FT.page = 0;
    sortFeatures(); paintFeatures();
  });

  $('#ft-table tbody').addEventListener('click', e => {
    const copy = e.target.closest('[data-copy]');
    if (copy){
      navigator.clipboard.writeText(copy.dataset.copy).then(() => toast('Feature ID copied'));
      return;
    }
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('expand')){ next.remove(); return; }
    const i = +tr.dataset.i;
    const row = document.createElement('tr');
    row.className = 'expand';
    row.innerHTML = `<td colspan="7" class="taxstr mono">${esc(FT.db.tax[i] || '(no taxonomy string)')}</td>`;
    tr.after(row);
  });

}

async function renderFeatures(){
  const id = $('#sel-features').value;
  const db = await withDB(id, $('#status-features'));
  if (!db) return;
  FT.db = db;

  const q = $('#ft-query').value.trim().toLowerCase();
  const rk = $('#ft-rank').value;
  const rv = $('#ft-rankval').value.trim().toLowerCase();
  const key = {class:'c', order:'o', family:'f', genus:'g', species:'s'}[rk];

  const out = [];
  for (let i = 0; i < db.ids.length; i++){
    if (key && rv){
      const v = db.rows[i][key];
      if (!v || !v.toLowerCase().includes(rv)) continue;
    }
    if (q){
      if (!db.ids[i].toLowerCase().includes(q) && !(db.tax[i] || '').toLowerCase().includes(q)) continue;
    }
    out.push(i);
  }
  FT.rows = out;
  if (FT.sort) sortFeatures();
  paintFeatures();
}

function sortFeatures(){
  const db = FT.db, k = FT.sort, d = FT.dir;
  const get = k === 'id' ? (i => db.ids[i])
            : (i => db.rows[i][{class:'c',order:'o',family:'f',genus:'g',species:'s'}[k]] || '\uffff');
  FT.rows.sort((a,b) => { const x = get(a), y = get(b); return x < y ? -d : x > y ? d : 0; });
}

function paintFeatures(){
  const db = FT.db; if (!db) return;
  const start = FT.page * FT.size;
  const slice = FT.rows.slice(start, start + FT.size);

  $('#ft-count').textContent =
    `${num(FT.rows.length)} of ${num(db.total)} features in ${db.id}`;
  $('#ft-page').textContent = FT.rows.length
    ? `${num(start+1)}–${num(Math.min(start+FT.size, FT.rows.length))} of ${num(FT.rows.length)}`
    : 'No matching features';
  $('#ft-prev').disabled = FT.page === 0;
  $('#ft-next').disabled = start + FT.size >= FT.rows.length;

  $('#ft-table tbody').innerHTML = slice.map(i => {
    const r = db.rows[i];
    const sp = (r.g && r.s) ? speciesLabel(r.g, r.s) : '';
    return `<tr data-i="${i}">
      <td class="mono">${esc(db.ids[i])}</td>
      <td>${esc(r.c || '—')}</td><td>${esc(r.o || '—')}</td><td>${esc(r.f || '—')}</td>
      <td>${esc(r.g || '—')}</td><td class="sci">${esc(sp || '—')}</td>
      <td class="r"><button class="btn" data-copy="${esc(db.ids[i])}" title="Copy Feature ID">Copy</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="7" class="muted small">No features match the current filters.</td></tr>`;
}

function exportFeatures(sep, ext){
  const db = FT.db;
  if (!db || !FT.rows.length){ toast('Nothing to export'); return; }
  const qt = v => (sep === ',' && /[",\n]/.test(v)) ? '"' + v.replace(/"/g,'""') + '"' : v;
  const lines = ['Feature_ID','Class','Order','Family','Genus','Species','Taxonomy'].join(sep) + '\n';
  const parts = [lines];
  for (const i of FT.rows){
    const r = db.rows[i];
    const sp = (r.g && r.s) ? speciesLabel(r.g, r.s) : '';
    parts.push([db.ids[i], r.c, r.o, r.f, r.g, sp, db.tax[i] || ''].map(v => qt(v || '')).join(sep) + '\n');
  }
  const blob = new Blob(parts, {type: ext === 'csv' ? 'text/csv' : 'text/tab-separated-values'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${db.id}_filtered.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast(`Exported ${num(FT.rows.length)} rows`);
}

/* ---------- 14. utils ------------------------------------- */

/* Charts are a nice-to-have. If the Chart.js CDN is unavailable
   (offline, restricted network) every table and number still works. */
function chartReady(canvas){
  if (typeof Chart !== 'undefined') return true;
  const box = canvas.closest('.chartbox');
  if (box && !box.dataset.failed){
    box.dataset.failed = '1';
    box.innerHTML = '<p class="muted small" style="padding:12px">Chart library unavailable ' +
      '(no network access to the CDN). All statistics and tables below remain fully available.</p>';
  }
  return false;
}

function debounce(fn, ms){
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

init();
