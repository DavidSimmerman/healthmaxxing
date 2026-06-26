#!/usr/bin/env python3
"""Tandem insulin pump → JSON, via the unofficial Tandem Source API.

Tandem has no official API; this reuses tconnectsync's reverse-engineered login
and binary event parser (the only thing that decodes the pump event log) and
emits a flat JSON insulin trace on stdout. It does NOT touch Nightscout.

Pure function: in = env, out = stdout JSON. Called by the Node sync endpoint,
which owns the DB. Credentials come via env (never argv — argv leaks via `ps`).

Env in:
  TANDEM_EMAIL, TANDEM_PASSWORD   Tandem Source login (required)
  TANDEM_REGION                   'US' (default) | 'EU'
  TANDEM_START, TANDEM_END        local 'YYYY-MM-DD' inclusive range (required)
  TIMEZONE_NAME                   pump/local tz, e.g. 'America/New_York' (required)

Stdout: {"device": {...}, "events": [ ... ]} ; on failure: {"error": "..."} + exit 1.
"""
import json
import os
import sys

# tconnectsync reads TIMEZONE_NAME / CACHE_CREDENTIALS at IMPORT time (secret.py),
# so these must be set before the import below. Never cache creds to disk — we
# manage our own auth and the disk cache would pickle the session unencrypted.
os.environ.setdefault('CACHE_CREDENTIALS', 'false')
if os.environ.get('TIMEZONE_NAME'):
    os.environ.setdefault('TZ', os.environ['TIMEZONE_NAME'])

from tconnectsync.api import TConnectApi  # noqa: E402
from tconnectsync.eventparser import events as ev  # noqa: E402
from tconnectsync.sync.tandemsource.helpers import (  # noqa: E402
    insulin_float_round,
    insulin_milliunits_to_real,
)

BOLUS_TYPE = ev.LidBolusRequestedMsg1.BolustypeMap  # {'0':'Insulin','2':'Automatic Correction',...}
# CGM event classes per sensor (Dexcom G6=Gxb, G7; Libre 2). All carry
# currentglucosedisplayvalue (mg/dL) + glucosevaluestatusRaw; ids are in the
# default fetch set so no extra fetch flag is needed.
CGM_CLASSES = tuple(
    c for c in (
        getattr(ev, n, None)
        for n in ('LidCgmDataG7', 'LidCgmDataGxb', 'LidCgmDataFsl2', 'LidCgmDataFsl3')
    )
    if c is not None
)


def die(msg):
    print(json.dumps({'error': str(msg)}), file=sys.stdout)
    sys.exit(1)


def pick_device(pumps):
    """Most recently active pump on the account (matches tconnectsync default)."""
    if not pumps:
        die('No pumps found on this Tandem account.')
    return max(pumps, key=lambda p: p['maxDateWithEvents'])


def build_trace(events):
    """Typed pump events → flat insulin trace (basal samples + joined boluses).

    Pure: no network, no env. This is the load-bearing logic, so it has a
    self-check below (run `tandem_sync.py --selftest`)."""
    out = []
    # Boluses span several event rows sharing a bolusid; join the completion
    # (actual delivered) with the request (carbs / BG / type).
    requests = {}
    completed = []
    for e in events:
        if isinstance(e, CGM_CLASSES):
            # Only real numeric readings (status 0 = Precise Value); skip
            # Special High/Low/Do-Not-Show sentinels.
            v = e.currentglucosedisplayvalue
            if e.glucosevaluestatusRaw == 0 and 10 <= v <= 600:
                ts = e.eventTimestamp
                out.append({
                    'at': ts.to('UTC').isoformat(),
                    'date': ts.format('YYYY-MM-DD'),
                    'kind': 'cgm',
                    'mgdl': v,
                })
        elif isinstance(e, ev.LidBasalDelivery):
            ts = e.eventTimestamp
            out.append({
                'at': ts.to('UTC').isoformat(),
                'date': ts.format('YYYY-MM-DD'),
                'kind': 'basal',
                'units': insulin_milliunits_to_real(e.commandedRate),  # U/hr
            })
        elif isinstance(e, ev.LidBolusRequestedMsg1):
            requests[e.bolusid] = e
        elif isinstance(e, ev.LidBolusCompleted):
            completed.append(e)

    for c in completed:
        req = requests.get(c.bolusid)
        ts = c.eventTimestamp
        bolus_type = carbs = bg = None
        if req is not None:
            bolus_type = BOLUS_TYPE.get(str(req.bolustypeRaw))
            carbs = req.carbamount if req.carbamount > 0 else None
            bg = req.BG if req.BG > 0 else None
        out.append({
            'at': ts.to('UTC').isoformat(),
            'date': ts.format('YYYY-MM-DD'),
            'kind': 'bolus',
            'units': insulin_float_round(c.insulindelivered),
            'requested': insulin_float_round(c.insulinrequested),
            'bolusType': bolus_type,
            'carbs': carbs,
            'bg': bg,
        })
    return out


def selftest():
    """Feed real fixture bytes (from tconnectsync's own tests) through build_trace."""
    from tconnectsync.eventparser.generic import Event
    os.environ['TZ'] = 'America/New_York'  # fixture timestamps are -05:00
    # LidBasalDelivery id=279 @ 2025-11-18 13:12:40-05:00, commandedRate=800 mU → 0.8 U/hr
    BASAL = b'\x01\x17!\xa2\xeeH\x00\x01\x86\xa1\x00\x00\x00\x03\x03 \x03 \x00\x00\x03 \x00\x00\x00\x00'
    trace = build_trace([Event(bytearray(BASAL))])
    assert len(trace) == 1, trace
    b = trace[0]
    assert b['kind'] == 'basal', b
    assert b['units'] == 0.8, b['units']
    assert b['date'] == '2025-11-18', b['date']
    assert b['at'] == '2025-11-18T18:12:40+00:00', b['at']  # 13:12:40-05:00 → UTC
    # boluses with no completion row produce no output
    assert build_trace([]) == []
    print('selftest ok')


def main():
    email = os.environ.get('TANDEM_EMAIL')
    password = os.environ.get('TANDEM_PASSWORD')
    start = os.environ.get('TANDEM_START')
    end = os.environ.get('TANDEM_END')
    region = os.environ.get('TANDEM_REGION', 'US')
    if not (email and password and start and end):
        die('Missing TANDEM_EMAIL/PASSWORD/START/END.')

    tconnect = TConnectApi(email, password, region=region)
    device = pick_device(tconnect.tandemsource.pump_event_metadata())

    events = tconnect.tandemsource.pump_events(device['tconnectDeviceId'], start, end)
    out = build_trace(events)

    json.dump({
        'device': {
            'serialNumber': device.get('serialNumber'),
            'modelNumber': device.get('modelNumber'),
            'lastUpload': device.get('lastUpload'),
        },
        'range': {'start': start, 'end': end},
        'events': out,
    }, sys.stdout)


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        selftest()
        sys.exit(0)
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # surface any tconnectsync/login error as JSON for Node
        die('%s: %s' % (type(e).__name__, e))
