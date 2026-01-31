// Wudai Relations (GitHub Pages frontend)
// Data is stored in Cloudflare D1 via a Cloudflare Worker API.
//
// IMPORTANT: Set your Worker base URL below OR in browser localStorage:
//   localStorage.setItem('WUDAI_API_BASE','https://<your-worker>.workers.dev');

const DEFAULT_API_BASE = 'https://wudai-sync-api.wudai-sync-qianqin.workers.dev'; // 默认后端（可按需修改）
const API_BASE = (localStorage.getItem('WUDAI_API_BASE') || DEFAULT_API_BASE).replace(/\/+$/, '');

// Generate a stable client id (used only for ownership hints in UI; backend uses cookies, too)
const CLIENT_ID_KEY = 'wudai_client_id';
let CLIENT_ID = localStorage.getItem(CLIENT_ID_KEY);
if (!CLIENT_ID) {
  CLIENT_ID = (crypto?.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
  localStorage.setItem(CLIENT_ID_KEY, CLIENT_ID);
}

// 管理员密钥（可选，只保存在本浏览器；不会写进 GitHub 仓库）
const ADMIN_KEY_STORAGE = 'WUDAI_ADMIN_KEY';
const ADMIN_OK_STORAGE = 'WUDAI_ADMIN_OK';
let ADMIN_KEY = localStorage.getItem(ADMIN_KEY_STORAGE) || '';
let ADMIN_OK = localStorage.getItem(ADMIN_OK_STORAGE) === '1';

function setAdmin(ok, key = ADMIN_KEY) {
  ADMIN_OK = !!ok;
  ADMIN_KEY = key || '';
  if (ADMIN_KEY) localStorage.setItem(ADMIN_KEY_STORAGE, ADMIN_KEY);
  else localStorage.removeItem(ADMIN_KEY_STORAGE);
  localStorage.setItem(ADMIN_OK_STORAGE, ADMIN_OK ? '1' : '0');
  updateAdminBadge();
}

function updateAdminBadge() {
  const badge = document.getElementById('adminBadge');
  if (!badge) return;
  badge.classList.toggle('hidden', !ADMIN_OK);
}

const STATE = {
  nodes: [],
  links: [],
  comments: [],
  selectedNodeId: null
};

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function on(id, evt, handler) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener(evt, handler);
}


function apiUrl(path) {
  return (API_BASE ? API_BASE : '') + path;
}

async function api(path, options = {}) {
  const extraHeaders = {};
  if (ADMIN_OK && ADMIN_KEY) extraHeaders['x-admin-key'] = ADMIN_KEY;
  const res = await fetch(apiUrl(path), {
    credentials: 'include',
    ...options,
    headers: {
      ...(options.headers || {}),
      ...extraHeaders,
      'content-type': 'application/json',
      // UI ownership (backend may also set cookie UID)
      'x-user-id': CLIENT_ID
    }
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// --------------------
// 管理员模式（按 Esc 三次触发）
// --------------------
async function adminPing(key) {
  // 用 /api/admin/ping 验证密钥是否正确
  const res = await fetch(apiUrl('/api/admin/ping'), {
    method: 'GET',
    credentials: 'include',
    headers: {
      'x-admin-key': key,
      'x-user-id': CLIENT_ID
    }
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || '管理员密钥不正确');
  }
  return true;
}

function setAdminOk(ok) {
  ADMIN_OK = !!ok;
  localStorage.setItem(ADMIN_OK_STORAGE, ADMIN_OK ? '1' : '0');
  updateAdminBadge();
}

function setAdminKey(key) {
  ADMIN_KEY = (key || '').trim();
  localStorage.setItem(ADMIN_KEY_STORAGE, ADMIN_KEY);
}

function clearAdmin() {
  ADMIN_KEY = '';
  ADMIN_OK = false;
  localStorage.removeItem(ADMIN_KEY_STORAGE);
  localStorage.removeItem(ADMIN_OK_STORAGE);
  updateAdminBadge();
}

function openAdminModal() {
  const input = document.getElementById('adminKeyInput');
  const logoutBtn = document.getElementById('adminLogoutBtn');
  const loginBtn = document.getElementById('adminLoginBtn');
  if (logoutBtn) logoutBtn.style.display = ADMIN_OK ? 'inline-flex' : 'none';
  if (loginBtn) loginBtn.textContent = ADMIN_OK ? '重新进入' : '进入';
  if (input) {
    input.value = '';
    input.focus();
  }
  openModal('adminModal');
}

async function handleAdminLogin() {
  const input = document.getElementById('adminKeyInput');
  const key = (input ? input.value : '').trim();
  if (!key) {
    toast('请输入管理员密钥');
    return;
  }
  try {
    await adminPing(key);
    setAdminKey(key);
    setAdminOk(true);
    closeModal('adminModal');
    toast('已进入管理员模式');
  } catch (e) {
    clearAdmin();
    toast('进入失败：' + (e.message || '未知原因'));
  }
}

function handleAdminLogout() {
  clearAdmin();
  closeModal('adminModal');
  toast('已退出管理员模式');
}

function setupAdminEscTriple() {
  let escCount = 0;
  let timer = null;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.repeat) return;
    escCount += 1;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      escCount = 0;
      timer = null;
    }, 900);

    if (escCount >= 3) {
      escCount = 0;
      if (timer) clearTimeout(timer);
      timer = null;
      // 已是管理员：再按三次 Esc 退出
      if (ADMIN_OK) {
        handleAdminLogout();
      } else {
        openAdminModal();
      }
    }
  }, true);
}

async function loadState() {
  const data = await api(`/api/state?ts=${Date.now()}`, { method: 'GET' });
  STATE.nodes = data.nodes || [];
  STATE.links = data.links || [];
  STATE.comments = data.comments || [];
}

function openModal(id) {
  document.getElementById(id).classList.add('active');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close')));
});
document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close')));
});

// ---------- Web pet ----------
(function initPet() {
  const pet = document.getElementById('webPet');
  const bubble = document.getElementById('petBubble');
  const lines = [
    '你好呀～点点人物圆圈可以看详情喔',
    '想加新人物？点下面“添加人物”',
    '想连关系？点“添加关系”，再选两个人',
    '关系线中间的字就是关系类型～',
    '评论写在页面下方，大家都能看到',
    '写错了也没关系，自己可以修改哦',
    '拖一拖人物，它会自己排得更好看',
    '如果卡住了，刷新一下页面试试',
    '我在右下角陪你～喵！',
  ];
  let i = 0;
  const show = (msg) => {
    bubble.textContent = msg;
    bubble.classList.add('show');
    setTimeout(() => bubble.classList.remove('show'), 1800);
  };
  pet.addEventListener('click', () => {
    show(lines[i % lines.length]);
    i++;
  });
})();

// ---------- Comments UI ----------
let editingCommentId = null;

function renderComments() {
  const list = document.getElementById('commentsList');
  list.innerHTML = '';

  if (!STATE.comments.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '还没有评论。';
    list.appendChild(empty);
    return;
  }

  for (const c of STATE.comments) {
    const item = document.createElement('div');
    item.className = 'comment-item';

    const header = document.createElement('div');
    header.className = 'comment-header';

    const left = document.createElement('div');
    left.innerHTML = `<span class="comment-author">${escapeHtml(c.author || '匿名')}</span>`;

    const right = document.createElement('div');
    const time = c.createdAt ? new Date(c.createdAt).toLocaleString() : '';
    right.innerHTML = `<span class="comment-time">${escapeHtml(time)}</span>`;

    header.appendChild(left);
    header.appendChild(right);

    const text = document.createElement('div');
    text.className = 'comment-text';
    text.textContent = c.content || '';

    const actions = document.createElement('div');
    actions.className = 'detail-actions';

    // Owner can edit/delete
    const isOwner = !!c.createdBy && c.createdBy === CLIENT_ID;

    if (isOwner) {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-secondary';
      editBtn.textContent = '编辑';
      editBtn.addEventListener('click', () => openEditComment(c));

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', async () => {
        if (!confirm('确定删除这条评论吗？')) return;
        try {
          await api(`/api/comments/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
          await refreshAll();
          toast('已删除');
        } catch (e) {
          toast('删除失败：' + e.message);
        }
      });

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
    }

    item.appendChild(header);
    item.appendChild(text);
    if (actions.childNodes.length) item.appendChild(actions);
    list.appendChild(item);
  }
}

function openEditComment(c) {
  editingCommentId = c.id;
  document.getElementById('editCommentContent').value = c.content || '';
  document.getElementById('commentModalHint').textContent = '只有评论发布者（或管理员）可以编辑/删除。';
  openModal('commentModal');
}

on('btnSaveCommentEdit','click', async () => {
  const content = document.getElementById('editCommentContent').value.trim();
  if (!content) return toast('评论不能为空');
  try {
    await api(`/api/comments/${encodeURIComponent(editingCommentId)}`, {
      method: 'PUT',
      body: JSON.stringify({ content })
    });
    closeModal('commentModal');
    await refreshAll();
    toast('已更新');
  } catch (e) {
    toast('更新失败：' + e.message);
  }
});

on('btnPostComment','click', async () => {
  const author = document.getElementById('commentAuthor').value.trim() || '匿名';
  const content = document.getElementById('commentContent').value.trim();
  if (!content) return toast('请先写点内容');
  try {
    await api('/api/comments', {
      method: 'POST',
      body: JSON.stringify({ author, content })
    });
    document.getElementById('commentContent').value = '';
    await refreshAll();
    toast('已发布');
  } catch (e) {
    toast('发布失败：' + e.message);
  }
});

// ---------- Graph UI (D3) ----------
let svg, g, simulation, zoomBehavior;
let linkSel, linkLabelSel, nodeSel;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (m) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[m]);
}

function getNodeById(id) {
  return STATE.nodes.find(n => n.id === id);
}

function openPersonModal(mode, node) {
  const title = document.getElementById('personModalTitle');
  const hint = document.getElementById('personModalHint');
  const delBtn = document.getElementById('btnDeletePerson');

  title.textContent = mode === 'add' ? '添加人物' : '编辑人物';
  hint.textContent = '保存后，大家打开都会是最新内容。';

  document.getElementById('personName').value = node?.name || '';
  document.getElementById('personPosition').value = node?.position || '';
  document.getElementById('personBirthYear').value = node?.birthYear || '';
  document.getElementById('personDeathYear').value = node?.deathYear || '';
  document.getElementById('personPersonality').value = node?.personality || '';

  delBtn.style.display = (mode === 'edit' && node && !node.isCenter) ? 'inline-flex' : 'none';
  delBtn.dataset.nodeId = node?.id || '';
  document.getElementById('btnSavePerson').dataset.mode = mode;
  document.getElementById('btnSavePerson').dataset.nodeId = node?.id || '';

  openModal('personModal');
}

on('btnAddPerson','click', () => openPersonModal('add'));

on('btnSavePerson','click', async (e) => {
  const mode = e.currentTarget.dataset.mode || 'add';
  const nodeId = e.currentTarget.dataset.nodeId || '';

  const payload = {
    name: document.getElementById('personName').value.trim(),
    position: document.getElementById('personPosition').value.trim(),
    birthYear: document.getElementById('personBirthYear').value.trim(),
    deathYear: document.getElementById('personDeathYear').value.trim(),
    personality: document.getElementById('personPersonality').value.trim()
  };
  if (!payload.name) return toast('姓名不能为空');

  try {
    if (mode === 'add') {
      await api('/api/nodes', { method: 'POST', body: JSON.stringify(payload) });
      toast('已添加');
    } else {
      await api(`/api/nodes/${encodeURIComponent(nodeId)}`, { method: 'PUT', body: JSON.stringify({ ...payload, id: nodeId }) });
      toast('已保存');
    }
    closeModal('personModal');
    await refreshAll();
  } catch (err) {
    toast('保存失败：' + err.message);
  }
});

on('btnDeletePerson','click', async (e) => {
  const id = e.currentTarget.dataset.nodeId;
  if (!id) return;
  if (!confirm('确定删除该人物吗？相关关系线也会一并删除。')) return;
  try {
    await api(`/api/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    closeModal('personModal');
    await refreshAll();
    toast('已删除');
  } catch (err) {
    toast('删除失败：' + err.message);
  }
});

// Relation modal
function populateRelationSelects() {
  const s = document.getElementById('relSource');
  const t = document.getElementById('relTarget');
  s.innerHTML = '';
  t.innerHTML = '';
  for (const n of STATE.nodes) {
    const o1 = document.createElement('option');
    o1.value = n.id; o1.textContent = n.name;
    const o2 = document.createElement('option');
    o2.value = n.id; o2.textContent = n.name;
    s.appendChild(o1);
    t.appendChild(o2);
  }
}

on('btnAddRelation','click', () => {
  populateRelationSelects();
  document.getElementById('relationModalHint').textContent = '';
  document.getElementById('relTypeSelect').value = '父子';
  document.getElementById('relCustomWrap').style.display = 'none';
  document.getElementById('relCustomType').value = '';
  openModal('relationModal');
});

on('relTypeSelect','change', (e) => {
  const v = e.target.value;
  document.getElementById('relCustomWrap').style.display = (v === '__custom__') ? 'block' : 'none';
});

on('btnSaveRelation','click', async () => {
  const source = document.getElementById('relSource').value;
  const target = document.getElementById('relTarget').value;
  if (!source || !target) return toast('请选择两个人物');
  if (source === target) return toast('请选择两个不同的人物');

  let type = document.getElementById('relTypeSelect').value;
  if (type === '__custom__') {
    type = document.getElementById('relCustomType').value.trim();
    if (!type) return toast('请输入自定义关系类型');
  }

  try {
    await api('/api/links', { method: 'POST', body: JSON.stringify({ source, target, type }) });
    closeModal('relationModal');
    await refreshAll();
    toast('关系已添加');
  } catch (e) {
    toast('添加关系失败：' + e.message);
  }
});

function renderSidebar(nodeId) {
  const wrap = document.getElementById('sidebarContent');
  const node = getNodeById(nodeId);
  if (!node) {
    wrap.className = 'empty-state';
    wrap.textContent = '点击人物节点查看详情。';
    return;
  }

  // Relations for this node
  const rels = STATE.links.filter(l => l.source === nodeId || l.target === nodeId);

  const years = [node.birthYear, node.deathYear].filter(Boolean).join('–');
  wrap.className = 'person-detail';
  wrap.innerHTML = `
    <div class="detail-section">
      <div class="detail-name">${escapeHtml(node.name)}</div>
    </div>
    <div class="detail-section">
      <div class="detail-label">职位</div>
      <div class="detail-value">${escapeHtml(node.position || '')}</div>
    </div>
    <div class="detail-section">
      <div class="detail-label">生卒年</div>
      <div class="detail-value">${escapeHtml(years || '')}</div>
    </div>
    <div class="detail-section">
      <div class="detail-label">性格评价</div>
      <div class="detail-value">${escapeHtml(node.personality || '')}</div>
    </div>
    <div class="detail-section">
      <div class="detail-label">关系</div>
      <div id="relList"></div>
    </div>
    <div class="detail-actions">
      <button class="btn btn-secondary" id="btn编辑Node">编辑</button>
    </div>
  `;

  document.getElementById('btn编辑Node').addEventListener('click', () => openPersonModal('edit', node));

  const relList = document.getElementById('relList');
  if (!rels.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '暂无关系。';
    relList.appendChild(empty);
  } else {
    for (const l of rels) {
      const otherId = (l.source === nodeId) ? l.target : l.source;
      const other = getNodeById(otherId);
      const otherName = other ? other.name : otherId;

      const item = document.createElement('div');
      item.className = 'relation-item';

      const txt = document.createElement('div');
      txt.className = 'relation-text';
      txt.textContent = `${otherName} — ${l.type || ''}`;
      item.appendChild(txt);

      const isOwner = !!l.createdBy && l.createdBy === CLIENT_ID;
      if (isOwner) {
        const del = document.createElement('button');
        del.className = 'relation-delete-btn';
        del.textContent = '×';
        del.title = '删除关系';
        del.addEventListener('click', async () => {
          if (!confirm('确定删除这条关系吗？')) return;
          try {
            await api(`/api/links/${encodeURIComponent(l.id)}`, { method: 'DELETE' });
            await refreshAll();
            toast('关系已删除');
          } catch (e) {
            toast('删除失败：' + e.message);
          }
        });
        item.appendChild(del);
      }

      relList.appendChild(item);
    }
  }
}

function showTooltip(evt, node) {
  const tt = document.getElementById('nodeTooltip');
  const wrap = document.getElementById('canvasContainer');
  if (!tt || !wrap) return;

  // 先填内容
  const nameEl = document.getElementById('ttName');
  const posEl = document.getElementById('ttPos');
  const yearsEl = document.getElementById('ttYears');
  const persEl = document.getElementById('ttPers');

  if (nameEl) nameEl.textContent = node.name || '';
  if (posEl) posEl.textContent = node.position || '';
  if (yearsEl) yearsEl.textContent = [node.birthYear, node.deathYear].filter(Boolean).join('—');
  if (persEl) persEl.textContent = node.personality || '';

  // 关键：提示框在 canvasContainer 里，所以坐标要换成“相对容器”的坐标（否则会偏到很远）
  const r = wrap.getBoundingClientRect();
  const clientX = (evt && typeof evt.clientX === 'number') ? evt.clientX : 0;
  const clientY = (evt && typeof evt.clientY === 'number') ? evt.clientY : 0;

  let x = clientX - r.left + 12;
  let y = clientY - r.top + 12;

  // 防止提示框跑出容器
  const maxX = Math.max(8, wrap.clientWidth - 320);
  const maxY = Math.max(8, wrap.clientHeight - 180);
  x = Math.max(8, Math.min(x, maxX));
  y = Math.max(8, Math.min(y, maxY));

  tt.style.left = x + 'px';
  tt.style.top = y + 'px';
  tt.classList.add('show');
}

function hideTooltip() {
  const tt = document.getElementById('nodeTooltip');
  if (tt) tt.classList.remove('show');
}

function initGraph() {
  const container = document.getElementById('graph');
  container.innerHTML = '';
  const width = container.clientWidth || 900;
  const height = container.clientHeight || 600;

  // Runtime copies so D3 can mutate safely
  const nodes = STATE.nodes.map(n => ({ ...n }));
  const links = STATE.links.map(l => ({ ...l }));

  svg = d3.select(container).append('svg')
    .attr('width', width)
    .attr('height', height)
    .attr('viewBox', `0 0 ${width} ${height}`);

  g = svg.append('g');

  zoomBehavior = d3.zoom()
    .scaleExtent([0.3, 3])
    .on('zoom', (event) => g.attr('transform', event.transform));

  svg.call(zoomBehavior);

  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(200))
    .force('charge', d3.forceManyBody().strength(-500))
    .force('center', d3.forceCenter(width/2, height/2))
    .force('collision', d3.forceCollide().radius(60))
    .force('x', d3.forceX(width/2).strength(0.05))
    .force('y', d3.forceY(height/2).strength(0.05));

  // Lines
  linkSel = g.append('g').attr('class', 'links')
    .selectAll('line')
    .data(links)
    .enter().append('line')
    .attr('class', 'link');

  // Link labels
  linkLabelSel = g.append('g').attr('class', 'link-labels')
    .selectAll('text')
    .data(links)
    .enter().append('text')
    .attr('class', 'link-label')
    .attr('text-anchor', 'middle')
    .text(d => d.type || '');

  // Nodes
  nodeSel = g.append('g').attr('class', 'nodes')
    .selectAll('g')
    .data(nodes)
    .enter().append('g')
    .attr('class', d => d.isCenter ? 'node center' : 'node')
    .call(d3.drag()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null; d.fy = null;
      })
    )
    .on('click', (event, d) => {
      event.stopPropagation();
      STATE.selectedNodeId = d.id;
      renderSidebar(d.id);
    })
    .on('mouseenter', (event, d) => showTooltip(event, d))
    .on('mouseleave', hideTooltip);

  nodeSel.append('circle').attr('r', d => d.isCenter ? 34 : 28);
  nodeSel.append('text')
    .attr('dy', 4)
    .text(d => d.name || '');

  simulation.on('tick', () => {
    linkSel
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    nodeSel.attr('transform', d => `translate(${d.x},${d.y})`);

    linkLabelSel
      .attr('x', d => (d.source.x + d.target.x) / 2)
      .attr('y', d => (d.source.y + d.target.y) / 2);
  });

  // Click blank to clear
  svg.on('click', () => {
    STATE.selectedNodeId = null;
    renderSidebar(null);
  });
}

// Controls
on('btnZoomIn','click', () => {
  svg.transition().call(zoomBehavior.scaleBy, 1.2);
});
on('btnZoomOut','click', () => {
  svg.transition().call(zoomBehavior.scaleBy, 0.8);
});
on('btnReset','click', () => {
  svg.transition().call(zoomBehavior.transform, d3.zoomIdentity);
});

// ---------- Refresh ----------
async function refreshAll() {
  await loadState();
  initGraph();
  renderComments();
  if (STATE.selectedNodeId) renderSidebar(STATE.selectedNodeId);
}

function setApiBaseHint() {
  const hint = document.getElementById('commentHint');
  if (!API_BASE) {
    hint.textContent = '⚠️ 暂未连接到同步服务：现在的修改不会保存。请联系站点管理员。';
  } else {
    hint.textContent = '✅ 已连接同步服务';
  }
}

window.addEventListener('load', async () => {
  try {
    setApiBaseHint();
    updateAdminBadge();
    setupAdminModal();
    setupAdminHotkeySequence();
    await refreshAll();
    toast('已加载');
  } catch (e) {
    toast('加载失败：' + e.message);
  }
});