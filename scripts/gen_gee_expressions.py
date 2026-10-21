"""Membuat templat ekspresi Earth Engine untuk backend Rust.

Jalankan SEKALI di komputer Anda (butuh `pip install earthengine-api` dan `earthengine authenticate`):

    python gen_gee_expressions.py NAMA_PROJECT_GCP

Hasil: burn_map.json, burn_zonal.json, pop_zonal.json. Salin ketiganya ke backend/src/
(sebelah co_expression.json). Placeholder yang diisi oleh gee.rs saat runtime:
  __START__ / __END__  -> tanggal filter
  "__COORDS__"         -> koordinat MultiPolygon (zonal)
"""
import json
import sys

import ee

ee.Initialize(project=sys.argv[1] if len(sys.argv) > 1 else None)

DUMMY = [[[[0, 0], [0, 1], [1, 1], [0, 0]]]]  # akan diganti "__COORDS__"


def encode(obj):
    out = ee.serializer.encode(obj, for_cloud_api=True)
    return json.loads(out) if isinstance(out, str) else out


def swap_coords(node):
    """Ganti koordinat geometri dummy dengan penanda "__COORDS__". Mengembalikan jumlah penggantian.
    Mendukung beberapa bentuk enkode: konstanta langsung, arrayValue, atau GeoJSON konstan."""
    n = 0
    if isinstance(node, dict):
        # bentuk 1: pemanggilan GeometryConstructors.* dengan argumen coordinates
        fi = node.get("functionInvocationValue")
        if isinstance(fi, dict) and str(fi.get("functionName", "")).startswith("GeometryConstructors."):
            args = fi.get("arguments", {})
            if "coordinates" in args:
                args["coordinates"] = {"constantValue": "__COORDS__"}
                return 1
        # bentuk 2: GeoJSON konstan {"constantValue": {"type": ..., "coordinates": ...}}
        cv = node.get("constantValue")
        if isinstance(cv, dict) and "coordinates" in cv:
            cv["coordinates"] = "__COORDS__"
            return 1
        for v in node.values():
            n += swap_coords(v)
    elif isinstance(node, list):
        for v in node:
            n += swap_coords(v)
    return n


def save(name, expr, need_coords=False):
    if need_coords and swap_coords(expr) != 1:
        with open("debug_" + name, "w", encoding="utf-8") as f:
            json.dump(expr, f, indent=1)
        raise SystemExit(f"{name}: penanda koordinat tidak ditemukan tepat satu kali; isi ekspresi disimpan di debug_{name}")
    with open(name, "w", encoding="utf-8") as f:
        json.dump(expr, f, ensure_ascii=False)
    print("ditulis:", name)


# MODIS MCD64A1: piksel terbakar (BurnDate > 0) pada jendela tanggal
burn_col = ee.ImageCollection("MODIS/061/MCD64A1").filterDate("__START__", "__END__")
burned = burn_col.select("BurnDate").max().gt(0)

# 1) lapisan peta area terbakar
save("burn_map.json", encode(burned.selfMask().visualize(palette=["ff2d95", "ff2d95"], min=0, max=1, opacity=0.9)))

# 2) jumlah hektar terbakar di dalam geometri
geom = ee.Geometry.MultiPolygon(DUMMY, None, False)
burn_ha = burned.multiply(ee.Image.pixelArea()).divide(10000).rename("burn_ha")
burn_sum = burn_ha.reduceRegion(
    reducer=ee.Reducer.sum(), geometry=geom, scale=500, maxPixels=1e10, bestEffort=True, tileScale=4
).get("burn_ha")
save("burn_zonal.json", encode(burn_sum), need_coords=True)

# 3) jumlah penduduk (WorldPop 100 m, Indonesia 2020) di dalam geometri
pop = (
    ee.ImageCollection("WorldPop/GP/100m/pop")
    .filter(ee.Filter.eq("country", "IDN"))
    .filter(ee.Filter.eq("year", 2020))
    .mosaic()
    .select("population")
)
pop_sum = pop.reduceRegion(
    reducer=ee.Reducer.sum(), geometry=geom, scale=100, maxPixels=1e10, bestEffort=True, tileScale=4
).get("population")
save("pop_zonal.json", encode(pop_sum), need_coords=True)