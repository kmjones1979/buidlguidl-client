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

const feeRecipient = argv["fee-recipient"] || null;
const graffiti = argv.graffiti || "BuidlGuidl";
const mevBoostEnabled = argv["mev-boost"] || false;
const passwordDir = argv["password-dir"] || null;

let prysmCommand;
const platform = os.platform();
if (["darwin", "linux"].includes(platform)) {
  prysmCommand = path.join(
    installDir,
    "ethereum_clients",
    "prysm",
    "prysm.sh"
  );
} else if (platform === "win32") {
  prysmCommand = path.join(
    installDir,
    "ethereum_clients",
    "prysm",
    "prysm.exe"
  );
}

const validatorDataDir = path.join(
  installDir,
  "ethereum_clients",
  "validator",
  "prysm"
);

// When --password-dir is provided (RAM-backed tmpfs), use that directory
// for the password file so it never touches physical disk.
const passwordPath = passwordDir
  ? path.join(passwordDir, "password.txt")
  : path.join(installDir, "ethereum_clients", "validator", "password.txt");

const logsDir = path.join(validatorDataDir, "logs");

// Ensure logs directory exists
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logFilePath = path.join(
  logsDir,
  `prysm_validator_${getFormattedDateTime()}.log`
);

const logStream = fs.createWriteStream(logFilePath, { flags: "a" });

const validatorArgs = [
  "validator",
  "--mainnet",
  "--beacon-rpc-provider=localhost:4000",
  "--grpc-gateway-host=127.0.0.1",
  "--grpc-gateway-port=7500",
  `--wallet-dir=${path.join(validatorDataDir, "database")}`,
  `--wallet-password-file=${passwordPath}`,
  "--accept-terms-of-use",
  "--monitoring-host",
  "127.0.0.1",
  "--monitoring-port",
  "5064",
  "--enable-doppelganger",
];

if (feeRecipient) {
  validatorArgs.push(`--suggested-fee-recipient=${feeRecipient}`);
}

if (graffiti) {
  validatorArgs.push(`--graffiti=${graffiti}`);
}

if (mevBoostEnabled) {
  validatorArgs.push("--enable-builder");
}

// Log startup without exposing full filesystem paths or passwords
debugToFile(
  `Prysm Validator: Starting (fee-recipient: ${feeRecipient ? "set" : "none"}, graffiti: ${graffiti}, mev-boost: ${mevBoostEnabled})`
);

const validator = pty.spawn(`${prysmCommand}`, validatorArgs, {
  name: "xterm-color",
  cols: 80,
  rows: 30,
  cwd: process.env.HOME,
  env: {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TERM: process.env.TERM || "xterm-color",
    INSTALL_DIR: installDir,
  },
});

// Pipe stdout and stderr to the log file and to the parent process
validator.on("data", (data) => {
  logStream.write(stripAnsiCodes(data));
  if (process.send) {
    process.send({ log: data });
  }
});

validator.on("exit", (code) => {
  logStream.end();
});

validator.on("error", (err) => {
  const errorMessage = `Error: ${err.message}`;
  logStream.write(errorMessage);
  if (process.send) {
    process.send({ log: errorMessage });
  }
  debugToFile(`From prysm_validator.js: ${errorMessage}`);
});

process.on("SIGINT", () => {
  validator.kill("SIGINT");
});
