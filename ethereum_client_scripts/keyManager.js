import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import readlineSync from "readline-sync";
import { debugToFile } from "../helpers.js";

const latestDepositCliVer = "2.7.0";

/**
 * Get the staking-deposit-cli download URL and filename for the current platform.
 */
function getDepositCliConfig(platform) {
  const arch = os.arch();

  const configs = {
    darwin: {
      x64: `staking_deposit-cli-fdab65d-darwin-amd64`,
      arm64: `staking_deposit-cli-fdab65d-darwin-arm64`,
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

  console.log("Downloading staking-deposit-cli...");
  execSync(`cd "${depositCliDir}" && curl -L -O -# ${downloadUrl}`, {
    stdio: "inherit",
  });

  console.log("Extracting staking-deposit-cli...");
  execSync(`cd "${depositCliDir}" && tar -xzvf "${fileName}.tar.gz"`, {
    stdio: "inherit",
  });

  // Move the binary out of the extracted directory
  execSync(`cd "${depositCliDir}/${fileName}" && mv deposit ..`, {
    stdio: "inherit",
  });

  // Cleanup
  execSync(
    `cd "${depositCliDir}" && rm -rf "${fileName}" "${fileName}.tar.gz"`,
    {
      stdio: "inherit",
    }
  );

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
 * Check if a password file exists.
 */
export function hasPasswordFile(installDir) {
  const passwordPath = path.join(
    installDir,
    "ethereum_clients",
    "validator",
    "password.txt"
  );
  return fs.existsSync(passwordPath);
}

/**
 * Prompt the user for their keystore password and save it securely.
 */
export function promptAndSavePassword(installDir) {
  const validatorDir = path.join(installDir, "ethereum_clients", "validator");
  const passwordPath = path.join(validatorDir, "password.txt");

  if (fs.existsSync(passwordPath)) {
    return passwordPath;
  }

  console.log("\n🔑 Keystore Password Setup");
  console.log("─".repeat(50));
  console.log(
    "Enter the password for your validator keystore(s)."
  );
  console.log(
    "This will be stored locally to allow the validator client to start automatically.\n"
  );

  const password = readlineSync.question("Keystore password: ", {
    hideEchoBack: true,
  });

  const confirmPassword = readlineSync.question("Confirm password: ", {
    hideEchoBack: true,
  });

  if (password !== confirmPassword) {
    console.log("❌ Passwords do not match. Please try again.");
    process.exit(1);
  }

  if (!fs.existsSync(validatorDir)) {
    fs.mkdirSync(validatorDir, { recursive: true });
  }

  fs.writeFileSync(passwordPath, password, { mode: 0o600 });
  debugToFile("Keystore password file created with restrictive permissions.");

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
  const numValidators = parseInt(numValidatorsStr, 10) || 1;

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

  try {
    execSync(
      `"${depositCliBin}" new-mnemonic ` +
        `--chain mainnet ` +
        `--num_validators ${numValidators} ` +
        `--execution_address ${withdrawalAddress} ` +
        `--keystore_password "" ` +
        `--folder "${path.join(installDir, "ethereum_clients", "validator")}"`,
      {
        stdio: "inherit",
        cwd: path.join(installDir, "ethereum_clients", "validator"),
      }
    );
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

  // Prompt password for auto-start
  promptAndSavePassword(installDir);

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

  // Prompt for password
  promptAndSavePassword(installDir);

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
  const passwordPath = path.join(
    installDir,
    "ethereum_clients",
    "validator",
    "password.txt"
  );
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
    execSync(
      `"${prysmCommand}" validator accounts import ` +
        `--keys-dir="${keystoresDir}" ` +
        `--wallet-dir="${prysmWalletDir}" ` +
        `--wallet-password-file="${passwordPath}" ` +
        `--account-password-file="${passwordPath}" ` +
        `--mainnet ` +
        `--accept-terms-of-use`,
      {
        stdio: "inherit",
      }
    );
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

    // Ensure password file exists
    if (!hasPasswordFile(installDir)) {
      promptAndSavePassword(installDir);
    }

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
