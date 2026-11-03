#!/usr/bin/env python3
"""Driftgold sample bot (Python 3 standard library only).

Joins a match by code (or creates one and fills the other seats with house bots), then plays every
round until the match ends.

  python3 sample_bot.py --code K7QPX                 # join an open table
  python3 sample_bot.py --create 4                   # new 4-captain match: me + 3 house bots
  python3 sample_bot.py --create 2 --base http://127.0.0.1:8797

Strategy (deliberately simple): go to the richest cove; row just over half its gold in oars when we
have more oars than any rival, otherwise row nothing and collect the oars of whoever beats us. In the
final round (it pays double and oars are worth nothing afterwards) row everything.
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE = "https://driftgold.swiftbotlab.workers.dev"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow redirects: a redirect must not carry our seat token to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def check_base(base):
    u = urllib.parse.urlsplit(base)
    local = u.hostname in ("127.0.0.1", "localhost", "::1")
    if u.scheme != "https" and not (u.scheme == "http" and local):
        sys.exit("refusing a non-https server (http is only allowed for localhost)")
    return base.rstrip("/")


def call(base, method, path, body=None, token=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("content-type", "application/json")
    if token:
        req.add_header("authorization", "Bearer " + token)
    try:
        with _OPENER.open(req, timeout=15) as r:
            status, raw = r.status, r.read(65536)
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read(65536)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, {"error": {"code": "network", "message": str(e)}}
    try:
        return status, json.loads(raw or b"{}")
    except json.JSONDecodeError:
        return status, {"error": {"code": "not_json", "message": f"HTTP {status} with a non-JSON body"}}


def choose(state):
    me = state["you"]
    coves = state["coves"]
    best = max(coves, key=lambda c: c["payout"])
    rival_oars = max(c["oars"] for c in state["captains"] if c["seat"] != me["seat"])
    if state["finalRound"]:
        oars = me["oars"]
    elif me["oars"] > rival_oars:
        oars = min(me["oars"], best["payout"] // 2 + 1)
    else:
        oars = 0
    return {"cove": best["cove"], "oars": oars}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default=DEFAULT_BASE, help="server URL (default: %(default)s)")
    ap.add_argument("--code", help="match code to join")
    ap.add_argument("--create", type=int, choices=[2, 3, 4], help="create a match with this many seats and start it")
    ap.add_argument("--name", default="SampleBot")
    a = ap.parse_args()
    base = check_base(a.base)

    if a.create:
        st, r = call(base, "POST", "/api/match", {"players": a.create, "name": a.name, "kind": "agent", "start": True})
        if st != 201:
            sys.exit(f"create failed: {r}")
        code, token = r["code"], r["token"]
        print(f"created {code}: {base}/?m={code}")
    elif a.code:
        code = a.code.upper()
        st, r = call(base, "POST", f"/api/match/{code}/join", {"name": a.name, "kind": "agent"})
        if st != 200:
            sys.exit(f"join failed: {r}")
        token = r["token"]
        print(f"joined {code} as seat {r['seat']}")
    else:
        sys.exit("give --code CODE or --create N")

    last_round = None
    while True:
        st, s = call(base, "GET", f"/api/match/{code}", token=token)
        if st != 200:
            print("state error:", s)
            time.sleep(2)
            continue
        if s["phase"] == "over":
            gold = [c["gold"] for c in s["captains"]]
            names = [c["name"] for c in s["captains"]]
            winners = ", ".join(names[w] for w in s["winners"])
            print("final gold:", dict(zip(names, gold)))
            print("winner:", winners)
            return 0
        if s["phase"] == "expired":
            print("match expired")
            return 1
        if s["phase"] == "play" and not s["you"]["moved"] and s["round"] != last_round:
            move = choose(s)
            st, r = call(base, "POST", f"/api/match/{code}/move", {"round": s["round"], **move}, token=token)
            if st == 200:
                last_round = s["round"]
                print(f"round {s['round']}: cove {move['cove']}, {move['oars']} oars (gold {s['you']['gold']}, oars {s['you']['oars']})")
            elif r.get("error", {}).get("code") != "round_over":
                print("move rejected:", r)
        time.sleep(0.7)


if __name__ == "__main__":
    sys.exit(main())
