// qams_amr_demo.ts
import amqplib from "amqplib";

const RABBIT_URL = process.env.RABBIT_URL || "amqp://localhost";

// Exchanges
const REQ_EX = "amr.req.topic";
const RES_EX = "amr.res.topic";
const EVENT_EX = "amr.event.topic";
const CONTROL_EX = "amr.control.topic"; // optional dedicated control exchange

// Queues
const MISSION_RES_QUEUE = "mission.res.queue";
const STATUS_RES_QUEUE = "status.res.queue";
const EVENTS_QUEUE = "amr.events.queue";

// Simple UUID (no dependency)
function uuid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// small sleep
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Broker infra initializer
 */
async function initBrokerInfra() {
  const conn = await amqplib.connect(RABBIT_URL);
  const ch = await conn.createChannel();

  await ch.assertExchange(REQ_EX, "topic", { durable: true });
  await ch.assertExchange(RES_EX, "topic", { durable: true });
  await ch.assertExchange(EVENT_EX, "topic", { durable: true });
  await ch.assertExchange(CONTROL_EX, "topic", { durable: true });

  // Shared mission responses (use quorum for critical)
  await ch.assertQueue(MISSION_RES_QUEUE, {
    durable: true,
    arguments: { "x-queue-type": "quorum" },
  });
  await ch.bindQueue(MISSION_RES_QUEUE, RES_EX, "amr.res.*.mission");

  // status responses
  await ch.assertQueue(STATUS_RES_QUEUE, { durable: true });
  await ch.bindQueue(STATUS_RES_QUEUE, RES_EX, "amr.res.*.status");

  // events
  await ch.assertQueue(EVENTS_QUEUE, { durable: true });
  await ch.bindQueue(EVENTS_QUEUE, EVENT_EX, "amr.event.*.*");

  // register queue (AMR -> QAMS registration requests)
  await ch.assertQueue(REGISTER_QUEUE, { durable: true });
  await ch.bindQueue(REGISTER_QUEUE, RES_EX, "amr.register.*");

  console.log("Broker infra ready");
  return { conn, ch };
}

/**
 * QAMS service: keeps registry, sends commands, consumes shared queues
 */
class QamsService {
  conn!: amqplib.Connection;
  ch!: amqplib.Channel;
  registry = new Map<string, { mac: string; name?: string }>(); // registered macs
  transactionMap = new Map<string, { resolve: Function; reject: Function; timeout: NodeJS.Timeout }>();

  constructor(private verbose = true) {}

  async init() {
    const infra = await initBrokerInfra();
    this.conn = infra.conn;
    this.ch = infra.ch;

    // consume register requests from AMR (routing: amr.register.<mac>)
    await this.ch.prefetch(10);
    this.ch.consume(REGISTER_QUEUE, (msg) => {
      if (!msg) return;
      try {
        const payload = JSON.parse(msg.content.toString());
        const rk = msg.fields.routingKey; // amr.register.<mac>
        const parts = rk.split(".");
        const mac = parts[2];
        if (this.verbose) console.log(`[QAMS] register request from ${mac}`, payload);

        // decide; for demo allow only if mac startsWith "MAC"
        const allowed = payload.mac && payload.mac.startsWith("MAC");
        // reply via control exchange: amr.<mac>.control
        const controlRK = `amr.${mac}.control`;
        this.ch.publish(
          CONTROL_EX,
          controlRK,
          Buffer.from(JSON.stringify({ type: "REGISTER_ACK", allowed })),
          { persistent: true }
        );

        // if allowed, add to registry
        if (allowed) {
          this.registry.set(mac, { mac, name: payload.name || mac });
          if (this.verbose) console.log(`[QAMS] ${mac} registered`);
        } else {
          if (this.verbose) console.log(`[QAMS] ${mac} registration denied`);
        }
      } catch (err) {
        console.error("[QAMS] register handler error", err);
      } finally {
        this.ch.ack(msg);
      }
    });

    // consume mission responses
    this.ch.consume(MISSION_RES_QUEUE, (msg) => {
      if (!msg) return;
      try {
        const payload = JSON.parse(msg.content.toString());
        const rk = msg.fields.routingKey; // amr.res.<mac>.mission
        const [, , mac, name] = rk.split(".");
        if (!this.registry.has(mac)) {
          if (this.verbose) console.log(`[QAMS] IGNORE mission.res from unregistered ${mac}`);
          this.ch.ack(msg);
          return;
        }
        console.log(`[QAMS] mission RES from ${mac}:`, payload);

        // If this corresponds to a waiting transaction, resolve it
        if (payload.txnId && this.transactionMap.has(payload.txnId)) {
          const t = this.transactionMap.get(payload.txnId)!;
          clearTimeout(t.timeout);
          t.resolve(payload);
          this.transactionMap.delete(payload.txnId);
        }
      } catch (err) {
        console.error("[QAMS] mission.consume error", err);
      } finally {
        this.ch.ack(msg);
      }
    });

    // consume events (heartbeat/pose/error)
    this.ch.consume(EVENTS_QUEUE, (msg) => {
      if (!msg) return;
      try {
        const payload = JSON.parse(msg.content.toString());
        const rk = msg.fields.routingKey; // amr.event.<mac>.<type>
        const [, , mac, eType] = rk.split(".");
        if (!this.registry.has(mac)) {
          if (this.verbose) console.log(`[QAMS] IGNORE event from unregistered ${mac}`);
          this.ch.ack(msg);
          return;
        }
        // handle event
        // e.g. update location, check arrival, conflict resolution
        if (this.verbose) console.log(`[QAMS] EVENT ${mac} ${eType}`, payload);
      } catch (err) {
        console.error("[QAMS] event.consume error", err);
      } finally {
        this.ch.ack(msg);
      }
    });

    console.log("[QAMS] init done");
  }

  // send a route_request and wait for route_ack (txn style)
  async sendRouteRequest(mac: string, path: { from: string; to: string; pathId: string }, timeoutMs = 5000) {
    const txnId = uuid();
    const rk = `amr.${mac}.req.route`;
    const envelope = {
      id: uuid(),
      txnId,
      time: Date.now(),
      publisher: "QAMS",
      amrId: mac,
      name: "route_request",
      flag: "REQ",
      payload: path,
    };
    // publish
    this.ch.publish(REQ_EX, rk, Buffer.from(JSON.stringify(envelope)), { persistent: true });
    if (this.verbose) console.log(`[QAMS] sent route_request to ${mac}`, envelope);

    // wait for ack via mission.res.queue (txnid)
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        this.transactionMap.delete(txnId);
        reject(new Error("route_request timeout"));
      }, timeoutMs);
      this.transactionMap.set(txnId, { resolve, reject, timeout: to });
    });
  }

  // send unregister (QAMS removes from registry and notifies)
  async unregisterMac(mac: string) {
    this.registry.delete(mac);
    // notify AMR via control exchange
    this.ch.publish(
      CONTROL_EX,
      `amr.${mac}.control`,
      Buffer.from(JSON.stringify({ type: "UNREGISTER" })),
      { persistent: true }
    );
    console.log(`[QAMS] Unregistered ${mac} and notified`);
  }
}

/**
 * AmrBridge simulating an AMR device.
 * - sends register requests repeatedly until ACK allowed
 * - consumes its req queue (amr.<mac>.req.*) with prefetch(1)
 * - publishes events to EVENT_EX when registered
 * - publishes mission responses to RES_EX
 */
class AmrBridge {
  conn!: amqplib.Connection;
  ch!: amqplib.Channel;
  registered = false;
  running = true;
  eventTimer?: NodeJS.Timeout;
  mac: string;

  constructor(mac: string, private verbose = true) {
    this.mac = mac;
  }

  async init() {
    this.conn = await amqplib.connect(RABBIT_URL);
    this.ch = await this.conn.createChannel();

    await this.ch.assertExchange(REQ_EX, "topic", { durable: true });
    await this.ch.assertExchange(RES_EX, "topic", { durable: true });
    await this.ch.assertExchange(EVENT_EX, "topic", { durable: true });
    await this.ch.assertExchange(CONTROL_EX, "topic", { durable: true });

    // create per-AMR req queue
    const reqQ = `amr.${this.mac}.req.queue`;
    await this.ch.assertQueue(reqQ, { durable: true });
    await this.ch.bindQueue(reqQ, REQ_EX, `amr.${this.mac}.req.*`);

    // consume control messages targeting this AMR (via CONTROL_EX)
    const controlQ = `amr.${this.mac}.control.queue`;
    await this.ch.assertQueue(controlQ, { durable: true });
    await this.ch.bindQueue(controlQ, CONTROL_EX, `amr.${this.mac}.control`);
    this.ch.consume(controlQ, (msg) => {
      if (!msg) return;
      try {
        const payload = JSON.parse(msg.content.toString());
        if (this.verbose) console.log(`[AMR ${this.mac}] control msg`, payload);
        if (payload.type === "REGISTER_ACK") {
          if (payload.allowed) {
            this.registered = true;
            this.startEventLoop();
            if (this.verbose) console.log(`[AMR ${this.mac}] REGISTERED`);
          } else {
            this.registered = false;
            this.stopEventLoop();
            if (this.verbose) console.log(`[AMR ${this.mac}] REGISTER DENIED`);
          }
        } else if (payload.type === "UNREGISTER") {
          this.registered = false;
          this.stopEventLoop();
          if (this.verbose) console.log(`[AMR ${this.mac}] RECEIVED UNREGISTER - STOPPING EVENTS`);
        }
      } catch (err) {
        console.error(`[AMR ${this.mac}] control handler error`, err);
      } finally {
        this.ch.ack(msg);
      }
    });

    // consume requests (task commands)
    await this.ch.prefetch(1); // <--- critical: only one unacked message at a time
    this.ch.consume(reqQ, async (msg) => {
      if (!msg) return;
      try {
        const env = JSON.parse(msg.content.toString());
        const rk = msg.fields.routingKey; // amr.<mac>.req.<name>
        if (this.verbose) console.log(`[AMR ${this.mac}] REQ received`, rk, env);

        // If not registered, ignore (but ack to remove)
        if (!this.registered) {
          if (this.verbose) console.log(`[AMR ${this.mac}] IGNORE REQ while unregistered`);
          this.ch.ack(msg);
          return;
        }

        // handle route_request example
        if (env.name === "route_request") {
          // send route_ack immediately (to let QAMS know we received)
          const ackPayload = {
            id: uuid(),
            txnId: env.txnId,
            publisher: "AMR",
            amrId: this.mac,
            name: "route_ack",
            flag: "RES",
            payload: { accepted: true, currentPose: { x: 0, y: 0 } },
          };
          this.ch.publish(RES_EX, `amr.res.${this.mac}.mission`, Buffer.from(JSON.stringify(ackPayload)), { persistent: true });
          if (this.verbose) console.log(`[AMR ${this.mac}] sent route_ack`, ackPayload);

          // simulate some processing then publish mission result
          await sleep(500 + Math.random() * 1000);
          const res = {
            id: uuid(),
            txnId: env.txnId,
            publisher: "AMR",
            amrId: this.mac,
            name: "mission",
            flag: "RES",
            payload: { result: "arrived", point: env.payload.to },
          };
          this.ch.publish(RES_EX, `amr.res.${this.mac}.mission`, Buffer.from(JSON.stringify(res)), { persistent: true });
          if (this.verbose) console.log(`[AMR ${this.mac}] sent mission RES`, res);
        }

      } catch (err) {
        console.error(`[AMR ${this.mac}] req handler error`, err);
      } finally {
        this.ch.ack(msg);
      }
    });

    // start registration loop: send register requests periodically until allowed
    this.registrationLoop();
    console.log(`[AMR ${this.mac}] init done`);
  }

  private async registrationLoop() {
    // send initial register request
    while (this.running && !this.registered) {
      const rk = `amr.register.${this.mac}`;
      const env = {
        id: uuid(),
        time: Date.now(),
        publisher: "AMR",
        amrId: this.mac,
        name: "register",
        flag: "REQ",
        payload: { mac: this.mac, name: `robot-${this.mac}` },
      };
      this.ch.publish(RES_EX, rk, Buffer.from(JSON.stringify(env)), { persistent: true });
      if (this.verbose) console.log(`[AMR ${this.mac}] sent register request`);
      // wait a bit before retry
      await sleep(2000);
    }
  }

  // start periodic events (heartbeat / pose)
  private startEventLoop() {
    if (this.eventTimer) return;
    this.eventTimer = setInterval(() => {
      if (!this.registered) return;
      // heartbeat
      const hb = { id: uuid(), publisher: "AMR", amrId: this.mac, name: "heartbeat", flag: "EVENT", payload: { ts: Date.now() } };
      this.ch.publish(EVENT_EX, `amr.event.${this.mac}.heartbeat`, Buffer.from(JSON.stringify(hb)));
      // pose
      const pose = { id: uuid(), publisher: "AMR", amrId: this.mac, name: "pose", flag: "EVENT", payload: { x: Math.random()*10, y: Math.random()*10 } };
      this.ch.publish(EVENT_EX, `amr.event.${this.mac}.pose`, Buffer.from(JSON.stringify(pose)));
      if (this.verbose) console.log(`[AMR ${this.mac}] publish heartbeat/pose`);
    }, 3000);
  }

  private stopEventLoop() {
    if (this.eventTimer) {
      clearInterval(this.eventTimer);
      this.eventTimer = undefined;
    }
  }

  // for demo shutdown
  async close() {
    this.running = false;
    this.stopEventLoop();
    try { await this.ch.close(); } catch {}
    try { await this.conn.close(); } catch {}
  }
}

/**
 * Demo runner: starts QAMS and 3 AMRs, then send route_request, then unregister one.
 */
async function mainDemo() {
  const qams = new QamsService(true);
  await qams.init();

  // start three AMRs with macs: MAC001, MAC002, BAD001 (BAD001 will be denied)
  const amr1 = new AmrBridge("MAC001", true);
  const amr2 = new AmrBridge("MAC002", true);
  const amr3 = new AmrBridge("BAD001", true); // this one will be denied because name doesn't start with "MAC"

  await amr1.init();
  await amr2.init();
  await amr3.init();

  // wait for registration flows (AMR will retry until allowed)
  console.log("waiting 4s for registration to settle...");
  await sleep(4000);

  // send a route request to MAC001
  try {
    const ack = await qams.sendRouteRequest("MAC001", { from: "P1", to: "P2", pathId: "path-123" }, 7000);
    console.log("[DEMO] route_request ACK/RES received:", ack);
  } catch (err) {
    console.error("[DEMO] route_request error", err);
  }

  // now unregister MAC002 to demonstrate immediate stop
  console.log("[DEMO] unregistering MAC002 in 3s...");
  await sleep(3000);
  await qams.unregisterMac("MAC002");

  // wait a bit to observe AMR behavior
  console.log("[DEMO] observing for 10s ...");
  await sleep(10000);

  // cleanup
  await amr1.close();
  await amr2.close();
  await amr3.close();
  try { await qams.ch.close(); await qams.conn.close(); } catch {}
  console.log("[DEMO] finished");
}

mainDemo().catch((err) => {
  console.error(err);
  process.exit(1);
});
