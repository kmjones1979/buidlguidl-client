import { execSync, spawn } from "child_process";
import os from "os";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { initializeMonitoring } from "./monitor.js";
import { installMacLinuxClient } from "./ethereum_client_scripts/install.js";
import { initializeWebSocketConnection } from "./webSocketConnection.js";
import {
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
} from "./commandLineOptions.js";
import { setupValidatorKeys } from "./ethereum_client_scripts/keyManager.js";
import {
  setTelegramAlertIdentifier,
  sendTelegramAlert,
} from "./telegramAlert.js";
import {
  fetchBGExecutionPeers,
  configureBGExecutionPeers,
  fetchBGConsensusPeers,
  configureBGConsensusPeers,
} from "./ethereum_client_scripts/configureBGPeers.js";
import { getVersionNumber } from "./ethereum_client_scripts/install.js";
import { debugToFile } from "./helpers.js";
import {
  selectCheckpointUrlForLighthouse,
  selectCheckpointUrlForPrysm,
} from "./checkpointHealthCheck.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const lockFilePath = path.join(installDir, "ethereum_clients", "script.lock");

// const CONFIG = {
//   debugLogPath: path.join(installDir, "ethereum_clients", "debugIndex.log"),
// };

function createJwtSecret(jwtDir) {
  if (!fs.existsSync(jwtDir)) {
    console.log(`\nCreating '${jwtDir}'`);
    fs.mkdirSync(jwtDir, { recursive: true });
  }

  if (!fs.existsSync(`${jwtDir}/jwt.hex`)) {
    console.log("Generating JWT.hex file.");
    execSync(`cd "${jwtDir}" && openssl rand -hex 32 > jwt.hex`, {
      stdio: "inherit",
    });
  }
}

let executionChild;
let consensusChild;
let validatorChild;
let mevBoostChild;

let executionExited = false;
let consensusExited = false;
let validatorExited = false;
let mevBoostExited = false;

let isExiting = false;

function handleExit(exitType) {
  if (isExiting) return; // Prevent multiple calls

  // Check if the current process PID matches the one in the lockfile
  try {
    const lockFilePid = fs.readFileSync(lockFilePath, "utf8");
    if (parseInt(lockFilePid) !== process.pid) {
      console.log(
        `This client process (${process.pid}) is not the first instance launched. Closing dashboard view without killing clients.`
      );
      process.exit(0);
    }
  } catch (error) {
    console.error("Error reading lockfile:", error);
    process.exit(1);
  }

  isExiting = true;

  console.log(`\n\n🛰️  Received exit signal: ${exitType}\n`);

  deleteOptionsFile();
  debugToFile(`handleExit(): deleteOptionsFile() has been called`);

  try {
    // If validator/mev-boost are not in use, mark them as already exited
    if (!validatorChild) validatorExited = true;
    if (!mevBoostChild) mevBoostExited = true;

    // Check if all child processes have exited
    const checkExit = () => {
      if (
        executionExited &&
        consensusExited &&
        validatorExited &&
        mevBoostExited
      ) {
        console.log("\n👍 All clients exited!");
        removeLockFile();
        process.exit(0);
      }
    };

    // Handle execution client exit
    const handleExecutionExit = (code) => {
      if (!executionExited) {
        executionExited = true;
        console.log(`🫡 Execution client exited with code ${code}`);
        checkExit();
      }
    };

    // Handle consensus client exit
    const handleConsensusExit = (code) => {
      if (!consensusExited) {
        consensusExited = true;
        console.log(`🫡 Consensus client exited with code ${code}`);
        checkExit();
      }
    };

    // Handle validator client exit
    const handleValidatorExit = (code) => {
      if (!validatorExited) {
        validatorExited = true;
        console.log(`🫡 Validator client exited with code ${code}`);
        checkExit();
      }
    };

    // Handle mev-boost exit
    const handleMevBoostExit = (code) => {
      if (!mevBoostExited) {
        mevBoostExited = true;
        console.log(`🫡 MEV-Boost exited with code ${code}`);
        checkExit();
      }
    };

    // Handle execution client close
    const handleExecutionClose = (code) => {
      if (!executionExited) {
        executionExited = true;
        console.log(`🫡 Execution client closed with code ${code}`);
        checkExit();
      }
    };

    // Handle consensus client close
    const handleConsensusClose = (code) => {
      if (!consensusExited) {
        consensusExited = true;
        console.log(`🫡 Consensus client closed with code ${code}`);
        checkExit();
      }
    };

    // Handle validator client close
    const handleValidatorClose = (code) => {
      if (!validatorExited) {
        validatorExited = true;
        console.log(`🫡 Validator client closed with code ${code}`);
        checkExit();
      }
    };

    // Handle mev-boost close
    const handleMevBoostClose = (code) => {
      if (!mevBoostExited) {
        mevBoostExited = true;
        console.log(`🫡 MEV-Boost closed with code ${code}`);
        checkExit();
      }
    };

    // Ensure event listeners are set before killing the processes
    if (executionChild && !executionExited) {
      executionChild.on("exit", handleExecutionExit);
      executionChild.on("close", handleExecutionClose);
    } else {
      executionExited = true;
    }

    if (consensusChild && !consensusExited) {
      consensusChild.on("exit", handleConsensusExit);
      consensusChild.on("close", handleConsensusClose);
    } else {
      consensusExited = true;
    }

    if (validatorChild && !validatorExited) {
      validatorChild.on("exit", handleValidatorExit);
      validatorChild.on("close", handleValidatorClose);
    } else {
      validatorExited = true;
    }

    if (mevBoostChild && !mevBoostExited) {
      mevBoostChild.on("exit", handleMevBoostExit);
      mevBoostChild.on("close", handleMevBoostClose);
    } else {
      mevBoostExited = true;
    }

    // Send the kill signals after setting the event listeners
    // Kill validator first (it depends on beacon node), then others
    if (validatorChild && !validatorExited) {
      console.log("⌛️ Exiting validator client...");
      setTimeout(() => {
        validatorChild.kill("SIGINT");
      }, 500);
    }

    if (executionChild && !executionExited) {
      console.log("⌛️ Exiting execution client...");
      setTimeout(() => {
        executionChild.kill("SIGINT");
      }, 750);
    }

    if (consensusChild && !consensusExited) {
      console.log("⌛️ Exiting consensus client...");
      setTimeout(() => {
        consensusChild.kill("SIGINT");
      }, 750);
    }

    if (mevBoostChild && !mevBoostExited) {
      console.log("⌛️ Exiting MEV-Boost...");
      setTimeout(() => {
        mevBoostChild.kill("SIGINT");
      }, 750);
    }

    // Initial check in case all children are already not running
    checkExit();

    // Periodically check if all child processes have exited
    const intervalId = setInterval(() => {
      checkExit();
      if (
        executionExited &&
        consensusExited &&
        validatorExited &&
        mevBoostExited
      ) {
        clearInterval(intervalId);
      }
    }, 1000);
  } catch (error) {
    console.log("Error from handleExit()", error);
  }
}

// Modify existing listeners
process.on("SIGINT", () => handleExit("SIGINT"));
process.on("SIGTERM", () => handleExit("SIGTERM"));
process.on("SIGHUP", () => handleExit("SIGHUP"));
process.on("SIGUSR2", () => handleExit("SIGUSR2"));

// Modify the exit listener
process.on("exit", (code) => {
  if (!isExiting) {
    handleExit("exit");
  }
});

// This helps catch uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  handleExit("uncaughtException");
});

// This helps catch unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  handleExit("unhandledRejection");
});

let bgConsensusPeers = [];
let bgConsensusAddrs;

async function startClient(
  clientName,
  executionType,
  installDir,
  checkpointUrl = null
) {
  let clientCommand,
    clientArgs = [];

  if (clientName === "geth") {
    clientArgs.push("--executionpeerport", executionPeerPort);
    clientArgs.push("--executiontype", executionType);
    clientCommand = path.join(__dirname, "ethereum_client_scripts/geth.js");
  } else if (clientName === "reth") {
    clientArgs.push("--executionpeerport", executionPeerPort);
    clientArgs.push("--executiontype", executionType);
    clientCommand = path.join(__dirname, "ethereum_client_scripts/reth.js");
  } else if (clientName === "prysm") {
    bgConsensusPeers = await fetchBGConsensusPeers();
    bgConsensusAddrs = await configureBGConsensusPeers(consensusClient);

    if (bgConsensusPeers.length > 0) {
      clientArgs.push("--bgconsensuspeers", bgConsensusPeers);
    }

    if (bgConsensusAddrs != null) {
      clientArgs.push("--bgconsensusaddrs", bgConsensusAddrs);
    }

    if (checkpointUrl != null) {
      clientArgs.push("--consensuscheckpoint", checkpointUrl);
    }

    clientArgs.push("--consensuspeerports", consensusPeerPorts);

    // Pass validator-related flags to beacon node
    if (validatorEnabled && feeRecipient) {
      clientArgs.push("--fee-recipient", feeRecipient);
    }
    if (mevBoostEnabled) {
      clientArgs.push("--mev-boost");
    }

    clientCommand = path.join(__dirname, "ethereum_client_scripts/prysm.js");
  } else if (clientName === "lighthouse") {
    bgConsensusPeers = await fetchBGConsensusPeers();
    bgConsensusAddrs = await configureBGConsensusPeers(consensusClient);

    if (bgConsensusPeers.length > 0) {
      clientArgs.push("--bgconsensuspeers", bgConsensusPeers);
    }

    if (bgConsensusAddrs != null) {
      clientArgs.push("--bgconsensusaddrs", bgConsensusAddrs);
    }

    if (checkpointUrl != null) {
      clientArgs.push("--consensuscheckpoint", checkpointUrl);
    }
    clientArgs.push("--consensuspeerports", consensusPeerPorts);

    // Pass validator-related flags to beacon node
    if (validatorEnabled && feeRecipient) {
      clientArgs.push("--fee-recipient", feeRecipient);
    }
    if (mevBoostEnabled) {
      clientArgs.push("--mev-boost");
    }

    clientCommand = path.join(
      __dirname,
      "ethereum_client_scripts/lighthouse.js"
    );
  } else {
    clientCommand = path.join(
      installDir,
      "ethereum_clients",
      clientName,
      clientName
    );
  }

  clientArgs.push("--directory", installDir);

  const child = spawn("node", [clientCommand, ...clientArgs], {
    stdio: ["inherit", "pipe", "inherit"],
    cwd: process.env.HOME,
    env: { ...process.env, INSTALL_DIR: installDir },
  });

  if (clientName === "geth" || clientName === "reth") {
    executionChild = child;
  } else if (clientName === "prysm" || clientName === "lighthouse") {
    consensusChild = child;
  }

  child.on("exit", (code) => {
    console.log(`🫡 ${clientName} process exited with code ${code}`);

    // Send telegram alert if client exited unexpectedly (not user-initiated shutdown)
    // Only send alert if isExiting is false, meaning the user didn't close the script
    if (!isExiting && code !== null) {
      const machineId = os.hostname();
      const clientNameCapitalized =
        clientName.charAt(0).toUpperCase() + clientName.slice(1);
      const alertMessage = `🔴 ${clientNameCapitalized} crashed on ${machineId} with exit code ${code}!`;
      sendTelegramAlert("crash", alertMessage).catch((err) => {
        debugToFile(
          `startClient(): Failed to send crash alert - ${err.message}`
        );
      });
    }

    if (clientName === "geth" || clientName === "reth") {
      executionExited = true;
    } else if (clientName === "prysm" || clientName === "lighthouse") {
      consensusExited = true;
    }
  });

  child.on("error", (err) => {
    console.log(`Error from start client: ${err.message}`);
  });

  console.log(clientName, "started");

  child.stdout.on("error", (err) => {
    console.error(`Error on stdout of ${clientName}: ${err.message}`);
  });
}

/**
 * Start the validator client process.
 */
async function startValidatorClient(consensusClient, installDir) {
  let clientCommand;
  const clientArgs = [];

  if (consensusClient === "lighthouse") {
    clientCommand = path.join(
      __dirname,
      "ethereum_client_scripts/lighthouse_validator.js"
    );
  } else if (consensusClient === "prysm") {
    clientCommand = path.join(
      __dirname,
      "ethereum_client_scripts/prysm_validator.js"
    );
  }

  clientArgs.push("--directory", installDir);

  if (feeRecipient) {
    clientArgs.push("--fee-recipient", feeRecipient);
  }
  if (graffiti) {
    clientArgs.push("--graffiti", graffiti);
  }
  if (mevBoostEnabled) {
    clientArgs.push("--mev-boost");
  }

  const child = spawn("node", [clientCommand, ...clientArgs], {
    stdio: ["inherit", "pipe", "inherit"],
    cwd: process.env.HOME,
    env: { ...process.env, INSTALL_DIR: installDir },
  });

  validatorChild = child;

  child.on("exit", (code) => {
    const clientLabel = `${consensusClient} validator`;
    console.log(`🫡 ${clientLabel} process exited with code ${code}`);

    // Validator crashes are critical - always alert
    if (!isExiting && code !== null) {
      const machineId = os.hostname();
      const alertMessage = `🔴 CRITICAL: Validator client crashed on ${machineId} with exit code ${code}! Missed duties may result in penalties.`;
      sendTelegramAlert("crash", alertMessage).catch((err) => {
        debugToFile(
          `startValidatorClient(): Failed to send crash alert - ${err.message}`
        );
      });
    }

    validatorExited = true;
  });

  child.on("error", (err) => {
    console.log(`Error from validator client: ${err.message}`);
  });

  console.log(`${consensusClient} validator started`);

  child.stdout.on("error", (err) => {
    console.error(
      `Error on stdout of ${consensusClient} validator: ${err.message}`
    );
  });
}

/**
 * Start the MEV-Boost process.
 */
async function startMevBoost(installDir) {
  const clientCommand = path.join(
    __dirname,
    "ethereum_client_scripts/mevboost.js"
  );
  const clientArgs = ["--directory", installDir];

  const child = spawn("node", [clientCommand, ...clientArgs], {
    stdio: ["inherit", "pipe", "inherit"],
    cwd: process.env.HOME,
    env: { ...process.env, INSTALL_DIR: installDir },
  });

  mevBoostChild = child;

  child.on("exit", (code) => {
    console.log(`🫡 MEV-Boost process exited with code ${code}`);

    if (!isExiting && code !== null) {
      const machineId = os.hostname();
      const alertMessage = `🟡 MEV-Boost stopped on ${machineId} with exit code ${code}. Block proposals will use local block building.`;
      sendTelegramAlert("crash", alertMessage).catch((err) => {
        debugToFile(
          `startMevBoost(): Failed to send alert - ${err.message}`
        );
      });
    }

    mevBoostExited = true;
  });

  child.on("error", (err) => {
    console.log(`Error from MEV-Boost: ${err.message}`);
  });

  console.log("MEV-Boost started");

  child.stdout.on("error", (err) => {
    console.error(`Error on stdout of MEV-Boost: ${err.message}`);
  });
}

function isAlreadyRunning() {
  try {
    if (fs.existsSync(lockFilePath)) {
      const pid = fs.readFileSync(lockFilePath, "utf8");
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        if (e.code === "ESRCH") {
          fs.unlinkSync(lockFilePath);
          return false;
        }
        throw e;
      }
    }
    return false;
  } catch (err) {
    console.error("Error checking for existing process:", err);
    return false;
  }
}

function createLockFile() {
  fs.writeFileSync(lockFilePath, process.pid.toString(), "utf8");
  // console.log(process.pid.toString())
}

function removeLockFile() {
  if (fs.existsSync(lockFilePath)) {
    fs.unlinkSync(lockFilePath);
  }
}

const jwtDir = path.join(installDir, "ethereum_clients", "jwt");
const platform = os.platform();

if (["darwin", "linux"].includes(platform)) {
  installMacLinuxClient(executionClient, platform);
  installMacLinuxClient(consensusClient, platform);

  // Install MEV-Boost if enabled
  if (mevBoostEnabled) {
    installMacLinuxClient("mev-boost", platform);
  }
}
// } else if (platform === "win32") {
//   installWindowsExecutionClient(executionClient);
//   installWindowsConsensusClient(consensusClient);
// }

let messageForHeader = "";
let runsClient = false;

createJwtSecret(jwtDir);

// Initialize Telegram alert identifier if owner is provided
if (owner) {
  setTelegramAlertIdentifier(owner);
}

const executionClientVer = getVersionNumber(executionClient);
const consensusClientVer = getVersionNumber(consensusClient);

const wsConfig = {
  executionClient: executionClient,
  consensusClient: consensusClient,
  executionClientVer: executionClientVer,
  consensusClientVer: consensusClientVer,
};

if (!isAlreadyRunning()) {
  deleteOptionsFile();
  createLockFile();

  // Select best checkpoint URL if user didn't provide one
  let selectedCheckpointUrl = consensusCheckpoint;
  if (!selectedCheckpointUrl) {
    if (consensusClient === "lighthouse") {
      selectedCheckpointUrl = await selectCheckpointUrlForLighthouse(
        installDir,
        null
      );
    } else if (consensusClient === "prysm") {
      selectedCheckpointUrl = await selectCheckpointUrlForPrysm(
        installDir,
        null
      );
    }

    // Give users time to see the selected checkpoint URL before logs start
    if (selectedCheckpointUrl) {
      const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      const startDelay = 10000; // 10 seconds
      const updateInterval = 100; // Update spinner every 100ms
      const totalFrames = startDelay / updateInterval;

      process.stdout.write("\n⏳ Starting clients in 10 seconds ");

      for (let i = 0; i < totalFrames; i++) {
        const spinnerChar = spinnerFrames[i % spinnerFrames.length];
        process.stdout.write(
          `\r⏳ Starting clients in 10 seconds ${spinnerChar}`
        );
        await new Promise((resolve) => setTimeout(resolve, updateInterval));
      }

      process.stdout.write("\r⏳ Starting clients in 10 seconds ✓\n\n");
    }
  } else {
    console.log(
      `\n✅ Using user-provided checkpoint URL: ${selectedCheckpointUrl}`
    );
    console.log("   (skipping health checks per user request)\n");
  }

  // If validator mode is enabled, show warnings and set up keys
  if (validatorEnabled) {
    console.log("\n" + "═".repeat(60));
    console.log("  ⚡  VALIDATOR MODE ENABLED");
    console.log("═".repeat(60));
    console.log("");
    console.log("  Fee Recipient: " + feeRecipient);
    console.log("  Graffiti:      " + graffiti);
    console.log("  MEV-Boost:     " + (mevBoostEnabled ? "Enabled" : "Disabled"));
    console.log("");
    console.log("  ⚠️  WARNING: Running validator keys on multiple machines");
    console.log("  simultaneously WILL result in slashing and loss of ETH.");
    console.log("  Doppelganger protection is enabled for safety.");
    console.log("═".repeat(60));
    console.log("");

    setupValidatorKeys(installDir, feeRecipient, validatorKeysDir, consensusClient);
  }

  // Start MEV-Boost first if enabled (beacon node connects to it)
  if (mevBoostEnabled) {
    await startMevBoost(installDir);
    // Give MEV-Boost a moment to start before beacon node connects
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  await startClient(executionClient, executionType, installDir);
  await startClient(
    consensusClient,
    executionType,
    installDir,
    selectedCheckpointUrl
  );

  // Start validator client after beacon node (it connects to beacon API)
  if (validatorEnabled) {
    // Wait for beacon node API to be ready
    console.log("⏳ Waiting for beacon node to initialize before starting validator...");
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await startValidatorClient(consensusClient, installDir);
  }

  if (owner !== null) {
    initializeWebSocketConnection(wsConfig);
  }

  runsClient = true;
  saveOptionsToFile();
} else {
  messageForHeader = "Dashboard View (client already running)";
  runsClient = false;
  // Initialize WebSocket connection for secondary instances too
  if (owner !== null) {
    initializeWebSocketConnection(wsConfig);
  }
}

initializeMonitoring(
  messageForHeader,
  executionClient,
  consensusClient,
  executionClientVer,
  consensusClientVer,
  runsClient,
  validatorEnabled
);

let bgExecutionPeers = [];

setTimeout(async () => {
  bgExecutionPeers = await fetchBGExecutionPeers();
  await configureBGExecutionPeers(bgExecutionPeers);
}, 10000);

export { bgExecutionPeers, bgConsensusPeers };
