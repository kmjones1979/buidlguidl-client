import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFileSync, spawnSync } from "child_process";
import readlineSync from "readline-sync";
import { debugToFile } from "../helpers.js";
import {
  getSecurePasswordPath,
  getSecureSecretsDir,
  getSecureDirPath,
} from "./secureStore.js";

const latestDepositCliVer = "2.7.0";

/**
 * Expected SHA256 checksums for staking-deposit-cli v2.7.0 archives.
 * Source: https://github.com/ethereum/staking-deposit-cli/releases/tag/v2.7.0
 */
const DEPOSIT_CLI_CHECKSUMS = {
  "staking_deposit-cli-fdab65d-darwin-amd64.tar.gz":
    "8f33bdb78dfbe334ac25d4d5146bb58a43a06b4f3ab02268ceaf003de1ebc4c3",
  "staking_deposit-cli-fdab65d-linux-amd64.tar.gz":
    "ac3151843d681c92ae75567a88fbe0e040d53c21368cc1ed1a8c3d9fb29f2a3a",
  "staking_deposit-cli-fdab65d-linux-arm64.tar.gz":
    "e9ba5baadd5fe0a30c3f222d8cf66cccdd414c7748d095a2c0540904deff3bac",
};

/**
 * Verify the SHA256 checksum of a file against an expected value.
 * Returns true if the checksum matches, false otherwise.
 */
function verifySha256(filePath, expectedHash) {
  const fileBuffer = fs.readFileSync(filePath);
  const hash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  return hash === expectedHash;
}

/**
 * Get the staking-deposit-cli download URL and filename for the current platform.
 */
function getDepositCliConfig(platform) {
  const arch = os.arch();

  // Note: macOS arm64 (Apple Silicon) uses the amd64 build via Rosetta 2.
  // There is no official darwin-arm64 build for v2.7.0.
  const configs = {
    darwin: {
      x64: `staking_deposit-cli-fdab65d-darwin-amd64`,
      arm64: `staking_deposit-cli-fdab65d-darwin-amd64`,
    },
    linux: {
      x64: `staking_deposit-cli-fdab65d-linux-amd64`,
      arm64: `staking_deposit-cli-fdab65d-linux-arm64`,
    },
  };

  const fileName = configs[platform]?.[arch];
  if (!fileName) {
    throw new Error(
      `Unsupported platform/architecture: ${platform}/${arch} for staking-deposit-cli`
    );
  }

  const downloadUrl = `https://github.com/ethereum/staking-deposit-cli/releases/download/v${latestDepositCliVer}/${fileName}.tar.gz`;

  return { fileName, downloadUrl };
}

/**
 * Install the staking-deposit-cli if not already present.
 * Downloads the binary, verifies its SHA256 checksum, and extracts it.
 */
export function installDepositCli(installDir, platform) {
  const depositCliDir = path.join(
    installDir,
    "ethereum_clients",
    "deposit-cli"
  );
  const depositCliBin = path.join(depositCliDir, "deposit");

  if (fs.existsSync(depositCliBin)) {
    debugToFile("staking-deposit-cli is already installed.");
    return depositCliBin;
  }

  console.log("\nInstalling staking-deposit-cli...");

  if (!fs.existsSync(depositCliDir)) {
    fs.mkdirSync(depositCliDir, { recursive: true });
  }

  const { fileName, downloadUrl } = getDepositCliConfig(platform);
  const archiveName = `${fileName}.tar.gz`;
  const archivePath = path.join(depositCliDir, archiveName);

  // Download using execFileSync (no shell interpolation)
  console.log("Downloading staking-deposit-cli...");
  execFileSync("curl", ["-L", "-o", archivePath, "-#", downloadUrl], {
    stdio: "inherit",
  });

  // Verify SHA256 checksum
  const expectedChecksum = DEPOSIT_CLI_CHECKSUMS[archiveName];
  if (!expectedChecksum) {
    console.log(`❌ No known checksum for ${archiveName}. Aborting for safety.`);
    fs.unlinkSync(archivePath);
    process.exit(1);
  }

  console.log("Verifying SHA256 checksum...");
  if (!verifySha256(archivePath, expectedChecksum)) {
    console.log("❌ SHA256 checksum verification FAILED!");
    console.log("   The downloaded file may be corrupted or tampered with.");
    console.log("   Aborting installation for safety.");
    fs.unlinkSync(archivePath);
    process.exit(1);
  }
  console.log("✅ Checksum verified.");

  // Extract using execFileSync (no shell interpolation)
  console.log("Extracting staking-deposit-cli...");
  execFileSync("tar", ["-xzf", archivePath, "-C", depositCliDir], {
    stdio: "inherit",
  });

  // Move the binary out of the extracted directory
  const extractedBin = path.join(depositCliDir, fileName, "deposit");
  if (fs.existsSync(extractedBin)) {
    fs.renameSync(extractedBin, depositCliBin);
    fs.chmodSync(depositCliBin, 0o755);
  }

  // Cleanup: remove the archive and extracted directory
  try {
    fs.unlinkSync(archivePath);
    fs.rmSync(path.join(depositCliDir, fileName), { recursive: true, force: true });
  } catch (e) {
    debugToFile(`Cleanup warning: ${e.message}`);
  }

  console.log("staking-deposit-cli installed successfully.\n");
  return depositCliBin;
}

/**
 * Ensure the validator directories exist.
 */
export function ensureValidatorDirs(installDir, consensusClient) {
  const validatorDir = path.join(installDir, "ethereum_clients", "validator");
  const keystoresDir = path.join(validatorDir, "keystores");
  const depositDataDir = path.join(validatorDir, "deposit_data");
  const clientDataDir = path.join(validatorDir, consensusClient, "database");
  const clientLogsDir = path.join(validatorDir, consensusClient, "logs");

  for (const dir of [
    validatorDir,
    keystoresDir,
    depositDataDir,
    clientDataDir,
    clientLogsDir,
  ]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  return { validatorDir, keystoresDir, depositDataDir };
}

/**
 * Check if validator keystores already exist.
 */
export function hasExistingKeys(installDir) {
  const keystoresDir = path.join(
    installDir,
    "ethereum_clients",
    "validator",
    "keystores"
  );

  if (!fs.existsSync(keystoresDir)) {
    return false;
  }

  const files = fs.readdirSync(keystoresDir);
  return files.some((f) => f.startsWith("keystore") && f.endsWith(".json"));
}

/**
 * Get the path where the password file is stored.
 * Uses the RAM-backed secure directory when available.
 */
export function getPasswordFilePath(installDir) {
  // Use tmpfs-backed path if the secure dir exists
  const secureDir = getSecureDirPath();
  if (secureDir) {
    return getSecurePasswordPath();
  }
  // Fallback for cases where secure dir isn't created yet
  return path.join(
    installDir,
    "ethereum_clients",
    "validator",
    "password.txt"
  );
}

/**
 * Check if a password file exists.
 */
export function hasPasswordFile(installDir) {
  return fs.existsSync(getPasswordFilePath(installDir));
}

/**
 * Prompt the user for their keystore password and write it to a secure
 * RAM-backed (tmpfs) file. The file never touches physical disk.
 *
 * The file is written with 0o600 permissions and is cleaned up along with
 * the entire secure directory when the process exits (see cleanupSecureDir).
 *
 * If firstTime is true, the user must confirm the password (used during
 * initial key generation/import). On subsequent startups, a single prompt
 * is sufficient.
 */
export function promptAndSavePassword(installDir, { firstTime = false } = {}) {
  const passwordPath = getPasswordFilePath(installDir);
  const parentDir = path.dirname(passwordPath);

  console.log("\n🔑 Keystore Password");
  console.log("─".repeat(50));
  console.log(
    "Enter the password for your validator keystore(s)."
  );
  console.log(
    "The password is stored in RAM only (tmpfs) and never written to"
  );
  console.log(
    "physical disk. It is destroyed when the process exits.\n"
  );

  const password = readlineSync.question("Keystore password: ", {
    hideEchoBack: true,
  });

  if (password.length < 8) {
    console.log("❌ Password must be at least 8 characters long.");
    process.exit(1);
  }

  if (firstTime) {
    const confirmPassword = readlineSync.question("Confirm password: ", {
      hideEchoBack: true,
    });

    if (password !== confirmPassword) {
      console.log("❌ Passwords do not match. Please try again.");
      process.exit(1);
    }
  }

  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  }

  fs.writeFileSync(passwordPath, password, { mode: 0o600 });
  debugToFile("Password file created in RAM-backed secure directory.");

  return passwordPath;
}

/**
 * Generate new validator keys using the staking-deposit-cli.
 */
export function generateValidatorKeys(installDir, feeRecipient) {
  const platform = os.platform();
  if (!["darwin", "linux"].includes(platform)) {
    console.log("❌ Key generation is only supported on macOS and Linux.");
    process.exit(1);
  }

  const depositCliBin = installDepositCli(installDir, platform);
  const { keystoresDir, depositDataDir } = ensureValidatorDirs(
    installDir,
    "lighthouse"
  );

  console.log("\n" + "═".repeat(60));
  console.log("  🔐  VALIDATOR KEY GENERATION");
  console.log("═".repeat(60));
  console.log("");
  console.log("⚠️  IMPORTANT WARNINGS:");
  console.log("  • You will be shown a mnemonic phrase. BACK IT UP SAFELY.");
  console.log("  • Anyone with the mnemonic can control your validator(s).");
  console.log("  • Never share your mnemonic or store it digitally.");
  console.log("  • Each validator requires a 32 ETH deposit.");
  console.log("");
  console.log("─".repeat(60));

  // Ask number of validators
  const numValidatorsStr = readlineSync.question(
    "\nHow many validators to create? (default: 1): "
  );

  let numValidators = 1;
  if (numValidatorsStr.trim() !== "") {
    // Strict numeric validation: reject strings like "5abc"
    if (!/^\d+$/.test(numValidatorsStr.trim())) {
      console.log("❌ Invalid input. Please enter a whole number.");
      process.exit(1);
    }
    numValidators = parseInt(numValidatorsStr.trim(), 10);
  }

  if (numValidators < 1 || numValidators > 100) {
    console.log("❌ Number of validators must be between 1 and 100.");
    process.exit(1);
  }

  // Use the fee recipient as the withdrawal address
  const withdrawalAddress = feeRecipient;
  console.log(`\nUsing fee recipient as withdrawal address: ${withdrawalAddress}`);

  // Confirm
  const confirm = readlineSync.question(
    `\nGenerate ${numValidators} validator key(s)? (y/n): `
  );

  if (confirm.toLowerCase() !== "y" && confirm.toLowerCase() !== "yes") {
    console.log("Key generation cancelled.");
    process.exit(0);
  }

  console.log("\n🔄 Generating validator keys...\n");
  console.log(
    "You will be prompted by the deposit-cli to create a keystore password and confirm your mnemonic.\n"
  );

  const outputFolder = path.join(installDir, "ethereum_clients", "validator");

  try {
    // Let deposit-cli prompt for password interactively (do NOT pass empty password)
    const depositCliArgs = [
      "new-mnemonic",
      "--chain", "mainnet",
      "--num_validators", String(numValidators),
      "--execution_address", withdrawalAddress,
      "--folder", outputFolder,
    ];

    execFileSync(depositCliBin, depositCliArgs, {
      stdio: "inherit",
      cwd: outputFolder,
    });
  } catch (error) {
    debugToFile(`Key generation error: ${error.message}`);
    console.log(
      "\n❌ Key generation failed. You may need to run it manually."
    );
    console.log("   The staking-deposit-cli is located at:");
    console.log(`   ${depositCliBin}`);
    process.exit(1);
  }

  // Move generated keystores to the proper directory
  const validatorKeysDir = path.join(
    installDir,
    "ethereum_clients",
    "validator",
    "validator_keys"
  );

  if (fs.existsSync(validatorKeysDir)) {
    const files = fs.readdirSync(validatorKeysDir);

    for (const file of files) {
      const srcPath = path.join(validatorKeysDir, file);

      if (file.startsWith("keystore") && file.endsWith(".json")) {
        const destPath = path.join(keystoresDir, file);
        fs.copyFileSync(srcPath, destPath);
        fs.chmodSync(destPath, 0o600);
        console.log(`  Keystore: ${file} -> keystores/`);
      } else if (file.startsWith("deposit_data") && file.endsWith(".json")) {
        const destPath = path.join(depositDataDir, file);
        fs.copyFileSync(srcPath, destPath);
        console.log(`  Deposit data: ${file} -> deposit_data/`);
      }
    }
  }

  console.log("\n" + "═".repeat(60));
  console.log("  ✅  KEY GENERATION COMPLETE");
  console.log("═".repeat(60));
  console.log("");
  console.log("📋 Next steps:");
  console.log(
    "  1. BACK UP your mnemonic phrase in a secure, offline location"
  );
  console.log(
    "  2. Go to https://launchpad.ethereum.org/ to make your 32 ETH deposit"
  );
  console.log(
    `  3. Upload the deposit_data JSON file from: ${depositDataDir}`
  );
  console.log(
    "  4. Your validator will activate once the deposit is processed (~24 hours)"
  );
  console.log("");
  console.log(
    "⚠️  Your validator client will show 'waiting for activation' until then."
  );
  console.log("─".repeat(60));

  // Prompt password for the session (first time setup)
  promptAndSavePassword(installDir, { firstTime: true });

  return true;
}

/**
 * Import existing validator keys from a directory.
 */
export function importValidatorKeys(installDir, keysSourceDir, consensusClient) {
  const { keystoresDir } = ensureValidatorDirs(installDir, consensusClient);

  console.log("\n📥 Importing validator keys...");
  console.log(`   Source: ${keysSourceDir}`);
  console.log(`   Destination: ${keystoresDir}\n`);

  if (!fs.existsSync(keysSourceDir)) {
    console.log(`❌ Keys directory not found: ${keysSourceDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(keysSourceDir);
  const keystoreFiles = files.filter(
    (f) => f.startsWith("keystore") && f.endsWith(".json")
  );
  const depositFiles = files.filter(
    (f) => f.startsWith("deposit_data") && f.endsWith(".json")
  );

  if (keystoreFiles.length === 0) {
    console.log(
      "❌ No keystore files found in the specified directory."
    );
    console.log(
      "   Expected files matching pattern: keystore-*.json"
    );
    process.exit(1);
  }

  console.log(`Found ${keystoreFiles.length} keystore file(s).`);

  // Display slashing warning
  console.log("\n" + "═".repeat(60));
  console.log("  ⚠️   SLASHING WARNING");
  console.log("═".repeat(60));
  console.log("");
  console.log(
    "  Running the same validator keys on MULTIPLE machines"
  );
  console.log(
    "  simultaneously WILL result in SLASHING and LOSS of ETH!"
  );
  console.log("");
  console.log(
    "  Make sure these keys are NOT running on another machine."
  );
  console.log("═".repeat(60));

  const confirm = readlineSync.question(
    "\nI confirm these keys are NOT running elsewhere (y/n): "
  );

  if (confirm.toLowerCase() !== "y" && confirm.toLowerCase() !== "yes") {
    console.log("Import cancelled.");
    process.exit(0);
  }

  // Copy keystore files
  for (const file of keystoreFiles) {
    const srcPath = path.join(keysSourceDir, file);
    const destPath = path.join(keystoresDir, file);
    fs.copyFileSync(srcPath, destPath);
    fs.chmodSync(destPath, 0o600);
    console.log(`  ✅ Imported: ${file}`);
  }

  // Copy deposit data files if present
  if (depositFiles.length > 0) {
    const depositDataDir = path.join(
      installDir,
      "ethereum_clients",
      "validator",
      "deposit_data"
    );

    for (const file of depositFiles) {
      const srcPath = path.join(keysSourceDir, file);
      const destPath = path.join(depositDataDir, file);
      fs.copyFileSync(srcPath, destPath);
      console.log(`  ✅ Imported deposit data: ${file}`);
    }
  }

  console.log(`\n✅ Successfully imported ${keystoreFiles.length} keystore(s).`);

  // Prompt for password (first time setup)
  promptAndSavePassword(installDir, { firstTime: true });

  return true;
}

/**
 * Import keys into Prysm validator wallet (Prysm requires its own import step).
 */
export function importKeysForPrysm(installDir) {
  const keystoresDir = path.join(
    installDir,
    "ethereum_clients",
    "validator",
    "keystores"
  );
  const passwordPath = getPasswordFilePath(installDir);
  const prysmWalletDir = path.join(
    installDir,
    "ethereum_clients",
    "validator",
    "prysm",
    "database"
  );

  const platform = os.platform();
  let prysmCommand;

  if (["darwin", "linux"].includes(platform)) {
    prysmCommand = path.join(
      installDir,
      "ethereum_clients",
      "prysm",
      "prysm.sh"
    );
  } else {
    console.log("❌ Prysm key import is only supported on macOS and Linux.");
    process.exit(1);
  }

  if (!fs.existsSync(prysmCommand)) {
    console.log("❌ Prysm is not installed. Cannot import keys.");
    process.exit(1);
  }

  console.log("\n🔄 Importing keys into Prysm validator wallet...");

  try {
    execFileSync(prysmCommand, [
      "validator", "accounts", "import",
      `--keys-dir=${keystoresDir}`,
      `--wallet-dir=${prysmWalletDir}`,
      `--wallet-password-file=${passwordPath}`,
      `--account-password-file=${passwordPath}`,
      "--mainnet",
      "--accept-terms-of-use",
    ], {
      stdio: "inherit",
    });
    console.log("✅ Keys imported into Prysm wallet successfully.");
  } catch (error) {
    debugToFile(`Prysm key import error: ${error.message}`);
    console.log("⚠️  Prysm key import may have failed. Check logs for details.");
  }
}

/**
 * Main setup flow for validator keys.
 * Called from index.js when --validator is enabled.
 */
export function setupValidatorKeys(
  installDir,
  feeRecipient,
  validatorKeysDir,
  consensusClient
) {
  // Check if keys already exist
  if (hasExistingKeys(installDir)) {
    console.log("\n✅ Existing validator keystores found. Skipping key setup.");

    // Always prompt for password on startup (never persist between sessions)
    promptAndSavePassword(installDir);

    return;
  }

  // If user provided a keys directory, import from there
  if (validatorKeysDir) {
    importValidatorKeys(installDir, validatorKeysDir, consensusClient);

    // Import into Prysm wallet if using Prysm
    if (consensusClient === "prysm") {
      importKeysForPrysm(installDir);
    }

    return;
  }

  // Otherwise, offer to generate or import
  console.log("\n🔑 No validator keys found. What would you like to do?\n");
  console.log("  1. Generate new validator keys");
  console.log("  2. Import existing validator keys");
  console.log("  3. Cancel\n");

  const choice = readlineSync.question("Choose an option (1/2/3): ");

  if (choice === "1") {
    generateValidatorKeys(installDir, feeRecipient);

    if (consensusClient === "prysm") {
      importKeysForPrysm(installDir);
    }
  } else if (choice === "2") {
    const keysPath = readlineSync.question(
      "Enter the path to your validator keystores directory: "
    );
    importValidatorKeys(installDir, keysPath.trim(), consensusClient);

    if (consensusClient === "prysm") {
      importKeysForPrysm(installDir);
    }
  } else {
    console.log("Validator setup cancelled.");
    process.exit(0);
  }
}
