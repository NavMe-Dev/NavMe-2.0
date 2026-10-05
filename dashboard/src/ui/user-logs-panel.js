/**
 * User logs — full-page activity report with search and filters.
 */

import { fetchVisibleUserLogs, canViewProfileActivity, formatXyz, xyzOf } from '../services/user-logs.js';
import { isSubAdminSession } from '../config/auth-session.js';
import { iconRefresh, iconSearch } from './icons.js';
import { t } from '../config/i18n.js';

function getActionOptions() {
  return [
    { value: '', label: t('userLogsPanel.actionAll') },
    { value: 'created', label: t('userLogsPanel.actionCreated') },
    { value: 'updated', label: t('userLogsPanel.actionUpdated') },
    { value: 'moved', label: t('userLogsPanel.actionMoved') },
    { value: 'scaled', label: t('userLogsPanel.actionScaled') },
    { value: 'deleted', label: t('userLogsPanel.actionDeleted') },
    { value: 'assigned', label: t('userLogsPanel.actionAssigned') },
    { value: 'enabled', label: t('userLogsPanel.actionEnabled') },
    { value: 'disabled', label: t('userLogsPanel.actionDisabled') },
  ];
}

function getEntityOptions() {
  return [
    { value: '', label: t('userLogsPanel.entityAllTypes') },
    { value: 'poi', label: t('userLogsPanel.entityPoi') },
    { value: 'media', label: t('userLogsPanel.entityMedia') },
    { value: 'facility', label: t('userLogsPanel.entityAmenity') },
    { value: 'block', label: t('userLogsPanel.entityZone') },
    { value: 'stairs', label: t('userLogsPanel.entityStairs') },
    { value: 'treasure', label: t('userLogsPanel.entityTreasure') },
    { value: 'sub_admin', label: t('userLogsPanel.entitySubAdmin') },
    { value: 'project_admin', label: t('userLogsPanel.entityProjectAdmin') },
    { value: 'tenant', label: t('userLogsPanel.entityTenant') },
    { value: 'editor', label: t('userLogsPanel.entityEditor') },
  ];
}

function getRoleOptions() {
  return [
    { value: '', label: t('userLogsPanel.roleAll') },
    { value: 'superadmin', label: t('userLogsPanel.roleSuperadmin') },
    { value: 'project_admin', label: t('userLogsPanel.roleProjectAdmin') },
    { value: 'sub_admin', label: t('userLogsPanel.roleSubAdmin') },
    { value: 'api_credential', label: t('userLogsPanel.roleApiCredential') },
  ];
}

/**
 * @param {unknown} value
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {string} iso
 */
function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * @param {string} iso
 */
function localDateKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * @param {Record<string, unknown>} row
 */
function entityTypeLabel(row) {
  const type = String(row.entity_type ?? '');
  const match = getEntityOptions().find((o) => o.value === type);
  return match?.label || type || '—';
}

/**
 * @param {Record<string, unknown>} row
 */
function actionLabel(row) {
  const action = String(row.action ?? '');
  const match = getActionOptions().find((o) => o.value === action);
  return match?.label || action || '—';
}

/**
 * @param {Record<string, unknown>} row
 */
function changeText(row) {
  const details = row.details && typeof row.details === 'object' ? row.details : {};
  const from = xyzOf(details.from);
  const to = xyzOf(details.to);
  const fromScale = xyzOf(details.fromScale);
  const toScale = xyzOf(details.toScale);
  if (to) {
    const fromPart = from
      ? `X ${Number(from.x).toFixed(3)} Y ${Number(from.y).toFixed(3)} Z ${Number(from.z).toFixed(3)} → `
      : '';
    return `${fromPart}X ${Number(to.x).toFixed(3)} Y ${Number(to.y).toFixed(3)} Z ${Number(to.z).toFixed(3)}`;
  }
  if (toScale) {
    const fromPart = fromScale ? `${formatXyz(fromScale)} → ` : '';
    return `scale ${fromPart}${formatXyz(toScale)}`;
  }
  return '';
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {{
 *   query?: string,
 *   action?: string,
 *   entityType?: string,
 *   actorEmail?: string,
 *   actorRole?: string,
 *   dateFrom?: string,
 *   dateTo?: string,
 *   poiType?: string,
 * }} filters
 */
export function filterUserLogRows(rows, filters = {}) {
  const query = String(filters.query ?? '')
    .trim()
    .toLowerCase();
  const action = String(filters.action ?? '').trim();
  const entityType = String(filters.entityType ?? '').trim();
  const actorEmail = String(filters.actorEmail ?? '').trim().toLowerCase();
  const actorRole = String(filters.actorRole ?? '').trim();
  const dateFrom = String(filters.dateFrom ?? '').trim();
  const dateTo = String(filters.dateTo ?? '').trim();
  const poiType = String(filters.poiType ?? '').trim().toLowerCase();

  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (action && String(row.action ?? '') !== action) return false;
    if (entityType && String(row.entity_type ?? '') !== entityType) return false;
    if (actorEmail && String(row.actor_email ?? '').toLowerCase() !== actorEmail) return false;
    if (actorRole && String(row.actor_role ?? '') !== actorRole) return false;
    if (poiType && String(row.poi_type ?? '').toLowerCase() !== poiType) return false;

    const day = localDateKey(String(row.created_at ?? ''));
    if (dateFrom && day && day < dateFrom) return false;
    if (dateTo && day && day > dateTo) return false;

    if (!query) return true;
    const change = changeText(row).toLowerCase();
    const hay = [
      row.summary,
      row.actor_email,
      row.actor_role,
      row.action,
      row.entity_type,
      row.entity_label,
      row.entity_id,
      row.poi_type,
      row.created_email,
      change,
    ]
      .map((v) => String(v ?? '').toLowerCase())
      .join(' ');
    return hay.includes(query);
  });
}

/**
 * @param {HTMLElement} tableBody
 * @param {{
 *   rows?: Record<string, unknown>[],
 *   showProject?: boolean,
 *   emptyText?: string,
 * }} [opts]
 */
function renderReportTable(tableBody, opts = {}) {
  if (!tableBody) return;
  const rows = Array.isArray(opts.rows) ? opts.rows : [];
  const showProject = Boolean(opts.showProject);
  const emptyText = opts.emptyText || t('userLogsPanel.defaultEmptyText');

  if (!rows.length) {
    tableBody.innerHTML = `
      <tr class="user-logs-empty-row">
        <td colspan="${showProject ? 7 : 6}">${escapeHtml(emptyText)}</td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = rows
    .map((row) => {
      const when = formatDateTime(String(row.created_at ?? ''));
      const actor = String(row.actor_email ?? '—');
      const role = String(row.actor_role ?? '').replace(/_/g, ' ');
      const item = String(row.entity_label || row.entity_id || '—');
      const project = String(row.poi_type ?? '—');
      const change = changeText(row);
      return `
        <tr>
          <td class="user-logs-col-when">${escapeHtml(when)}</td>
          <td class="user-logs-col-actor">
            <div class="user-logs-actor-email">${escapeHtml(actor)}</div>
            <div class="user-logs-actor-role">${escapeHtml(role || '—')}</div>
          </td>
          <td><span class="user-logs-pill user-logs-pill--action">${escapeHtml(actionLabel(row))}</span></td>
          <td>
            <div class="user-logs-item-type">${escapeHtml(entityTypeLabel(row))}</div>
            <div class="user-logs-item-label">${escapeHtml(item)}</div>
          </td>
          ${
            showProject
              ? `<td class="user-logs-col-project"><span class="user-logs-project">${escapeHtml(project)}</span></td>`
              : ''
          }
          <td class="user-logs-col-change">${change ? escapeHtml(change) : '<span class="user-logs-muted">—</span>'}</td>
          <td class="user-logs-col-summary">${escapeHtml(String(row.summary ?? ''))}</td>
        </tr>
      `;
    })
    .join('');
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {boolean} showProject
 */
function rowsToCsv(rows, showProject) {
  const headers = [
    t('userLogsPanel.colWhen'),
    t('userLogsPanel.colActor'),
    t('userLogsPanel.colRole'),
    t('userLogsPanel.colAction'),
    t('userLogsPanel.colType'),
    t('userLogsPanel.colItem'),
    ...(showProject ? [t('userLogsPanel.colProject')] : []),
    t('userLogsPanel.colChange'),
    t('userLogsPanel.colSummary'),
  ];
  const escapeCsv = (value) => {
    const raw = String(value ?? '');
    if (/[",\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
    return raw;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    const cells = [
      formatDateTime(String(row.created_at ?? '')),
      row.actor_email,
      row.actor_role,
      actionLabel(row),
      entityTypeLabel(row),
      row.entity_label || row.entity_id || '',
      ...(showProject ? [row.poi_type || ''] : []),
      changeText(row),
      row.summary || '',
    ];
    lines.push(cells.map(escapeCsv).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {HTMLSelectElement | null} select
 * @param {Array<{ value: string, label: string }>} options
 * @param {string} current
 */
function fillSelect(select, options, current) {
  if (!select) return;
  select.innerHTML = options
    .map(
      (opt) =>
        `<option value="${escapeHtml(opt.value)}"${opt.value === current ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`,
    )
    .join('');
}

/**
 * Mount a searchable / filterable activity report into a container.
 * @param {HTMLElement} container
 * @param {{
 *   global?: boolean,
 *   poiType?: string | null,
 *   showTitle?: boolean,
 *   title?: string,
 *   subtitle?: string,
 *   ownOnly?: boolean,
 * }} [opts]
 */
export function mountUserLogsReport(container, opts = {}) {
  if (!container) {
    return {
      refresh: async () => {},
      destroy: () => {},
    };
  }

  const showProject = Boolean(opts.global);
  const showTitle = opts.showTitle !== false;
  const ownOnly = Boolean(opts.ownOnly) || isSubAdminSession();
  const title = opts.title || (ownOnly ? t('userLogsPanel.titleUserLogs') : t('userLogsPanel.titleActivityReport'));
  const subtitle =
    opts.subtitle ||
    (ownOnly
      ? t('userLogsPanel.subtitleOwnOnly')
      : showProject
        ? t('userLogsPanel.subtitleGlobal')
        : t('userLogsPanel.subtitleProject'));

  container.classList.add('user-logs-report');
  container.innerHTML = `
    ${
      showTitle
        ? `<div class="user-logs-report-header">
            <div>
              <h2 class="user-logs-report-title">${escapeHtml(title)}</h2>
              <p class="user-logs-report-subtitle">${escapeHtml(subtitle)}</p>
            </div>
            <div class="user-logs-report-header-actions">
              <button type="button" class="access-action-btn user-logs-export-btn" data-logs-export title="${escapeHtml(t('userLogsPanel.exportTitle'))}">${escapeHtml(t('userLogsPanel.exportLabel'))}</button>
              <button type="button" class="admin-refresh-btn" data-logs-refresh title="${escapeHtml(t('userLogsPanel.refreshTitle'))}" aria-label="${escapeHtml(t('userLogsPanel.refreshTitle'))}">${iconRefresh()}</button>
            </div>
          </div>`
        : `<div class="user-logs-report-header user-logs-report-header--compact">
            <div class="user-logs-report-header-actions">
              <button type="button" class="access-action-btn user-logs-export-btn" data-logs-export title="${escapeHtml(t('userLogsPanel.exportTitle'))}">${escapeHtml(t('userLogsPanel.exportLabel'))}</button>
              <button type="button" class="admin-refresh-btn" data-logs-refresh title="${escapeHtml(t('userLogsPanel.refreshTitle'))}" aria-label="${escapeHtml(t('userLogsPanel.refreshTitle'))}">${iconRefresh()}</button>
            </div>
          </div>`
    }
    <div class="user-logs-report-toolbar">
      <label class="user-logs-search-field">
        <span class="user-logs-search-icon" aria-hidden="true">${iconSearch()}</span>
        <input type="search" data-logs-search placeholder="${escapeHtml(t('userLogsPanel.searchPlaceholder'))}" autocomplete="off" />
      </label>
      <div class="user-logs-filters-row">
        <select data-logs-action aria-label="${escapeHtml(t('userLogsPanel.filterByAction'))}"></select>
        <select data-logs-entity aria-label="${escapeHtml(t('userLogsPanel.filterByType'))}"></select>
        ${ownOnly ? '' : `<select data-logs-actor aria-label="${escapeHtml(t('userLogsPanel.filterByActor'))}"></select>`}
        ${ownOnly ? '' : `<select data-logs-role aria-label="${escapeHtml(t('userLogsPanel.filterByRole'))}"></select>`}
        ${showProject ? `<select data-logs-project aria-label="${escapeHtml(t('userLogsPanel.filterByProject'))}"></select>` : ''}
        <input type="date" data-logs-from aria-label="${escapeHtml(t('userLogsPanel.fromDate'))}" />
        <input type="date" data-logs-to aria-label="${escapeHtml(t('userLogsPanel.toDate'))}" />
        <button type="button" class="user-logs-clear-btn" data-logs-clear>${escapeHtml(t('userLogsPanel.clearFilters'))}</button>
      </div>
    </div>
    <div class="user-logs-report-meta" data-logs-meta aria-live="polite">${escapeHtml(t('userLogsPanel.loading'))}</div>
    <div class="user-logs-table-wrap">
      <table class="user-logs-table">
        <thead>
          <tr>
            <th>${escapeHtml(t('userLogsPanel.colWhen'))}</th>
            <th>${escapeHtml(t('userLogsPanel.colActor'))}</th>
            <th>${escapeHtml(t('userLogsPanel.colAction'))}</th>
            <th>${escapeHtml(t('userLogsPanel.colItem'))}</th>
            ${showProject ? `<th>${escapeHtml(t('userLogsPanel.colProject'))}</th>` : ''}
            <th>${escapeHtml(t('userLogsPanel.colChange'))}</th>
            <th>${escapeHtml(t('userLogsPanel.colSummary'))}</th>
          </tr>
        </thead>
        <tbody data-logs-tbody>
          <tr class="user-logs-empty-row"><td colspan="${showProject ? 7 : 6}">${escapeHtml(t('userLogsPanel.loading'))}</td></tr>
        </tbody>
      </table>
    </div>
  `;

  const searchInput = /** @type {HTMLInputElement | null} */ (container.querySelector('[data-logs-search]'));
  const actionSelect = /** @type {HTMLSelectElement | null} */ (container.querySelector('[data-logs-action]'));
  const entitySelect = /** @type {HTMLSelectElement | null} */ (container.querySelector('[data-logs-entity]'));
  const actorSelect = /** @type {HTMLSelectElement | null} */ (container.querySelector('[data-logs-actor]'));
  const roleSelect = /** @type {HTMLSelectElement | null} */ (container.querySelector('[data-logs-role]'));
  const projectSelect = /** @type {HTMLSelectElement | null} */ (container.querySelector('[data-logs-project]'));
  const dateFromInput = /** @type {HTMLInputElement | null} */ (container.querySelector('[data-logs-from]'));
  const dateToInput = /** @type {HTMLInputElement | null} */ (container.querySelector('[data-logs-to]'));
  const metaEl = container.querySelector('[data-logs-meta]');
  const tbody = /** @type {HTMLElement | null} */ (container.querySelector('[data-logs-tbody]'));
  const refreshBtn = container.querySelector('[data-logs-refresh]');
  const exportBtn = container.querySelector('[data-logs-export]');
  const clearBtn = container.querySelector('[data-logs-clear]');

  fillSelect(actionSelect, getActionOptions(), '');
  fillSelect(entitySelect, getEntityOptions(), '');
  if (roleSelect) fillSelect(roleSelect, getRoleOptions(), '');
  if (actorSelect) fillSelect(actorSelect, [{ value: '', label: t('userLogsPanel.allActors') }], '');
  if (projectSelect) fillSelect(projectSelect, [{ value: '', label: t('userLogsPanel.allProjects') }], '');

  /** @type {Record<string, unknown>[]} */
  let allRows = [];

  function currentFilters() {
    return {
      query: searchInput?.value ?? '',
      action: actionSelect?.value ?? '',
      entityType: entitySelect?.value ?? '',
      actorEmail: actorSelect?.value ?? '',
      actorRole: roleSelect?.value ?? '',
      dateFrom: dateFromInput?.value ?? '',
      dateTo: dateToInput?.value ?? '',
      poiType: projectSelect?.value ?? '',
    };
  }

  function syncActorOptions() {
    if (!actorSelect) return;
    const current = actorSelect?.value ?? '';
    const emails = [...new Set(allRows.map((r) => String(r.actor_email ?? '').trim()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    );
    fillSelect(
      actorSelect,
      [{ value: '', label: t('userLogsPanel.allActors') }, ...emails.map((email) => ({ value: email, label: email }))],
      emails.includes(current) ? current : '',
    );
  }

  function syncProjectOptions() {
    if (!projectSelect) return;
    const current = projectSelect.value;
    const projects = [...new Set(allRows.map((r) => String(r.poi_type ?? '').trim()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    );
    fillSelect(
      projectSelect,
      [{ value: '', label: t('userLogsPanel.allProjects') }, ...projects.map((p) => ({ value: p, label: p }))],
      projects.includes(current) ? current : '',
    );
  }

  function applyFilters() {
    const filtered = filterUserLogRows(allRows, currentFilters());
    if (metaEl) {
      metaEl.textContent =
        filtered.length === allRows.length
          ? t(filtered.length === 1 ? 'userLogsPanel.eventCountOne' : 'userLogsPanel.eventCountOther', {
              count: filtered.length,
            })
          : t('userLogsPanel.eventCountFiltered', { filtered: filtered.length, total: allRows.length });
    }
    renderReportTable(tbody, {
      rows: filtered,
      showProject,
      emptyText: allRows.length ? t('userLogsPanel.defaultEmptyText') : t('userLogsPanel.noActivityYet'),
    });
    return filtered;
  }

  async function refresh() {
    if (!canViewProfileActivity()) {
      allRows = [];
      if (metaEl) metaEl.textContent = t('userLogsPanel.notAvailable');
      renderReportTable(tbody, {
        rows: [],
        showProject,
        emptyText: t('userLogsPanel.notAvailable'),
      });
      return;
    }
    if (metaEl) metaEl.textContent = t('userLogsPanel.loading');
    try {
      allRows = await fetchVisibleUserLogs({
        poiType: opts.poiType ?? null,
        global: Boolean(opts.global),
        limit: 1000,
      });
      syncActorOptions();
      syncProjectOptions();
      applyFilters();
    } catch (err) {
      allRows = [];
      if (metaEl) metaEl.textContent = String(err?.message ?? err);
      renderReportTable(tbody, {
        rows: [],
        showProject,
        emptyText: String(err?.message ?? err),
      });
    }
  }

  function exportCsv() {
    const filtered = applyFilters();
    const blob = new Blob([rowsToCsv(filtered, showProject)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `navme-user-logs-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function clearFilters() {
    if (searchInput) searchInput.value = '';
    if (actionSelect) actionSelect.value = '';
    if (entitySelect) entitySelect.value = '';
    if (actorSelect) actorSelect.value = '';
    if (roleSelect) roleSelect.value = '';
    if (projectSelect) projectSelect.value = '';
    if (dateFromInput) dateFromInput.value = '';
    if (dateToInput) dateToInput.value = '';
    applyFilters();
  }

  searchInput?.addEventListener('input', () => applyFilters());
  actionSelect?.addEventListener('change', () => applyFilters());
  entitySelect?.addEventListener('change', () => applyFilters());
  actorSelect?.addEventListener('change', () => applyFilters());
  roleSelect?.addEventListener('change', () => applyFilters());
  projectSelect?.addEventListener('change', () => applyFilters());
  dateFromInput?.addEventListener('change', () => applyFilters());
  dateToInput?.addEventListener('change', () => applyFilters());
  refreshBtn?.addEventListener('click', () => {
    void refresh();
  });
  exportBtn?.addEventListener('click', () => exportCsv());
  clearBtn?.addEventListener('click', () => clearFilters());

  void refresh();

  return {
    refresh,
    destroy() {
      container.innerHTML = '';
      container.classList.remove('user-logs-report');
    },
  };
}

/**
 * Editor sidebar / full-page report host (kept for embeds; Profile mounts report directly).
 * @param {HTMLElement} container
 */
export function createUserLogsPanel(container) {
  const panel = document.createElement('div');
  panel.className =
    'user-logs-panel user-panel scene-float-panel scene-float-panel--single float-glass drawer-frost hidden';
  panel.id = 'user-logs-panel';
  panel.innerHTML = `<div class="user-logs-report-host" id="user-logs-report-host"></div>`;
  container.appendChild(panel);

  const host = /** @type {HTMLElement | null} */ (panel.querySelector('#user-logs-report-host'));
  /** @type {{ refresh: () => Promise<void>, destroy: () => void } | null} */
  let report = null;

  function ensureReport() {
    if (!host) return null;
    if (!report) {
      report = mountUserLogsReport(host, {
        global: false,
        showTitle: true,
        title: t('userLogsPanel.titleUserLogs'),
        subtitle: t('userLogsPanel.subtitleEditorEmbed'),
        ownOnly: isSubAdminSession(),
      });
    }
    return report;
  }

  return {
    show() {
      if (!canViewProfileActivity()) {
        panel.classList.add('hidden');
        return;
      }
      panel.classList.remove('hidden');
      void ensureReport()?.refresh();
    },
    hide() {
      panel.classList.add('hidden');
    },
    refresh() {
      return ensureReport()?.refresh();
    },
  };
}

/**
 * Lightweight feed helper kept for simple embeds.
 * Prefer mountUserLogsReport for searchable reports.
 * @param {HTMLElement} feedEl
 * @param {{ poiType?: string | null, global?: boolean }} [opts]
 */
export async function loadUserLogsFeed(feedEl, opts = {}) {
  if (!feedEl) return;
  mountUserLogsReport(feedEl, {
    poiType: opts.poiType ?? null,
    global: Boolean(opts.global),
    showTitle: false,
  });
}

/**
 * @deprecated Use mountUserLogsReport / table rendering.
 * Kept so older call sites keep compiling during transition.
 */
export function renderUserLogsFeed(container, opts = {}) {
  if (!container) return;
  const showProject = Boolean(opts.showProject);
  container.innerHTML = `
    <div class="user-logs-table-wrap">
      <table class="user-logs-table">
        <thead>
          <tr>
            <th>${escapeHtml(t('userLogsPanel.colWhen'))}</th>
            <th>${escapeHtml(t('userLogsPanel.colActor'))}</th>
            <th>${escapeHtml(t('userLogsPanel.colAction'))}</th>
            <th>${escapeHtml(t('userLogsPanel.colItem'))}</th>
            ${showProject ? `<th>${escapeHtml(t('userLogsPanel.colProject'))}</th>` : ''}
            <th>${escapeHtml(t('userLogsPanel.colChange'))}</th>
            <th>${escapeHtml(t('userLogsPanel.colSummary'))}</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  `;
  renderReportTable(container.querySelector('tbody'), opts);
}
