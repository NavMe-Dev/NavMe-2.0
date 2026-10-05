"""Step ingest: locate/extract the MatterPak (folder, .zip, or .e57) into work/matterpak/.

Accepted inputs (`config.matterpak`):
- MatterPak .zip or folder with *.obj (+ .mtl, textures), colorplan_*.jpg, optional cloud.xyz
- ASTM E57 point cloud:
  - a bare `.e57` file
  - a directory containing one / the largest `*.e57` (and no `.obj`)
  - a `.zip` whose payload is an `.e57` (Matterport `mp_e57_*.zip` → `cloud_0.e57`)
  → converted in-process to model.obj + synthetic colorplan_*.jpg (see wfpipe.e57_convert)
"""
import os, re, shutil, zipfile
from pathlib import Path


def _dir_has_obj(d: Path) -> bool:
    return any(d.rglob("*.obj"))


def _dir_e57s(d: Path):
    return sorted(d.rglob("*.e57"), key=lambda p: p.stat().st_size, reverse=True)


def _is_e57_source(src: Path) -> bool:
    if src.is_file() and src.suffix.lower() == ".e57":
        return True
    if src.is_file() and src.suffix.lower() == ".zip":
        try:
            names = [n.lower() for n in zipfile.ZipFile(src).namelist()]
        except zipfile.BadZipFile:
            return False
        return any(n.endswith(".e57") for n in names) and not any(n.endswith(".obj") for n in names)
    if src.is_dir():
        return bool(_dir_e57s(src)) and not _dir_has_obj(src)
    return False


def _ingest_e57(ctx, e57_path: Path, dst: Path):
    from wfpipe.e57_convert import convert_e57_to_matterpak, libs_status, find_e57
    st = libs_status()
    if not st["pye57"]:
        raise RuntimeError(
            "E57 ingest needs pye57, which is not installed "
            f"(error: {st['pye57_error']}). "
            "Run: .venv/bin/pip install pye57 open3d"
        )
    if not st["open3d"]:
        ctx.warn(f"open3d unavailable ({st['open3d_error']}) – E57 will use 2.5D heightfield mesh only")
    e57 = find_e57(e57_path)
    ctx.log(f"ingest: converting E57 {e57} → MatterPak-like assets")
    voxel = float((ctx.cfg.get("e57") or {}).get("voxel_m", 0.08))
    cres = float((ctx.cfg.get("e57") or {}).get("colorplan_res_m", 0.05))
    max_pts = int((ctx.cfg.get("e57") or {}).get("max_points", 8_000_000))
    # convert writes into dst (may already contain source.e57 from a prior extract)
    manifest = convert_e57_to_matterpak(
        e57, dst, voxel=voxel, colorplan_res=cres, max_points=max_pts,
        log=lambda m: ctx.log(m),
    )
    ctx.write_json(ctx.w("matterpak_manifest.json"), manifest)
    return {
        "format": "e57",
        "colorplans": len(manifest["colorplans"]),
        "textures": 0,
        "obj_mb": round(manifest["obj_bytes"] / 1e6, 1),
        "mesh_method": (manifest.get("conversion") or {}).get("mesh_method"),
    }


def _extract_zip(src: Path, dst: Path):
    with zipfile.ZipFile(src) as z:
        for m in z.infolist():
            if m.is_dir():
                continue
            name = Path(m.filename).name
            if not name or name.startswith("."):
                continue
            with z.open(m) as fi, open(dst / name, "wb") as fo:
                shutil.copyfileobj(fi, fo)


def _copy_dir(src: Path, dst: Path):
    for p in src.rglob("*"):
        if p.is_file():
            t = dst / p.name
            try:
                os.link(p, t)
            except OSError:
                shutil.copy2(p, t)


def run(ctx):
    src = ctx.cfg.get("matterpak")
    if not src:
        raise ValueError("config.matterpak (folder, zip, or .e57 path) is required")
    src = Path(src)
    dst = ctx.w("matterpak")
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)

    # Bare .e57 file
    if src.is_file() and src.suffix.lower() == ".e57":
        return _ingest_e57(ctx, src, dst)

    # Zip: MatterPak (has .obj) or E57 payload (has .e57, no .obj)
    if src.is_file() and src.suffix.lower() == ".zip":
        _extract_zip(src, dst)
        objs = sorted(dst.glob("*.obj"), key=lambda p: p.stat().st_size, reverse=True)
        e57s = _dir_e57s(dst)
        if not objs and e57s:
            # Keep the extracted e57; convert in place (convert will link/copy to source.e57)
            e57_file = e57s[0]
            # Move other extracted junk aside? only e57 expected. Convert uses find_e57 on file.
            return _ingest_e57(ctx, e57_file, dst)
        if not objs:
            raise ValueError("zip contains neither .obj nor .e57 – not a MatterPak or E57 bundle")
        # fall through to MatterPak finalization below
    elif src.is_dir():
        if _is_e57_source(src):
            return _ingest_e57(ctx, src, dst)
        _copy_dir(src, dst)
    else:
        raise FileNotFoundError(f"MatterPak / E57 not found: {src}")

    objs = sorted(dst.glob("*.obj"), key=lambda p: p.stat().st_size, reverse=True)
    if not objs:
        e57s = _dir_e57s(dst)
        if e57s:
            return _ingest_e57(ctx, e57s[0], dst)
        raise ValueError("no .obj mesh in MatterPak (and no .e57 to convert)")
    if objs[0].name != "model.obj":
        os.replace(objs[0], dst / "model.obj")
    cps = sorted(p.name for p in dst.glob("colorplan_*.jpg") if re.fullmatch(r"colorplan_\d+\.jpg", p.name))
    if not cps:
        try:
            from . import mesh as mesh_step
            from ..mesh_colorplan import synthesize_colorplans
            V, F = mesh_step.load_obj(dst / "model.obj")
            cps = synthesize_colorplans(V, F, dst, log=ctx.log)
        except Exception as e:
            ctx.warn(f"no colorplan_*.jpg found and mesh-based synthesis failed ({e}) – "
                     f"colour-plan overlays / auto georef will be unavailable")
        else:
            if cps:
                ctx.warn("no colorplan_*.jpg in source – synthesized greyscale floor plan(s) from mesh geometry "
                          "instead (no real photos; auto-georef via satellite match still needs a real address/geocode)")
            else:
                ctx.warn("no colorplan_*.jpg found and mesh synthesis produced none – "
                         "colour-plan overlays / auto georef will be unavailable")
    textures = [p.name for p in dst.glob("*.jpg") if not p.name.startswith("colorplan")]
    manifest = {"source_format": "matterpak", "obj": "model.obj", "obj_bytes": (dst / "model.obj").stat().st_size,
                "colorplans": cps, "textures": len(textures), "mtl": [p.name for p in dst.glob("*.mtl")],
                "cloud_xyz": (dst / "cloud.xyz").exists()}
    if not textures:
        ctx.warn("MatterPak has no texture images – GLB will use colour-plan vertex colours only")
    ctx.write_json(ctx.w("matterpak_manifest.json"), manifest)
    return {"format": "matterpak", "colorplans": len(cps), "textures": len(textures),
            "obj_mb": round(manifest["obj_bytes"] / 1e6, 1)}
