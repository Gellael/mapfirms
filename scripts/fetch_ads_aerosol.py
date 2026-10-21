#!/usr/bin/env python3
"""Ambil prakiraan aerosol CAMS Global dari Copernicus ADS -> JSON grid 2 derajat untuk BaraNusa.

Env:
  ADS_KEY  (wajib)  API key akun ADS (https://ads.atmosphere.copernicus.eu -> profil)
  ADS_URL  (opsional, default https://ads.atmosphere.copernicus.eu/api)
  OUT      (opsional, default public/data/aerosol_ads.json, relatif ke akar repo frontend)

Pasang: pip install cdsapi xarray netcdf4 numpy pandas scipy
"""
import glob
import json
import os
import sys
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone

import cdsapi
import numpy as np
import pandas as pd
import xarray as xr

OUT = os.environ.get("OUT", "public/data/aerosol_ads.json")
URL = os.environ.get("ADS_URL", "https://ads.atmosphere.copernicus.eu/api")
KEY = os.environ["ADS_KEY"]

# Grid HARUS sama dengan frontend (GLON/GLAT/GSTEP di App.tsx): lon 94..142, lat -12..8, langkah 2 derajat
GLON = np.arange(94, 142 + 1e-9, 2.0)
GLAT = np.arange(-12, 8 + 1e-9, 2.0)
AREA = [10, 92, -14, 144]  # N, W, S, E (margin 2 derajat supaya interpolasi tepi aman)
HOURS = 72  # kemarin 00:00 WIB s/d besok 23:00 WIB, sama dengan data Open-Meteo di frontend
WIB = timedelta(hours=7)

DATASET = "cams-global-atmospheric-composition-forecasts"
VARIABLES = [
    "particulate_matter_2.5um",
    "particulate_matter_10um",
    "total_aerosol_optical_depth_550nm",
]


def classify(name: str):
    n = name.lower()
    if "pm2p5" in n or "pm2.5" in n or "pm2_5" in n:
        return "pm25"
    if "pm10" in n:
        return "pm10"
    if "aod550" in n and not n.startswith(("du", "ss", "bc", "om", "su", "ni", "am")):
        return "aod"
    return None


def fetch_run(client, run: datetime, tmp: str) -> str:
    target = os.path.join(tmp, f"run_{run:%Y%m%d}.dl")
    client.retrieve(
        DATASET,
        {
            "variable": VARIABLES,
            "date": [f"{run:%Y-%m-%d}/{run:%Y-%m-%d}"],
            "time": ["00:00"],
            "leadtime_hour": [str(h) for h in range(0, 49, 3)],
            "type": ["forecast"],
            "data_format": "netcdf",
            "area": AREA,
        },
        target,
    )
    return target


def open_nc(path: str) -> xr.Dataset:
    files = [path]
    if zipfile.is_zipfile(path):
        d = path + "_x"
        os.makedirs(d, exist_ok=True)
        with zipfile.ZipFile(path) as z:
            z.extractall(d)
        files = sorted(glob.glob(os.path.join(d, "**", "*.nc"), recursive=True))
    parts = []
    for f in files:
        with xr.open_dataset(f) as d:  # muat ke memori lalu tutup file (penting di Windows)
            parts.append(d.load())
    return xr.merge(parts, compat="override")


def valid_times(da: xr.DataArray, tdim: str, run: datetime):
    v = da[tdim].values
    base = pd.Timestamp(run)
    if np.issubdtype(v.dtype, np.datetime64):
        return pd.to_datetime(v)
    if np.issubdtype(v.dtype, np.timedelta64):
        return base + pd.to_timedelta(v)
    return base + pd.to_timedelta(v.astype(float), unit="h")


def run_to_hourly(ds: xr.Dataset, run: datetime) -> dict:
    out = {}
    for name, da in ds.data_vars.items():
        key = classify(name)
        if not key:
            continue
        da = da.squeeze()
        tdim = next((d for d in ("valid_time", "forecast_period", "step", "time") if d in da.dims), None)
        if tdim is None:
            continue
        vt = valid_times(da, tdim, run)
        da = da.rename({tdim: "t"})
        da = da.reset_coords(drop=True).assign_coords(t=vt)
        for a, b in (("lat", "latitude"), ("lon", "longitude")):
            if a in da.dims:
                da = da.rename({a: b})
        da = da.sortby("latitude").sortby("longitude")
        da = da.interp(latitude=GLAT, longitude=GLON)
        units = str(ds[name].attrs.get("units", "")).replace(" ", "")
        if key in ("pm25", "pm10") and units.startswith("kg"):
            da = da * 1e9  # kg/m3 -> ug/m3
        hours = pd.date_range(vt.min(), vt.max(), freq="1h")
        out[key] = da.interp(t=hours).transpose("t", "latitude", "longitude")
    return out


def main():
    client = cdsapi.Client(url=URL, key=KEY, quiet=True)
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)
    acc: dict = {}
    used = []
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        for back in (2, 1, 0):  # lama -> baru; run terbaru menimpa yang lama
            run = today - timedelta(days=back)
            try:
                ds = open_nc(fetch_run(client, run, tmp))
                part = run_to_hourly(ds, run)
                if not all(k in part for k in ("pm25", "pm10", "aod")):
                    raise RuntimeError(f"variabel tidak lengkap: {list(ds.data_vars)}")
            except Exception as e:  # run hari ini bisa saja belum tersedia
                print(f"run {run:%Y-%m-%d} dilewati: {e}", file=sys.stderr)
                continue
            for k, v in part.items():
                acc[k] = v.combine_first(acc[k]) if k in acc else v
            used.append(f"{run:%Y-%m-%d}T00Z")

    if not used:
        sys.exit("Tidak ada run ADS yang berhasil diambil")

    now_wib = datetime.now(timezone.utc).replace(tzinfo=None) + WIB
    start_utc = datetime(now_wib.year, now_wib.month, now_wib.day) - timedelta(days=1) - WIB
    hours = pd.date_range(start_utc, periods=HOURS, freq="1h")
    wib = hours + WIB

    v = {}
    for k, da in acc.items():
        arr = da.reindex(t=hours, method="nearest").values  # (jam, lat, lon)
        arr = np.nan_to_num(arr, nan=0.0).reshape(HOURS, -1)  # indeks = lat * NX + lon, sama dengan GRID_PTS
        v[k] = np.round(arr, 2 if k == "aod" else 1).tolist()

    payload = {
        "source": "Copernicus Atmosphere Data Store, CAMS global atmospheric composition forecasts",
        "updated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "runs": used,
        "t": [x.strftime("%Y-%m-%dT%H:00") for x in wib],
        "v": v,
    }
    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"OK: {OUT}, run: {used}, jam: {HOURS}")


if __name__ == "__main__":
    main()