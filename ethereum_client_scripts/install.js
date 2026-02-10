import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import os from "os";
import { installDir } from "../commandLineOptions.js";
import { debugToFile } from "./../helpers.js";

export const latestGethVer = "1.16.7";
export const latestRethVer = "1.9.3";
export const latestLighthouseVer = "8.0.1";
export const latestMevBoostVer = "1.8.1";

export function installMacLinuxClient(clientName, platform) {
  const arch = os.arch();

  const gethHash = {
    "1.14.3": "ab48ba42",
    "1.14.12": "293a300d",
    "1.15.10": "2bf8a789",
    "1.15.11": "36b2371c",
    "1.16.3": "d818a9af",
    "1.16.5": "737ffd1b",
    "1.16.7": "b9f3a3d9",
  };

  const configs = {
    darwin: {
      x64: {
        geth: `geth-darwin-amd64-${latestGethVer}-${gethHash[latestGethVer]}`,
        reth: `reth-v${latestRethVer}-x86_64-apple-darwin`,
        lighthouse: `lighthouse-v${latestLighthouseVer}-aarch64-apple-darwin`,
        prysm: "prysm.sh",
        "mev-boost": `mev-boost_${latestMevBoostVer}_darwin_amd64`,
      },
      arm64: {
        geth: `geth-darwin-arm64-${latestGethVer}-${gethHash[latestGethVer]}`,
        reth: `reth-v${latestRethVer}-aarch64-apple-darwin`,
        lighthouse: `lighthouse-v${latestLighthouseVer}-aarch64-apple-darwin`,
        prysm: "prysm.sh",
        "mev-boost": `mev-boost_${latestMevBoostVer}_darwin_arm64`,
      },
    },
    linux: {
      x64: {
        geth: `geth-linux-amd64-${latestGethVer}-${gethHash[latestGethVer]}`,
        reth: `reth-v${latestRethVer}-x86_64-unknown-linux-gnu`,
        lighthouse: `lighthouse-v${latestLighthouseVer}-x86_64-unknown-linux-gnu`,
        prysm: "prysm.sh",
        "mev-boost": `mev-boost_${latestMevBoostVer}_linux_amd64`,
      },
      arm64: {
        geth: `geth-linux-arm64-${latestGethVer}-${gethHash[latestGethVer]}`,
        reth: `reth-v${latestRethVer}-aarch64-unknown-linux-gnu`,
        lighthouse: `lighthouse-v${latestLighthouseVer}-aarch64-unknown-linux-gnu`,
        prysm: "prysm.sh",
        "mev-boost": `mev-boost_${latestMevBoostVer}_linux_arm64`,
      },
    },
  };

  const fileName = configs[platform][arch][clientName];
  const clientDir = path.join(installDir, "ethereum_clients", clientName);

  // Determine the expected binary/script name
  let clientBinName;
  if (clientName === "prysm") {
    clientBinName = "prysm.sh";
  } else if (clientName === "mev-boost") {
    clientBinName = "mev-boost";
  } else {
    clientBinName = clientName;
  }

  const clientScript = path.join(clientDir, clientBinName);

  if (!fs.existsSync(clientScript)) {
    console.log(`\nInstalling ${clientName}.`);
    if (!fs.existsSync(clientDir)) {
      console.log(`Creating '${clientDir}'`);
      fs.mkdirSync(`${clientDir}/database`, { recursive: true });
      fs.mkdirSync(`${clientDir}/logs`, { recursive: true });
    }

    const downloadUrls = {
      geth: `https://gethstore.blob.core.windows.net/builds/${fileName}.tar.gz`,
      reth: `https://github.com/paradigmxyz/reth/releases/download/v${latestRethVer}/${fileName}.tar.gz`,
      lighthouse: `https://github.com/sigp/lighthouse/releases/download/v${latestLighthouseVer}/${fileName}.tar.gz`,
      prysm:
        "https://raw.githubusercontent.com/prysmaticlabs/prysm/master/prysm.sh",
      "mev-boost": `https://github.com/flashbots/mev-boost/releases/download/v${latestMevBoostVer}/${fileName}.tar.gz`,
    };

    if (clientName === "prysm") {
      console.log("Downloading Prysm.");
      execSync(
        `cd "${clientDir}" && curl -L -O -# ${downloadUrls.prysm} && chmod +x prysm.sh`,
        { stdio: "inherit" }
      );
    } else if (clientName === "mev-boost") {
      console.log("Downloading MEV-Boost.");
      execSync(
        `cd "${clientDir}" && curl -L -O -# ${downloadUrls["mev-boost"]}`,
        { stdio: "inherit" }
      );
      console.log("Extracting MEV-Boost.");
      execSync(`cd "${clientDir}" && tar -xzvf "${fileName}.tar.gz"`, {
        stdio: "inherit",
      });
      execSync(`cd "${clientDir}" && chmod +x mev-boost`, {
        stdio: "inherit",
      });
      console.log("Cleaning up mev-boost directory.");
      execSync(`cd "${clientDir}" && rm "${fileName}.tar.gz"`, {
        stdio: "inherit",
      });
    } else {
      console.log(`Downloading ${clientName}.`);
      execSync(
        `cd "${clientDir}" && curl -L -O -# ${downloadUrls[clientName]}`,
        { stdio: "inherit" }
      );
      console.log(`Uncompressing ${clientName}.`);
      execSync(`cd "${clientDir}" && tar -xzvf "${fileName}.tar.gz"`, {
        stdio: "inherit",
      });

      if (clientName === "geth") {
        execSync(`cd "${clientDir}/${fileName}" && mv geth ..`, {
          stdio: "inherit",
        });
        execSync(`cd "${clientDir}" && rm -r "${fileName}"`, {
          stdio: "inherit",
        });
      }

      console.log(`Cleaning up ${clientName} directory.`);
      execSync(`cd "${clientDir}" && rm "${fileName}.tar.gz"`, {
        stdio: "inherit",
      });
    }
  } else {
    console.log(`${clientName} is already installed.`);
  }
}

export function getVersionNumber(client) {
  const platform = os.platform();
  let clientCommand;
  let argument;
  let versionOutput;
  let versionMatch;

  if (client === "reth" || client === "lighthouse" || client === "geth") {
    argument = "--version";
  } else if (client === "prysm") {
    argument = "beacon-chain --version";
  }

  if (["darwin", "linux"].includes(platform)) {
    clientCommand = path.join(
      installDir,
      "ethereum_clients",
      `${client}`,
      client === "prysm" ? `${client}.sh` : `${client}`
    );
  } else if (platform === "win32") {
    console.log("getVersionNumber() for windows is yet not implemented");
    process.exit(1);
  }

  try {
    const versionCommand = execSync(
      `${clientCommand} ${argument} 2>/dev/null`,
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }
    );
    versionOutput = versionCommand.trim();

    if (client === "reth") {
      versionMatch = versionOutput.match(
        /[Rr]eth(?:-ethereum-cli)? Version: (\d+\.\d+\.\d+)/
      );
    } else if (client === "lighthouse") {
      versionMatch = versionOutput.match(/Lighthouse v(\d+\.\d+\.\d+)/);
    } else if (client === "geth") {
      versionMatch = versionOutput.match(/geth version (\d+\.\d+\.\d+)/);
    } else if (client === "prysm") {
      versionMatch = versionOutput.match(/beacon-chain-v(\d+\.\d+\.\d+)-/);
    }

    const parsedVersion = versionMatch ? versionMatch[1] : null;

    if (parsedVersion) {
      return parsedVersion;
    } else {
      debugToFile(`Unable to parse version number for ${client}`);
      return null;
    }
  } catch (error) {
    debugToFile(`Error getting version for ${client}:`, error.message);
    return null;
  }
}

export function compareClientVersions(client, installedVersion) {
  let isLatest = true;
  let latestVersion;

  if (client === "reth") {
    latestVersion = latestRethVer;
  } else if (client === "geth") {
    latestVersion = latestGethVer;
  } else if (client === "lighthouse") {
    latestVersion = latestLighthouseVer;
  }
  if (compareVersions(installedVersion, latestVersion) < 0) {
    isLatest = false;
  }
  return [isLatest, latestVersion];
}

export function removeClient(client) {
  const clientDir = path.join(installDir, "ethereum_clients", client, client);
  if (fs.existsSync(clientDir)) {
    fs.rmSync(clientDir, { recursive: true });
  }
}

function compareVersions(v1, v2) {
  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    if (parts1[i] > parts2[i]) return 1;
    if (parts1[i] < parts2[i]) return -1;
  }

  return 0;
}
