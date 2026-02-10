import pty from "node-pty";
import fs from "fs";
import os from "os";
import path from "path";
import { debugToFile } from "../helpers.js";
import { stripAnsiCodes, getFormattedDateTime } from "../helpers.js";
import minimist from "minimist";

let installDir = os.homedir();

const argv = minimist(process.argv.slice(2));

// Check if a different install directory was provided via the `--directory` option
if (argv.directory) {
  installDir = argv.directory;
}

// Well-known mainnet MEV relay URLs
const DEFAULT_RELAYS = [
  // Flashbots
  "https://0xac6e77dfe25ecd6110b8e780608cce0dab71fdd5ebea22a16c0205200f2f8e2e3ad3b71d3499c54ad14d6c21b41a37ae@boost-relay.flashbots.net",
  // bloXroute Max Profit
  "https://0x8b5d2e73e2a3a55c6c87b8b6eb92e0149a125c852751db1422fa951e42a09b82c142c3ea98d0d9930b056a3bc9896b8f@bloxroute.max-profit.blxrbdn.com",
  // Agnostic Gnosis
  "https://0xa7ab7a996c8584251c8f925da3170bdfd6ebc75d50f5ddc4050a6fdc77f2a3b5fce2cc750d0865e05d7228af97d69561@agnostic-relay.net",
  // Ultra Sound
  "https://0xa1559ace749633b997cb3fdacffb890aeebdb0f5a3b6aaa7eeeaf1a38af0a8fe88b9e4b1f61f236d2e64d95733327a62@relay.ultrasound.money",
];

let mevBoostCommand;
const platform = os.platform();
if (["darwin", "linux"].includes(platform)) {
  mevBoostCommand = path.join(
    installDir,
    "ethereum_clients",
    "mev-boost",
    "mev-boost"
  );
} else if (platform === "win32") {
  mevBoostCommand = path.join(
    installDir,
    "ethereum_clients",
    "mev-boost",
    "mev-boost.exe"
  );
}

const logsDir = path.join(
  installDir,
  "ethereum_clients",
  "mev-boost",
  "logs"
);

// Ensure logs directory exists
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logFilePath = path.join(
  logsDir,
  `mevboost_${getFormattedDateTime()}.log`
);

const logStream = fs.createWriteStream(logFilePath, { flags: "a" });

const mevBoostArgs = [
  "-mainnet",
  "-relay-check",
  "-relays",
  DEFAULT_RELAYS.join(","),
];

debugToFile(`MEV-Boost: Starting with ${DEFAULT_RELAYS.length} relays`);

const mevBoost = pty.spawn(`${mevBoostCommand}`, mevBoostArgs, {
  name: "xterm-color",
  cols: 80,
  rows: 30,
  cwd: process.env.HOME,
  env: { ...process.env, INSTALL_DIR: installDir },
});

// Pipe stdout and stderr to the log file and to the parent process
mevBoost.on("data", (data) => {
  logStream.write(stripAnsiCodes(data));
  if (process.send) {
    process.send({ log: data });
  }
});

mevBoost.on("exit", (code) => {
  logStream.end();
});

mevBoost.on("error", (err) => {
  const errorMessage = `Error: ${err.message}`;
  logStream.write(errorMessage);
  if (process.send) {
    process.send({ log: errorMessage });
  }
  debugToFile(`From mevboost.js: ${errorMessage}`);
});

process.on("SIGINT", () => {
  mevBoost.kill("SIGINT");
});
