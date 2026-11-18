/**
 * 車端充電鎖的測試 (yarn test): 不連 ROS / RabbitMQ, 用假的暫停發送器和暫存目錄。
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChargeLock } from "../src/service/chargeLock";

const PAUSE = 2;
const RESUME = 0;
const FINISH_THEN_PAUSE = 1;

function stop(t: number) {
  return JSON.stringify({ Id: `x${t}`, Action: "pauseTask", Time: 0, Device: "A", Body: { StopType: t } });
}

function setup(opts: { ros?: boolean; file?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "charge-lock-"));
  const file = opts.file ?? path.join(dir, "charge-lock.json");
  const published: string[] = [];
  const ros = { connected: opts.ros ?? true };
  const logs: string[] = [];
  const make = () =>
    new ChargeLock({
      publishPause: (p) => published.push(p),
      isRosConnected: () => ros.connected,
      amrId: () => "A",
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
      file,
    });
  const lock = make();
  const types = () => published.map((p) => JSON.parse(p).Body.StopType as number);
  return { dir, file, published, ros, logs, lock, make, types };
}

test("上鎖: 馬上送立即暫停, 回覆鎖好了而且暫停有送到", () => {
  const h = setup();
  const r = h.lock.handle(true, "伸桿");
  assert.deepEqual(r, { locked: true, paused: true });
  assert.deepEqual(h.types(), [PAUSE]);
  h.lock.dispose();
});

test("ROS 沒連: 回覆 paused = false (QAMS 就不伸桿)", () => {
  const h = setup({ ros: false });
  const r = h.lock.handle(true, "伸桿");
  assert.deepEqual(r, { locked: true, paused: false });
  assert.deepEqual(h.published, []);
  h.lock.dispose();
});

test("上鎖中: 放行和「做完再停」擋下, 立即暫停照送", () => {
  const h = setup();
  h.lock.handle(true, "伸桿");
  h.published.length = 0;
  assert.equal(h.lock.onStopRequest(stop(RESUME)), false);
  assert.equal(h.lock.onStopRequest(stop(FINISH_THEN_PAUSE)), false);
  assert.equal(h.lock.onStopRequest("not json"), false);
  assert.equal(h.lock.onStopRequest(stop(PAUSE)), true);
  assert.deepEqual(h.types(), [PAUSE]);
  h.lock.dispose();
});

test("沒上鎖: 暫停 / 放行照原樣送", () => {
  const h = setup();
  assert.equal(h.lock.onStopRequest(stop(RESUME)), true);
  assert.equal(h.lock.onStopRequest(stop(PAUSE)), true);
  assert.deepEqual(h.types(), [RESUME, PAUSE]);
});

test("解鎖: 補送上鎖期間被擋下的最後一個 (先放行後解鎖也不會卡住)", () => {
  const h = setup();
  h.lock.handle(true, "伸桿");
  h.lock.onStopRequest(stop(RESUME)); // QAMS 的放行比解鎖先到
  h.published.length = 0;
  assert.deepEqual(h.lock.handle(false, "收好了"), { locked: false, paused: false });
  assert.deepEqual(h.types(), [RESUME]);
});

test("解鎖: 上鎖期間沒有被擋下的就不補送 (車維持原狀, 等 QAMS 的指令)", () => {
  const h = setup();
  h.lock.onStopRequest(stop(RESUME)); // 上鎖之前的放行
  h.lock.handle(true, "伸桿");
  h.lock.onStopRequest(stop(PAUSE));
  h.published.length = 0;
  h.lock.handle(false, "收好了");
  assert.deepEqual(h.published, []);
});

test("上鎖中每秒再送一次暫停, 解鎖後停止", async () => {
  const h = setup();
  h.lock.handle(true, "伸桿");
  await new Promise((r) => setTimeout(r, 2200));
  assert.ok(h.types().filter((t) => t === PAUSE).length >= 3, `只送了 ${h.published.length} 次`);
  h.lock.handle(false, "收好了");
  const n = h.published.length;
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(h.published.length, n);
});

test("amr-core 重開: 從存檔讀回來還是鎖著, 繼續擋放行", () => {
  const h = setup();
  h.lock.handle(true, "伸桿");
  h.lock.dispose();
  assert.equal(JSON.parse(fs.readFileSync(h.file, "utf8")).locked, true);

  const again = h.make();
  assert.equal(again.isLocked, true);
  h.published.length = 0;
  assert.equal(again.onStopRequest(stop(RESUME)), false);
  assert.deepEqual(h.published, []);
  again.handle(false, "收好了");
  assert.equal(JSON.parse(fs.readFileSync(h.file, "utf8")).locked, false);
  assert.equal(h.make().isLocked, false);
});

test("ROS 重連: 鎖著就馬上補一個暫停 (ROS 重開不記得暫停)", () => {
  const h = setup({ ros: false });
  h.lock.handle(true, "伸桿");
  assert.deepEqual(h.published, []);
  h.ros.connected = true;
  h.lock.onRosConnected();
  assert.deepEqual(h.types(), [PAUSE]);
  h.lock.dispose();
});

test("存檔壞掉: 當成鎖著 (等 QAMS 連上來解)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "charge-lock-"));
  const file = path.join(dir, "charge-lock.json");
  fs.writeFileSync(file, "{broken");
  const h = setup({ file });
  assert.equal(h.lock.isLocked, true);
  h.lock.dispose();
});

test("沒鎖時收到解鎖: 什麼都不做", () => {
  const h = setup();
  assert.deepEqual(h.lock.handle(false, "x"), { locked: false, paused: false });
  assert.deepEqual(h.published, []);
  assert.equal(fs.existsSync(h.file), false);
});

test("記住是哪座充電站鎖的: 註冊時回報, 重開後還在, 解鎖後清掉", () => {
  const h = setup();
  assert.deepEqual(h.lock.registerInfo, { locked: false, dockLocationId: "" });
  h.lock.handle(true, "伸桿", "6656");
  assert.deepEqual(h.lock.registerInfo, { locked: true, dockLocationId: "6656" });
  h.lock.dispose();

  const again = h.make();
  assert.deepEqual(again.registerInfo, { locked: true, dockLocationId: "6656" });
  // 舊版 QAMS 上鎖不帶充電站: 保留原本記的
  again.handle(true, "再鎖一次");
  assert.equal(again.registerInfo.dockLocationId, "6656");
  again.handle(false, "收好了");
  assert.deepEqual(again.registerInfo, { locked: false, dockLocationId: "" });
  assert.deepEqual(h.make().registerInfo, { locked: false, dockLocationId: "" });
});
