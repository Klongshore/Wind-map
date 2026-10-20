#!/usr/bin/env python3
"""Download the latest NOAA GFS 10 m wind analysis and write it for the map.

Writes two files into the output folder (default: data/):
  wind.json  grid description and the time the wind is valid for
  wind.bin   int8 u then v components in 0.5 m/s steps, rows south to north,
             columns west to east starting at 180 W

The GFS files come from NOAA's open data bucket on AWS. Only the two 10 m wind
fields are downloaded (about 1 MB), using the byte ranges in the .idx index.
Needs: pip install pygrib numpy
"""
import datetime as dt
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request

import numpy as np
import pygrib

BUCKET = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com'
FIELDS = ('UGRD:10 m above ground', 'VGRD:10 m above ground')
STEP = 0.5  # m/s per int8 unit


def get(url, byte_range=None):
    req = urllib.request.Request(url)
    if byte_range:
        req.add_header('Range', 'bytes=%d-%s' % byte_range)
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read()


def latest_cycle(now):
    """Newest GFS run whose analysis file is published, as (date, hour, base url)."""
    for back in range(0, 48, 6):
        t = now - dt.timedelta(hours=back)
        hour = t.hour // 6 * 6
        day = t.strftime('%Y%m%d')
        base = '%s/gfs.%s/%02d/atmos/gfs.t%02dz.pgrb2.0p50.f000' % (BUCKET, day, hour, hour)
        try:
            idx = get(base + '.idx').decode()
        except urllib.error.HTTPError:
            continue
        if all(f in idx for f in FIELDS):
            return dt.datetime.strptime(day, '%Y%m%d').replace(hour=hour), base, idx
    raise SystemExit('No recent GFS run found')


def ranges(idx):
    lines = [l.split(':') for l in idx.strip().splitlines()]
    out = []
    for i, parts in enumerate(lines):
        if ':'.join(parts[3:5]) in FIELDS:
            start = int(parts[1])
            end = str(int(lines[i + 1][1]) - 1) if i + 1 < len(lines) else ''
            out.append((start, end))
    return out


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else 'data'
    when, base, idx = latest_cycle(dt.datetime.now(dt.timezone.utc).replace(tzinfo=None))
    grib = b''.join(get(base, r) for r in ranges(idx))

    with tempfile.NamedTemporaryFile(suffix='.grib2', delete=False) as f:
        f.write(grib)
        path = f.name
    try:
        grbs = pygrib.open(path)
        comps = {}
        for g in grbs:
            comps[g.shortName] = g.values
            lats, lons = g.latlons()
        grbs.close()
    finally:
        os.unlink(path)

    # GFS rows run north to south and columns 0..360 E. Flip to south..north
    # and roll so the first column is 180 W.
    north_first = lats[0, 0] > lats[-1, 0]
    nx = lons.shape[1]
    shift = int(np.argmin(np.abs(lons[0] - 180)))
    data = []
    for name in ('10u', '10v'):
        a = np.asarray(comps[name], dtype=np.float32)
        if north_first:
            a = a[::-1]
        a = np.roll(a, -shift, axis=1)
        data.append(np.clip(np.round(a / STEP), -127, 127).astype(np.int8))

    south = float(min(lats[0, 0], lats[-1, 0]))
    north = float(max(lats[0, 0], lats[-1, 0]))
    ny = data[0].shape[0]
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, 'wind.bin'), 'wb') as f:
        f.write(data[0].tobytes())
        f.write(data[1].tobytes())
    meta = {
        'source': 'NOAA GFS 0.5 degree analysis, 10 m wind',
        'time': when.strftime('%Y-%m-%dT%H:%M'),
        'south': south,
        'north': north,
        'west': -180,
        'rows': ny,
        'cols': nx,
        'step': STEP
    }
    with open(os.path.join(out_dir, 'wind.json'), 'w') as f:
        json.dump(meta, f)
    print('Wrote wind for %s UTC (%d x %d) to %s' % (meta['time'], nx, ny, out_dir))


if __name__ == '__main__':
    main()
