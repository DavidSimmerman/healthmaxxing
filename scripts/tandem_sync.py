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
from tconnectsync.eventparser.generic import Events  # noqa: E402
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
    """Most recently active pump on the account (matches tconnectsync default).

    BFF pumps that never uploaded omit maxDateOfEvents, so sort None-safe."""
    if not pumps:
        die('No pumps found on this Tandem account.')
    return max(pumps, key=lambda p: p.get('maxDateOfEvents') or '')


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
            v = e.currentGlucoseDisplayValue
            if e.glucoseValueStatusRaw == 0 and v is not None and 10 <= v <= 600:
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
            requests[e.bolusId] = e
        elif isinstance(e, ev.LidBolusCompleted):
            completed.append(e)

    for c in completed:
        req = requests.get(c.bolusId)
        ts = c.eventTimestamp
        bolus_type = carbs = bg = None
        if req is not None:
            # BFF JSON may omit a property (-> None); guard before comparing.
            bolus_type = BOLUS_TYPE.get(str(req.bolusTypeRaw))
            carbs = req.carbAmount if req.carbAmount else None
            bg = req.bg if req.bg else None
        out.append({
            'at': ts.to('UTC').isoformat(),
            'date': ts.format('YYYY-MM-DD'),
            'kind': 'bolus',
            'units': insulin_float_round(c.insulinDelivered),
            'requested': insulin_float_round(c.insulinRequested),
            'bolusType': bolus_type,
            'carbs': carbs,
            'bg': bg,
        })
    return out


def selftest():
    """Feed pump-logs JSON events (the Tandem Source BFF shape) through
    build_trace — the same path production now takes. Covers basal, the
    bolus request→completion join, and a CGM reading."""
    os.environ['TZ'] = 'America/New_York'  # naive pump times are local (-05:00)

    def ev_json(code, seq, props):
        return {'eventCode': code, 'sequenceNumber': seq, 'sequenceGroup': 0,
                'pumpDateTime': '2025-11-18T13:12:40', 'eventProperties': props}

    fixtures = [
        ev_json(279, 1, {'commandedrate': 800}),                       # basal 0.8 U/hr
        ev_json(64, 2, {'bolusid': 7, 'bolustype': 0,                  # request: carbs/BG/type
                        'carbamount': 30, 'bg': 120}),
        ev_json(20, 3, {'bolusid': 7, 'insulindelivered': 2.5,         # completion
                        'insulinrequested': 2.5}),
        ev_json(399, 4, {'currentglucosedisplayvalue': 105,            # CGM (G7)
                         'glucosevaluestatus': 0}),
    ]
    trace = build_trace(Events(fixtures))
    by = {e['kind']: e for e in trace}
    assert set(by) == {'basal', 'bolus', 'cgm'}, [e['kind'] for e in trace]

    assert by['basal']['units'] == 0.8, by['basal']
    # all events share the fixture timestamp: 13:12:40-05:00 → 18:12:40 UTC
    assert by['basal']['at'] == '2025-11-18T18:12:40+00:00', by['basal']['at']
    assert by['basal']['date'] == '2025-11-18', by['basal']['date']

    b = by['bolus']
    assert b['units'] == 2.5 and b['requested'] == 2.5, b
    assert b['bolusType'] == 'Insulin' and b['carbs'] == 30 and b['bg'] == 120, b

    assert by['cgm']['mgdl'] == 105, by['cgm']

    # a completion with no matching request still emits, with null carb/BG/type
    lone = build_trace(Events([ev_json(20, 5, {'bolusid': 9, 'insulindelivered': 1.0,
                                               'insulinrequested': 1.0})]))
    assert len(lone) == 1 and lone[0]['carbs'] is None and lone[0]['bolusType'] is None, lone
    assert build_trace(Events([])) == []
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
    # Tandem retired the reportsfacade endpoints; 3.x uses the BFF API. Device
    # list is get_pumper().pumps; the log path key is assignmentId (UUID).
    device = pick_device(tconnect.tandemsource.get_pumper().get('pumps'))

    events = tconnect.tandemsource.pump_events(device['assignmentId'], start, end)
    out = build_trace(events)

    json.dump({
        'device': {
            'serialNumber': device.get('serialNumber'),
            'modelNumber': device.get('modelNumber'),
            'lastUpload': device.get('lastUploadDate'),
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
