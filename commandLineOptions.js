import os from "os";
import fs from "fs";
import path from "path";
import minimist from "minimist";
import readlineSync from "readline-sync";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  installMacLinuxClient,
  getVersionNumber,
  compareClientVersions,
  removeClient,
  latestGethVer,
  latestRethVer,
  latestLighthouseVer,
} from "./ethereum_client_scripts/install.js";
import { debugToFile } from "./helpers.js";

debugToFile(
  `\n\n\n\n\n\n--------------------------------------------------------------------------`
);
debugToFile(
  `----------------------------  CLIENT STARTED  ----------------------------`
);

/// Set default command line option values
let executionClient = "reth";
let executionType = "full";
let consensusClient = "lighthouse";
let executionPeerPort = 30303;
let consensusPeerPorts = [null, null];
let consensusCheckpoint = null;
let owner = null;
let validatorEnabled = false;
let feeRecipient = null;
let graffiti = "BuidlGuidl";
let validatorKeysDir = null;
let mevBoostEnabled = false;

const filename = fileURLToPath(import.meta.url);
let installDir = dirname(filename);

const optionsFilePath = join(installDir, "options.json");

function showHelp() {
  console.log("");
  console.log(
    "  -e, --executionclient <client>            Specify the execution client ('reth' or 'geth')"
  );
  console.log("                                            Default: reth");
  console.log(
    "                                            Note: geth is only supported on Ubuntu/Linux\n"
  );
  console.log(
    "  -c, --consensusclient <client>            Specify the consensus client ('lighthouse' or 'prysm')"
  );
  console.log(
    "                                            Default: lighthouse\n"
  );
  console.log(
    "       --archive                            Perform an archive sync for the execution client\n"
  );
  console.log(
    "  -ep, --executionpeerport <port>           Specify the execution peer port (must be a number between 1 and 65535)"
  );
  console.log("                                            Default: 30303\n");
  console.log(
    "  -cp, --consensuspeerports <port>,<port>   Specify the consensus peer ports (must be two comma-separated numbers between 1 and 65535)"
  );
  console.log(
    "                                            lighthouse defaults: 9000,9001. prysm defaults: 12000,13000\n"
  );
  console.log(
    "  -cc, --consensuscheckpoint <url>          Specify a custom consensus checkpoint server URL"
  );
  console.log(
    "                                            If not provided, the fastest and most current checkpoint server will be automatically"
  );
  console.log(
    "                                            selected from 8 public servers (see: https://eth-clients.github.io/checkpoint-sync-endpoints)\n"
  );
  console.log(
    "  -d, --directory <path>                    Specify ethereum client executable, database, and logs directory"
  );
  console.log(
    "                                            Default: buidlguidl-client/ethereum_clients\n"
  );
  console.log(
    "  -o, --owner <eth address>                 Specify a owner eth address to opt in to the points system, distributed RPC network, and Telegram alerts"
  );
  console.log(
    `                                            To set up Telegram alerts for clients crashes, message /start to @BG_Client_Alert_Bot on Telegram\n`
  );
  console.log(
    "  -v, --validator                           Enable validator mode (runs a validator client alongside the beacon node)\n"
  );
  console.log(
    "  -fr, --fee-recipient <address>            Specify the fee recipient ETH address for execution layer rewards"
  );
  console.log(
    "                                            Required when --validator is enabled\n"
  );
  console.log(
    "       --graffiti <string>                  Specify custom graffiti for proposed blocks (max 32 chars, alphanumeric + _-.:!@#)"
  );
  console.log(
    '                                            Default: "BuidlGuidl"\n'
  );
  console.log(
    "       --validator-keys-dir <path>          Specify a directory containing existing validator keystore files to import\n"
  );
  console.log(
    "       --mev-boost                          Enable MEV-boost for additional execution layer rewards (optional)\n"
  );
  console.log(
    "      --update                              Update the execution and consensus clients to the latest version."
  );
  console.log(
    `                                            Latest versions: Reth: ${latestRethVer}, Geth: ${latestGethVer}, Lighthouse: ${latestLighthouseVer}, (Prysm is handled by its executable automatically)\n`
  );
  console.log(
    "  -h, --help                                Display this help message and exit"
  );
  console.log("");
}

function isValidPath(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch (err) {
    return false;
  }
}

// Function to save options to a file
function saveOptionsToFile() {
  const options = {
    executionClient,
    consensusClient,
    executionPeerPort,
    consensusPeerPorts,
    consensusCheckpoint,
    installDir,
    owner,
    validatorEnabled,
    feeRecipient,
    graffiti,
    validatorKeysDir,
    mevBoostEnabled,
  };
  fs.writeFileSync(optionsFilePath, JSON.stringify(options), {
    encoding: "utf8",
    mode: 0o600,
  });
}

// Function to load options from a file with basic schema validation
function loadOptionsFromFile() {
  if (fs.existsSync(optionsFilePath)) {
    const raw = fs.readFileSync(optionsFilePath, "utf8");
    const options = JSON.parse(raw);

    // Validate types to prevent prototype pollution and unexpected values
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new Error("Invalid options file: root must be an object");
    }
    if (options.__proto__ !== undefined || options.constructor !== undefined) {
      throw new Error("Invalid options file: suspicious keys detected");
    }

    const stringFields = ["executionClient", "consensusClient", "consensusCheckpoint", "installDir", "owner", "feeRecipient", "graffiti", "validatorKeysDir"];
    for (const field of stringFields) {
      if (options[field] !== undefined && options[field] !== null && typeof options[field] !== "string") {
        throw new Error(`Invalid options file: ${field} must be a string or null`);
      }
    }
    const boolFields = ["validatorEnabled", "mevBoostEnabled"];
    for (const field of boolFields) {
      if (options[field] !== undefined && typeof options[field] !== "boolean") {
        throw new Error(`Invalid options file: ${field} must be a boolean`);
      }
    }
    if (options.executionPeerPort !== undefined && typeof options.executionPeerPort !== "number") {
      throw new Error("Invalid options file: executionPeerPort must be a number");
    }
    if (options.consensusPeerPorts !== undefined && !Array.isArray(options.consensusPeerPorts)) {
      throw new Error("Invalid options file: consensusPeerPorts must be an array");
    }

    return options;
  } else {
    debugToFile(`loadOptionsFromFile(): Options file not found`);
  }
}

// Check if the options file already exists
let optionsLoaded = false;
if (fs.existsSync(optionsFilePath)) {
  try {
    const options = loadOptionsFromFile();
    executionClient = options.executionClient;
    consensusClient = options.consensusClient;
    executionPeerPort = options.executionPeerPort;
    consensusPeerPorts = options.consensusPeerPorts;
    consensusCheckpoint = options.consensusCheckpoint;
    installDir = options.installDir;
    owner = options.owner;
    validatorEnabled = options.validatorEnabled || false;
    feeRecipient = options.feeRecipient || null;
    graffiti = options.graffiti || "BuidlGuidl";
    validatorKeysDir = options.validatorKeysDir || null;
    mevBoostEnabled = options.mevBoostEnabled || false;
    optionsLoaded = true;

    // Check if loaded geth option is being used on macOS (not supported)
    if (executionClient === "geth" && os.platform() === "darwin") {
      console.log("");
      console.log("❌ Error: Geth is currently not supported on macOS.");
      console.log("🔄 Please use 'reth' as your execution client instead:");
      console.log("");
      process.exit(1);
    }
  } catch (error) {
    debugToFile(`Failed to load options from file: ${error}`);
  }
}

function deleteOptionsFile() {
  try {
    if (fs.existsSync(optionsFilePath)) {
      fs.unlinkSync(optionsFilePath);
    }
  } catch (error) {
    debugToFile(`deleteOptionsFile(): ${error}`);
  }
}

// Preprocess arguments to handle "-ep", "-cp", "-fr" as aliases
const args = process.argv.slice(2).flatMap((arg) => {
  if (arg === "-ep") {
    return "--executionpeerport";
  } else if (arg === "-cp") {
    return "--consensuspeerports";
  } else if (arg === "-cc") {
    return "--consensuscheckpoint";
  } else if (arg === "-fr") {
    return "--fee-recipient";
  }
  return arg;
});

// If options were not loaded from the file, process command-line arguments
if (!optionsLoaded) {
  const argv = minimist(args, {
    string: [
      "e",
      "executionclient",
      "c",
      "consensusclient",
      "executionpeerport",
      "consensuspeerports",
      "consensuscheckpoint",
      "d",
      "directory",
      "o",
      "owner",
      "fee-recipient",
      "graffiti",
      "validator-keys-dir",
    ],
    alias: {
      e: "executionclient",
      c: "consensusclient",
      d: "directory",
      o: "owner",
      h: "help",
      v: "validator",
    },
    boolean: ["h", "help", "update", "archive", "validator", "mev-boost"],
    unknown: (option) => {
      console.log(`Invalid option: ${option}`);
      showHelp();
      process.exit(1);
    },
  });

  if (argv.executionclient) {
    executionClient = argv.executionclient;
    if (executionClient !== "reth" && executionClient !== "geth") {
      console.log(
        "Invalid option for --executionclient (-e). Use 'reth' or 'geth'."
      );
      process.exit(1);
    }
  }

  // Check if geth is being used on macOS (not supported)
  if (executionClient === "geth" && os.platform() === "darwin") {
    console.log("");
    console.log("❌ Error: Geth is currently not supported on macOS.");
    console.log("🔄 Please use 'reth' as your execution client instead:");
    console.log("");
    process.exit(1);
  }

  if (argv.archive) {
    executionType = "archive";
  }

  if (argv.consensusclient) {
    consensusClient = argv.consensusclient;
    if (consensusClient !== "lighthouse" && consensusClient !== "prysm") {
      console.log(
        "Invalid option for --consensusclient (-c). Use 'lighthouse' or 'prysm'."
      );
      process.exit(1);
    }
  }

  if (argv.executionpeerport) {
    executionPeerPort = parseInt(argv.executionpeerport, 10);
    if (isNaN(executionPeerPort) || executionPeerPort < 1 || executionPeerPort > 65535) {
      console.log(
        "Invalid option for --executionpeerport (-ep). Must be a number between 1 and 65535."
      );
      process.exit(1);
    }
  }

  if (argv.consensuspeerports) {
    consensusPeerPorts = argv.consensuspeerports
      .split(",")
      .map((port) => parseInt(port.trim(), 10));

    // Check if there are exactly two ports and if both are valid numbers in range
    if (
      consensusPeerPorts.length !== 2 ||
      consensusPeerPorts.some(isNaN) ||
      consensusPeerPorts.some((p) => p < 1 || p > 65535)
    ) {
      console.log(
        "Invalid option for --consensuspeerports (-cp). Must be two comma-separated numbers between 1 and 65535 (e.g., 9000,9001)."
      );
      process.exit(1);
    }
  }

  if (argv.consensuscheckpoint) {
    consensusCheckpoint = argv.consensuscheckpoint;
  }

  if (argv.directory) {
    installDir = path.resolve(argv.directory);
    if (!isValidPath(installDir)) {
      console.log(
        `Invalid option for --directory (-d). '${installDir}' is not a valid path.`
      );
      process.exit(1);
    }
    // Prevent path traversal into system directories
    const homeDir = os.homedir();
    if (!installDir.startsWith(homeDir) && !installDir.startsWith("/opt") && !installDir.startsWith("/srv")) {
      console.log(
        `Invalid option for --directory (-d). Path must be within your home directory, /opt, or /srv.`
      );
      process.exit(1);
    }
  }

  if (argv.owner) {
    owner = argv.owner;
  }

  if (argv.validator) {
    validatorEnabled = true;
  }

  if (argv["fee-recipient"]) {
    feeRecipient = argv["fee-recipient"];
    // Validate ETH address format
    if (!/^0x[0-9a-fA-F]{40}$/.test(feeRecipient)) {
      console.log(
        "Invalid option for --fee-recipient (-fr). Must be a valid Ethereum address (0x followed by 40 hex characters)."
      );
      process.exit(1);
    }
  }

  if (argv.graffiti) {
    graffiti = argv.graffiti;
    if (graffiti.length > 32) {
      console.log(
        "Invalid option for --graffiti. Must be 32 characters or fewer."
      );
      process.exit(1);
    }
    // Restrict graffiti to safe characters (alphanumeric, spaces, basic punctuation)
    if (!/^[a-zA-Z0-9 _\-.:!@#]+$/.test(graffiti)) {
      console.log(
        "Invalid option for --graffiti. Only alphanumeric characters, spaces, and basic punctuation (_-.:!@#) are allowed."
      );
      process.exit(1);
    }
  }

  if (argv["validator-keys-dir"]) {
    validatorKeysDir = path.resolve(argv["validator-keys-dir"]);
    if (!isValidPath(validatorKeysDir)) {
      console.log(
        `Invalid option for --validator-keys-dir. '${validatorKeysDir}' is not a valid path.`
      );
      process.exit(1);
    }
    // Prevent path traversal into system directories
    const homeDir2 = os.homedir();
    if (!validatorKeysDir.startsWith(homeDir2) && !validatorKeysDir.startsWith("/opt") && !validatorKeysDir.startsWith("/srv")) {
      console.log(
        `Invalid option for --validator-keys-dir. Path must be within your home directory, /opt, or /srv.`
      );
      process.exit(1);
    }
  }

  if (argv["mev-boost"]) {
    mevBoostEnabled = true;
  }

  // Validate that --fee-recipient is provided when --validator is enabled
  if (validatorEnabled && !feeRecipient) {
    console.log(
      "❌ Error: --fee-recipient (-fr) is required when --validator (-v) is enabled."
    );
    console.log(
      "   Please provide an Ethereum address to receive execution layer rewards."
    );
    console.log(
      "   Example: node index.js --validator --fee-recipient 0xYourAddress"
    );
    process.exit(1);
  }

  if (argv.update) {
    // Get list of installed clients from directory
    const clientsDir = join(installDir, "ethereum_clients");
    const clients = fs.existsSync(clientsDir)
      ? fs
          .readdirSync(clientsDir)
          .filter((dir) => fs.statSync(join(clientsDir, dir)).isDirectory())
      : [];

    for (const client of clients) {
      if (client !== "prysm" && client !== "jwt") {
        const installedVersion = getVersionNumber(client);

        // Skip if no version number found
        if (!installedVersion) {
          console.log(
            `⚠️  Could not determine version for ${client}, skipping update check.`
          );
          continue;
        }

        const [isLatest, latestVersion] = compareClientVersions(
          client,
          installedVersion
        );
        if (isLatest) {
          console.log(
            `\n✅ The currently installed ${client} version (${installedVersion}) is the latest available.`
          );
        } else {
          console.log(
            `\n❓ An updated version of ${client} is available. ${installedVersion} is currently installed. Would you like to update to ${latestVersion}? (y/yes)`
          );

          const answer = readlineSync.question("");
          if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
            console.log(`Removing old version of ${client}`);
            removeClient(client);

            const platform = os.platform();
            if (["darwin", "linux"].includes(platform)) {
              installMacLinuxClient(client, platform);
            }
            console.log("");
            console.log(`👍 Updated ${client} to ${latestVersion}`);
          } else {
            console.log("Update cancelled.");
          }
        }
      }
    }
    process.exit(0);
  }

  if (argv.help) {
    showHelp();
    process.exit(0);
  }

  if (
    consensusPeerPorts.every((port) => port === null) &&
    consensusClient === "lighthouse"
  ) {
    consensusPeerPorts = [9000, 9001];
  }

  if (
    consensusPeerPorts.every((port) => port === null) &&
    consensusClient === "prysm"
  ) {
    consensusPeerPorts = [12000, 13000];
  }
}

export {
  executionClient,
  executionType,
  consensusClient,
  executionPeerPort,
  consensusPeerPorts,
  consensusCheckpoint,
  installDir,
  owner,
  validatorEnabled,
  feeRecipient,
  graffiti,
  validatorKeysDir,
  mevBoostEnabled,
  saveOptionsToFile,
  deleteOptionsFile,
};
