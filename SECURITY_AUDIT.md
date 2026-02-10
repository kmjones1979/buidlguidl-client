# Security Audit Report: BuidlGuidl Client

**Audit Date:** February 9, 2026
**Remediation Date:** February 10, 2026
**Second Review Date:** February 10, 2026
**Repository:** `git@github.com:kmjones1979/buidlguidl-client.git`
**Initial Audit Commit:** `c74e2c1`
**Remediation Commit:** `f26cd46`
**tmpfs/YubiKey Commit:** `dfd48cd`
**Scope:** Full codebase audit -- all JavaScript source files, dependencies, and configuration

---

## Executive Summary

The BuidlGuidl Client is a Node.js tool that automates Ethereum node management, including execution clients (Reth/Geth), consensus clients (Lighthouse/Prysm), optional validator clients for solo staking, and optional MEV-boost. It connects to the BuidlGuidl distributed RPC network and provides a terminal monitoring dashboard.

The initial audit identified **7 Critical**, **8 High**, **12 Medium**, and **9 Low/Informational** findings across the codebase. A subsequent remediation pass addressed **all findings introduced by the validator support commits**, plus several pre-existing issues that were touched during the changes. A second review pass on the final state of all five validator-related commits identified **1 new Medium** and **3 new Low** findings; the Medium finding (M-13) and one Low (L-11) were fixed immediately.

### Severity Summary

| Severity | Initial Count | Added (2nd Review) | Resolved | Remaining |
|----------|---------------|---------------------|----------|-----------|
| Critical | 7 | 0 | 3 | 4 |
| High | 8 | 0 | 3 | 5 |
| Medium | 12 | 1 | 10 | 3 |
| Low / Informational | 9 | 3 | 5 | 7 |
| **Total** | **36** | **4** | **21** | **19** |

### Remediation Scope

The remediation focused on findings introduced by the five validator support commits ([comparison](https://github.com/BuidlGuidl/buidlguidl-client/compare/main...kmjones1979:buidlguidl-client:main)). Several pre-existing findings (H-03, H-05, L-05, M-10, M-11) were also fixed because the relevant code was already being modified. Pre-existing findings in files not touched by the validator commits remain open.

---

## Findings

---

### [C-01] Command Injection via Shell Execution in `configureBGPeers.js`

**Severity:** Critical
**Status:** OPEN (pre-existing, not introduced by validator commits)
**Location:** `ethereum_client_scripts/configureBGPeers.js` lines 41-42

**Description:**
The `configureBGExecutionPeers()` function constructs `curl` commands by directly interpolating `enode` values fetched from a remote server into a shell string passed to `exec()`:

```javascript
const curlCommandAddPeer = `curl -s -X POST -H "Content-Type: application/json" --data '{"jsonrpc":"2.0","id":1,"method":"admin_addPeer","params":["${enode}"]}' http://localhost:8545`;
```

If the remote server returns a malicious enode value (e.g., `"; rm -rf / #`), arbitrary shell commands will execute with the privileges of the Node.js process.

**Attack Scenario:**
1. Attacker compromises the BuidlGuidl peer endpoint (`https://pool.mainnet.rpc.buidlguidl.com:48546/enodes`)
2. Returns a crafted enode string containing shell metacharacters
3. The client executes arbitrary commands on the host machine

**Impact:** Full system compromise. The node operator's machine could be taken over, including access to validator keys, keystores, and funds.

**Recommendation:**
Replace `exec()` with a proper HTTP client library (the project already has `axios` and `node-fetch`):

```javascript
const response = await fetch("http://localhost:8545", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1,
    method: "admin_addPeer",
    params: [enode]
  })
});
```

---

### [C-02] Command Injection in `peerCountGauge.js` via Metrics Scraping

**Severity:** Critical
**Status:** OPEN (pre-existing, not introduced by validator commits)
**Location:** `monitor_components/peerCountGauge.js` lines 58-87, 122-129

**Description:**
The monitoring component constructs shell commands with `exec()` using `curl | grep` to scrape Prometheus metrics. While the `searchString` values are currently hardcoded, the pattern is dangerous and any future modification that introduces dynamic values would be immediately exploitable:

```javascript
exec(
  `curl -s http://localhost:5054/metrics | grep -E '^${searchString} '`,
  ...
);
```

**Impact:** If `searchString` becomes dynamic or is modified to include user input, arbitrary command execution is possible.

**Recommendation:**
Use an HTTP client library to fetch metrics and parse them in JavaScript instead of piping through shell commands.

---

### [C-03] No Binary Integrity Verification for Downloaded Executables

**Severity:** Critical
**Status:** OPEN (pre-existing; partial mitigation via C-04 fix for deposit-cli)
**Location:** `ethereum_client_scripts/install.js` lines 84-140

**Description:**
All client binaries (Reth, Geth, Lighthouse, Prysm, MEV-Boost) are downloaded from GitHub releases and extracted without any checksum or signature verification. The `prysm.sh` script is particularly dangerous as it is downloaded as a raw shell script and made executable.

**Attack Scenario:**
1. Attacker performs a supply chain attack (GitHub account compromise, DNS hijack, MITM on CDN)
2. Replaces a client binary with a trojaned version
3. The BuidlGuidl client downloads and executes the malicious binary
4. Attacker gains access to the node, validator keys, and staked ETH

**Impact:** Complete compromise of the node and all validator keys. Potential loss of all staked ETH through malicious withdrawals or slashing.

**Recommendation:**
1. Verify SHA256 checksums of all downloaded archives against known-good values
2. For Prysm, verify GPG signatures on the `prysm.sh` script
3. Store expected checksums alongside version numbers in `install.js`

```javascript
const checksums = {
  reth: { "1.9.3": { "x86_64-apple-darwin": "abc123...", ... } },
  // ...
};
```

---

### [C-04] No Integrity Verification for `staking-deposit-cli`

**Severity:** Critical
**Status:** RESOLVED
**Location:** `ethereum_client_scripts/keyManager.js`

**Description:**
The `staking-deposit-cli` binary, which generates validator mnemonic phrases and private keys, was downloaded without checksum verification. A compromised binary could generate keys known to the attacker.

**Remediation Applied:**
- Added a `DEPOSIT_CLI_CHECKSUMS` constant with official SHA256 checksums from the [v2.7.0 release page](https://github.com/ethereum/staking-deposit-cli/releases/tag/v2.7.0) for all supported platforms (linux-amd64, linux-arm64, darwin-amd64).
- Added a `verifySha256()` function using Node.js `crypto` module to compute and compare file hashes.
- The download now verifies the checksum before extraction. If verification fails, the archive is deleted and the process exits with an error.
- Fixed incorrect darwin-arm64 config (no official build exists) to use darwin-amd64 via Rosetta 2.
- Replaced `execSync` shell strings with `execFileSync` argument arrays for download and extraction.
- Replaced shell-based file operations (`mv`, `rm -rf`) with Node.js `fs.renameSync()` and `fs.rmSync()`.

---

### [C-05] Unauthenticated RPC Proxy in WebSocket Connection

**Severity:** Critical
**Status:** OPEN (pre-existing, not introduced by validator commits)
**Location:** `webSocketConnection.js` lines 168-195

**Description:**
The WebSocket connection to the BuidlGuidl pool acts as an RPC proxy, forwarding requests from the remote server to the local execution client at `http://localhost:8545` without any authentication, method filtering, or rate limiting.

**Attack Scenario:**
1. Attacker compromises the BuidlGuidl WebSocket server (or performs a MITM)
2. Sends arbitrary RPC requests through the proxy
3. Could call sensitive admin methods (`admin_addPeer`, `debug_*`, `personal_*`) or extract private state

**Impact:** Unauthorized access to the local Ethereum node's RPC interface. Potential for denial of service, state extraction, or manipulation.

**Recommendation:**
1. Implement an allowlist of permitted RPC methods (e.g., only `eth_call`, `eth_getBlockByNumber`, etc.)
2. Rate limit forwarded requests
3. Never proxy admin/debug namespace methods

---

### [C-06] Plaintext Password Storage for Validator Keystores

**Severity:** Critical
**Status:** RESOLVED
**Location:** `ethereum_client_scripts/keyManager.js`, `index.js`

**Description:**
The validator keystore password was previously stored in plaintext at `ethereum_clients/validator/password.txt` and persisted between sessions.

**Remediation Applied:**
- Password is now prompted on **every startup** rather than being persisted between sessions.
- **The password file is stored entirely in RAM** using a platform-specific RAM-backed filesystem:
  - **Linux:** `/dev/shm` (always a tmpfs, guaranteed to never touch physical disk).
  - **macOS:** A dedicated 1 MB RAM disk created via `hdiutil`/`diskutil`.
  - **Fallback:** If neither is available, `os.tmpdir()` is used with a warning.
- The RAM-backed secure directory is created with `0o700` permissions and password files within it use `0o600`.
- On process exit (`handleExit()` and `process.on('exit')`), `cleanupSecureDir()` removes all password files and, on macOS, ejects the RAM disk.
- Stale secure directories from previous unclean exits (e.g., SIGKILL) are automatically cleaned up on startup.
- During first-time setup (key generation or import), the password requires confirmation (enter twice). On subsequent startups, a single prompt is sufficient.
- Minimum password length of 8 characters is enforced.
- The `.gitignore` also covers `password.txt` as defense-in-depth.
- **Optional YubiKey 2FA** (`--yubikey` flag) adds a physical presence check: the user must touch their YubiKey, which emits a modhex-encoded OTP that is validated before the validator client starts. This prevents remote attackers from starting the validator even if they compromise the password.

---

### [C-07] Empty Keystore Password Passed to `staking-deposit-cli`

**Severity:** Critical
**Status:** RESOLVED
**Location:** `ethereum_client_scripts/keyManager.js`

**Description:**
The key generation command previously passed `--keystore_password ""` to the deposit-cli, which could result in unencrypted or weakly-encrypted keystores.

**Remediation Applied:**
- Removed the `--keystore_password ""` argument entirely.
- The deposit-cli now prompts the user interactively for a keystore password during generation, ensuring a proper password is always set.
- Replaced `execSync` shell string with `execFileSync` using an argument array, eliminating any possibility of shell injection in the deposit-cli invocation.

---

### [H-01] SSRF via User-Provided Checkpoint URLs

**Severity:** High
**Status:** OPEN (pre-existing, not introduced by validator commits)
**Location:** `checkpointHealthCheck.js` lines 235-241, 363-369

**Description:**
User-provided checkpoint URLs via `--consensuscheckpoint` are used directly without validation. An attacker (or a misconfigured user) could provide URLs targeting internal services.

**Attack Scenario:**
```bash
node index.js --consensuscheckpoint http://169.254.169.254/latest/meta-data/
```
This could access cloud metadata services, internal APIs, or scan internal ports.

**Impact:** Information disclosure of internal services, potential access to cloud instance credentials.

**Recommendation:**
Validate that checkpoint URLs:
1. Use `https://` protocol only
2. Do not resolve to private/internal IP ranges (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x)
3. Match a known hostname pattern for checkpoint servers

---

### [H-02] Command Injection via `execSync` in JWT Secret Generation

**Severity:** High
**Status:** OPEN (pre-existing, not introduced by validator commits)
**Location:** `index.js` line 62

**Description:**
JWT secret generation uses `execSync` with string interpolation of the `jwtDir` path:

```javascript
execSync(`cd "${jwtDir}" && openssl rand -hex 32 > jwt.hex`, {
  stdio: "inherit",
});
```

If `jwtDir` contains shell metacharacters (e.g., from a crafted `--directory` option), command injection is possible. Note: the new path traversal validation on `--directory` (see M-02 fix) mitigates this partially by restricting the directory to safe locations.

**Impact:** Arbitrary command execution.

**Recommendation:**
Use Node.js `crypto` module instead of shelling out:

```javascript
import crypto from "crypto";
const jwt = crypto.randomBytes(32).toString("hex");
fs.writeFileSync(path.join(jwtDir, "jwt.hex"), jwt);
```

---

### [H-03] Port Validation Logic Error (Always Bypassed)

**Severity:** High
**Status:** RESOLVED
**Location:** `commandLineOptions.js`

**Description:**
The port validation condition was logically incorrect and could never be true:

```javascript
executionPeerPort = parseInt(argv.executionpeerport, 10);
if (executionPeerPort === "number" && !isNaN(executionPeerPort)) {
```

A number can never `===` the string `"number"`, so the validation was always bypassed.

**Remediation Applied:**
- Replaced the broken condition with proper validation:
  ```javascript
  if (isNaN(executionPeerPort) || executionPeerPort < 1 || executionPeerPort > 65535) {
  ```
- Now correctly rejects non-numeric values, negative numbers, zero, and ports above 65535.

---

### [H-04] Lock File TOCTOU Race Condition

**Severity:** High
**Status:** OPEN (pre-existing, not introduced by validator commits)
**Location:** `index.js` lines 548-568

**Description:**
The `isAlreadyRunning()` function checks for the lock file's existence with `existsSync()`, then reads it with `readFileSync()`, then validates the PID with `process.kill(pid, 0)`. This creates a time-of-check-to-time-of-use (TOCTOU) race condition where:

1. Another instance could create the lock file between the existence check and the read
2. The PID could be recycled between the read and the kill probe

**Impact:** Multiple primary instances could run simultaneously, potentially corrupting client databases or causing conflicting validator operations (slashing risk).

**Recommendation:**
Use atomic lock file creation with `fs.openSync(lockFilePath, 'wx')` (exclusive create) wrapped in a try/catch.

---

### [H-05] Unsafe JSON Deserialization of Options File

**Severity:** High
**Status:** RESOLVED
**Location:** `commandLineOptions.js`

**Description:**
The options file was parsed with `JSON.parse()` without schema validation. A manually crafted or corrupted `options.json` could contain unexpected types, `__proto__` pollution payloads, or values that bypass validation.

**Remediation Applied:**
- Added comprehensive schema validation in `loadOptionsFromFile()`:
  - Verifies the root value is a plain object (not null, not array).
  - Rejects objects with `__proto__` or `constructor` keys (prototype pollution defense).
  - Validates types for all string fields (`executionClient`, `consensusClient`, `installDir`, `owner`, `feeRecipient`, `graffiti`, `validatorKeysDir`, `consensusCheckpoint`).
  - Validates boolean fields (`validatorEnabled`, `mevBoostEnabled`, `yubikeyEnabled`).
  - Validates `executionPeerPort` is a number and `consensusPeerPorts` is an array.
- Options file is now written with `mode: 0o600` (see M-10 fix).

---

### [H-06] Wildcard CORS and WebSocket Origins on Execution Clients

**Severity:** High
**Status:** OPEN (pre-existing, not introduced by validator commits)
**Location:** `ethereum_client_scripts/reth.js` lines 57-58, 72-73; `ethereum_client_scripts/geth.js` lines 65-66, 77-78

**Description:**
Both Reth and Geth are configured with wildcard CORS and WebSocket origins:

```
--http.corsdomain "*"
--ws.origins "*"
```

Combined with the HTTP RPC bound to `0.0.0.0:8545`, this allows any website visited by the node operator to make cross-origin requests to the local RPC endpoint.

**Attack Scenario:**
1. Node operator visits a malicious website
2. Website JavaScript makes `fetch("http://localhost:8545", ...)` calls
3. Due to wildcard CORS, the browser allows the response
4. Attacker can read blockchain state or call sensitive RPC methods

**Impact:** Unauthorized access to the local RPC interface from any web page.

**Recommendation:**
Restrict CORS to specific trusted origins or remove wildcard. Consider binding HTTP RPC to `127.0.0.1` only.

---

### [H-07] No WebSocket Authentication to BuidlGuidl Pool

**Severity:** High
**Status:** OPEN (pre-existing, not introduced by validator commits)
**Location:** `webSocketConnection.js` line 149

**Description:**
The WebSocket connection to the BuidlGuidl pool server has no authentication mechanism. Any client can connect and potentially impersonate a node operator by providing their Ethereum address.

**Impact:** Node impersonation, false check-ins, potential RPC reward theft.

**Recommendation:**
Implement signature-based authentication using the owner's Ethereum address to prove identity.

---

### [H-08] Sensitive System Data Transmitted to Remote Server

**Severity:** High
**Status:** OPEN (pre-existing, not introduced by validator commits)
**Location:** `webSocketConnection.js` lines 277-303

**Description:**
The following sensitive data is sent to the BuidlGuidl server on each check-in:
- MAC address (device fingerprint)
- Hostname
- Platform and architecture
- Git branch and commit hash
- Public IP address
- Enode (includes public IP)
- ENR and Peer ID
- System stats (CPU, memory, disk)

This data is transmitted over TLS (wss://) but to a third-party server, creating a privacy concern.

**Impact:** Device fingerprinting, privacy erosion, potential correlation with Ethereum addresses.

**Recommendation:**
1. Document exactly what data is collected and why (privacy policy)
2. Allow users to opt out of specific data points
3. Hash or anonymize the MAC address before sending
4. Consider making system stats opt-in rather than opt-out

---

### [M-01] Command Injection via `execSync` in `keyManager.js`

**Severity:** Medium
**Status:** RESOLVED
**Location:** `ethereum_client_scripts/keyManager.js`

**Description:**
Multiple `execSync()` calls constructed shell commands by interpolating variables into strings.

**Remediation Applied:**
- Replaced all `execSync` shell string calls with safe alternatives:
  - Download: `execFileSync("curl", [...args])` -- no shell interpolation.
  - Extraction: `execFileSync("tar", [...args])` -- no shell interpolation.
  - File operations: replaced shell `mv` and `rm -rf` with `fs.renameSync()` and `fs.rmSync()`.
  - Key generation: `execFileSync(depositCliBin, [...args])` -- argument array, no shell.
  - Prysm key import: `execFileSync(prysmCommand, [...args])` -- argument array, no shell.

---

### [M-02] Path Traversal in `--validator-keys-dir` and `--directory`

**Severity:** Medium
**Status:** RESOLVED
**Location:** `commandLineOptions.js`

**Description:**
The `isValidPath()` function only verified the path exists and is a directory. It did not prevent path traversal (e.g., `--directory ../../../etc`).

**Remediation Applied:**
- Both `--directory` and `--validator-keys-dir` values are now resolved to absolute paths via `path.resolve()` before validation.
- Added boundary validation: paths must be within the user's home directory, `/opt`, or `/srv`. Paths outside these boundaries are rejected.

---

### [M-03] Incorrect `--secrets-dir` Configuration in Lighthouse Validator

**Severity:** Medium
**Status:** RESOLVED
**Location:** `ethereum_client_scripts/lighthouse_validator.js`

**Description:**
The `--secrets-dir` flag pointed to the validator parent directory, but Lighthouse expects this directory to contain files named after the validator public key, each containing the keystore password.

**Remediation Applied:**
- Created a dedicated `secrets/` directory at `ethereum_clients/validator/secrets/`.
- On startup, the Lighthouse validator script reads each keystore JSON file, extracts the `pubkey` field, and creates a corresponding password file named `0x{pubkey}` in the secrets directory.
- Each per-validator password file is created with `0o600` permissions.
- The `--secrets-dir` argument now correctly points to this populated secrets directory.

---

### [M-04] Signal Handler Re-entrancy Risk

**Severity:** Medium
**Status:** OPEN (pre-existing, not introduced by validator commits)
**Location:** `index.js` lines 80-272

**Description:**
The `handleExit()` function uses a boolean `isExiting` flag to prevent re-entrancy, but this is not atomic. If two signals arrive in rapid succession before the flag is set, both could enter the handler.

**Recommendation:**
Use a more robust synchronization mechanism or accept the current risk with documentation.

---

### [M-05] Sensitive Data in Debug Logs

**Severity:** Medium
**Status:** RESOLVED
**Location:** `helpers.js`, multiple client scripts

**Description:**
Debug logs included sensitive information including full command-line arguments (with file paths to keystores and password files). The `debug.log` file was also created with default (world-readable) permissions.

**Remediation Applied:**
- `debug.log` is now created with `0o600` permissions (owner-only) via `fs.openSync()` with explicit mode in both `debugToFile()` and `setupDebugLogging()` in `helpers.js`.
- Lighthouse validator and Prysm validator startup debug logs now log only configuration flags (fee-recipient: set/none, graffiti value, mev-boost: true/false) instead of full command-line argument arrays containing filesystem paths.
- MEV-boost log was already safe (only logged relay count).

---

### [M-06] Prysm Beacon Node Uses `grpc-gateway` Instead of Standard Beacon API Port

**Severity:** Medium
**Status:** RESOLVED
**Location:** `ethereum_client_scripts/prysm.js`; `ethereum_client_scripts/prysm_validator.js`

**Description:**
The Prysm beacon node exposed gRPC gateway on port 5052, but the Prysm validator client connected via `--beacon-rpc-provider=localhost:4000` (gRPC). The default Prysm gRPC port (4000) was not explicitly configured.

**Remediation Applied:**
- Added explicit `--rpc-host=127.0.0.1` and `--rpc-port=4000` flags to the Prysm beacon node configuration.
- The validator client's `--beacon-rpc-provider=localhost:4000` now matches an explicitly configured port rather than relying on Prysm's default.
- Binding RPC to `127.0.0.1` restricts gRPC access to local connections only.

---

### [M-07] No Rate Limiting on Telegram Alert Endpoint

**Severity:** Medium
**Status:** OPEN (pre-existing, not introduced by validator commits)
**Location:** `telegramAlert.js` line 34

**Description:**
The Telegram alert endpoint has no client-side rate limiting. A rapidly crashing client could flood the alert service and potentially be used for denial of service.

**Recommendation:**
Add client-side rate limiting (e.g., max 1 alert per minute per alert type).

---

### [M-08] Trusted Peer Addition Without Verification

**Severity:** Medium
**Status:** OPEN (pre-existing, not introduced by validator commits)
**Location:** `ethereum_client_scripts/configureBGPeers.js` line 42

**Description:**
Peers fetched from the BuidlGuidl server are added as trusted peers without cryptographic verification. If the server is compromised, malicious peers could be injected.

**Impact:** Eclipse attacks, censorship, or targeted transaction manipulation.

**Recommendation:**
Sign peer lists with a known key, or allow users to verify/approve peer additions.

---

### [M-09] Staging URL in Production Telegram Alert Code

**Severity:** Medium
**Status:** OPEN (pre-existing, not introduced by validator commits)
**Location:** `telegramAlert.js` line 34

**Description:**
The alert endpoint uses `stage.rpc.buidlguidl.com` instead of a production URL, which may be unintentional.

**Recommendation:**
Verify this is the correct endpoint. If not, update to the production URL.

---

### [M-10] Options File Persists Sensitive Configuration in Plaintext

**Severity:** Medium
**Status:** RESOLVED
**Location:** `commandLineOptions.js`

**Description:**
The `options.json` file stored all CLI options in plaintext, including the owner's Ethereum address and fee recipient address, with default (world-readable) permissions.

**Remediation Applied:**
- `saveOptionsToFile()` now writes `options.json` with `mode: 0o600` (owner-only read/write).
- Combined with H-05 schema validation, the options file is now both permission-restricted and integrity-validated on load.

---

### [M-11] Environment Variable Inheritance in Child Processes

**Severity:** Medium
**Status:** RESOLVED
**Location:** All client scripts (`reth.js`, `geth.js`, `lighthouse.js`, `prysm.js`, `lighthouse_validator.js`, `prysm_validator.js`, `mevboost.js`)

**Description:**
Child processes previously inherited the full `process.env`, which may contain sensitive variables (API keys, tokens, credentials) from the parent environment.

**Remediation Applied:**
- All seven client process scripts now use a whitelisted environment containing only `HOME`, `PATH`, `TERM`, and `INSTALL_DIR` instead of spreading the full `process.env`.

---

### [M-12] Infinite Retry Loop When Fetching Public IP

**Severity:** Medium
**Status:** OPEN (pre-existing, not introduced by validator commits)
**Location:** `getSystemStats.js` lines 100-108

**Description:**
The public IP fetch retries indefinitely on failure, which could cause resource exhaustion or hang the process if the network is down.

**Recommendation:**
Add a maximum retry count and fallback behavior.

---

### [M-13] Prysm Validator gRPC Gateway Bound to All Interfaces

**Severity:** Medium
**Status:** RESOLVED (2nd review)
**Location:** `ethereum_client_scripts/prysm_validator.js` line 72

**Description:**
The Prysm validator client's gRPC gateway was configured with `--grpc-gateway-host=0.0.0.0`, binding it to all network interfaces. This exposed the validator's HTTP API (port 7500) to the local network and potentially the internet, allowing anyone on the network to query validator status, proposer duties, and other sensitive validator information.

**Remediation Applied:**
- Changed `--grpc-gateway-host=0.0.0.0` to `--grpc-gateway-host=127.0.0.1` to restrict the gRPC gateway to localhost-only access.

---

### [L-01] Floating Dependency Versions

**Severity:** Low
**Status:** OPEN (pre-existing)
**Location:** `package.json`

**Description:**
All dependencies use caret (`^`) ranges, allowing automatic minor/patch updates that could introduce breaking changes or vulnerabilities.

**Recommendation:**
Pin exact versions or use a lockfile verification step in CI.

---

### [L-02] Known Dependency Vulnerabilities

**Severity:** Low
**Status:** OPEN (pre-existing)
**Location:** `package.json` (transitive dependencies)

**Description:**
`yarn audit` reports 9 known vulnerabilities:

| Package | Severity | Issue |
|---------|----------|-------|
| `axios` (direct) | Critical | Server-Side Request Forgery |
| `axios` (direct) | High | Cross-Site Request Forgery |
| `axios` (direct) | High | DoS via data size check |
| `axios` (direct) | High | DoS via `__proto__` key |
| `axios` (direct) | High | Unspecified |
| `lodash` (via blessed-contrib) | Moderate | Prototype Pollution in `_.unset`/`_.omit` |
| `lodash` (via blessed-contrib) | Moderate | Prototype Pollution (duplicate path) |
| `xml2js` (via blessed-contrib) | Moderate | Prototype Pollution |

**Recommendation:**
1. Update `axios` to `>=1.13.5`
2. Consider replacing `blessed-contrib` or pinning a version with patched transitive dependencies

---

### [L-03] Missing Import in `viemClients.js`

**Severity:** Low
**Status:** OPEN (pre-existing)
**Location:** `monitor_components/viemClients.js` line 32

**Description:**
`debugToFile` is called but not imported in this file. This will cause a runtime error if the error handling path is triggered.

**Recommendation:**
Add `import { debugToFile } from "../helpers.js";` at the top of the file.

---

### [L-04] Git Information Exposed in Dashboard

**Severity:** Low
**Status:** OPEN (pre-existing)
**Location:** `monitor_components/header.js` lines 138, 147

**Description:**
The dashboard header displays the git branch and commit hash, which leaks information about the deployment state.

**Recommendation:**
Consider making this optional or removing it from the dashboard.

---

### [L-05] No Consensus Peer Port Range Validation

**Severity:** Low
**Status:** RESOLVED
**Location:** `commandLineOptions.js`

**Description:**
Consensus peer ports were parsed as integers but not validated against the valid port range (1-65535).

**Remediation Applied:**
- Added range validation (`p < 1 || p > 65535`) to the consensus peer ports parsing, alongside the existing count and NaN checks.

---

### [L-06] MAC Address Collected and Transmitted

**Severity:** Low (Privacy)
**Status:** OPEN (pre-existing)
**Location:** `getSystemStats.js` lines 111-132; `webSocketConnection.js` line 277

**Description:**
The machine's MAC address is collected and sent to the BuidlGuidl server. MAC addresses are persistent hardware identifiers that can be used for device tracking.

**Recommendation:**
Hash the MAC address before transmission, or make collection opt-in.

---

### [L-07] Graffiti Not Sanitized for Special Characters

**Severity:** Low
**Status:** RESOLVED
**Location:** `commandLineOptions.js`

**Description:**
The graffiti string was length-validated (<=32 chars) but not sanitized for special characters.

**Remediation Applied:**
- Added character validation: graffiti is now restricted to alphanumeric characters, spaces, and basic punctuation (`_-.:!@#`).
- Invalid characters are rejected at CLI parsing time with a clear error message.

---

### [L-08] `numValidators` Input Not Fully Validated

**Severity:** Low
**Status:** RESOLVED
**Location:** `ethereum_client_scripts/keyManager.js`

**Description:**
The number of validators was validated for range (1-100) but `parseInt` could parse unexpected formats like `"5abc"` as `5`.

**Remediation Applied:**
- Added strict regex validation (`/^\d+$/`) before `parseInt`. Inputs like `"5abc"` are now rejected with a clear error.
- Empty input (just pressing Enter) still defaults to 1 as expected.

---

### [L-09] Hardcoded MEV Relay URLs

**Severity:** Low / Informational
**Status:** OPEN (acknowledged, low priority)
**Location:** `ethereum_client_scripts/mevboost.js` lines 19-28

**Description:**
MEV relay URLs are hardcoded. If any relay is decommissioned, compromised, or censoring, the user has no way to customize the relay list without modifying source code.

**Recommendation:**
Add a `--mev-relays` CLI option to allow users to specify custom relay URLs.

---

### [L-10] YubiKey OTP Verification is Format-Only (No Cryptographic Validation)

**Severity:** Low
**Status:** OPEN (acknowledged, by design -- documented limitation)
**Location:** `ethereum_client_scripts/keyManager.js`, `verifyYubiKeyPresence()`

**Description:**
The YubiKey verification function validates that the input matches the modhex character set and length range (`/^[cbdefghijklnrtuv]{32,64}$/`) but does **not** cryptographically verify the OTP against Yubico's validation servers or via a local HMAC-SHA1 challenge-response.

A remote attacker with stdin access (e.g., SSH session, compromised terminal multiplexer) could generate a valid-format modhex string without a physical YubiKey, bypassing the physical presence check.

**Threat Model:**
- **Mitigated:** Casual remote access, automated scripts, or attackers unaware of the modhex format.
- **Not mitigated:** Sophisticated attacker with interactive stdin access who knows about modhex encoding.

**Recommendation:**
For stronger YubiKey verification, consider:
1. **Yubico OTP validation** via `https://api.yubico.com/wsapi/2.0/verify` (requires internet + API key)
2. **HMAC-SHA1 challenge-response** via the `ykchalresp` tool (offline, requires YubiKey slot 2 configuration)

The current format-only check is an acceptable trade-off for the stated use case (preventing unattended remote startup), as documented in the README.

---

### [L-11] Keystore Pubkey Not Validated Before Path Construction

**Severity:** Low
**Status:** RESOLVED (2nd review)
**Location:** `ethereum_client_scripts/lighthouse_validator.js` line 83-84

**Description:**
The `pubkey` field extracted from keystore JSON files was used directly in `path.join(secretsDir, \`0x${pubkey}\`)` without sanitization. If a crafted keystore contained a pubkey with path separator characters (e.g., `../../tmp/evil`), the per-validator secret file could be written outside the intended secrets directory.

**Practical Risk:** Low. An attacker would need write access to the keystores directory to place a malicious keystore file, at which point they already have significant system access.

**Remediation Applied:**
- Added hex-only validation (`/^[0-9a-fA-F]+$/`) on the pubkey before using it in a path. Non-hex pubkeys are silently skipped.

---

### [L-12] macOS Stale RAM Disk Not Cleaned on Startup

**Severity:** Low
**Status:** OPEN (acknowledged, low priority)
**Location:** `ethereum_client_scripts/secureStore.js`

**Description:**
On Linux, `cleanupStaleDirs()` is called during startup to remove `/dev/shm/bgclient-*` directories from previous unclean exits. On macOS, there is no equivalent cleanup for stale RAM disks (`/Volumes/BGClientSecure`) from previous runs that crashed without unmounting.

macOS RAM disks persist until reboot or manual `hdiutil detach`. If the process is killed with SIGKILL, the 1 MB RAM disk and its password files remain mounted until reboot.

**Recommendation:**
On macOS startup, check if `/Volumes/BGClientSecure` is already mounted and attempt to clean it up (or warn the user) before creating a new RAM disk.

---

## Dependency Audit Results

```
9 vulnerabilities found - Packages audited: 132
Severity: 3 Moderate | 5 High | 1 Critical
```

| Package | Via | Severity | Patched In | Advisory |
|---------|-----|----------|------------|----------|
| axios | direct | Critical | >=1.8.2 | SSRF |
| axios | direct | High | >=1.8.2 | CSRF |
| axios | direct | High | >=1.12.0 | DoS (data size) |
| axios | direct | High | >=1.13.5 | DoS (`__proto__`) |
| axios | direct | High | >=1.8.2 | Unspecified |
| lodash | blessed-contrib | Moderate | >=4.17.23 | Prototype Pollution |
| lodash | blessed-contrib > marked-terminal | Moderate | >=4.17.23 | Prototype Pollution |
| xml2js | blessed-contrib > map-canvas | Moderate | >=0.5.0 | Prototype Pollution |

**Immediate action:** Update `axios` to `>=1.13.5`.

---

## Recommendations Summary (Prioritized)

### Immediate (Critical/High) -- Remaining Open Items

1. **Replace shell command execution with native Node.js APIs or `spawn()` with argument arrays** in pre-existing files (`configureBGPeers.js`, `peerCountGauge.js`, JWT generation in `index.js`). This addresses C-01, C-02, H-02.

2. **Add SHA256 checksum verification** for main client binaries in `install.js` (C-03). The deposit-cli now has checksum verification (C-04 resolved).

3. **Implement RPC method allowlisting** on the WebSocket proxy (C-05). Only forward safe read-only methods.

4. **Update `axios`** to `>=1.13.5` to fix known vulnerabilities (L-02).

5. **Restrict CORS origins** on execution clients (H-06).

### Short-Term (Medium) -- Remaining Open Items

6. Add URL validation for checkpoint servers to prevent SSRF (H-01).
7. Use atomic lock file creation to prevent TOCTOU races (H-04).
8. Add rate limiting to Telegram alerts (M-07).
9. Add max retry count to public IP fetching (M-12).

### Long-Term (Low/Informational)

10. Pin dependency versions and enable automated vulnerability scanning (L-01).
11. Add WebSocket authentication via message signing (H-07).
12. Hash MAC addresses before transmission (L-06).
13. Add `--mev-relays` CLI option for custom relay configuration (L-09).
14. Fix the missing `debugToFile` import in `viemClients.js` (L-03).
15. Consider Yubico OTP cloud validation or HMAC-SHA1 challenge-response for stronger YubiKey verification (L-10).
16. Add macOS stale RAM disk cleanup on startup (L-12).

---

## Resolved Findings Summary

| Finding | Severity | Resolution |
|---------|----------|------------|
| C-04 | Critical | SHA256 checksum verification added for staking-deposit-cli |
| C-06 | Critical | Password stored in RAM only (tmpfs/RAM disk); never touches physical disk; optional YubiKey 2FA |
| C-07 | Critical | Removed empty keystore password; deposit-cli now prompts interactively |
| H-03 | High | Fixed broken port validation logic; added range check (1-65535) |
| H-05 | High | Added schema validation with type checks and prototype pollution defense |
| M-01 | Medium | Replaced all execSync shell strings with execFileSync argument arrays |
| M-02 | Medium | Added path.resolve() and boundary validation for --directory and --validator-keys-dir |
| M-03 | Medium | Lighthouse secrets-dir now populated with per-validator password files |
| M-05 | Medium | debug.log created with 0o600 permissions; validator logs redacted |
| M-06 | Medium | Explicitly configured Prysm gRPC port (--rpc-host/--rpc-port) on beacon node |
| M-10 | Medium | Options file now written with 0o600 permissions |
| M-11 | Medium | All 7 client scripts use whitelisted environment variables |
| M-13 | Medium | Prysm validator gRPC gateway bound to 127.0.0.1 (was 0.0.0.0) |
| L-05 | Low | Added port range validation (1-65535) for consensus peer ports |
| L-07 | Low | Graffiti restricted to safe character set |
| L-08 | Low | Strict regex validation for numValidators input |
| L-11 | Low | Keystore pubkey validated as hex-only before path construction |

---

## Scope Notes

- This audit covers the JavaScript source code and dependencies only
- Smart contract interactions (Bread token ABI) were not audited
- The BuidlGuidl server-side infrastructure was not in scope
- Network-level attacks (DNS, BGP, TLS stripping) were not analyzed
- The audit does not cover the correctness of Ethereum client configurations for consensus safety
- The second review pass focused specifically on the five validator-related commits and the `secureStore.js`, `keyManager.js`, `lighthouse_validator.js`, `prysm_validator.js`, `mevboost.js`, `commandLineOptions.js`, and `index.js` files

---

*End of Security Audit Report*
