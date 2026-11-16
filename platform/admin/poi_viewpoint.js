/* Independent directions look-at targets. The POI routing anchor never moves. */
(function (root) {
  "use strict";

  function point(value) {
    if (!value || typeof value !== "object") return null;
    const result = {};
    for (const axis of ["x", "y", "z"]) {
      const raw = value[axis];
      if (raw == null || typeof raw === "boolean" || String(raw).trim() === "") return null;
      const number = Number(raw);
      if (!Number.isFinite(number) || Math.abs(number) > 100000) return null;
      result[axis] = number;
    }
    return result;
  }

  function equalPoint(a, b) {
    const first = point(a), second = point(b);
    return first && second ? ["x", "y", "z"].every(axis => first[axis] === second[axis]) : first === second;
  }

  function nearestSweep(rows, position) {
    if (!point(position)) return null;
    let found = null, distance = Infinity;
    for (const [key, row] of Object.entries(rows || {})) {
      const location = point(row && row.position);
      if (!location || row.enabled === false) continue;
      const length = Math.hypot(location.x - position.x, location.y - position.y, location.z - position.z);
      if (length < distance) { found = { id: row.sid || row.id || key, position: location }; distance = length; }
    }
    return found;
  }

  function facingRotation(from, target) {
    const a = point(from), b = point(target);
    if (!a || !b) return null;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal < 0.0001 && Math.abs(dy) < 0.0001) return null;
    return {x: Math.max(-58, Math.min(28, Math.atan2(dy, horizontal) * 180 / Math.PI)),
      y: Math.atan2(-dx, -dz) * 180 / Math.PI};
  }

  // SDK Sweep.data is an observable collection, not a snapshot dictionary.
  // Cache its updates immediately after connecting. Model.getData() also works
  // when this SDK/model emitted its initial collection before PLAYING.
  function createSweepReader(sdk, earlySnapshot) {
    let rows = {}, closed = false, subscription = null, pending = null;
    function add(key, row) {
      if (closed || !row) return;
      const id = row.sid || row.id || row.uuid || key;
      if (row.enabled === false) { delete rows[String(id)]; return; }
      const position = point(row.position || (row.pose && row.pose.position) || row.location);
      if (id != null && position) rows[String(id)] = {sid: String(id), position,
        floor_id: row.floorInfo && row.floorInfo.id || null};
    }
    function replace(collection) {
      if (closed || !collection) return;
      rows = {};
      if (typeof collection.forEach === "function") collection.forEach((row, key) => add(key, row));
      else Object.entries(collection).forEach(([key, row]) => add(key, row));
    }
    function remove(key, row) {
      const id = row && (row.sid || row.id || row.uuid) || key;
      delete rows[String(id)];
    }
    const observable = sdk && sdk.Sweep && sdk.Sweep.data;
    if (typeof earlySnapshot === "function") {
      replace(earlySnapshot());
    } else if (observable && typeof observable.subscribe === "function") {
      try {
        subscription = observable.subscribe({onCollectionUpdated: replace, onAdded: add,
          onUpdated: add, onRemoved: remove, onChanged: function () {}});
      } catch (_) { /* Model.getData remains available below. */ }
    } else if (observable) replace(observable);
    return {
      async read() {
        if (!closed && typeof earlySnapshot === "function") replace(earlySnapshot());
        if (closed || Object.keys(rows).length) return rows;
        if (!pending) pending = (async () => {
          try {
            if (sdk.Model && typeof sdk.Model.getData === "function") {
              const data = await sdk.Model.getData();
              if (data && data.sweeps) replace(data.sweeps);
            }
          } catch (_) { /* Try the legacy API or the subscribed snapshot. */ }
          if (!Object.keys(rows).length) {
            try {
              if (sdk.Sweep && typeof sdk.Sweep.getData === "function") replace(await sdk.Sweep.getData());
            } catch (_) { /* The caller shows a useful preview error. */ }
          }
          return rows;
        })().finally(() => { pending = null; });
        return pending;
      },
      close() {
        closed = true; rows = {};
        try {
          if (typeof subscription === "function") subscription();
          else if (subscription && subscription.cancel) subscription.cancel();
          else if (subscription && subscription.unsubscribe) subscription.unsubscribe();
        } catch (_) { /* already disconnected */ }
        subscription = null;
      }
    };
  }

  function createComponent(deps) {
    const { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } = root.Vue;
    const { api, fetchShowcaseUrl } = deps;
    return {
      props: ["b"],
      template: `<section class="poi-viewpoints" aria-labelledby="viewpoint-title">
        <div class="card"><div class="row"><h2 id="viewpoint-title" class="grow">POI viewpoints</h2><button @click="load" :disabled="loading || saving || twinBusy">Reload POIs</button></div>
          <p class="muted">Aim directions at the selected point. The route destination stays the same.</p>
          <p class="err" role="alert" v-if="error && !selected">{{error}}</p>
          <p role="status" v-if="loading">Loading POIs…</p>
          <p class="muted" v-else-if="!enabled">Viewpoint editing is unavailable for this building.</p>
          <p class="muted" v-else-if="!writable">Viewpoints are available to preview. Saving is currently unavailable.</p>
        </div>
        <div class="viewpoint-layout" v-if="enabled && !loading">
          <div class="card viewpoint-list"><label for="viewpoint-filter">Find a POI</label><input id="viewpoint-filter" v-model="query" placeholder="Search all POIs" :disabled="saving">
            <p class="small muted">{{filtered.length}} of {{rows.length}} POIs</p>
            <ul><li v-for="poi in filtered" :key="poi.id"><button type="button" :class="{on: selectedId===poi.id}" :aria-pressed="selectedId===poi.id" @click="select(poi)" :disabled="saving || twinBusy">
              <span>{{poi.name}}</span><span class="small muted">{{poi.override ? 'Custom viewpoint' : 'Studio default'}}</span></button></li></ul>
            <p class="muted" v-if="!filtered.length">No matching POIs.</p>
          </div>
          <div v-if="selected" class="viewpoint-detail">
            <div class="card"><h2>{{selected.name}}</h2><p class="small muted">{{selected.override ? 'Custom viewpoint saved for NavMe directions.' : 'Using the viewpoint from Spatial Studio.'}}</p>
              <div class="row"><button @click="openTwin" :disabled="twinBusy || saving">{{twinBusy ? 'Connecting…' : (connected ? 'Reconnect digital twin' : 'Open digital twin')}}</button>
                <button @click="closeTwin" v-if="showcase" :disabled="saving">Close twin</button></div>
              <p class="twin-status" role="status" v-if="twinStatus">{{twinStatus}}</p>
              <div class="viewpoint-twin-wrap" v-show="showcase">
                <iframe ref="twinFrame" :src="showcase || 'about:blank'" class="showcase viewpoint-twin" title="POI viewpoint digital twin" allow="xr-spatial-tracking; fullscreen" allowfullscreen></iframe>
                <span class="viewpoint-crosshair" v-if="connected" aria-hidden="true"></span>
              </div>
              <p class="small muted" v-if="connected">Centre the door or sign under the crosshair, then choose Use current view. This captures and previews the point directions will face.</p>
              <button @click="captureCurrentView" :disabled="!connected || saving || twinBusy">Use current view</button>
              <fieldset :disabled="saving || twinBusy"><legend>Look-at point (Matterport coordinates, metres)</legend><div class="viewpoint-coordinates">
                <label>X<input type="number" step="any" v-model="draft.x" aria-label="Viewpoint X"></label>
                <label>Y (height)<input type="number" step="any" v-model="draft.y" aria-label="Viewpoint Y height"></label>
                <label>Z<input type="number" step="any" v-model="draft.z" aria-label="Viewpoint Z"></label>
              </div></fieldset>
              <p class="small muted" v-if="dirty && !validTarget">Enter all three coordinates as finite numbers.</p>
              <div class="row viewpoint-actions"><button @click="preview" :disabled="!validTarget || twinBusy || saving">Preview from POI</button>
                <button class="primary" @click="save" :disabled="!writable || !validTarget || !dirty || saving || twinBusy">{{saving ? 'Saving…' : 'Save viewpoint'}}</button>
                <button @click="reset" :disabled="!writable || !selected.override || saving || twinBusy">Reset to Studio default</button>
                <button @click="discard" :disabled="!dirty || saving || twinBusy">Discard edits</button></div>
              <div ref="feedback" class="viewpoint-feedback" aria-live="polite" aria-atomic="true">
                <p class="err" role="alert" v-if="error">{{error}}</p>
                <p class="ok" role="status" v-else-if="message">{{message}}</p>
              </div>
            </div>
          </div>
          <div class="card muted" v-else>Select a POI to adjust the point that directions face.</div>
        </div>
      </section>`,
      setup(props) {
        const rows = ref([]), selectedId = ref(null), query = ref("");
        const enabled = ref(false), writable = ref(false), loading = ref(false), saving = ref(false);
        const error = ref(""), message = ref("");
        const feedback = ref(null);
        const draft = reactive({ x: "", y: "", z: "" });
        const twinFrame = ref(null), showcase = ref(""), twinBusy = ref(false), twinStatus = ref(""), connected = ref(false);
        const selected = computed(() => rows.value.find(poi => poi.id === selectedId.value) || null);
        const filtered = computed(() => rows.value.filter(poi => String(poi.name || "").toLowerCase().includes(query.value.trim().toLowerCase())));
        const validTarget = computed(() => point(draft));
        const dirty = computed(() => !!selected.value && !equalPoint(draft, selected.value.target));
        let session = null, sweepReader = null, disposed = false, epoch = 0;

        async function revealFeedback(run) {
          await nextTick();
          if (!disposed && run === epoch && feedback.value && typeof feedback.value.scrollIntoView === "function") {
            feedback.value.scrollIntoView({ block: "nearest", behavior: "smooth" });
          }
        }

        function disconnect() {
          const old = session; session = null; connected.value = false;
          if (sweepReader) sweepReader.close();
          sweepReader = null;
          try { if (old && old.disconnect) old.disconnect(); } catch (_) { /* already closed */ }
        }
        function closeTwin() {
          epoch++; disconnect(); showcase.value = ""; twinStatus.value = ""; twinBusy.value = false;
        }
        function discard() {
          const target = point(selected.value && selected.value.target);
          for (const axis of ["x", "y", "z"]) draft[axis] = target ? target[axis] : "";
          message.value = "";
        }
        function select(poi) {
          if (saving.value || twinBusy.value) return;
          selectedId.value = poi.id; error.value = ""; discard();
        }
        async function load() {
          if (saving.value) return;
          closeTwin();
          const run = epoch, slug = props.b.slug;
          loading.value = true; error.value = ""; message.value = "";
          try {
            const result = await api(`/admin/buildings/${slug}/poi-viewpoints`);
            if (disposed || run !== epoch || slug !== props.b.slug) return;
            enabled.value = !!result.enabled; writable.value = !!result.writable;
            rows.value = Array.isArray(result.pois) ? result.pois : [];
            if (!rows.value.some(poi => poi.id === selectedId.value)) selectedId.value = rows.value.length ? rows.value[0].id : null;
            discard();
          } catch (ex) {
            if (!disposed && run === epoch) { rows.value = []; selectedId.value = null; enabled.value = false; error.value = ex.message || "Could not load POI viewpoints."; }
          } finally { if (!disposed && run === epoch) loading.value = false; }
        }
        async function openTwin() {
          if (!selected.value || saving.value || twinBusy.value) return false;
          closeTwin();
          const run = epoch, slug = props.b.slug;
          twinBusy.value = true; twinStatus.value = "Opening digital twin…";
          try {
            if (!root.MpPlace) throw new Error("Digital twin tools could not load. Reload the page.");
            const url = await fetchShowcaseUrl(slug, { sdk: 1 });
            if (disposed || run !== epoch || slug !== props.b.slug) return false;
            const key = root.MpPlace.keyFromShowcaseUrl(url);
            if (!key) throw new Error("The digital twin is view-only. Enter the look-at coordinates below.");
            showcase.value = url;
            await nextTick();
            const frame = twinFrame.value;
            if (!frame) throw new Error("The digital twin could not open. Reload the page.");
            await root.MpPlace.waitIframeLoad(frame, 12000);
            if (disposed || run !== epoch || slug !== props.b.slug) return false;
            const result = await root.MpPlace.connect({ iframe: frame, applicationKey: key, onStatus: status => {
              if (!disposed && run === epoch) twinStatus.value = status;
            } });
            if (disposed || run !== epoch || slug !== props.b.slug) { if (result && result.disconnect) result.disconnect(); return false; }
            if (!result || !result.ok) throw new Error("Could not connect the digital twin. Enter coordinates below or reconnect.");
            session = result; sweepReader = createSweepReader(result.sdk, result.sweepData); connected.value = true;
            twinStatus.value = "Connected. Centre the door or sign under the crosshair, then choose Use current view.";
            return true;
          } catch (ex) {
            if (!disposed && run === epoch) { disconnect(); twinStatus.value = ex.message || "Could not open the digital twin."; }
            return false;
          } finally { if (!disposed && run === epoch) twinBusy.value = false; }
        }
        async function captureCurrentView() {
          if (!session || !selected.value || saving.value || twinBusy.value) return;
          const activeSession = session, run = epoch, id = selected.value.id;
          const current = () => !disposed && run === epoch && activeSession === session && selected.value && selected.value.id === id;
          twinBusy.value = true; error.value = ""; message.value = "";
          let captured = false;
          try {
            const renderer = activeSession.sdk && activeSession.sdk.Renderer;
            if (!renderer || typeof renderer.getWorldPositionData !== "function") {
              throw new Error("This digital twin cannot capture the current view. Reconnect the twin or enter the look-at coordinates below.");
            }
            const frame = twinFrame.value;
            const width = frame && frame.clientWidth, height = frame && frame.clientHeight;
            if (!(width > 0 && height > 0)) throw new Error("Open the digital twin before capturing the current view.");
            // Capture the centre of the view, not the last pointer hit: moving the
            // mouse out of the iframe toward this button otherwise selects the floor.
            const hit = await renderer.getWorldPositionData({ x: width / 2, y: height / 2 });
            if (!current()) return;
            const target = point(hit && hit.position);
            if (!target) throw new Error("No surface at the crosshair. Centre a door or sign, then try Use current view again.");
            Object.assign(draft, target); captured = true;
          } catch (ex) {
            if (current()) error.value = ex.message || "Could not capture the current view. Please try again.";
          } finally { if (current()) twinBusy.value = false; }
          if (captured && current() && await preview() && current()) {
            message.value = "Current view captured and previewed. Save viewpoint to apply it to directions.";
          }
        }
        async function preview() {
          const target = point(draft), poi = selected.value;
          if (!target || !poi || saving.value || twinBusy.value) return;
          if (!session && !(await openTwin())) return;
          const activeSession = session, run = epoch;
          twinBusy.value = true; error.value = "";
          try {
            const sdk = activeSession.sdk;
            const data = await sweepReader.read();
            const sweep = nearestSweep(data, poi.position);
            if (!sweep || !sdk.Sweep || typeof sdk.Sweep.moveTo !== "function") throw new Error("Could not find a nearby walkthrough position. Reconnect the twin and try again.");
            if (disposed || run !== epoch || activeSession !== session) return;
            const rotation = facingRotation(sweep.position, target);
            if (!rotation) throw new Error("Choose a look-at point away from the walkthrough position.");
            await sdk.Sweep.moveTo(sweep.id, { transition: (sdk.Sweep.Transition || {}).INSTANT, rotation });
            if (!disposed && run === epoch && activeSession === session) {
              twinStatus.value = "Previewing from the POI. Save viewpoint to apply it to directions.";
              return true;
            }
          } catch (ex) { if (!disposed && run === epoch) error.value = ex.message || "Could not preview this viewpoint."; }
          finally { if (!disposed && run === epoch) twinBusy.value = false; }
          return false;
        }
        async function persist(target) {
          const poi = selected.value;
          if (!poi || !writable.value || saving.value) return;
          const id = poi.id, slug = props.b.slug, run = epoch;
          saving.value = true; error.value = ""; message.value = "";
          try {
            const result = await api(`/admin/buildings/${slug}/pois/${id}/viewpoint`, {
              method: "PUT", json: { target, revision: poi.revision }
            });
            if (disposed || run !== epoch || slug !== props.b.slug) return;
            if (!result || result.id !== id || typeof result.revision !== "string" || !result.revision
                || result.override !== !!target || (target && !equalPoint(result.target, target))) {
              throw new Error("Could not verify the saved viewpoint. Reload POIs to check it before trying again.");
            }
            Object.assign(poi, result); discard();
            message.value = target ? "Viewpoint saved. Refresh the public viewer to use it in directions." : "Studio default restored. Refresh the public viewer to use it.";
          } catch (ex) {
            if (!disposed && run === epoch) error.value = ex.message || "Could not save the viewpoint. Your edits are still here.";
          } finally {
            if (!disposed && run === epoch) { saving.value = false; await revealFeedback(run); }
          }
        }
        function save() {
          const target = point(draft);
          if (!target) { error.value = "Enter all three coordinates as finite numbers before saving."; return; }
          return persist(target);
        }
        function reset() { return persist(null); }
        onMounted(load);
        watch(() => props.b.slug, load);
        watch(() => [draft.x, draft.y, draft.z], () => { message.value = ""; error.value = ""; }, { flush: "sync" });
        onBeforeUnmount(() => { disposed = true; closeTwin(); });
        return { rows, selectedId, query, enabled, writable, loading, saving, error, message, feedback, draft,
          selected, filtered, validTarget, dirty, twinFrame, showcase, twinBusy, twinStatus, connected,
          load, select, discard, openTwin, closeTwin, captureCurrentView, preview, save, reset };
      }
    };
  }

  // Camera viewpoints are separate from the legacy directions look-at target above.
  // A saved camera view restores an actual enabled panorama and its captured rotation.
  function cameraViewpoint(value, modelId) {
    if (!value || typeof value !== "object" || value.model_id !== modelId
        || !/^[A-Za-z0-9_-]{1,40}$/.test(value.model_id)
        || !/^[A-Za-z0-9_-]{1,128}$/.test(value.sweep_id)) return null;
    const position = value.camera_position, rotation = value.camera_rotation;
    const finite = (number, limit) => typeof number === "number" && Number.isFinite(number) && Math.abs(number) <= limit;
    if (!position || !["x", "y", "z"].every(axis => finite(position[axis], 100000))
        || !rotation || !finite(rotation.pitch, 90) || !finite(rotation.yaw, 180)
        || typeof value.captured_at !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(value.captured_at)
        || !Number.isFinite(Date.parse(value.captured_at))) return null;
    const floor = value.floor_id == null ? null : value.floor_id;
    if (floor != null && (typeof floor !== "string" || !floor.trim() || floor.length > 80)) return null;
    return {model_id: value.model_id, sweep_id: value.sweep_id,
      camera_position: {x: position.x, y: position.y, z: position.z},
      camera_rotation: {pitch: rotation.pitch, yaw: rotation.yaw},
      floor_id: floor, captured_at: new Date(value.captured_at).toISOString()};
  }

  function sameCameraViewpoint(first, second, modelId) {
    if (first == null || second == null) return first == null && second == null;
    const a = cameraViewpoint(first, modelId), b = cameraViewpoint(second, modelId);
    return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
  }

  function cancelSubscription(subscription) {
    try {
      if (typeof subscription === "function") subscription();
      else if (subscription && subscription.cancel) subscription.cancel();
      else if (subscription && subscription.unsubscribe) subscription.unsubscribe();
    } catch (_) { /* the SDK may already be disconnected */ }
  }

  async function readCameraPose(sdk) {
    const camera = sdk && sdk.Camera;
    if (camera && typeof camera.getPose === "function") return camera.getPose();
    if (!camera || !camera.pose || typeof camera.pose.subscribe !== "function") throw new Error("camera unavailable");
    return new Promise((resolve, reject) => {
      let subscription = null, finished = false;
      const timer = setTimeout(() => finish(null), 2500);
      function finish(pose) {
        if (finished) return;
        finished = true; clearTimeout(timer); cancelSubscription(subscription);
        if (pose) resolve(pose); else reject(new Error("camera unavailable"));
      }
      try {
        subscription = camera.pose.subscribe(finish);
        if (finished) cancelSubscription(subscription);
      } catch (_) { finish(null); }
    });
  }

  function createCameraComponent(deps) {
    const {ref, computed, watch, onMounted, onBeforeUnmount, nextTick} = root.Vue;
    const {api, fetchShowcaseUrl, viewerUrl} = deps;
    return {
      props: ["b"],
      template: `<section class="poi-viewpoints camera-viewpoints" aria-labelledby="camera-viewpoint-title">
        <div class="card"><div class="row"><h2 id="camera-viewpoint-title" class="grow">Location viewpoints</h2><button @click="load" :disabled="loading || saving || capturing || twinBusy">Reload locations</button></div>
          <p class="muted">Save where visitors stand and what they face when they select a location. Location markers and directions stay unchanged.</p>
          <p role="status" v-if="loading">Loading locations…</p>
          <p class="muted" v-else-if="!enabled">Add a Matterport model to this building to set location viewpoints.</p>
          <p class="muted" v-else-if="!writable">Saved views can be previewed. Saving viewpoints is not configured for this server.</p>
          <p class="err" role="alert" v-if="error && !selected">{{error}}</p>
        </div>
        <div class="viewpoint-layout" v-if="enabled && !loading">
          <div class="card viewpoint-list"><label for="camera-viewpoint-filter">Find a location</label><input id="camera-viewpoint-filter" v-model="query" placeholder="Search all locations" :disabled="saving">
            <p class="small muted">{{filtered.length}} of {{rows.length}} locations</p>
            <ul><li v-for="poi in filtered" :key="poi.id"><button type="button" :class="{on:selectedId===poi.id}" :aria-pressed="selectedId===poi.id" @click="select(poi)" :disabled="saving || capturing || twinBusy || setupMode">
              <span>{{poi.name}}</span><span class="small muted">{{poi.status==='incompatible' ? 'Review model compatibility' : (poi.viewpoint ? 'Saved viewpoint' : 'No saved viewpoint')}}</span></button></li></ul>
            <p class="muted" v-if="!filtered.length">No matching locations.</p>
          </div>
          <div class="viewpoint-detail" v-if="selected"><div class="card">
            <h2>{{selected.name}}</h2>
            <p class="muted" v-if="selected.status==='incompatible'">This location has a viewpoint from another model. Set a new viewpoint for the current model; its earlier view will be preserved.</p>
            <p class="muted" v-else-if="!selected.viewpoint">No saved view is available for this location. Visitors will use the existing navigation.</p>
            <p class="muted" v-else>Visitors will open this saved scan position and viewing direction.</p>
            <div class="row" v-if="!setupMode">
              <button class="primary" @click="beginSetup" :disabled="!writable || saving || twinBusy">{{selected.viewpoint ? 'Replace Viewpoint' : 'Set Viewpoint'}}</button>
              <button @click="previewSaved" :disabled="!selected.viewpoint || saving || twinBusy">View saved viewpoint</button>
              <a class="btn" v-if="visitorViewUrl" :href="visitorViewUrl" target="_blank" rel="noopener">Open visitor view ↗</a>
              <button @click="remove" :disabled="!writable || !selected.viewpoint || saving || twinBusy">Remove saved viewpoint</button>
            </div>
            <div class="viewpoint-capture-panel" v-if="setupMode" role="region" aria-label="Viewpoint setup">
              <div class="grow"><strong>Set Space Viewpoint — {{selected.name}}</strong><p>Walk to the desired location, face the room, then capture.</p></div>
              <div class="row"><button class="primary" @click="captureCurrentViewpoint" :disabled="!connected || saving || capturing || twinBusy">{{saving ? 'Saving…' : (capturing ? 'Capturing…' : 'Capture Current Viewpoint')}}</button>
                <button @click="retrySave" v-if="captured && error" :disabled="saving || capturing || twinBusy">Retry Save</button>
                <button @click="cancelSetup" :disabled="saving">Cancel Viewpoint Setup</button></div>
            </div>
            <div class="row viewpoint-twin-controls" v-if="setupMode || showcase"><button @click="openTwin" :disabled="saving || capturing || twinBusy">{{twinBusy ? 'Connecting…' : (connected ? 'Reconnect digital twin' : 'Open digital twin')}}</button>
              <button @click="closeTwin" v-if="showcase" :disabled="saving">Close twin</button></div>
            <p class="twin-status" role="status" v-if="twinStatus">{{twinStatus}}</p>
            <div class="viewpoint-twin-wrap" v-show="showcase"><iframe ref="twinFrame" :src="showcase || 'about:blank'" class="showcase viewpoint-twin" title="Location viewpoint digital twin" allow="xr-spatial-tracking"></iframe></div>
            <div ref="feedback" class="viewpoint-feedback" aria-live="polite" aria-atomic="true"><p class="err" role="alert" v-if="error">{{error}}</p><p class="ok" role="status" v-else-if="message">{{message}}</p></div>
          </div></div>
          <div class="card muted" v-else>Select a location to set its viewpoint.</div>
        </div>
      </section>`,
      setup(props) {
        const rows = ref([]), selectedId = ref(null), query = ref("");
        const enabled = ref(false), writable = ref(false), modelId = ref("");
        const loading = ref(false), saving = ref(false), capturing = ref(false), setupMode = ref(false), captured = ref(null);
        const error = ref(""), message = ref(""), twinStatus = ref("");
        const twinFrame = ref(null), showcase = ref(""), connected = ref(false), twinBusy = ref(false), feedback = ref(null);
        const selected = computed(() => rows.value.find(poi => poi.id === selectedId.value) || null);
        const filtered = computed(() => rows.value.filter(poi => String(poi.name || "").toLowerCase().includes(query.value.trim().toLowerCase())));
        const visitorViewUrl = computed(() => {
          const poi = selected.value;
          if (typeof viewerUrl !== "function" || !poi || poi.published === false || !props.b.published_version
              || !cameraViewpoint(poi.viewpoint, modelId.value)) return null;
          const publicId = poi.source_id || poi.key;
          if (publicId == null || String(publicId).trim() === "") return null;
          try {
            const url = new URL(viewerUrl(props.b, true), root.location && root.location.href || "http://localhost/");
            if (!/^https?:$/.test(url.protocol)) return null;
            url.searchParams.set("mp", "1"); url.searchParams.set("to", String(publicId));
            return url.href;
          } catch (_) { return null; }
        });
        let session = null, sweepReader = null, connectedModel = "", epoch = 0, operation = 0, disposed = false;
        const listingUrl = (slug = props.b.slug) => `/admin/buildings/${slug}/camera-viewpoints`;
        const current = (run, op, id, model, slug) => !disposed && slug === props.b.slug && run === epoch && op === operation && model === modelId.value && selected.value && selected.value.id === id;
        async function revealFeedback() { await nextTick(); if (!disposed && feedback.value && feedback.value.scrollIntoView) feedback.value.scrollIntoView({block:"nearest",behavior:"smooth"}); }
        function closeTwin() {
          epoch++; operation++; capturing.value = false; twinBusy.value = false; connected.value = false; connectedModel = "";
          const old = session; session = null;
          if (sweepReader) sweepReader.close(); sweepReader = null;
          try { if (old && old.disconnect) old.disconnect(); } catch (_) { /* already closed */ }
          showcase.value = ""; twinStatus.value = "";
        }
        function cancelSetup() { if (saving.value) return; operation++; setupMode.value = false; capturing.value = false; captured.value = null; error.value = ""; message.value = ""; }
        function select(poi) {
          if (saving.value || capturing.value || twinBusy.value || setupMode.value) return;
          operation++; selectedId.value = poi.id; captured.value = null; error.value = ""; message.value = "";
        }
        async function load(force = false) {
          if (disposed || (saving.value && force !== true)) return;
          closeTwin(); setupMode.value = false; captured.value = null;
          if (force === true) {
            // A building navigation supersedes the old view even if its server
            // write is still settling. Epoch/slug guards quarantine that result.
            saving.value = false; rows.value = []; selectedId.value = null;
            enabled.value = false; writable.value = false; modelId.value = "";
          }
          const run = epoch, slug = props.b.slug;
          loading.value = true; error.value = ""; message.value = "";
          try {
            const data = await api(listingUrl(slug));
            if (disposed || run !== epoch || slug !== props.b.slug) return;
            enabled.value = !!data.enabled; writable.value = !!data.writable; modelId.value = data.model_id || "";
            rows.value = Array.isArray(data.pois) ? data.pois : [];
            let initial = null;
            try { initial = new URLSearchParams(((root.location && root.location.hash) || "").split("?")[1] || "").get("poi"); } catch (_) { /* no deep link */ }
            if (initial && rows.value.some(poi => String(poi.id) === initial)) selectedId.value = rows.value.find(poi => String(poi.id) === initial).id;
            if (!rows.value.some(poi => poi.id === selectedId.value)) selectedId.value = rows.value.length ? rows.value[0].id : null;
          } catch (_) { if (!disposed && run === epoch) { rows.value = []; selectedId.value = null; error.value = "Couldn't load the location viewpoints. Please try again."; } }
          finally { if (!disposed && run === epoch) loading.value = false; }
        }
        async function openTwin() {
          if (saving.value || capturing.value || twinBusy.value) return false;
          closeTwin(); const run = epoch, slug = props.b.slug, model = modelId.value;
          twinBusy.value = true; error.value = "";
          try {
            if (!model || !root.MpPlace) throw new Error("unavailable");
            const url = await fetchShowcaseUrl(slug, {sdk:1});
            if (disposed || run !== epoch || slug !== props.b.slug || model !== modelId.value) return false;
            if (new URL(url, root.location && root.location.href || "http://localhost/").searchParams.get("m") !== model) throw new Error("wrong model");
            const key = root.MpPlace.keyFromShowcaseUrl(url);
            if (!key) throw new Error("missing SDK key");
            showcase.value = url; await nextTick();
            const frame = twinFrame.value; if (!frame) throw new Error("missing twin");
            await root.MpPlace.waitIframeLoad(frame, 12000);
            if (disposed || run !== epoch || slug !== props.b.slug || model !== modelId.value) return false;
            const result = await root.MpPlace.connect({iframe:frame,applicationKey:key,onStatus:status=>{if (!disposed && run === epoch) twinStatus.value = status;}});
            if (disposed || run !== epoch || slug !== props.b.slug || model !== modelId.value) { if (result && result.disconnect) result.disconnect(); return false; }
            if (!result || !result.ok) throw new Error("connection failed");
            session = result; connectedModel = model; sweepReader = createSweepReader(result.sdk, result.sweepData); connected.value = true;
            twinStatus.value = "Walk to the desired scan position and rotate the view to face the location.";
            return true;
          } catch (_) { if (!disposed && run === epoch) twinStatus.value = "Couldn't connect the digital twin. Finish loading the walkthrough, then reconnect."; return false; }
          finally { if (!disposed && run === epoch) twinBusy.value = false; }
        }
        async function beginSetup() {
          if (!selected.value || !writable.value || saving.value || capturing.value || twinBusy.value) return;
          operation++; setupMode.value = true; captured.value = null; error.value = ""; message.value = "";
          if (!session && !(await openTwin())) return;
          if (selected.value && selected.value.viewpoint) await previewSaved();
        }
        async function persist(viewpoint) {
          if (!selected.value || !writable.value || saving.value) return false;
          const id = selected.value.id, model = modelId.value, run = epoch, op = operation, slug = props.b.slug;
          saving.value = true; error.value = ""; message.value = "";
          try {
            const response = await api(`/admin/buildings/${slug}/pois/${id}/camera-viewpoint`, {method:"PUT",json:{model_id:model,viewpoint,revision:selected.value.revision}});
            if (!current(run, op, id, model, slug)) return false;
            if (!response || response.id !== id || response.model_id !== model || !Object.prototype.hasOwnProperty.call(response,"viewpoint") || typeof response.revision !== "string"
                || !response.revision || !sameCameraViewpoint(response.viewpoint, viewpoint, model)) throw new Error("unconfirmed write");
            // Read the committed record before reporting success. A failed readback
            // keeps the capture available and does not misreport persistence.
            const state = await api(listingUrl(slug));
            if (!current(run, op, id, model, slug)) return false;
            const saved = state && state.model_id === model && Array.isArray(state.pois) && state.pois.find(poi => poi.id === id);
            if (!saved || !Object.prototype.hasOwnProperty.call(saved,"viewpoint") || saved.revision !== response.revision || !sameCameraViewpoint(saved.viewpoint, viewpoint, model)) throw new Error("unconfirmed readback");
            rows.value = state.pois; captured.value = null; setupMode.value = false;
            message.value = viewpoint
              ? (saved.published === false || props.b.published_version === null ? "Viewpoint saved. Publish this location before visitors can open it." : "Viewpoint saved. Visitors will open this saved view when they select the location.")
              : "Saved viewpoint removed. Existing navigation will be used.";
            return true;
          } catch (_) { if (current(run, op, id, model, slug)) error.value = "Couldn't confirm the saved viewpoint. Reload locations to check it before trying again. Your captured view is still here."; return false; }
          finally { if (!disposed && run === epoch) { saving.value = false; await revealFeedback(); } }
        }
        async function captureCurrentViewpoint() {
          if (!setupMode.value || !session || !selected.value || !writable.value || saving.value || capturing.value || twinBusy.value) return;
          const active = session, id = selected.value.id, model = modelId.value, run = epoch, op = operation, slug = props.b.slug;
          capturing.value = true; captured.value = null; error.value = ""; message.value = "";
          let value = null;
          try {
            if (connectedModel !== model) throw new Error("wrong model");
            const pose = await readCameraPose(active.sdk);
            const sweeps = await sweepReader.read();
            if (!current(run, op, id, model, slug) || active !== session || !setupMode.value) return;
            const sweep = pose && pose.sweep && sweeps[pose.sweep];
            const inside = active.sdk.Mode && active.sdk.Mode.Mode && active.sdk.Mode.Mode.INSIDE || "mode.inside";
            if (!pose || pose.mode !== inside || !sweep || !point(pose.position) || !pose.rotation
                || ![pose.rotation.x,pose.rotation.y].every(number=>typeof number==="number"&&Number.isFinite(number))
                || Math.hypot(pose.position.x-sweep.position.x,pose.position.y-sweep.position.y,pose.position.z-sweep.position.z)>0.35) throw new Error("not at a scan position");
            const currentSweep = active.currentSweep && active.currentSweep();
            const floor = currentSweep && (currentSweep.sid || currentSweep.id) === pose.sweep && currentSweep.floorInfo && currentSweep.floorInfo.id || sweep.floor_id || null;
            value = cameraViewpoint({model_id:model,sweep_id:pose.sweep,camera_position:pose.position,
              camera_rotation:{pitch:pose.rotation.x,yaw:((pose.rotation.y+180)%360+360)%360-180},
              floor_id:floor,captured_at:new Date().toISOString()}, model);
            if (!value) throw new Error("invalid pose");
            captured.value = value;
          } catch (_) { if (current(run, op, id, model, slug)) error.value = "Couldn't capture this viewpoint. Stop at a walkthrough scan position, face the location, and try again."; }
          finally { if (current(run, op, id, model, slug)) capturing.value = false; }
          if (value && current(run, op, id, model, slug) && active === session && setupMode.value) await persist(value);
        }
        async function retrySave() { if (captured.value && !capturing.value && !twinBusy.value) await persist(captured.value); }
        async function remove() { if (!setupMode.value && !capturing.value && !twinBusy.value) await persist(null); }
        async function previewSaved() {
          if (!selected.value || saving.value || capturing.value || twinBusy.value) return false;
          const view = cameraViewpoint(selected.value.viewpoint, modelId.value);
          if (!view) { error.value = selected.value.viewpoint ? "This saved view is no longer available. Please choose another location." : "No saved view is available for this location."; return false; }
          if (!session && !(await openTwin())) return false;
          const active = session, id = selected.value.id, run = epoch, op = operation, model = modelId.value, slug = props.b.slug;
          twinBusy.value = true; error.value = "";
          try {
            const sweeps = await sweepReader.read();
            if (!current(run, op, id, model, slug) || active !== session) return false;
            if (connectedModel !== view.model_id || !sweeps[view.sweep_id] || !active.sdk.Sweep || typeof active.sdk.Sweep.moveTo !== "function") throw new Error("invalid sweep");
            await active.sdk.Sweep.moveTo(view.sweep_id, {transition:(active.sdk.Sweep.Transition||{}).INSTANT,
              rotation:{x:view.camera_rotation.pitch,y:view.camera_rotation.yaw}});
            if (!current(run, op, id, model, slug) || active !== session) return false;
            twinStatus.value = "Showing the saved viewpoint for this location."; return true;
          } catch (_) { if (current(run, op, id, model, slug)) error.value = "This saved view is no longer available. Please choose another location."; return false; }
          finally { if (!disposed && run === epoch) twinBusy.value = false; }
        }
        onMounted(async () => { await load(); let initialSetup = false; try { initialSetup = new URLSearchParams(((root.location && root.location.hash)||"").split("?")[1]||"").get("setup")==="1"; } catch (_) {} if (initialSetup) await beginSetup(); });
        watch(() => props.b.slug, () => load(true));
        onBeforeUnmount(() => { disposed = true; closeTwin(); });
        return {rows,selectedId,query,enabled,writable,modelId,loading,saving,capturing,setupMode,captured,error,message,twinStatus,twinFrame,showcase,connected,twinBusy,feedback,selected,filtered,visitorViewUrl,
          load,select,openTwin,closeTwin,beginSetup,cancelSetup,captureCurrentViewpoint,retrySave,remove,previewSaved};
      }
    };
  }

  root.WFPoiViewpoint = { point, equalPoint, nearestSweep, facingRotation, createSweepReader, createComponent,
    cameraViewpoint, sameCameraViewpoint, readCameraPose, createCameraComponent };
})(typeof window !== "undefined" ? window : globalThis);
