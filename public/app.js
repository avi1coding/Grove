/* Grove — client */

const $ = (sel) => document.querySelector(sel);
/* `hidden` is an IDL property of HTMLElement only — assigning it on an <svg>
   sets a dead JS property and leaves the attribute (and `display:none`) in
   place. Always drive visibility through the attribute. */
const setHidden = (node, value) => {
  if (!node) return;
  if (value) node.setAttribute('hidden', '');
  else node.removeAttribute('hidden');
};
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};
const svgEl = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
};

/* --------------------------------------------------------------- state -- */

const S = {
  sessionId: localStorage.getItem('grove.session') || null,
  data: null,
  quiz: null,
  answers: {},
  qIndex: 0,
  health: null,
  screen: 'import',
};

/* ----------------------------------------------------------------- net -- */

let busyDepth = 0;
let busyTimer = null;
function busy(label) {
  busyDepth++;
  const text = label || 'Working…';
  const started = Date.now();
  const tick = () => {
    const s = Math.round((Date.now() - started) / 1000);
    $('#busy-label').textContent = s > 2 ? `${text}  ${s}s` : text;
  };
  tick();
  clearInterval(busyTimer);
  busyTimer = setInterval(tick, 1000);
  setHidden($('#busy'), false);

  // Never trap the user behind the overlay: offer an escape once it drags on.
  const escape = $('#busy-escape');
  setHidden(escape, true);
  clearTimeout(busy.escapeTimer);
  busy.escapeTimer = setTimeout(() => setHidden(escape, false), 8000);
  escape.onclick = () => {
    busyDepth = 0;
    clearInterval(busyTimer);
    setHidden($('#busy'), true);
    toast('Cancelled — the request may still be running.', true);
  };
}
function unbusy() {
  busyDepth = Math.max(0, busyDepth - 1);
  if (!busyDepth) {
    clearInterval(busyTimer);
    busyTimer = null;
    setHidden($('#busy'), true);
  }
}
let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  setHidden(t, false);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setHidden(t, true), isError ? 8000 : 3500);
}

async function api(path, { method = 'GET', body, form, label } = {}) {
  if (label) busy(label);
  try {
    const res = await fetch(path, {
      method,
      headers: form ? undefined : body ? { 'Content-Type': 'application/json' } : undefined,
      body: form || (body ? JSON.stringify(body) : undefined),
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
  } finally {
    if (label) unbusy();
  }
}

/* -------------------------------------------------------------- boot ---- */

async function boot() {
  S.health = await api('/api/health');
  if (!S.health.featherlessKey) toast('FEATHERLESS_API_KEY is not set — copy .env.example to .env and add your key.', true);

  if (S.sessionId) {
    try {
      S.data = await api(`/api/session/${S.sessionId}`);
    } catch {
      localStorage.removeItem('grove.session');
      S.sessionId = null;
    }
  }
  if (!S.sessionId) {
    const s = await api('/api/session', { method: 'POST' });
    S.sessionId = s.id;
    S.data = s;
    localStorage.setItem('grove.session', s.id);
  }
  renderCatalogue();
  showScreen(S.data?.tree ? 'tree' : 'import');
  render();
}

/* ---- theme ------------------------------------------------------------- */
const THEME_KEY = 'grove.theme';
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  localStorage.setItem(THEME_KEY, mode);
  if (S.data?.tree && S.screen === 'tree') renderTree();
}
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved && saved !== 'system') document.documentElement.setAttribute('data-theme', saved);
  $('#theme-toggle').onclick = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
      || (!document.documentElement.hasAttribute('data-theme')
          && matchMedia('(prefers-color-scheme: dark)').matches);
    applyTheme(dark ? 'light' : 'dark');
  };
}
initTheme();

/* ---- narrow-screen sidebar --------------------------------------------- */
function closeSidebar() {
  document.body.classList.remove('sidebar-open');
  setHidden($('#scrim'), true);
}
$('#sidebar-toggle').onclick = () => {
  const open = document.body.classList.toggle('sidebar-open');
  setHidden($('#scrim'), !open);
};
$('#scrim').onclick = closeSidebar;

/* Two screens: 'import' (add material) and 'tree' (the app). */
function showScreen(name) {
  S.screen = name;
  closeSidebar();
  setHidden($('#screen-import'), name !== 'import');
  setHidden($('#screen-tree'), name !== 'tree');
  if (name === 'tree' && S.data?.tree) renderTree();
}

$('#back-to-import').onclick = () => { showScreen('import'); setTab('upload'); };
// ...and back again, for when you change your mind about adding anything.
$('#back-to-tree').onclick = () => showScreen('tree');

function setTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.tab-panel').forEach((p) => setHidden(p, p.dataset.panel !== name));
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => setTab(t.dataset.tab)));

async function renderCatalogue() {
  let catalogue = [];
  try {
    ({ catalogue } = await api('/api/catalogue'));
  } catch { return; }

  $('#type-count').textContent = catalogue.length;

  // The whole list is one click away instead of filling the screen.
  $('#catalogue-toggle').onclick = () => {
    const group = (kind, title) => {
      const items = catalogue.filter((c) => c.input === kind);
      if (!items.length) return null;
      return el('div', { class: 'type-group' },
        el('h3', {}, title),
        el('div', { class: 'type-list' }, items.map((i) => el('span', { class: 'chip' }, i.label))),
      );
    };
    openModal(el('div', { style: 'display:flex;flex-direction:column;gap:16px' },
      el('div', { class: 'quiz-head' },
        el('h2', { style: 'flex:1' }, 'What you can add'),
        el('button', { class: 'close', style: 'position:static', onclick: closeModal }, '\u00d7')),
      group('file', 'Files'),
      group('url', 'Links'),
      group('text', 'Text'),
    ));
  };

  const unusedBoxes = { file: null, url: null, text: null };
  const counts = { file: 0, url: 0, text: 0 };

  for (const item of catalogue) {
    const box = unusedBoxes[item.input];
    if (!box) continue;
    counts[item.input]++;
    box.append(
      el('button', {
        class: `cat-item cat-${item.input}`,
        title: item.hint || item.label,
        onclick: () => {
          if (item.input === 'file') {
            setTab('upload');
            const input = $('#file-input');
            input.setAttribute('accept', item.accept || '');
            input.click();
          } else if (item.input === 'url') {
            setTab('link');
            const urls = $('#urls');
            urls.placeholder = item.hint ? `${item.label} — ${item.hint}` : item.label;
            if (item.hint) $('#link-hint').textContent = `${item.label}: ${item.hint}`;
            urls.focus();
          } else {
            setTab('paste');
            $('#paste').focus();
          }
        },
      },
        el('span', { class: 'cat-dot' }),
        el('span', {}, item.label),
      ),
    );
  }

}

/* ------------------------------------------------------------- ingest --- */

$('#browse').onclick = () => $('#file-input').click();
$('#file-input').onchange = () => renderPendingFiles();
const drop = $('#drop');
['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (ev) => {
  $('#file-input').files = ev.dataTransfer.files;
  renderPendingFiles();
});
function renderPendingFiles() {
  const n = $('#file-input').files?.length || 0;
  drop.querySelector('p').innerHTML = n
    ? `<strong>${n} file${n > 1 ? 's' : ''} ready</strong>`
    : `<strong>Drop files here</strong> or <button class="link" id="browse">browse</button>`;
  if (!n) $('#browse').onclick = () => $('#file-input').click();
  else drop.querySelector('p').onclick = () => $('#file-input').click();
}

$('#add-sources').onclick = async () => {
  const form = new FormData();
  const files = $('#file-input').files || [];
  for (const f of files) form.append('files', f);
  const text = $('#paste').value.trim();
  if (text) form.append('text', text);
  const urls = $('#urls').value.trim();
  if (urls) form.append('urls', urls);
  if (!files.length && !text && !urls) return toast('Add a file, some text, or a link first.', true);

  try {
    const data = await api(`/api/session/${S.sessionId}/sources`, { method: 'POST', form, label: 'Reading your material…' });
    S.data = { ...S.data, ...data };
    $('#paste').value = '';
    $('#urls').value = '';
    $('#file-input').value = '';
    $('#file-input').removeAttribute('accept');
    renderPendingFiles();
    if (data.failures?.length) toast(data.failures.map((f) => `${f.name}: ${f.error}`).join(' · '), true);
    else toast(`Added · ${data.chunkCount} chunks`);
    render();
  } catch (err) { toast(err.message, true); }
};

$('#build').onclick = async () => {
  try {
    const data = await api(`/api/session/${S.sessionId}/build`, { method: 'POST', label: 'Building the tree…' });
    S.data = data;
    showScreen('tree');
    render();
    toast(data.carriedOver ? `${data.tree.nodes.root.title} · kept ${data.carriedOver} finished` : data.tree.nodes.root.title);
  } catch (err) { toast(err.message, true); }
};

/* -------------------------------------------------------------- render -- */

function nodeState(id) {
  const p = S.data?.progress?.[id];
  const node = S.data?.tree?.nodes?.[id];
  if (!node) return 'available';
  if (p?.state === 'mastered') return 'mastered';
  if (node.children?.length) return node.children.every((c) => nodeState(c) === 'mastered') ? 'mastered' : 'split';
  return p?.state || 'available';
}

function countLeaves(id, acc = { done: 0, total: 0 }) {
  const node = S.data.tree.nodes[id];
  if (node.children?.length) node.children.forEach((c) => countLeaves(c, acc));
  else {
    acc.total++;
    if (nodeState(id) === 'mastered') acc.done++;
  }
  return acc;
}

function render() {
  renderSources();
  renderGaps();
  renderSrs();

  const hasTree = Boolean(S.data?.tree);
  $('#build').disabled = !(S.data?.chunkCount > 0);
  const live = (S.data?.sources || []).filter((x) => !x.error).length;
  $('#build').textContent = hasTree ? 'Rebuild map' : 'Build skill tree';
  $('#build-hint').textContent = S.data?.chunkCount
    ? hasTree
      ? 'Finished subtopics stay finished'
      : `${live} source${live > 1 ? 's' : ''} · ${S.data.chunkCount} chunks`
    : '';
  setHidden($('#tree'), !hasTree);
  setHidden($('#progress-wrap'), !hasTree);
  // Only offer "back to map" once there is a map to go back to.
  setHidden($('#back-to-tree'), !hasTree);
  if (!hasTree) {
    $('#crumbs').innerHTML = '<span class="crumb current">No tree yet</span>';
    setHidden($('#boss-btn'), true);
    return;
  }

  const root = S.data.tree.nodes.root;
  const { done, total } = countLeaves('root');
  $('#progress-bar').style.width = `${total ? (done / total) * 100 : 0}%`;
  $('#progress-label').textContent = `${done} / ${total}`;

  const unlocked = root.children.length > 0 && root.children.every((id) => nodeState(id) === 'mastered');
  const bossBtn = $('#boss-btn');
  setHidden(bossBtn, false);
  bossBtn.disabled = !unlocked;
  bossBtn.textContent = S.data.boss?.passed ? 'Topic completed' : unlocked ? 'Boss quiz' : 'Boss quiz — locked';
  bossBtn.onclick = () => (S.data.boss?.passed ? showBossDone() : startBoss());

  renderCrumbs();
  renderTree();
}

function renderCrumbs() {
  const c = $('#crumbs');
  c.innerHTML = '';
  c.append(el('span', { class: 'crumb current' }, S.data.tree.nodes.root.title));
}

function renderSources() {
  const list = $('#source-list');
  list.className = list.className.includes('stagger') ? list.className : `${list.className} stagger`;
  list.innerHTML = '';
  const sources = S.data?.sources || [];
  const live = sources.filter((x) => !x.error);
  setHidden($('#sources-title'), !sources.length);
  const summary = $('#corpus-summary');
  if (summary) {
    summary.textContent = live.length
      ? `${live.length} source${live.length > 1 ? 's' : ''} · ${S.data.chunkCount} chunk${S.data.chunkCount > 1 ? 's' : ''}`
      : '';
  }
  for (const s of S.data?.sources || []) {
    const tag = {
      pdf: 'PDF', youtube: 'YT', image: 'IMG', text: 'TXT', web: 'WEB', failed: 'ERR',
      docx: 'DOC', pptx: 'PPT', xlsx: 'XLS', epub: 'BOOK', csv: 'CSV', json: 'JSON',
      html: 'HTML', srt: 'SUBS', code: 'CODE', wikipedia: 'WIKI', arxiv: 'ARXIV',
      github: 'GIT', reddit: 'RDDT', hackernews: 'HN', stackoverflow: 'SO',
      rss: 'RSS', gdocs: 'GDOC', plaintext: 'TXT', pdfurl: 'PDF',
    }[s.kind] || 'FILE';
    list.append(
      el('li', { class: s.error ? 'failed' : '' },
        el('span', { class: `kind kind-${s.kind}` }, tag),
        el('div', {},
          el('div', {}, s.name.length > 42 ? s.name.slice(0, 40) + '…' : s.name),
          el('div', { class: 'meta' }, s.error || `${s.chunkCount} chunks · ${(s.chars / 1000).toFixed(1)}k chars`),
        ),
      ),
    );
  }
}

function renderGaps() {
  const gaps = S.data?.gaps || [];
  setHidden($('#gap-panel'), !gaps.length);
  $('#gap-count').textContent = gaps.length;
  const list = $('#gap-list');
  list.className = list.className.includes('stagger') ? list.className : `${list.className} stagger`;
  list.innerHTML = '';
  for (const g of gaps) {
    list.append(
      el('li', { style: 'cursor:pointer', onclick: () => openDrawer(g.nodeId) },
        el('strong', {}, g.title),
        el('p', {}, `${Math.round(g.coverage * 100)}% · ${g.suggestion || g.missing || ''}`),
      ),
    );
  }
}

function renderSrs() {
  const due = S.data?.dueReviews || [];
  setHidden($('#srs-panel'), !due.length);
  const list = $('#srs-list');
  list.className = list.className.includes('stagger') ? list.className : `${list.className} stagger`;
  list.innerHTML = '';
  for (const d of due) {
    list.append(
      el('li', {},
        el('strong', {}, d.title),
        el('button', {
          class: 'btn sm',
          // A due boss review has no node quiz — it must go to the boss route.
          onclick: () => (d.kind === 'boss' ? startBoss() : startReview(d.nodeId)),
        }, 'Refresh it'),
      ),
    );
  }
}

/* ----------------------------------------------------------- tree draw -- */

let NODE_R = 34;
let CROWN_R = 44;

/**
 * Radial map: the topic sits in the middle, subtopics ring it, and expanding a
 * subtopic fans its own children outward from it. Everything stays on one
 * canvas — the whole tree is always visible, scaled to fit.
 */
function layoutTree() {
  const nodes = S.data.tree.nodes;
  const root = nodes.root;
  const placed = [];

  placed.push({ node: root, x: 0, y: 0, r: CROWN_R, depth: 0, parent: null, hue: null });

  const kids = root.children.map((id) => nodes[id]);
  const n = Math.max(1, kids.length);
  const R1 = 250;

  kids.forEach((kid, i) => {
    // Start at the top and go clockwise.
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const x = Math.cos(angle) * R1;
    const y = Math.sin(angle) * R1;
    placed.push({ node: kid, x, y, r: NODE_R, depth: 1, parent: { x: 0, y: 0 }, angle, order: i });

    const grandkids = (kid.children || []).map((id) => nodes[id]);
    if (!grandkids.length) return;

    // Fan the children outward from their parent, away from the centre.
    const spread = Math.min(Math.PI * 0.8, 0.46 * grandkids.length);
    const step = grandkids.length > 1 ? spread / (grandkids.length - 1) : 0;
    const first = angle - spread / 2;

    grandkids.forEach((g, j) => {
      const a = first + j * step;
      // Alternate the ring distance so neighbouring labels cannot collide.
      const R2 = 196 + (j % 2) * 52;
      placed.push({
        node: g,
        x: x + Math.cos(a) * R2,
        y: y + Math.sin(a) * R2,
        r: NODE_R * 0.72,
        depth: 2,
        parent: { x, y },
        angle: a,
        order: kids.length + j,
      });
    });
  });

  return placed;
}

function renderTree() {
  const svg = $('#tree');
  svg.innerHTML = '';

  const placed = layoutTree();

  // Fit the whole map — INCLUDING its labels — into the canvas, whatever its
  // size. Bounding only the circles let long titles run off the edge.
  const labelChars = (p) => Math.min(p.depth === 0 ? 30 : p.depth === 1 ? 20 : 15, String(p.node.title).length);
  const halfLabel = (p) => Math.max(p.r, (labelChars(p) * 7.4) / 2 + 6);
  const pad = 26;
  const minX = Math.min(...placed.map((p) => p.x - halfLabel(p))) - pad;
  const maxX = Math.max(...placed.map((p) => p.x + halfLabel(p))) + pad;
  const minY = Math.min(...placed.map((p) => p.y - p.r - 34)) - pad;
  const maxY = Math.max(...placed.map((p) => p.y + p.r + 54)) + pad;
  // Size comes from CSS (100% of the stage) and the fitted viewBox does the
  // scaling. Setting width/height here from a measured clientWidth was wrong
  // whenever the measurement ran before layout settled — it pushed the map
  // wider than the screen.
  svg.setAttribute('viewBox', `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.removeAttribute('width');
  svg.removeAttribute('height');

  // ---- connectors first, so nodes sit on top ----
  for (const p of placed) {
    if (!p.parent) continue;
    const done = nodeState(p.node.id) === 'mastered';
    const dx = p.x - p.parent.x;
    const dy = p.y - p.parent.y;
    const len = Math.hypot(dx, dy) || 1;
    const parentR = p.depth === 1 ? CROWN_R : NODE_R;
    // Trim the line so it meets the two circles instead of running under them.
    const x1 = p.parent.x + (dx / len) * (parentR + 4);
    const y1 = p.parent.y + (dy / len) * (parentR + 4);
    const x2 = p.x - (dx / len) * (p.r + 4);
    const y2 = p.y - (dy / len) * (p.r + 4);
    const span = Math.hypot(x2 - x1, y2 - y1);
    svg.append(svgEl('line', {
      class: `path-line${done ? ' done' : ''}`,
      x1, y1, x2, y2,
      // Draw the line on rather than snapping it in.
      style: `--dash:${span.toFixed(0)};stroke-dasharray:${span.toFixed(0)};animation-delay:${(0.05 + (p.order || 0) * 0.035).toFixed(2)}s`,
    }));
  }

  // ---- nodes ----
  for (const p of placed) {
    const node = p.node;
    const isRoot = p.depth === 0;
    const st = isRoot ? (S.data.boss?.passed ? 'mastered' : 'root') : nodeState(node.id);
    const weak = (S.data.gaps || []).some((g) => g.nodeId === node.id);

    const g = svgEl('g', {
      class: 'node-hit',
      onclick: () => openDrawer(node.id),
    });
    const body = svgEl('g', {
      class: 'node-body',
      style: `animation-delay:${(0.04 + (p.order || 0) * 0.045).toFixed(2)}s; transform-origin:${p.x}px ${p.y}px`,
    });

    // Base disc stays put; the lift group rises on hover, so the bubble reads
    // as a physical button sitting on a ledge.
    body.append(svgEl('circle', {
      class: `node-base is-${isRoot ? 'root' : st}`,
      cx: p.x, cy: p.y + Math.max(5, p.r * 0.17), r: p.r,
    }));
    const lift = svgEl('g', { class: 'node-lift' });
    lift.append(
      svgEl('circle', {
        class: isRoot ? `crown-circle${S.data.boss?.passed ? ' is-complete' : ''}` : `node-circle is-${st}`,
        cx: p.x, cy: p.y, r: p.r,
      }),
    );
    body.append(lift);
    if (isRoot) g.classList.add('crown-group');

    const glyph = { mastered: '\u2713', needs_review: '\u21bb', split: '\u00b7\u00b7\u00b7' }[st];
    if (glyph && !isRoot) {
      lift.append(svgEl('text', {
        class: `node-glyph is-${st}`, x: p.x, y: p.y + p.r * 0.32, 'font-size': p.r * 0.85,
      }, glyph));
    }
    // A subtopic that can still be opened up shows a quiet plus.
    if (!isRoot && p.depth === 1 && !node.children?.length && node.expandable) {
      lift.append(svgEl('text', { class: 'node-plus', x: p.x, y: p.y + p.r * 0.34, 'font-size': p.r * 0.95 }, '+'));
    }
    if (weak) {
      lift.append(svgEl('circle', {
        class: 'gap-dot', cx: p.x + p.r * 0.72, cy: p.y - p.r * 0.72, r: Math.max(5, p.r * 0.2),
      }));
    }
    g.append(body);

    // Labels sit outside the ring so they never cross the lines.
    const outward = p.angle == null ? Math.PI / 2 : p.angle;
    const above = Math.sin(outward) < -0.4;
    const labelY = p.y + (above ? -(p.r + 14) : p.r + 21);
    const maxChars = isRoot ? 30 : p.depth === 1 ? 20 : 15;   // mirrored in labelChars() above
    g.append(svgEl('text', {
      class: `node-label${isRoot ? ' node-title' : ''}`, x: p.x, y: labelY,
    }, clip(node.title, maxChars)));

    const sub = node.children?.length
      ? `${node.children.filter((c) => nodeState(c) === 'mastered').length}/${node.children.length}`
      : weak ? `${Math.round((node.coverage ?? 0) * 100)}%`
      : '';
    if (sub) g.append(svgEl('text', { class: 'node-sub', x: p.x, y: labelY + (above ? -13 : 15) }, sub));

    svg.append(g);
  }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/* ------------------------------------------------------------- drawer --- */

document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close-drawer]')) setHidden($('#drawer'), true);
});

let drawerToken = 0;
async function openDrawer(nodeId) {
  const node = S.data.tree.nodes[nodeId];
  if (!node) return;
  const token = ++drawerToken;
  const prog = S.data.progress[nodeId] || {};
  const st = nodeState(nodeId);
  const d = $('#drawer');
  setHidden(d, false);
  $('#drawer-title').textContent = node.title;
  $('#drawer-summary').textContent = node.summary || '';
  const chips = $('#drawer-concepts');
  chips.innerHTML = '';
  (node.keyConcepts || []).forEach((c) => chips.append(el('span', { class: 'chip' }, c)));

  const cov = node.coverage ?? null;
  $('#cov-bar').style.width = cov == null ? '0%' : `${Math.round(cov * 100)}%`;
  $('#cov-bar').classList.toggle('weak', cov != null && cov < 0.34);
  $('#cov-label').textContent = cov == null ? '' : `${Math.round(cov * 100)}% covered`;

  const gapBox = $('#drawer-gap');
  if (node.gap) {
    setHidden(gapBox, false);
    gapBox.innerHTML = '';
    gapBox.append(
      el('strong', {}, 'Thin coverage'),
      el('div', {}, node.gap.missing || ''),
      el('div', { style: 'margin-top:6px;color:var(--gold)' }, node.gap.suggestion || ''),
    );
  } else setHidden(gapBox, true);

  const actions = $('#drawer-actions');
  actions.innerHTML = '';

  if (nodeId === 'root') {
    actions.append(el('p', { class: 'hint' }, 'Finish every subtopic to unlock the boss.'));
  } else if (prog.remediation?.required && !prog.remediation.satisfied) {
    actions.append(el('button', { class: 'btn accent', onclick: () => showRemediation(nodeId) }, 'Review what you missed'));

  } else if (node.children?.length) {

  } else {
    actions.append(el('button', { class: 'btn accent', onclick: () => startQuiz(nodeId) },
      st === 'mastered' ? 'Practice again' : 'Start quiz'));
    if (node.depth === 1 && node.expandable) {
      actions.append(el('button', { class: 'btn ghost', onclick: () => zoomIn(nodeId) }, 'Expand into subtopics'));
    }
  }

  // Source snippets are collapsed: useful when you want them, noise when you don't.
  const src = $('#drawer-sources');
  src.innerHTML = '';
  const body = el('div', { class: 'src-body', hidden: '' });
  const toggle = el('button', { class: 'src-toggle' },
    el('span', {}, 'From your material'),
    el('span', { class: 'chev' }, '\u203a'),
  );
  let loaded = false;
  toggle.onclick = async () => {
    const open = body.hasAttribute('hidden');
    setHidden(body, !open);
    toggle.classList.toggle('open', open);
    if (!open || loaded) return;
    loaded = true;
    body.append(el('p', { class: 'hint' }, 'loading…'));
    try {
      const { chunks } = await api(`/api/session/${S.sessionId}/node/${nodeId}/sources`);
      if (token !== drawerToken) return;
      body.innerHTML = '';
      for (const c of chunks.slice(0, 4)) {
        body.append(el('div', { class: 'snippet' },
          el('span', { class: 'src' }, c.sourceName),
          clip(c.text, 320)));
      }
      if (!chunks.length) body.append(el('p', { class: 'hint' }, 'Nothing here matches this yet.'));
    } catch (err) {
      body.innerHTML = '';
      body.append(el('p', { class: 'hint' }, err.message));
    }
  };
  src.append(toggle, body);
}

async function zoomIn(nodeId) {
  try {
    const data = await api(`/api/session/${S.sessionId}/node/${nodeId}/expand`, { method: 'POST', label: 'Expanding…' });
    S.data = { ...S.data, ...data };
    setHidden($('#drawer'), true);
    render();
  } catch (err) { toast(err.message, true); }
}

/* --------------------------------------------------------------- quiz --- */

function openModal(node) {
  setHidden($('#modal'), false);
  const card = $('#modal-card');
  card.innerHTML = '';
  card.append(node);
}
function closeModal() { setHidden($('#modal'), true); }

async function startQuiz(nodeId) {
  try {
    const quiz = await api(`/api/session/${S.sessionId}/node/${nodeId}/quiz`, {
      method: 'POST',
      label: 'Writing and verifying…',
    });
    setHidden($('#drawer'), true);
    beginQuiz(quiz);
  } catch (err) { toast(err.message, true); }
}

async function startReview(nodeId) {
  try {
    const quiz = await api(`/api/session/${S.sessionId}/node/${nodeId}/review-quiz`, { method: 'POST', label: 'Building review…' });
    beginQuiz(quiz);
  } catch (err) { toast(err.message, true); }
}

async function startBoss() {
  try {
    const quiz = await api(`/api/session/${S.sessionId}/boss/quiz`, {
      method: 'POST',
      label: 'Assembling the boss…',
    });
    beginQuiz(quiz);
  } catch (err) { toast(err.message, true); }
}

function beginQuiz(quiz) {
  S.quiz = quiz;
  S.answers = {};
  S.qIndex = 0;
  renderQuestion();
}

function renderQuestion() {
  const quiz = S.quiz;
  const q = quiz.questions[S.qIndex];
  const isBoss = quiz.kind === 'boss';
  const title = isBoss
    ? `Boss quiz — ${S.data.tree.nodes.root.title}`
    : S.data.tree.nodes[quiz.nodeId].title;

  const dots = el('div', { class: 'dots' },
    quiz.questions.map((qq, i) =>
      el('span', { class: `dot${S.answers[qq.id] != null && S.answers[qq.id] !== '' ? ' answered' : ''}`, title: `Q${i + 1}` })),
  );

  const head = el('div', { class: 'quiz-head' },
    el('h2', {}, title),
    dots,
    el('button', { class: 'close', onclick: () => { if (confirm('Abandon this quiz? It will not count.')) closeModal(); } }, '\u00d7'),
  );

  const meta = el('div', { class: 'q-foot' },
    el('span', { class: 'badge' }, `${S.qIndex + 1} / ${quiz.questions.length}`),
    q.synthesis && el('span', { class: 'badge synth' }, 'synthesis'),
    el('span', { class: 'badge verified' }, 'verified'),
    quiz.attempt > 1 && el('span', { class: 'badge' }, `attempt ${quiz.attempt}`),
  );

  let body;
  if (q.type === 'short') {
    body = el('textarea', {
      class: 'short-input', rows: 3, placeholder: 'Answer in a sentence…',
      oninput: (e) => { S.answers[q.id] = e.target.value; },
    });
    body.value = S.answers[q.id] || '';
  } else {
    body = el('div', { class: 'options' },
      q.options.map((opt, i) =>
        el('button', {
          class: `option${S.answers[q.id] === i ? ' selected' : ''}`,
          onclick: () => { S.answers[q.id] = i; renderQuestion(); },
        }, el('span', { class: 'key' }, 'ABCD'[i]), el('span', {}, opt)),
      ),
    );
  }

  const hintBox = el('div', { class: 'hint' });
  const nav = el('div', { class: 'q-foot' },
    el('button', { class: 'btn sm ghost', onclick: () => { S.qIndex = Math.max(0, S.qIndex - 1); renderQuestion(); } , disabled: S.qIndex === 0 }, 'Back'),
    el('button', { class: 'btn sm ghost', onclick: async () => {
      try {
        hintBox.textContent = 'thinking…';
        const { hint } = await api(`/api/session/${S.sessionId}/quiz/${quiz.id}/hint`, { method: 'POST', body: { questionId: q.id } });
        hintBox.textContent = hint;
      } catch (err) { hintBox.textContent = err.message; }
    } }, 'Hint'),
    el('div', { class: 'grow', style: 'flex:1' }),
    S.qIndex < quiz.questions.length - 1
      ? el('button', { class: 'btn primary', onclick: () => { S.qIndex++; renderQuestion(); } }, 'Next')
      : el('button', { class: 'btn accent', onclick: submitQuiz }, 'Submit'),
  );

  openModal(el('div', { style: 'display:flex;flex-direction:column;gap:16px' },
    head, meta, el('div', { class: 'q-prompt' }, q.prompt), body, hintBox, nav,
  ));
}

async function submitQuiz() {
  const quiz = S.quiz;
  const unanswered = quiz.questions.filter((q) => S.answers[q.id] == null || S.answers[q.id] === '');
  if (unanswered.length && !confirm(`${unanswered.length} unanswered — submit anyway?`)) return;
  try {
    const res = await api(`/api/session/${S.sessionId}/quiz/${quiz.id}/submit`, {
      method: 'POST', body: { answers: S.answers }, label: 'Grading…',
    });
    S.data = { ...S.data, ...res.state };
    render();
    showResults(res);
  } catch (err) { toast(err.message, true); }
}

function citationBlock(r) {
  return el('div', {},
    r.citations.map((c) =>
      el('div', { class: 'snippet' },
        el('span', { class: 'src' }, `${c.sourceName} · ${c.chunkId}`),
        `“${c.snippet}”`)),
    el('p', { class: 'hint', style: 'margin-top:6px' }, r.explanation),
  );
}

function showResults(res) {
  const isBoss = res.kind === 'boss';
  const passed = res.passed;
  const node = isBoss ? S.data.tree.nodes.root : S.data.tree.nodes[S.quiz.nodeId];

  const rows = res.results.map((r) =>
    el('div', { class: `result-row ${r.correct ? 'ok' : 'no'}` },
      el('div', { class: 'rq' }, `${r.correct ? '\u2713' : '\u2715'}  ${r.prompt}`),
      r.type === 'short'
        ? el('p', { class: 'hint' }, `You: ${r.given || '(blank)'} — expected: ${r.correctAnswer}${r.note ? ` · ${r.note}` : ''}`)
        : el('p', { class: 'hint' }, `Correct: ${'ABCD'[r.correctAnswer]}. ${r.options[r.correctAnswer]}`),
      citationBlock(r),
    ),
  );

  const header = el('div', { class: 'center' },
    el('div', { class: 'score-big', style: `color:${passed ? 'var(--green-600)' : 'var(--gold)'}` }, `${res.score} / ${res.total}`),
    el('h2', {}, passed
      ? (isBoss ? 'Topic completed' : `${node.title} — lit up`)
      : (isBoss ? `Need ${res.needed} to clear the boss` : 'Not quite — review and retry')),
    el('p', { class: 'hint' }, passed ? 'Scheduled for spaced review.' : `${res.total - res.score} to review`),
  );

  const actions = el('div', { class: 'row', style: 'justify-content:center' });
  if (passed) {
    actions.append(el('button', { class: 'btn accent', onclick: () => { closeModal(); render(); } }, 'Back to tree'));
    if (!isBoss && res.bossUnlocked) actions.append(el('button', { class: 'btn boss', onclick: () => { closeModal(); startBoss(); } }, 'Boss quiz unlocked'));
  } else {
    actions.append(el('button', { class: 'btn accent', onclick: () => showRemediation(isBoss ? 'root' : node.id, isBoss) }, 'Review what you missed'));
    actions.append(el('button', { class: 'btn ghost', onclick: closeModal }, 'Later'));
  }

  openModal(el('div', { style: 'display:flex;flex-direction:column;gap:14px' },
    header, actions, el('div', { style: 'display:flex;flex-direction:column;gap:10px' }, rows),
    S.quiz.meta?.rejected
      ? el('p', { class: 'hint center' }, `${S.quiz.meta.rejected} rejected by the verifier before you saw this`)
      : null,
  ));
}

/* -------------------------------------------------------- remediation --- */

async function showRemediation(nodeId, isBoss = false) {
  const prog = isBoss ? S.data.boss : S.data.progress[nodeId];
  const rem = prog?.remediation;
  const node = S.data.tree.nodes[nodeId];
  if (!rem?.required) { toast('Nothing pending to review.'); return; }

  const seen = new Set();
  const snippets = (rem.snippets || []).filter((s) => !seen.has(s.chunkId + s.snippet) && seen.add(s.chunkId + s.snippet));

  const lessonBox = el('div', {});
  const card = el('div', { style: 'display:flex;flex-direction:column;gap:14px' },
    el('div', { class: 'quiz-head' },
      el('h2', { style: 'flex:1' }, `Review — ${node.title}`),
      el('button', { class: 'close', style: 'position:static', onclick: closeModal }, '\u00d7')),
    el('p', { class: 'hint' }, (prog.missedConcepts || []).slice(0, 4).join(' · ')),
    el('div', {}, snippets.map((s) =>
      el('div', { class: 'snippet' },
        el('span', { class: 'src' }, `${s.sourceName} · ${s.concept || ''}`),
        `“${s.snippet}”`))),
    el('div', { class: 'row' },
      el('button', { class: 'btn ghost', onclick: async () => {
        try {
          lessonBox.innerHTML = '';
          lessonBox.append(el('p', { class: 'hint' }, 'writing…'));
          const { lesson } = await api(`/api/session/${S.sessionId}/node/${nodeId}/micro-lesson`, { method: 'POST' });
          lessonBox.innerHTML = '';
          lessonBox.append(el('div', { class: 'lesson' }, lesson));
        } catch (err) { lessonBox.innerHTML = ''; lessonBox.append(el('p', { class: 'hint' }, err.message)); }
      } }, 'Micro-lesson'),
      el('button', { class: 'btn accent', onclick: async () => {
        try {
          const path = isBoss
            ? `/api/session/${S.sessionId}/boss/review-done`
            : `/api/session/${S.sessionId}/node/${nodeId}/review-done`;
          const data = await api(path, { method: 'POST', label: 'Unlocking…' });
          S.data = { ...S.data, ...data };
          render();
          closeModal();
          isBoss ? startBoss() : startQuiz(nodeId);
        } catch (err) { toast(err.message, true); }
      } }, 'Retry'),
    ),
    lessonBox,
  );
  openModal(card);
}

function showBossDone() {
  openModal(el('div', { class: 'center', style: 'display:flex;flex-direction:column;gap:12px' },
    el('div', { class: 'crest' }, 'Complete'),
    el('h2', {}, `${S.data.tree.nodes.root.title} — completed`),
    el('p', { class: 'hint' }, `Boss cleared with a best of ${S.data.boss.best}. Spaced repetition will bring pieces of this back over the coming weeks so mastery sticks.`),
    el('div', { class: 'row', style: 'justify-content:center' },
      el('button', { class: 'btn ghost', onclick: closeModal }, 'Close'),
      el('button', { class: 'btn boss', onclick: () => { closeModal(); startBoss(); } }, 'Try it again'),
    ),
  ));
}

// A silent JS exception looks exactly like a hang — make it loud.
window.addEventListener('error', (e) => toast(`UI error: ${e.message}`, true));
window.addEventListener('unhandledrejection', (e) => toast(`UI error: ${e.reason?.message || e.reason}`, true));

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (S.data?.tree && S.screen === 'tree') renderTree(); }, 120);
});
boot().catch((err) => toast(err.message, true));
