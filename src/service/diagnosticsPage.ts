// The page served by diagnostics.ts. One self-contained document: no external files, since the
// car may have no internet. All server data is put in with textContent, never as HTML.
export const DIAG_PAGE = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>amr-core 診斷</title>
<style>
  :root { --bg:#f4f6f8; --card:#fff; --text:#1f2933; --sub:#617080; --line:#d9e0e6; --ok:#1b7f3b; --okbg:#e3f5e9; --warn:#a15c00; --warnbg:#fff1d6; --err:#b42318; --errbg:#fde4e1; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12171c; --card:#1b232b; --text:#e6ebef; --sub:#9aa7b3; --line:#2c3843; --ok:#6fd08c; --okbg:#173326; --warn:#f0b35a; --warnbg:#3a2d12; --err:#ff8a80; --errbg:#401c19; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px; background:var(--bg); color:var(--text); font:16px/1.5 "Noto Sans CJK TC","Microsoft JhengHei",system-ui,sans-serif; }
  main { max-width: 980px; margin: 0 auto; display:grid; gap:14px; }
  header { display:flex; flex-wrap:wrap; gap:6px 18px; align-items:baseline; }
  header h1 { margin:0; font-size:20px; }
  header span { color:var(--sub); font-size:14px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px 16px; }
  h2 { margin:0 0 8px; font-size:15px; color:var(--sub); font-weight:600; }
  .banner { border-radius:8px; padding:16px; border:1px solid transparent; }
  .banner.ok { background:var(--okbg); color:var(--ok); border-color:var(--ok); }
  .banner.warn { background:var(--warnbg); color:var(--warn); border-color:var(--warn); }
  .banner.error { background:var(--errbg); color:var(--err); border-color:var(--err); }
  .banner b { font-size:20px; display:block; }
  .banner p { margin:6px 0 0; color:var(--text); }
  .item { padding:8px 0; border-top:1px solid var(--line); } .item:first-child { border-top:0; }
  .item b.error { color:var(--err); } .item b.warn { color:var(--warn); } .item b.ok { color:var(--ok); }
  .item p { margin:2px 0 0; color:var(--sub); font-size:14px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:6px 8px; border-top:1px solid var(--line); vertical-align:top; }
  th { color:var(--sub); font-weight:600; border-top:0; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; background:var(--err); }
  .dot.on { background:var(--ok); } .dot.na { background:var(--sub); }
  .cols { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:14px; }
  ul { margin:0; padding:0; list-style:none; font-size:14px; } li { padding:3px 0; border-top:1px solid var(--line); } li:first-child { border-top:0; }
  .mono { font-family:ui-monospace,Menlo,Consolas,monospace; word-break:break-all; }
  footer { color:var(--sub); font-size:12px; text-align:center; }
</style>
</head>
<body>
<main>
  <header><h1>amr-core 診斷</h1><span id="car"></span><span id="ver"></span></header>
  <div id="banner" class="banner warn"><b>讀取中…</b></div>
  <section><h2>檢查結果</h2><div id="items"></div></section>
  <section><h2>四條連線</h2>
    <table><thead><tr><th>連線</th><th>狀態</th><th>持續</th><th>對象</th><th>最後的錯誤</th></tr></thead><tbody id="links"></tbody></table>
  </section>
  <div class="cols">
    <section><h2>車端資料多久前更新 (沒有更新 = 車端沒在送)</h2><ul id="data"></ul></section>
    <section><h2>網路測試 (每 5 秒)</h2><ul id="probes"></ul></section>
    <section><h2>任務</h2><ul id="mission"></ul></section>
  </div>
  <section><h2>最近的事件 (新的在上面)</h2><ul id="events"></ul></section>
  <footer id="foot">這個頁面只能看, 不能改任何設定。amr-core 沒在跑的時候這個頁面打不開: 請在車上執行 systemctl status kenmec-amr-core。</footer>
</main>
<script>
const $ = (id) => document.getElementById(id);
const dur = (ms) => {
  if (ms === null || ms === undefined) return "從未";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + " 秒";
  if (s < 3600) return Math.floor(s / 60) + " 分 " + (s % 60) + " 秒";
  return Math.floor(s / 3600) + " 小時 " + Math.floor((s % 3600) / 60) + " 分";
};
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const fill = (id, nodes) => { const box = $(id); box.replaceChildren(...nodes); };
const li = (text) => el("li", "", text);
const probeText = (p, okLabel) => {
  if (!p) return "測試中…";
  if (p.ok === null) return p.error;
  return p.ok ? okLabel + (p.ms !== undefined ? " (" + Math.round(p.ms) + " ms)" : "") : "不通: " + (p.error || "");
};
async function refresh() {
  try {
    const r = await fetch("/api/status", { cache: "no-store" });
    const d = await r.json();
    $("car").textContent = (d.car.amrId ? d.car.amrId + "  " : "") + d.car.mac + "  " + (d.car.ips.length ? d.car.ips.map((ip) => ip + ":" + d.car.port).join("  ") : "");
    $("ver").textContent = "版本 " + d.car.version + " · 已運行 " + dur(d.car.uptimeMs);
    const h = d.headline;
    const b = $("banner");
    b.className = "banner " + (h ? h.level : "warn");
    b.replaceChildren(el("b", "", h ? h.title : "沒有資料"), el("p", "", h ? h.hint : ""));
    fill("items", d.items.map((i) => { const row = el("div", "item"); row.append(el("b", i.level, i.title), el("p", "", i.hint)); return row; }));
    fill("links", d.links.map((l) => {
      const tr = el("tr");
      const status = el("td"); status.append(el("span", "dot " + (l.connected ? "on" : "")), document.createTextNode(l.connected ? "已連上" : "斷線"));
      tr.append(el("td", "", l.label), status, el("td", "", dur(l.ageMs)), el("td", "mono", l.target), el("td", "mono", l.connected ? "" : l.lastError));
      return tr;
    }));
    fill("data", [
      li("定位 pose: " + dur(d.data.pose)), li("任務狀態 has_mission: " + dur(d.data.hasMission)), li("車況 io_info: " + dur(d.data.ioInfo)),
      li("交管的心跳: " + dur(d.data.qamsHeartbeat)), li("AMR service 的心跳: " + dur(d.data.amrServiceHeartbeat)),
    ]);
    fill("probes", [
      li("ping 交管電腦 " + (d.probes.ping ? d.probes.ping.target : "") + ": " + probeText(d.probes.ping, "通")),
      li("RabbitMQ " + (d.probes.rabbit ? d.probes.rabbit.target : "") + ": " + probeText(d.probes.rabbit, "通")),
      li("rosbridge " + (d.probes.ros ? d.probes.ros.target : "") + ": " + probeText(d.probes.ros, "通")),
    ]);
    const m = d.mission;
    fill("mission", [
      li("記錄的任務: " + (m.goalId || "無") + (m.type ? " (" + m.type + ")" : "")),
      li("等交管確認的結果: " + (m.pendingResult || "無")),
      li("車端回報: has_mission=" + (m.carHasMission === null ? "還沒報" : m.carHasMission) + "  正在跑: " + (m.runningGoalId || "無")),
      li("上次對帳: " + (m.reconcile ? m.reconcile.code + " " + m.reconcile.message + " (" + dur(m.reconcile.ageMs) + "前)" : "還沒有")),
    ]);
    fill("events", d.events.length ? d.events.map((e) => li(dur(e.ageMs) + "前  " + e.text)) : [li("沒有")]);
    $("foot").dataset.ok = "1";
  } catch (e) {
    const b = $("banner");
    b.className = "banner error";
    b.replaceChildren(el("b", "", "連不到 amr-core"), el("p", "", "這個頁面是 amr-core 提供的: amr-core 剛重啟、已停止, 或車的網路不通。請在車上執行 systemctl status kenmec-amr-core。"));
  }
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
