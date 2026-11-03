// One container, two processes. The app listens on loopback and the API-only
// gateway holds the public port, so the split that protects the private app on
// a laptop is the same split that protects it in the cloud.
//
// Either process dying makes the container useless, so the first exit takes the
// other one down and the platform replaces the machine.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = (name) => fileURLToPath(new URL(name, import.meta.url));

// The app flushes every open archive on SIGTERM and gives itself up to 35
// seconds to do it. Killing the container sooner would lose a saved episode,
// so the hard kill deliberately sits past that deadline — and the platform's
// own kill timeout has to be at least this long too (see fly.toml).
const graceMs = Number(process.env.NEWSCAST_KILL_GRACE_MS) || 40000;

const children = new Map();
let stopping = false;
let code = 0;
// A planned shutdown that loses an archive is not a clean shutdown. Tracking
// failure separately from the shutdown reason is what keeps the platform from
// reading "we asked it to stop, and it stopped" as "nothing went wrong": a child
// that blew its flush deadline or had to be SIGKILLed still fails the container.
let failed = false;

function stop(reason) {
  if (stopping) return;
  stopping = true;
  code = reason;
  for (const child of children.values()) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of children.values()) child.kill("SIGKILL");
  }, graceMs).unref();
}

function start(name, path, env = {}) {
  const child = spawn(process.execPath, [path], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  children.set(name, child);
  child.on("error", (err) => {
    console.error(`[serve] ${name} could not start: ${err.message}`);
    failed = true;
    stop(1);
  });
  child.on("exit", (status, signal) => {
    children.delete(name);
    console.log(`[serve] ${name} exited (${signal || status})`);
    // Mid-shutdown, the one clean way out is exiting 0 or going quietly on the
    // SIGTERM we sent. A non-zero status means it gave up on its own flush, and
    // SIGKILL means it ran out of grace with work still in hand.
    const clean = stopping ? (status === 0 || (status === null && signal === "SIGTERM")) : false;
    if (!clean) failed = true;
    stop(stopping ? code : status || 1);
    if (!children.size) process.exit(failed ? code || 1 : code);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));

start("app", script("../server.js"));
start("gateway", script("./public-gateway.mjs"));
