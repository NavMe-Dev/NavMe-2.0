export const POI_PIN_SVG_ORIGIN =
  '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="#4caf50" stroke="#2e7d32" stroke-width="1.2" d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3.2" fill="#fff"/></svg>';
export const POI_PIN_SVG_DEST =
  '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="#2b6fed" stroke="#1d4ed8" stroke-width="1.2" d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3.2" fill="#fff"/></svg>';

const NAVME_LOGO_SRCS = ['/assets/NavMe_wb.png', './NavMe_wb.png', '/assets/navmelogo.png'];

export function injectMini3dGtaUiStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('mini3dgta-ui-styles')) return;
  const style = document.createElement('style');
  style.id = 'mini3dgta-ui-styles';
  style.textContent = `
.mini3dgta-map-toggle{
  position:fixed;top:max(12px,env(safe-area-inset-top,0px));left:max(12px,env(safe-area-inset-left,0px));
  z-index:2147483001;width:48px;height:48px;padding:0;border:1px solid var(--border-base,#e6ebf2);border-radius:50%;
  background:var(--bg-surface,#fff);cursor:pointer;pointer-events:auto;
  display:flex;align-items:center;justify-content:center;overflow:hidden;
  transition:transform .15s ease,opacity .15s ease}
.mini3dgta-map-toggle img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
.mini3dgta-map-toggle:hover{transform:translateY(-1px)}
.mini3dgta-map-toggle--hidden{display:none!important}
.mini3dgta-fs-overlay{
  position:fixed;inset:0;z-index:2147483000;display:none;flex-direction:column;
  background:var(--bg-app-gradient,#f4f8ff);pointer-events:auto;
  font-family:var(--font-body,Inter,system-ui,sans-serif);color:var(--text-1,#0b1a2e)}
.mini3dgta-fs-toolbar{
  display:grid;
  grid-template-columns:1fr 1fr minmax(88px,auto) auto;
  grid-template-rows:auto auto;
  gap:10px 12px;
  align-items:end;
  padding:max(12px,env(safe-area-inset-top,0px)) 14px 12px;
  background:var(--bg-surface,#fff);border-bottom:1px solid var(--border-base,#e6ebf2);flex-shrink:0}
.mini3dgta-fs-toolbar--with-map{
  grid-template-columns:minmax(100px,1fr) 1fr 1fr minmax(88px,auto) auto;
  grid-template-rows:auto auto}
.mini3dgta-fs-field--origin{grid-column:1;grid-row:2}
.mini3dgta-fs-field--dest{grid-column:2;grid-row:2}
.mini3dgta-fs-field--slice{grid-column:3;grid-row:2}
.mini3dgta-fs-back{
  grid-column:1 / -1;grid-row:1;align-self:center;
  justify-self:start;padding:8px 14px;border:1px solid var(--border-base,#e6ebf2);border-radius:var(--radius-pill,6px);
  background:var(--glass-control-bg,#fff);color:var(--text-1,#0b1a2e);font-size:13px;font-weight:600;cursor:pointer;line-height:1;white-space:nowrap}
.mini3dgta-fs-back:hover{background:var(--glass-control-bg-hover,#f4f8ff);border-color:var(--border-bright,#b8c5d6)}
.mini3dgta-fs-close{grid-column:4;grid-row:2;align-self:end}

.mini3dgta-fs-field--project{grid-column:1;grid-row:2}
.mini3dgta-fs-field--map{grid-column:2/span 2;grid-row:2}
.mini3dgta-fs-refresh{
  grid-column:4;grid-row:2;align-self:end;
  padding:10px 14px;border:none;border-radius:var(--radius-pill,6px);cursor:pointer;
  background:var(--accent,#2b6fed);color:var(--text-inverse,#fff);font-size:13px;font-weight:600;line-height:1;white-space:nowrap}
.mini3dgta-fs-refresh:hover{background:var(--accent-hover,#1d4ed8)}
.mini3dgta-fs-refresh:disabled{opacity:.55;cursor:not-allowed}
.mini3dgta-fs-input{
  width:100%;box-sizing:border-box;padding:10px 11px;border-radius:var(--radius,6px);
  border:1px solid var(--glass-control-border,#e6ebf2);background-color:var(--glass-control-bg,#fff);
  color:var(--text-1,#0b1a2e);font-size:14px;font-weight:500}
.mini3dgta-fs-input:focus{outline:none;border-color:var(--accent,#2b6fed);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent,#2b6fed) 22%,transparent)}
.mini3dgta-fs-input--map{text-transform:uppercase;letter-spacing:.04em}
.mini3dgta-fs-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.mini3dgta-fs-field__label{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:700;
  letter-spacing:.08em;text-transform:uppercase;color:var(--text-3,#8a97a8)}
.mini3dgta-fs-field__label svg{width:13px;height:13px;flex-shrink:0}
.mini3dgta-fs-field__label--origin svg{fill:#4caf50;stroke:#2e7d32;stroke-width:.8}
.mini3dgta-fs-field__label--dest svg{fill:var(--accent,#2b6fed);stroke:var(--accent-hover,#1d4ed8);stroke-width:.8}
.mini3dgta-fs-select{
  width:100%;box-sizing:border-box;padding:10px 34px 10px 11px;border-radius:var(--radius,6px);
  border:1px solid var(--glass-control-border,#e6ebf2);background-color:var(--glass-control-bg,#fff);
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238a97a8' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 11px center;
  color:var(--text-1,#0b1a2e);font-size:14px;font-weight:500;cursor:pointer;appearance:none;-webkit-appearance:none}
.mini3dgta-fs-select:focus{outline:none}
.mini3dgta-fs-select--origin:focus{border-color:#4caf50;box-shadow:0 0 0 2px rgba(76,175,80,.22)}
.mini3dgta-fs-select--dest:focus{border-color:var(--accent,#2b6fed);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent,#2b6fed) 22%,transparent)}
.mini3dgta-fs-select--project:focus{border-color:var(--accent,#2b6fed);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent,#2b6fed) 22%,transparent)}
.mini3dgta-fs-close{
  align-self:end;padding:10px 14px;min-width:44px;border:1px solid var(--border-base,#e6ebf2);border-radius:var(--radius,6px);
  background:var(--glass-control-bg,#fff);color:var(--text-2,#5c6b80);font-size:17px;font-weight:600;cursor:pointer;line-height:1}
.mini3dgta-fs-close:hover{background:var(--glass-control-bg-hover,#f4f8ff);color:var(--text-1,#0b1a2e)}
.mini3dgta-fs-tools{
  display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 14px;
  background:var(--bg-surface,#fff);border-bottom:1px solid var(--border-base,#e6ebf2);flex-shrink:0}
.mini3dgta-fs-analyze,.mini3dgta-fs-tool,.mini3dgta-fs-save{
  padding:8px 14px;border:1px solid var(--border-base,#e6ebf2);border-radius:var(--radius,6px);cursor:pointer;
  font-size:12px;font-weight:600;line-height:1;white-space:nowrap;color:var(--text-2,#5c6b80);
  background:var(--glass-control-bg,#fff)}
.mini3dgta-fs-analyze:hover,.mini3dgta-fs-tool:hover:not(:disabled){background:var(--glass-control-bg-hover,#f4f8ff);color:var(--text-1,#0b1a2e)}
.mini3dgta-fs-analyze:disabled,.mini3dgta-fs-tool:disabled{opacity:.45;cursor:not-allowed;color:var(--text-3,#8a97a8)}
.mini3dgta-fs-tool--active{background:var(--accent,#2b6fed);border-color:var(--accent,#2b6fed);color:var(--text-inverse,#fff)}
.mini3dgta-fs-tool--active:hover{background:var(--accent-hover,#1d4ed8);border-color:var(--accent-hover,#1d4ed8)}
.mini3dgta-fs-tool--danger{background:#fef2f2;color:#dc2626;border-color:#fecaca}
.mini3dgta-fs-tool--danger:hover:not(:disabled){background:#fee2e2}
.mini3dgta-fs-tool--danger:disabled{opacity:.45;cursor:not-allowed;color:var(--text-3,#8a97a8);background:var(--glass-control-bg,#fff)}
.mini3dgta-fs-save{background:var(--accent,#2b6fed);border-color:var(--accent,#2b6fed);color:var(--text-inverse,#fff)}
.mini3dgta-fs-save:hover:not(:disabled){background:var(--accent-hover,#1d4ed8);border-color:var(--accent-hover,#1d4ed8)}
.mini3dgta-fs-save:disabled{opacity:.45;cursor:not-allowed;background:var(--glass-control-bg,#fff);color:var(--text-3,#8a97a8);border-color:var(--border-base,#e6ebf2)}
.mini3dgta-fs-shapes{
  display:inline-flex;gap:4px;align-items:center;padding:2px 4px;
  border-radius:var(--radius,6px);background:var(--glass-stat-bg,#fafcff);border:1px solid var(--border-base,#e6ebf2)}
.mini3dgta-fs-viewmodes{margin-left:4px}
.mini3dgta-fs-shape{
  padding:6px 10px;border:none;border-radius:var(--radius-sm,4px);cursor:pointer;
  font-size:11px;font-weight:600;color:var(--text-2,#5c6b80);background:transparent}
.mini3dgta-fs-shape:hover{background:var(--glass-control-bg-hover,#f4f8ff);color:var(--text-1,#0b1a2e)}
.mini3dgta-fs-shape--active{background:var(--accent,#2b6fed);color:var(--text-inverse,#fff)}
.mini3dgta-fs-shape--active:hover{background:var(--accent-hover,#1d4ed8)}
.floor2d-materials{
  position:absolute;left:12px;top:12px;z-index:14;width:236px;max-height:calc(100% - 24px);
  display:none;flex-direction:column;background:var(--bg-surface,#fff);border:1px solid var(--border-base,#e6ebf2);border-radius:var(--float-radius,8px);
  overflow:hidden;pointer-events:auto}
.floor2d-materials--visible{display:flex}
.floor2d-materials__head{
  display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:10px 12px;border-bottom:1px solid var(--border-base,#e6ebf2);font-size:12px;font-weight:700;
  color:var(--text-2,#5c6b80);letter-spacing:.04em;text-transform:uppercase}
.floor2d-materials__freehand{
  padding:5px 9px;border:1px solid var(--border-base,#e6ebf2);border-radius:var(--radius-sm,4px);cursor:pointer;
  background:var(--glass-control-bg,#fff);color:var(--text-2,#5c6b80);font-size:11px;font-weight:600;text-transform:none;letter-spacing:0}
.floor2d-materials__freehand:hover{background:var(--glass-control-bg-hover,#f4f8ff)}
.floor2d-materials__count{
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:8px 12px;border-bottom:1px solid var(--border-base,#e6ebf2);background:var(--glass-stat-bg,#fafcff)}
.floor2d-materials__count[hidden]{display:none}
.floor2d-materials__count-label{
  font-size:11px;font-weight:600;color:var(--text-2,#5c6b80);text-transform:none;letter-spacing:0}
.floor2d-materials__count-input{
  width:64px;padding:5px 8px;border:1px solid var(--glass-control-border,#e6ebf2);border-radius:var(--radius-sm,4px);
  font-size:12px;font-weight:600;color:var(--text-1,#0b1a2e);text-align:center;background:var(--glass-control-bg,#fff)}
.floor2d-materials__count-input:focus{outline:none;border-color:var(--accent,#2b6fed);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent,#2b6fed) 18%,transparent)}
.floor2d-materials__body{overflow-y:auto;padding:4px 10px 12px}
.floor2d-materials__cat{
  font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
  color:var(--text-3,#8a97a8);margin:12px 2px 6px}
.floor2d-materials__grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.floor2d-mat{
  display:flex;flex-direction:column;align-items:center;gap:3px;padding:7px 4px;
  border:1px solid var(--border-base,#e6ebf2);border-radius:var(--radius,6px);background:var(--glass-stat-bg,#fafcff);cursor:pointer}
.floor2d-mat:hover{background:var(--glass-control-bg-hover,#f4f8ff);border-color:var(--border-bright,#b8c5d6)}
.floor2d-mat--active{background:var(--accent-soft,#eef4ff);border-color:var(--accent,#2b6fed)}
.floor2d-mat__preview{display:block;width:36px;height:36px;border-radius:var(--radius-sm,4px);border:1px solid var(--border-base,#e6ebf2)}
.floor2d-mat__name{
  font-size:9px;font-weight:600;color:var(--text-2,#5c6b80);text-align:center;line-height:1.1;
  overflow:hidden;text-overflow:ellipsis;max-width:100%;white-space:nowrap}
.floor2d-layout{display:flex;flex:1;min-height:0;min-width:0;width:100%}
.floor2d-zone-sidebar{
  width:220px;flex-shrink:0;display:flex;flex-direction:column;
  background:var(--bg-surface,#fff);border-right:1px solid var(--border-base,#e6ebf2);overflow:hidden}
.floor2d-zone-sidebar__header{
  padding:12px 14px 6px;font-size:12px;font-weight:700;letter-spacing:.04em;
  text-transform:uppercase;color:var(--text-2,#5c6b80)}
.floor2d-zone-sidebar__header--zones{
  padding-top:14px;border-top:1px solid var(--border-base,#e6ebf2);margin-top:4px}
.floor2d-floor-list{margin-bottom:4px}
.floor2d-zone-item--floor-active{background:var(--accent-soft,#eef4ff);border-color:color-mix(in srgb,var(--accent,#2b6fed) 35%,transparent)}
.floor2d-zone-item--floor-parent{background:var(--glass-stat-bg,#fafcff);border-color:var(--border-base,#e6ebf2)}
.floor2d-zone-item--subfloor{padding-left:22px;background:var(--bg-surface,#fff)}
.floor2d-zone-item--subfloor.floor2d-zone-item--floor-active{background:var(--accent-soft,#eef4ff);border-color:var(--accent,#2b6fed)}
.floor2d-zone-sidebar__hint{
  padding:0 14px 10px;font-size:11px;line-height:1.35;color:var(--text-3,#8a97a8)}
.floor2d-zone-colors{
  margin:0 10px 10px;padding:10px;border:1px solid var(--border-base,#e6ebf2);border-radius:var(--radius,6px);background:var(--glass-stat-bg,#fafcff)}
.floor2d-zone-colors[hidden]{display:none}
.floor2d-zone-colors__label{
  font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
  color:var(--text-3,#8a97a8);margin-bottom:8px}
.floor2d-zone-colors__grid{
  display:grid;grid-template-columns:repeat(6,1fr);gap:5px;margin-bottom:8px}
.floor2d-zone-colors__swatch{
  width:100%;aspect-ratio:1;border:2px solid var(--bg-surface,#fff);border-radius:var(--radius-sm,4px);cursor:pointer;
  box-shadow:0 0 0 1px var(--border-base,#e6ebf2);padding:0}
.floor2d-zone-colors__swatch:hover{transform:scale(1.08)}
.floor2d-zone-colors__swatch--active{
  box-shadow:0 0 0 2px var(--accent,#2b6fed),0 0 0 3px var(--bg-surface,#fff);transform:scale(1.05)}
.floor2d-zone-colors__custom{
  display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:4px;
  border-top:1px solid var(--border-base,#e6ebf2)}
.floor2d-zone-colors__custom-label{font-size:11px;font-weight:600;color:var(--text-2,#5c6b80)}
.floor2d-zone-colors__picker{
  width:36px;height:28px;padding:0;border:1px solid var(--border-base,#e6ebf2);border-radius:var(--radius-sm,4px);
  cursor:pointer;background:var(--bg-surface,#fff)}
.floor2d-zone-list{flex:1;overflow-y:auto;padding:6px 8px 12px}
.floor2d-zone-list__empty{padding:10px 8px;font-size:12px;color:var(--text-3,#8a97a8);line-height:1.4}
.floor2d-zone-item{
  display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;margin-bottom:4px;
  border:1px solid transparent;border-radius:var(--radius,6px);background:var(--glass-stat-bg,#fafcff);cursor:pointer;text-align:left}
.floor2d-zone-item:hover{background:var(--glass-control-bg-hover,#f4f8ff);border-color:var(--border-base,#e6ebf2)}
.floor2d-zone-item--active{background:var(--accent-soft,#eef4ff);border-color:var(--accent,#2b6fed)}
.floor2d-zone-item__dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.floor2d-zone-item__name{
  font-size:12px;font-weight:600;color:var(--text-1,#0b1a2e);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mini3dgta-fs-map{position:relative;flex:1;min-height:0;min-width:0;overflow:hidden;background:var(--bg-mesh,#f4f8ff)}
.floor2d-paint-tools{
  position:absolute;right:max(12px,env(safe-area-inset-right,0px));top:50%;
  transform:translateY(-50%);z-index:12;display:none;flex-direction:column;gap:6px;
  padding:8px 6px;border-radius:var(--float-radius,8px);background:var(--bg-surface,#fff);
  border:1px solid var(--border-base,#e6ebf2);pointer-events:auto}
.floor2d-paint-tools--visible{display:flex}
.floor2d-paint-tools__label{
  font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
  color:var(--text-3,#8a97a8);text-align:center;padding:0 4px 2px}
.floor2d-paint-shape{
  width:42px;height:42px;padding:0;border:1px solid var(--border-base,#e6ebf2);border-radius:var(--radius,6px);
  cursor:pointer;background:var(--glass-control-bg,#fff);color:var(--text-1,#0b1a2e);display:flex;align-items:center;
  justify-content:center;transition:background .12s ease,border-color .12s ease,color .12s ease}
.floor2d-paint-shape:hover{background:var(--glass-control-bg-hover,#f4f8ff);border-color:var(--border-bright,#b8c5d6)}
.floor2d-paint-shape--active{background:var(--accent,#2b6fed);color:var(--text-inverse,#fff);border-color:var(--accent,#2b6fed)}
.floor2d-paint-shape--active:hover{background:var(--accent-hover,#1d4ed8);border-color:var(--accent-hover,#1d4ed8)}
.floor2d-paint-shape svg{width:22px;height:22px;pointer-events:none}
.floor2d-zone-dialog{
  position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;
  background:var(--glass-backdrop,rgba(11,26,46,.35));pointer-events:auto}
.floor2d-zone-dialog__panel{
  width:min(320px,calc(100% - 32px));padding:16px;border-radius:var(--float-radius,8px);background:var(--bg-surface,#fff);
  border:1px solid var(--border-base,#e6ebf2)}
.floor2d-zone-dialog__title{font-size:14px;font-weight:700;color:var(--text-1,#0b1a2e);margin-bottom:10px}
.floor2d-zone-dialog__input{
  width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--glass-control-border,#e6ebf2);border-radius:var(--radius,6px);
  font-size:14px;color:var(--text-1,#0b1a2e);outline:none;margin-bottom:12px;background:var(--glass-control-bg,#fff)}
.floor2d-zone-dialog__input:focus{border-color:var(--accent,#2b6fed);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent,#2b6fed) 22%,transparent)}
.floor2d-zone-dialog__actions{display:flex;gap:8px;justify-content:flex-end}
.floor2d-zone-dialog__btn{
  padding:8px 14px;border:1px solid var(--border-base,#e6ebf2);border-radius:var(--radius,6px);cursor:pointer;font-size:12px;font-weight:600}
.floor2d-zone-dialog__btn--cancel{background:var(--glass-control-bg,#fff);color:var(--text-2,#5c6b80)}
.floor2d-zone-dialog__btn--cancel:hover{background:var(--glass-control-bg-hover,#f4f8ff)}
.floor2d-zone-dialog__btn--ok{background:var(--accent,#2b6fed);border-color:var(--accent,#2b6fed);color:var(--text-inverse,#fff)}
.floor2d-zone-dialog__btn--ok:hover{background:var(--accent-hover,#1d4ed8);border-color:var(--accent-hover,#1d4ed8)}
.mini3dgta-map-overlay{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:4}
.mini3dgta-poi-label{
  position:absolute;transform:translate(4px,-50%);max-width:120px;text-align:left;
  font:600 11px/1.15 var(--font-body,system-ui,sans-serif);color:var(--accent,#2b6fed);letter-spacing:.01em;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
.mini3dgta-route-pin{
  position:absolute;transform:translate(-50%,-100%);pointer-events:none;
  filter:drop-shadow(0 1px 2px rgba(11,26,46,.18))}
.mini3dgta-route-pin svg{width:34px;height:34px;display:block}
.mini3dgta-route-pin--hidden{display:none}
@media (max-width:520px){
  .mini3dgta-fs-toolbar{grid-template-columns:1fr auto}
  .mini3dgta-fs-field--dest{grid-column:1}
  .mini3dgta-fs-field--slice{display:none!important}
  .mini3dgta-fs-back{grid-column:1;grid-row:2}
  .mini3dgta-fs-close{grid-column:2;grid-row:1;align-self:center}
}
`;
  document.head.appendChild(style);
}

export function applyNavMeLogoToToggleButton(btn: HTMLButtonElement): void {
  btn.textContent = '';
  btn.setAttribute('aria-label', 'Open navigation map');
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  let srcIdx = 0;
  img.onerror = () => {
    srcIdx += 1;
    if (srcIdx < NAVME_LOGO_SRCS.length) {
      img.src = NAVME_LOGO_SRCS[srcIdx];
      return;
    }
    img.remove();
    btn.innerHTML =
      '<svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="#2b6fed"/><path fill="#fff" d="M10 22V10h3.2l4.8 7.4L22.8 10H26v12h-2.8v-7.1L17.6 22h-2.1l-5.6-7.1V22H10z"/></svg>';
  };
  img.src = NAVME_LOGO_SRCS[0];
  btn.appendChild(img);
}

export function createMini3dGtaMapButton(onOpen: () => void): HTMLButtonElement {
  injectMini3dGtaUiStyles();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mini3dgta-map-toggle';
  applyNavMeLogoToToggleButton(btn);
  btn.addEventListener('click', onOpen);
  document.body.appendChild(btn);
  return btn;
}
