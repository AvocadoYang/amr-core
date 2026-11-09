import { execFile } from "child_process";
import * as fs from "fs";

/**
 * WiFi status of this car, for the traffic computer's network map (heat map of signal
 * strength / access-point changes) and for the diagnostics page.
 *
 * Read every few seconds from Linux, no extra package required:
 *  - /proc/net/wireless lists the wireless interfaces and their signal level (dBm)
 *  - `iw dev <iface> link` adds the access point (BSSID), frequency and tx bitrate when `iw` is installed
 * Uses IFACE_NAME when it is a wireless interface, otherwise the first wireless one.
 * A car whose computer reaches the network through a cable to a WiFi bridge has no wireless
 * interface: then this stays null (the bridge's own signal is not visible from here).
 */

/** s = signal dBm, b = BSSID (lower case, "" = unknown), f = MHz, r = tx bitrate Mbit/s */
export type WifiInfo = { s: number; b: string; f?: number; r?: number };

const IW_TIMEOUT_MS = 2000;

/** `iw dev <iface> link` output; null when not connected or no signal line */
export const parseIwLink = (text: string): WifiInfo | null => {
  if (/not connected/i.test(text)) return null;
  const signal = /signal:\s*(-?\d+(?:\.\d+)?)\s*dBm/i.exec(text);
  if (!signal) return null;
  const bssid = /Connected to\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i.exec(text)?.[1] ?? "";
  const freq = /freq:\s*(\d+(?:\.\d+)?)/i.exec(text);
  const rate = /tx bitrate:\s*(\d+(?:\.\d+)?)\s*MBit\/s/i.exec(text);
  return {
    s: Math.round(Number(signal[1])),
    b: bssid.toLowerCase(),
    ...(freq ? { f: Math.round(Number(freq[1])) } : {}),
    ...(rate ? { r: Number(rate[1]) } : {}),
  };
};

/**
 * /proc/net/wireless, e.g.
 *   Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE
 *    face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22
 *   wlan0: 0000   54.  -56.  -256        0      0      0      0     34        0
 * Old drivers report the level as an unsigned byte (200 = -56 dBm).
 */
export const parseProcWireless = (text: string): { iface: string; signal: number }[] =>
  text
    .split("\n")
    .slice(2)
    .map((line) => /^\s*([^:\s]+):\s+\S+\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => {
      let level = Math.round(parseFloat(m[3]));
      if (level > 0) level -= 256;
      return { iface: m[1], signal: level };
    });

const readProcWireless = (): { iface: string; signal: number }[] => {
  try {
    return parseProcWireless(fs.readFileSync("/proc/net/wireless", "utf8"));
  } catch {
    return [];
  }
};

export class WifiProbe {
  private latest: WifiInfo | null = null;
  private iwMissing = false;
  private busy = false;

  constructor(private preferredIface: string) {}

  start(everyMs = 5000) {
    void this.probe();
    setInterval(() => void this.probe(), everyMs).unref();
  }

  /** null = no wireless interface / not connected / not read yet */
  get value(): WifiInfo | null {
    return this.latest;
  }

  private async probe() {
    if (this.busy) return;
    this.busy = true;
    try {
      const ifaces = readProcWireless();
      const iface = ifaces.find((i) => i.iface === this.preferredIface) ?? ifaces[0];
      if (!iface) {
        this.latest = null;
        return;
      }
      const fromIw = await this.iwLink(iface.iface);
      if (fromIw) {
        this.latest = fromIw;
        return;
      }
      this.latest = iface.signal < 0 && iface.signal > -120 ? { s: iface.signal, b: "" } : null;
    } finally {
      this.busy = false;
    }
  }

  private iwLink(iface: string): Promise<WifiInfo | null> {
    if (this.iwMissing) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile("iw", ["dev", iface, "link"], { timeout: IW_TIMEOUT_MS }, (err, stdout) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          this.iwMissing = true; // no `iw` on this car: /proc/net/wireless only (no BSSID)
          resolve(null);
          return;
        }
        resolve(err ? null : parseIwLink(String(stdout)));
      });
    });
  }
}
