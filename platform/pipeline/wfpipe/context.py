"""Building workspace + config + logging for pipeline steps."""
import json, os, time, hashlib, logging
from pathlib import Path

DEFAULTS = {
    "georef": {"mode": "auto", "search_radius_m": 130, "control_points": []},
    "osm": {"enabled": True, "footway_radius_m": 220, "building_radius_m": 450},
    "glb": {"target_reduction": 0.72},
    "thumbs": {"enabled": True, "size": [320, 192]},
    "vps_index": {"enabled": True},
    "graph": {"max_edge_m": 15, "step_free_max_step_m": 0.16, "osm_link_max_m": 12},
    "floors": [],
    "stairs": None,          # None = auto-detect; list = manual zones
    "pois_seed": [],         # optional curated POIs (see docs/DATA_FORMATS.md)
    "arrival_poi": None,     # POI id used for "step-free from arrival" flags (default: first parking POI)
}


def deep_merge(a, b):
    out = dict(a)
    for k, v in (b or {}).items():
        out[k] = deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


class StepError(RuntimeError):
    pass


class Context:
    def __init__(self, root, config=None, log_cb=None):
        self.root = Path(root).resolve()
        self.work = self.root / "work"; self.out = self.root / "out"
        self.work.mkdir(parents=True, exist_ok=True); self.out.mkdir(parents=True, exist_ok=True)
        cfg_path = self.root / "building.json"
        if config is None:
            config = json.loads(cfg_path.read_text()) if cfg_path.exists() else {}
        else:
            cfg_path.write_text(json.dumps(config, indent=1))
        self.cfg = deep_merge(DEFAULTS, config)
        self.log_cb = log_cb
        self.logger = logging.getLogger("wfpipe")
        self.state_path = self.work / "state.json"
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.current_step = None

    # ---------- logging ----------
    def log(self, msg, level="info"):
        line = f"[{time.strftime('%H:%M:%S')}] {('['+self.current_step+'] ') if self.current_step else ''}{msg}"
        if self.logger.handlers:
            getattr(self.logger, level if level in ("info", "warning", "error") else "info")(line)
        print(line, flush=True)
        if self.log_cb:
            try: self.log_cb(line, level)
            except Exception: pass

    def warn(self, msg): self.log("WARNING: " + msg, "warning")

    # ---------- io ----------
    def w(self, name): return self.work / name
    def o(self, name): return self.out / name

    def read_json(self, path):
        return json.loads(Path(path).read_text())

    def write_json(self, path, obj, compact=False):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps(obj, separators=(",", ":")) if compact else json.dumps(obj, indent=1))

    def save_state(self):
        self.state_path.write_text(json.dumps(self.state, indent=1))

    def fingerprint(self, keys, deps):
        h = hashlib.sha256()
        h.update(json.dumps({k: self.cfg.get(k) for k in keys}, sort_keys=True, default=str).encode())
        for d in deps:
            h.update((self.state.get(d, {}).get("fp") or "missing").encode())
        return h.hexdigest()[:16]

    # ---------- shared lazily-loaded artefacts ----------
    def georef(self):
        from .geo import Georef
        return Georef.from_json(self.read_json(self.o("georef.json")))

    def floors(self):
        """Resolved floor list (from floors step)."""
        return self.read_json(self.w("floors_resolved.json"))["floors"]
