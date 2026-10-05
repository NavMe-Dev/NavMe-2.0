# Third-party notices

Project code: MIT (see `../LICENSE`). Components and services used:

## Libraries (bundled or installed)
| Component | Licence | Where |
|---|---|---|
| FastAPI, Starlette, Pydantic, pydantic-settings | MIT | api |
| Uvicorn | BSD-3 | api |
| SQLAlchemy, Alembic, Mako | MIT | api |
| GeoAlchemy2 | MIT | api |
| psycopg 3 | LGPL-3.0 (dynamic use) | api |
| PyJWT | MIT | api |
| bcrypt | Apache-2.0 | api |
| httpx | BSD-3 | api |
| python-multipart | Apache-2.0 | api |
| NumPy | BSD-3 | pipeline |
| OpenCV (opencv-python-headless) | Apache-2.0 | pipeline |
| Shapely (GEOS: LGPL-2.1) | BSD-3 | pipeline, api |
| NetworkX | BSD-3 | pipeline, api |
| trimesh | MIT | pipeline |
| fast-simplification | MIT | pipeline |
| Pillow | MIT-CMU (HPND) | pipeline |
| requests | Apache-2.0 | pipeline |
| pye57 (optional, E57 ingest) | MIT | pipeline |
| Open3D (optional, E57 ingest) | MIT | pipeline |
| Vue 3 | MIT | admin/vendor |
| MapLibre GL JS | BSD-3 | admin/vendor |
| ArcGIS Maps SDK for JavaScript | Esri proprietary (free developer use; production terms apply) | viewer (loaded from js.arcgis.com) |
| Fuse.js | Apache-2.0 | viewer/vendor |
| ngraph.graph, ngraph.path | BSD-3 | viewer/vendor |
| Turf.js | MIT | viewer/vendor |
| Material Symbols, Roboto | Apache-2.0 / OFL | viewer (Google Fonts) |
| PostgreSQL | PostgreSQL licence | db |
| PostGIS | GPL-2.0 (separate server process) | db |
| Caddy | Apache-2.0 | proxy |
| Playwright (dev tool only) | Apache-2.0 | tools |

## Data & services
| Source | Terms / attribution |
|---|---|
| Matterport scans, MatterPak, GraphQL model data, skybox imagery | property of the scan owner / Matterport terms of use. The public GraphQL endpoint (`https://my.matterport.com/api/mp/models/graph`) is undocumented; use only for models you own or are authorised to use |
| Esri World Imagery (georeferencing, admin satellite view) | "Esri, Maxar, Earthstar Geographics, and the GIS User Community"; Esri terms of use |
| Esri World Geocoder | Esri terms (stored results may require an ArcGIS account for production) |
| OpenStreetMap data (footways, buildings, admin light basemap tiles), Overpass API, Nominatim | © OpenStreetMap contributors, ODbL 1.0; follow the tile / Overpass / Nominatim usage policies |
| Esri / OpenFreeMap / OpenMapTiles basemaps in the viewer | attribution shown on the map |
