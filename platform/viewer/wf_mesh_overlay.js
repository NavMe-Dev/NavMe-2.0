/* wf_mesh_overlay.js – stub. Overlay is now handled by ArcGIS native rendering:
 *   2D: GraphicsLayer polygon from corners_lonlat (same coords as POIs/navigation)
 *   3D: mesh-3d symbol with material color [0,0,0,30] on the existing meshLayer
 * No Three.js camera sync, no separate canvas. */
(function () {
  "use strict";
  window.WFMeshOverlay = {
    init: function () {},
    setView3D: function () {},
    setMode: function () {},
    show: function () {},
    hide: function () {}
  };
})();
