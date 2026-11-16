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
      if (id != null && position) rows[String(id)] = {sid: String(id), position};
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
              <iframe ref="twinFrame" v-show="showcase" :src="showcase || 'about:blank'" class="showcase viewpoint-twin" title="POI viewpoint digital twin" allow="xr-spatial-tracking; fullscreen" allowfullscreen></iframe>
              <p class="small muted" v-if="connected">Move the pointer over the door or surface that directions should face, then choose Use pointed location.</p>
              <button @click="capturePointer" :disabled="!connected || saving || twinBusy">Use pointed location</button>
              <fieldset :disabled="saving"><legend>Look-at point (Matterport coordinates, metres)</legend><div class="viewpoint-coordinates">
                <label>X<input type="number" step="any" v-model="draft.x" aria-label="Viewpoint X"></label>
                <label>Y (height)<input type="number" step="any" v-model="draft.y" aria-label="Viewpoint Y height"></label>
                <label>Z<input type="number" step="any" v-model="draft.z" aria-label="Viewpoint Z"></label>
              </div></fieldset>
              <p class="small muted" v-if="dirty && !validTarget">Enter all three coordinates as finite numbers.</p>
              <div class="row viewpoint-actions"><button @click="preview" :disabled="!validTarget || twinBusy || saving">Preview from POI</button>
                <button class="primary" @click="save" :disabled="!writable || !validTarget || !dirty || saving || twinBusy">{{saving ? 'Saving…' : 'Save viewpoint'}}</button>
                <button @click="reset" :disabled="!writable || !selected.override || saving || twinBusy">Reset to Studio default</button>
                <button @click="discard" :disabled="!dirty || saving">Discard edits</button></div>
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
            twinStatus.value = "Connected. Aim at the door or surface that directions should face.";
            return true;
          } catch (ex) {
            if (!disposed && run === epoch) { disconnect(); twinStatus.value = ex.message || "Could not open the digital twin."; }
            return false;
          } finally { if (!disposed && run === epoch) twinBusy.value = false; }
        }
        function capturePointer() {
          if (!session || !selected.value || saving.value) return;
          const hit = session.pointerModelXY && session.pointerModelXY();
          const target = point(hit && root.MpPlace.modelToSdk(hit));
          if (!target) { error.value = "Move the pointer over a door or surface in the digital twin first."; return; }
          Object.assign(draft, target); error.value = ""; message.value = "Point selected. Preview it, then save the viewpoint.";
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
            if (!disposed && run === epoch) twinStatus.value = "Previewing from the POI. Save viewpoint to apply it to directions.";
          } catch (ex) { if (!disposed && run === epoch) error.value = ex.message || "Could not preview this viewpoint."; }
          finally { if (!disposed && run === epoch) twinBusy.value = false; }
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
          load, select, discard, openTwin, closeTwin, capturePointer, preview, save, reset };
      }
    };
  }

  root.WFPoiViewpoint = { point, equalPoint, nearestSweep, facingRotation, createSweepReader, createComponent };
})(typeof window !== "undefined" ? window : globalThis);
