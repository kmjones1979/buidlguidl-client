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

let lighthouseCommand;
const platform = os.platform();
if (["darwin", "linux"].includes(platform)) {
  lighthouseCommand = path.join(
    installDir,
    "ethereum_clients",
    "lighthouse",
    "lighthouse"
  );
} else if (platform === "win32") {
  lighthouseCommand = path.join(
    installDir,
    "ethereum_clients",
    "lighthouse",
    "lighthouse.exe"
  );
}

const validatorDataDir = path.join(
  installDir,
  "ethereum_clients",
  "validator",
  "lighthouse"
);

const keystoresDir = path.join(
  installDir,
  "ethereum_clients",
  "validator",
  "keystores"
);

// Determine the password file and secrets directory.
// When --password-dir is provided (RAM-backed tmpfs), use that directory
// for both the password file and per-validator secrets so they never touch disk.
const passwordFile = passwordDir
  ? path.join(passwordDir, "password.txt")
  : path.join(installDir, "ethereum_clients", "validator", "password.txt");

const secretsDir = passwordDir
  ? path.join(passwordDir, "secrets")
  : path.join(installDir, "ethereum_clients", "validator", "secrets");

// Lighthouse expects --secrets-dir to contain one file per validator,
// named after the validator's public key, each containing the keystore password.
// Populate the secrets dir from the master password file and keystore filenames.
if (fs.existsSync(passwordFile) && fs.existsSync(keystoresDir)) {
  if (!fs.existsSync(secretsDir)) {
    fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  }
  const password = fs.readFileSync(passwordFile, "utf8");
  const keystoreFiles = fs.readdirSync(keystoresDir).filter(
    (f) => f.startsWith("keystore") && f.endsWith(".json")
  );
  for (const ksFile of keystoreFiles) {
    try {
      const ksContent = JSON.parse(
        fs.readFileSync(path.join(keystoresDir, ksFile), "utf8")
      );
      const pubkey = ksContent.pubkey;
      if (pubkey) {
        const secretFile = path.join(secretsDir, `0x${pubkey}`);
        fs.writeFileSync(secretFile, password, { mode: 0o600 });
      }
    } catch (e) {
      debugToFile(`Warning: could not read keystore ${ksFile}: ${e.message}`);
    }
  }
}

const logsDir = path.join(validatorDataDir, "logs");

// Ensure logs directory exists
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logFilePath = path.join(
  logsDir,
  `lighthouse_validator_${getFormattedDateTime()}.log`
);

const logStream = fs.createWriteStream(logFilePath, { flags: "a" });

const validatorArgs = [
  "vc",
  "--network",
  "mainnet",
  "--beacon-nodes",
  "http://localhost:5052",
  "--datadir",
  path.join(validatorDataDir, "database"),
  "--validators-dir",
  keystoresDir,
  "--secrets-dir",
  secretsDir,
  "--metrics",
  "--metrics-address",
  "127.0.0.1",
  "--metrics-port",
  "5064",
  "--enable-doppelganger-protection",
];

if (feeRecipient) {
  validatorArgs.push("--suggested-fee-recipient", feeRecipient);
}

if (graffiti) {
  validatorArgs.push("--graffiti", graffiti);
}

if (mevBoostEnabled) {
  validatorArgs.push("--builder-proposals");
}

// Log startup without exposing full filesystem paths
debugToFile(
  `Lighthouse Validator: Starting (fee-recipient: ${feeRecipient ? "set" : "none"}, graffiti: ${graffiti}, mev-boost: ${mevBoostEnabled})`
);

const validator = pty.spawn(`${lighthouseCommand}`, validatorArgs, {
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
  debugToFile(`From lighthouse_validator.js: ${errorMessage}`);
});

process.on("SIGINT", () => {
  validator.kill("SIGINT");
});
