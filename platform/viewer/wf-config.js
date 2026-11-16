/* Viewer deployment config. Overwritten by `wayfinding export-static` for static hosting.
   apiBase : base URL of the public API (or of a static export with the same layout)
   venue   : venue slug whose buildings are shown ("all" = every published building)
   dataBase: optional – load ONE building straight from a folder (legacy prototype layout), bypassing the API */
/* Optional: vpsUrl: "https://host:8770" or full ".../localize" — else uses /api/v1/public/vps/localize when vps_enabled, or same-origin /localize */
window.WF_CONFIG = window.WF_CONFIG || { apiBase: "/api/v1/public/", venue: "all" };
