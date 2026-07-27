"""Reusable gpredict faketime pass helpers (scenario-2 · DEMOSAT uplink).

Pure logic only — no HTTP. control.py wires this to env vars + a status server.

Model (per the scn2 demo brief):
  · On phase-3 entry the satellite is placed LEAD seconds BEFORE a fixed pass AOS,
    then time runs at REAL rate → the participant waits ~LEAD s, the satellite
    enters range, they TRANSMIT during the natural pass.
  · Every RESET_INTERVAL seconds it re-arms (jumps back to LEAD-before-AOS) as a
    safety net for a missed pass.

This reuses scenario-1's libfaketime-offset mechanism (write "%+ds" to a file that
gpredict reads live under FAKETIME_NO_CACHE=1) but, unlike scn1, never restarts
gpredict — so the rotator (rotctld → OpenVSA) stays engaged across re-arms.
"""
import time
import calendar
import datetime
import threading


def parse_qth(path):
    """Read LAT/LON (deg) and ALT (m) from a gpredict .qth file."""
    lat = lon = alt = 0.0
    with open(path) as f:
        for line in f:
            if line.startswith("LAT="):
                lat = float(line.split("=", 1)[1])
            elif line.startswith("LON="):
                lon = float(line.split("=", 1)[1])
            elif line.startswith("ALT="):
                alt = float(line.split("=", 1)[1])
    return lat, lon, alt


def read_tle(path):
    """Return (name, line1, line2) from a .tle file."""
    lines = [l.rstrip("\n") for l in open(path) if l.strip()]
    return lines[0], lines[1], lines[2]


def find_pass(qth_path, tle_path, min_alt=15.0, max_alt=45.0, search=40):
    """Next pass whose peak elevation is in the [min_alt, max_alt] "grazing" band
    (so the satellite crosses NEAR the station, not straight overhead — the
    "절묘하게 스쳐 지나가는" look). Returns (aos_unix, los_unix, max_alt_deg).
    Falls back to the highest pass found if none land in the band."""
    import ephem
    import math
    lat, lon, alt = parse_qth(qth_path)
    l0, l1, l2 = read_tle(tle_path)
    obs = ephem.Observer()
    obs.lat = str(lat)
    obs.lon = str(lon)
    obs.elevation = alt
    obs.date = ephem.now()
    sat = ephem.readtle(l0, l1, l2)
    best = None
    for _ in range(search):
        info = obs.next_pass(sat)          # rise, rise_az, max_t, max_alt, set, set_az
        rise_t, set_t = info[0], info[4]
        if rise_t is None or set_t is None:
            break
        a = float(info[3]) * 180.0 / math.pi
        aos = calendar.timegm(rise_t.datetime().timetuple())
        los = calendar.timegm(set_t.datetime().timetuple())
        if los <= aos:
            los = aos + 60
        if best is None or a > best[2]:
            best = (aos, los, a)           # highest pass = fallback
        if min_alt <= a <= max_alt:
            return aos, los, a
        obs.date = ephem.Date(set_t + ephem.minute)   # step past this pass
    return best if best else (int(time.time()), int(time.time()) + 600, 0.0)


def sub_point(tle_path, when_unix):
    """Sub-satellite geographic point (lat_deg, lon_deg) at a UTC unix time.
    Same TLE + same (faked) clock gpredict uses → the victim GS map can plot the
    identical position. Longitude is normalised to [-180, 180]."""
    import ephem
    import math
    l0, l1, l2 = read_tle(tle_path)
    sat = ephem.readtle(l0, l1, l2)
    sat.compute(ephem.Date(datetime.datetime.utcfromtimestamp(when_unix)))
    lat = math.degrees(sat.sublat)
    lon = ((math.degrees(sat.sublong) + 180.0) % 360.0) - 180.0
    return lat, lon


def look_angles(qth_path, tle_path, when_unix):
    """Satellite look-angles from the QTH at a given UTC unix time:
    (elevation_deg, azimuth_deg, range_km). Used to show the participant the
    live distance and whether the satellite is above the horizon (in range)."""
    import ephem
    import math
    lat, lon, alt = parse_qth(qth_path)
    l0, l1, l2 = read_tle(tle_path)
    obs = ephem.Observer()
    obs.lat = str(lat)
    obs.lon = str(lon)
    obs.elevation = alt
    obs.date = ephem.Date(datetime.datetime.utcfromtimestamp(when_unix))
    sat = ephem.readtle(l0, l1, l2)
    sat.compute(obs)
    return math.degrees(sat.alt), math.degrees(sat.az), sat.range / 1000.0


def write_offset(ft_file, seconds):
    """Write a libfaketime offset (same '%+ds' format scenario-1 uses)."""
    with open(ft_file, "w") as f:
        f.write("%+ds" % int(round(seconds)))


def read_offset_ms(ft_file):
    """Current libfaketime offset in ms (status / VSA alignment)."""
    try:
        s = open(ft_file).read().strip().rstrip("s")
        return int(float(s)) * 1000
    except Exception:
        return 0


class PassArmer(threading.Thread):
    """Place gpredict LEAD seconds before a fixed pass AOS, then let its clock run
    at real rate. Re-arms every `interval` seconds, and arm() may be called on
    demand (phase-3 entry). Runs OUTSIDE libfaketime, so time.time() is real."""

    def __init__(self, ft_file, aos_unix, lead=20, interval=300):
        super().__init__(daemon=True)
        self.ft = ft_file
        self.aos = float(aos_unix)
        self.lead = float(lead)
        self.interval = float(interval)
        self._lock = threading.Lock()
        self._next = 0.0
        self.last_arm = 0.0
        self.arm_count = 0
        self.enabled = True

    def arm(self):
        """Jump the faked clock to (AOS - lead) as of now; reset the re-arm timer."""
        with self._lock:
            now = time.time()
            write_offset(self.ft, (self.aos - self.lead) - now)
            self.last_arm = now
            self._next = now + self.interval
            self.arm_count += 1
        return self.last_arm

    def seconds_to_rearm(self):
        return max(0.0, self._next - time.time())

    def run(self):
        self.arm()                          # arm once at startup
        while True:
            if self.enabled and time.time() >= self._next:
                self.arm()
            time.sleep(1)
