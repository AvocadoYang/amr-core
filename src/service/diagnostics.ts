import * as http from "http";
import * as net from "net";
import * as os from "os";
import { execFile, execFileSync } from "child_process";
import { URL } from "url";
import * as ROS from "../ros";
import { IFACE_NAME, MAC, DIAG_PORT, RABBIT_MQ_HOST, RABBIT_MQ_PORT, ROS_BRIDGE_URL } from "../configs";
import { errorLogger, infoLogger } from "~/logger/logger";
import { AMR_STATUS, MISSION_STATUS, TRANSACTION_INFO } from "~/types/status";
import CarState from "./carState";
import { DIAG_PAGE } from "./diagnosticsPage";

/**
 * Read-only status page for the person standing next to the car ("why does the traffic
 * computer show this car offline?"): which of the four links is down, for how long, why, and
 * what to check. Served on DIAG_PORT (default 6060), no login, nothing on it can change
 * anything. The same summary rides in the heartbeat answer so the backend can show it too.
 */

type LinkName = "ros" | "amrService" | "rabbit" | "qams";
type Link = { connected: boolean; since: number; lastError: string; lastErrorAt: number };
type Probe = { ok: boolean | null; ms?: number; error?: string; at: number };
type Item = { level: "error" | "warn" | "ok"; title: string; hint: string };

// data from the AMR older than this counts as "not coming"
const DATA_STALE_MS = 10000;
const PROBE_EVERY_MS = 5000;
const EVENT_LIMIT = 60;

const LINK_LABEL: Record<LinkName, string> = {
  ros: "ROS bridge (車端程式)",
  amrService: "AMR service (車端)",
  rabbit: "RabbitMQ (交管電腦)",
  qams: "QAMS 登入 (交管程式)",
};

const age = (t: number) => (t ? Date.now() - t : null);

const tcpProbe = (host: string, port: number, timeoutMs = 2500): Promise<Probe> =>
  new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const finish = (p: Omit<Probe, "at">) => {
      socket.destroy();
      resolve({ ...p, at: Date.now() });
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: "逾時" }));
    socket.once("connect", () => finish({ ok: true, ms: Date.now() - started }));
    socket.once("error", (e: NodeJS.ErrnoException) => finish({ ok: false, error: e.code || e.message }));
  });

const pingProbe = (host: string): Promise<Probe> =>
  new Promise((resolve) => {
    execFile("ping", ["-c", "1", "-W", "1", host], { timeout: 3000 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ ok: null, error: "這台車沒有 ping 指令", at: Date.now() });
        return;
      }
      const m = /time[=<]([\d.]+)\s*ms/.exec(String(stdout));
      resolve(err || !m ? { ok: false, error: "沒有回應", at: Date.now() } : { ok: true, ms: Number(m[1]), at: Date.now() });
    });
  });

const rosEndpoint = () => {
  try {
    const u = new URL(ROS_BRIDGE_URL);
    return { host: u.hostname, port: Number(u.port) || 9090 };
  } catch {
    return { host: "127.0.0.1", port: 9090 };
  }
};

const readVersion = () => {
  try {
    return execFileSync("git", ["describe", "--always", "--dirty"], { cwd: process.cwd(), timeout: 2000 })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
};

const localIps = () => {
  const all = os.networkInterfaces();
  const pick = (names: string[]) =>
    names.flatMap((n) =>
      (all[n] || []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => `${a.address}`)
    );
  const preferred = pick([IFACE_NAME]);
  return preferred.length ? preferred : pick(Object.keys(all));
};

export default class Diagnostics {
  private startedAt = Date.now();
  private version = readVersion();
  private links: Record<LinkName, Link> = {
    ros: { connected: false, since: Date.now(), lastError: "", lastErrorAt: 0 },
    amrService: { connected: false, since: Date.now(), lastError: "", lastErrorAt: 0 },
    rabbit: { connected: false, since: Date.now(), lastError: "", lastErrorAt: 0 },
    qams: { connected: false, since: Date.now(), lastError: "", lastErrorAt: 0 },
  };
  private events: { at: number; text: string }[] = [];
  private seen = { pose: 0, hasMission: 0, ioInfo: 0 };
  private probes: { ping?: Probe; rabbit?: Probe; ros?: Probe } = {};
  private probing = false;
  private reconcile = { code: "", message: "", at: 0 };
  private reconcileBegan = 0;
  private chAttempts = 0;
  private qamsErrorSource: () => { message: string; at: number } = () => ({ message: "", at: 0 });
  private heartbeatSource: () => { qamsAt: number; amrServiceAt: number } = () => ({ qamsAt: 0, amrServiceAt: 0 });
  private rabbitErrorSource: () => { message: string; at: number } = () => ({ message: "", at: 0 });

  constructor(
    private info: TRANSACTION_INFO,
    private missionStatus: MISSION_STATUS,
    private amrStatus: AMR_STATUS,
    private carState: CarState
  ) {
    ROS.pose$.subscribe(() => (this.seen.pose = Date.now()));
    ROS.getIOInfo$.subscribe(() => (this.seen.ioInfo = Date.now()));
    ROS.has_mission.subscribe(() => (this.seen.hasMission = Date.now()));
    ROS.connectionError$.subscribe((e) => {
      const message = (e as { message?: string })?.message || "websocket 連線失敗";
      this.links.ros.lastError = message;
      this.links.ros.lastErrorAt = Date.now();
    });
    this.addEvent(`amr-core 啟動 (${this.version})`);
    void this.runProbes();
    setInterval(() => void this.runProbes(), PROBE_EVERY_MS).unref();
    this.listen();
  }

  // ---- fed by main.ts and the services ------------------------------------------------

  public attachSources(src: {
    qamsError: () => { message: string; at: number };
    rabbitError: () => { message: string; at: number };
    heartbeat: () => { qamsAt: number; amrServiceAt: number };
  }) {
    this.qamsErrorSource = src.qamsError;
    this.rabbitErrorSource = src.rabbitError;
    this.heartbeatSource = src.heartbeat;
  }

  public setLinks(c: { qams: boolean; rabbit: boolean; ros: boolean; amrService: boolean }) {
    (Object.keys(c) as LinkName[]).forEach((name) => {
      const link = this.links[name];
      if (link.connected === c[name]) return;
      link.connected = c[name];
      link.since = Date.now();
      this.addEvent(`${LINK_LABEL[name]} ${c[name] ? "已連上" : "斷線"}`);
    });
  }

  public reconcileBegin() {
    if (!this.reconcileBegan) {
      this.reconcileBegan = Date.now();
      this.chAttempts = 0;
    }
  }

  public reconcileAttempt() {
    this.chAttempts++;
  }

  public reconcileEnd() {
    this.reconcileBegan = 0;
  }

  public setReconcile(code: string, message: string) {
    this.reconcile = { code, message, at: Date.now() };
    this.addEvent(`QAMS 對帳結果 ${code} ${message}`);
  }

  // ---- what the backend gets in every heartbeat answer ---------------------------------

  public summary() {
    const sec = (t: number) => Math.round((Date.now() - t) / 1000);
    const l = this.links;
    return {
      v: this.version,
      up: sec(this.startedAt),
      ip: localIps()[0] || "",
      port: DIAG_PORT,
      ros: { c: l.ros.connected, s: sec(l.ros.since), e: l.ros.connected ? "" : l.ros.lastError },
      svc: { c: l.amrService.connected, s: sec(l.amrService.since) },
      rb: { c: l.rabbit.connected, s: sec(l.rabbit.since) },
      q: { c: l.qams.connected, s: sec(l.qams.since) },
    };
  }

  // ---- snapshot for the page ----------------------------------------------------------

  private addEvent(text: string) {
    this.events.unshift({ at: Date.now(), text });
    if (this.events.length > EVENT_LIMIT) this.events.length = EVENT_LIMIT;
  }

  private async runProbes() {
    if (this.probing) return;
    this.probing = true;
    try {
      const ros = rosEndpoint();
      const [ping, rabbit, rosTcp] = await Promise.all([
        pingProbe(RABBIT_MQ_HOST),
        tcpProbe(RABBIT_MQ_HOST, RABBIT_MQ_PORT),
        tcpProbe(ros.host, ros.port),
      ]);
      this.probes = { ping, rabbit, ros: rosTcp };
    } catch {
      // probes are best effort
    } finally {
      this.probing = false;
    }
  }

  private diagnose(): Item[] {
    const items: Item[] = [];
    const L = this.links;
    const P = this.probes;
    const ros = rosEndpoint();
    const rosErr = L.ros.lastError ? ` (${L.ros.lastError})` : "";

    if (!L.ros.connected) {
      if (P.ros && P.ros.ok === false) {
        items.push({
          level: "error",
          title: `ROS bridge 連不上 ${ROS_BRIDGE_URL}`,
          hint: `${ros.host}:${ros.port} 沒有程式在聽${rosErr}。車端程式或 rosbridge 沒開: 檢查車端程式有沒有啟動、rosbridge_websocket 有沒有在跑。`,
        });
      } else {
        items.push({
          level: "error",
          title: `ROS bridge 的連線失敗 ${ROS_BRIDGE_URL}`,
          hint: `通訊埠通, 但 websocket 連不上${rosErr}。rosbridge 可能剛啟動或卡住, 重啟 rosbridge 再看。`,
        });
      }
    } else {
      const stale = (["pose", "hasMission", "ioInfo"] as const).filter((k) => {
        const a = age(this.seen[k]);
        return a === null || a > DATA_STALE_MS;
      });
      if (stale.length) {
        const names = { pose: "定位 (pose)", hasMission: "任務狀態 (has_mission)", ioInfo: "車況 (io_info)" };
        items.push({
          level: "warn",
          title: "ROS bridge 連著, 但車端沒有送資料",
          hint: `超過 10 秒沒收到: ${stale.map((k) => names[k]).join("、")}。rosbridge 有開, 車端程式 (定位、任務節點) 可能沒開。`,
        });
      }
    }

    const hb = this.heartbeatSource();
    if (!L.amrService.connected) {
      const last = hb.amrServiceAt ? `最後一次收到 AMR service 心跳是 ${Math.round((Date.now() - hb.amrServiceAt) / 1000)} 秒前` : "開機以來沒收過 AMR service 心跳";
      items.push({
        level: "error",
        title: "AMR service 沒有連到 amr-core",
        hint: `${last}。車端的 AMR service 沒開或已停止 (它要連到這台的 TCP 8532)。`,
      });
    }

    if (!L.rabbit.connected) {
      const e = this.rabbitErrorSource();
      const err = e.message ? ` 最後的錯誤: ${e.message}` : "";
      if (P.ping && P.ping.ok === false) {
        items.push({
          level: "error",
          title: `連不上交管電腦 ${RABBIT_MQ_HOST} (ping 不通)`,
          hint: `網路不通: 檢查車上的網路線 / WiFi 有沒有連上、交管電腦有沒有開機、amr-core 設定的 IP 對不對。${err}`,
        });
      } else if (P.rabbit && P.rabbit.ok === false) {
        items.push({
          level: "error",
          title: `${RABBIT_MQ_HOST}:${RABBIT_MQ_PORT} 連不上 (RabbitMQ)`,
          hint: `主機找得到, 但 RabbitMQ 的通訊埠不通 (${P.rabbit.error}): 交管電腦的 RabbitMQ 沒開, 或防火牆擋住。${err}`,
        });
      } else {
        items.push({
          level: "error",
          title: "通訊埠通, 但 RabbitMQ 登入失敗",
          hint: `檢查 amr-core 設定的帳號密碼。${err}`,
        });
      }
    } else if (!L.qams.connected) {
      const e = this.qamsErrorSource();
      items.push({
        level: "error",
        title: "已連上 RabbitMQ, 但沒有向 QAMS 登入",
        hint: `交管程式 (backend) 沒開, 或交管裡沒有登錄這台車 (序號 ${MAC})。${e.message ? ` 最後的錯誤: ${e.message}` : ""}`,
      });
    }

    if (L.ros.connected && L.amrService.connected && L.rabbit.connected && L.qams.connected) {
      if (this.reconcileBegan) {
        const secs = Math.round((Date.now() - this.reconcileBegan) / 1000);
        items.push(
          secs > 15
            ? {
                level: "warn",
                title: `對帳卡住 (已 ${secs} 秒, 重送 ${this.chAttempts} 次)`,
                hint: "已經登入, 但交管沒有回應對帳。交管的 amr-core 版本可能不一致 (交管跟車上的 amr-core 要同一批版本), 或交管正在忙。",
              }
            : { level: "ok", title: `對帳中 (${secs} 秒)`, hint: "剛連上, 正在跟交管核對任務。" }
        );
      } else {
        items.push({ level: "ok", title: "四條連線都正常", hint: "如果交管仍顯示離線, 請看交管電腦上這台車卡片的原因。" });
      }
    }
    return items;
  }

  public snapshot() {
    const items = this.diagnose();
    const hb = this.heartbeatSource();
    const rosEp = rosEndpoint();
    const links = (Object.keys(this.links) as LinkName[]).map((name) => {
      const l = this.links[name];
      const extra =
        name === "rabbit"
          ? `${RABBIT_MQ_HOST}:${RABBIT_MQ_PORT}`
          : name === "ros"
            ? ROS_BRIDGE_URL
            : name === "amrService"
              ? "TCP 8532 (等車端連進來)"
              : `序號 ${MAC}`;
      const lastError =
        name === "rabbit" ? this.rabbitErrorSource().message : name === "qams" ? this.qamsErrorSource().message : l.lastError;
      return { name, label: LINK_LABEL[name], connected: l.connected, ageMs: age(l.since), target: extra, lastError };
    });
    return {
      now: Date.now(),
      car: { amrId: this.info.amrId, mac: MAC, ips: localIps(), port: DIAG_PORT, version: this.version, uptimeMs: Date.now() - this.startedAt },
      // a real error beats a warning, a warning beats "all fine"
      headline: items.find((i) => i.level === "error") || items.find((i) => i.level === "warn") || items[0] || null,
      items,
      links,
      data: {
        pose: age(this.seen.pose),
        hasMission: age(this.seen.hasMission),
        ioInfo: age(this.seen.ioInfo),
        qamsHeartbeat: age(hb.qamsAt),
        amrServiceHeartbeat: age(hb.amrServiceAt),
      },
      probes: {
        ping: this.probes.ping ? { target: RABBIT_MQ_HOST, ...this.probes.ping } : null,
        rabbit: this.probes.rabbit ? { target: `${RABBIT_MQ_HOST}:${RABBIT_MQ_PORT}`, ...this.probes.rabbit } : null,
        ros: this.probes.ros ? { target: `${rosEp.host}:${rosEp.port}`, ...this.probes.ros } : null,
      },
      mission: {
        goalId: this.missionStatus.lastSendGoalId,
        type: this.missionStatus.missionType,
        pendingResult: this.missionStatus.pendingReadStatus?.id ? this.missionStatus.pendingReadStatus.read.feedback_id : "",
        carHasMission: this.carState.getHasMission(),
        runningGoalId: this.carState.getRunningGoalId(),
        legacyFlag: this.amrStatus.amrHasMission,
        session: this.info.session,
        reconcile: this.reconcile.at ? { ...this.reconcile, ageMs: age(this.reconcile.at) } : null,
      },
      events: this.events.map((e) => ({ ageMs: Date.now() - e.at, text: e.text })),
    };
  }

  private listen() {
    if (!DIAG_PORT) return;
    const server = http.createServer((req, res) => {
      const url = (req.url || "/").split("?")[0];
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      if (url === "/api/status") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(this.snapshot()));
        return;
      }
      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(DIAG_PAGE);
        return;
      }
      res.writeHead(404).end();
    });
    server.on("error", (e: NodeJS.ErrnoException) => {
      // a taken port must never keep amr-core from running
      errorLogger.error(`diagnostics page can not listen on ${DIAG_PORT}: ${e.code || e.message}`, {
        title: "system",
        type: "diagnostics",
      });
    });
    server.listen(DIAG_PORT, "0.0.0.0", () => {
      infoLogger.info(`diagnostics page: http://${localIps()[0] || "<車的 IP>"}:${DIAG_PORT}`, {
        title: "system",
        type: "diagnostics",
      });
    });
  }
}
