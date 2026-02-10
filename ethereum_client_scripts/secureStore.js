import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { debugToFile } from "../helpers.js";

/**
 * secureStore.js
 *
 * Manages a RAM-backed directory for storing sensitive files (keystore
 * passwords, Lighthouse per-validator secret files) so they never touch
 * physical disk.
 *
 * - Linux:  Uses /dev/shm (always a tmpfs).
 * - macOS:  Creates a small RAM disk via hdiutil/diskutil.
 * - Fallback: Uses os.tmpdir() with a warning.
 */

let secureDirPath = null;
let macRamDiskDevice = null; // e.g. "/dev/disk4" on macOS

/**
 * Clean up stale secure dirs from previous runs that may not have
 * exited cleanly (e.g. SIGKILL).
 */
function cleanupStaleDirs(parentDir) {
  try {
    if (!fs.existsSync(parentDir)) return;
    const entries = fs.readdirSync(parentDir);
    for (const entry of entries) {
      if (entry.startsWith("bgclient-")) {
        const stalePath = path.join(parentDir, entry);
        // Check if the PID in the dir name is still running
        const pid = parseInt(entry.replace("bgclient-", ""), 10);
        if (!isNaN(pid)) {
          try {
            process.kill(pid, 0); // throws if process doesn't exist
            // Process is still running -- leave it alone
          } catch {
            // Process is gone -- clean up
            debugToFile(`Cleaning up stale secure dir: ${stalePath}`);
            fs.rmSync(stalePath, { recursive: true, force: true });
          }
        }
      }
    }
  } catch (e) {
    debugToFile(`Warning: stale dir cleanup failed: ${e.message}`);
  }
}

/**
 * Create the secure directory on Linux using /dev/shm (tmpfs).
 */
function createLinuxSecureDir() {
  const shmDir = "/dev/shm";

  if (fs.existsSync(shmDir)) {
    cleanupStaleDirs(shmDir);
    const dirName = `bgclient-${process.pid}`;
    const dirPath = path.join(shmDir, dirName);
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    debugToFile(`Secure dir created on /dev/shm (tmpfs): ${dirPath}`);
    return dirPath;
  }

  return null;
}

/**
 * Create the secure directory on macOS using a RAM disk.
 *
 * Creates a 1 MB RAM disk (2048 512-byte sectors = 1 MiB), formats it
 * with HFS+, and mounts it at /Volumes/BGClientSecure.
 */
function createMacSecureDir() {
  try {
    // Create and attach a 1 MB RAM disk (2048 * 512 bytes)
    const deviceRaw = execFileSync("hdiutil", [
      "attach",
      "-nomount",
      "ram://2048",
    ], { encoding: "utf8" }).trim();

    macRamDiskDevice = deviceRaw;

    // Format and mount
    execFileSync("diskutil", [
      "erasevolume",
      "HFS+",
      "BGClientSecure",
      macRamDiskDevice,
    ], { stdio: "pipe" });

    const mountPoint = "/Volumes/BGClientSecure";
    const dirPath = path.join(mountPoint, `bgclient-${process.pid}`);
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });

    debugToFile(`Secure dir created on macOS RAM disk (${macRamDiskDevice}): ${dirPath}`);
    return dirPath;
  } catch (e) {
    debugToFile(`macOS RAM disk creation failed: ${e.message}`);
    macRamDiskDevice = null;
    return null;
  }
}

/**
 * Create the secure directory using os.tmpdir() as a last resort.
 * Files here ARE on physical disk -- user is warned.
 */
function createFallbackSecureDir() {
  const dirPath = path.join(os.tmpdir(), `bgclient-${process.pid}`);
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  console.log(
    "\n⚠️  WARNING: Could not create RAM-backed secure directory."
  );
  console.log(
    "   Password files will be stored in a temporary directory on disk"
  );
  console.log(
    `   and deleted on exit: ${dirPath}\n`
  );
  debugToFile(`Fallback secure dir created on disk: ${dirPath}`);
  return dirPath;
}

/**
 * Create a RAM-backed secure directory for storing password files.
 * Returns the absolute path to the directory.
 *
 * Call this once during startup. The returned path is cached.
 */
export function createSecureDir() {
  if (secureDirPath && fs.existsSync(secureDirPath)) {
    return secureDirPath;
  }

  const platform = os.platform();

  if (platform === "linux") {
    secureDirPath = createLinuxSecureDir();
  } else if (platform === "darwin") {
    secureDirPath = createMacSecureDir();
  }

  // Fallback for unsupported platforms or failures
  if (!secureDirPath) {
    secureDirPath = createFallbackSecureDir();
  }

  return secureDirPath;
}

/**
 * Get the path for the main password.txt inside the secure directory.
 */
export function getSecurePasswordPath() {
  if (!secureDirPath) {
    throw new Error("Secure directory has not been created. Call createSecureDir() first.");
  }
  return path.join(secureDirPath, "password.txt");
}

/**
 * Get the path for the Lighthouse secrets directory inside the secure dir.
 */
export function getSecureSecretsDir() {
  if (!secureDirPath) {
    throw new Error("Secure directory has not been created. Call createSecureDir() first.");
  }
  const secretsDir = path.join(secureDirPath, "secrets");
  if (!fs.existsSync(secretsDir)) {
    fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  }
  return secretsDir;
}

/**
 * Get the secure directory path (if created).
 */
export function getSecureDirPath() {
  return secureDirPath;
}

/**
 * Clean up the secure directory and all its contents.
 * On macOS, also unmounts and ejects the RAM disk.
 *
 * Safe to call multiple times.
 */
export function cleanupSecureDir() {
  if (!secureDirPath) return;

  try {
    // Remove all files in the secure dir
    if (fs.existsSync(secureDirPath)) {
      fs.rmSync(secureDirPath, { recursive: true, force: true });
      debugToFile(`Secure dir cleaned up: ${secureDirPath}`);
    }
  } catch (e) {
    debugToFile(`Warning: could not remove secure dir: ${e.message}`);
  }

  // On macOS, eject the RAM disk
  if (macRamDiskDevice) {
    try {
      execFileSync("hdiutil", ["detach", macRamDiskDevice, "-force"], {
        stdio: "pipe",
      });
      debugToFile(`macOS RAM disk ejected: ${macRamDiskDevice}`);
    } catch (e) {
      debugToFile(`Warning: could not eject RAM disk: ${e.message}`);
    }
    macRamDiskDevice = null;
  }

  secureDirPath = null;
}
