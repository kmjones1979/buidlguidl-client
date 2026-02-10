# Security Audit Report: BuidlGuidl Client

**Audit Date:** February 9, 2026
**Repository:** `git@github.com:kmjones1979/buidlguidl-client.git`
**Commit:** `c74e2c1`
**Scope:** Full codebase audit -- all JavaScript source files, dependencies, and configuration

---

## Executive Summary

The BuidlGuidl Client is a Node.js tool that automates Ethereum node management, including execution clients (Reth/Geth), consensus clients (Lighthouse/Prysm), optional validator clients for solo staking, and optional MEV-boost. It connects to the BuidlGuidl distributed RPC network and provides a terminal monitoring dashboard.

This audit identified **7 Critical**, **8 High**, **12 Medium**, and **9 Low/Informational** findings across the codebase. The most severe issues involve **command injection via shell execution**, **missing binary integrity verification**, **unauthenticated RPC proxying**, and **plaintext secret storage**. Many of these are pre-existing in the original codebase and are not introduced by the new validator support code.

### Severity Summary

| Severity | Count |
|----------|-------|
| Critical | 7 |
| High | 8 |
| Medium | 12 |
| Low / Informational | 9 |
| **Total** | **36** |

---

## Findings

---

### [C-01] Command Injection via Shell Execution in `configureBGPeers.js`

**Severity:** Critical
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
**Location:** `ethereum_client_scripts/keyManager.js` lines 64-84

**Description:**
The `staking-deposit-cli` binary, which generates validator mnemonic phrases and private keys, is downloaded without checksum verification. A compromised binary could generate keys known to the attacker.

**Attack Scenario:**
1. Attacker compromises the download (supply chain, MITM)
2. Trojaned deposit-cli generates a mnemonic with a backdoor seed
3. User deposits 32 ETH per validator
4. Attacker drains validators using the known mnemonic

**Impact:** Total loss of staked ETH. The user would have no indication that their keys are compromised until funds are stolen.

**Recommendation:**
Verify the SHA256 checksum of the downloaded `staking-deposit-cli` against the official published checksums.

---

### [C-05] Unauthenticated RPC Proxy in WebSocket Connection

**Severity:** Critical
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
**Location:** `ethereum_client_scripts/keyManager.js` line 184

**Description:**
The validator keystore password is stored in plaintext at `ethereum_clients/validator/password.txt`. While the file has `0o600` permissions, anyone with read access to the filesystem (root, backup processes, disk forensics) can recover the password and decrypt the validator private keys.

**Attack Scenario:**
1. Attacker gains limited filesystem access (backup exposure, shared hosting, physical access to disk)
2. Reads `password.txt` and keystore files
3. Decrypts validator BLS private keys
4. Uses keys to slash the validator or steal withdrawal funds

**Impact:** Loss of validator private keys and potentially all staked ETH.

**Recommendation:**
1. Use OS-level secret storage (macOS Keychain, Linux Secret Service/libsecret)
2. At minimum, encrypt the password file with a key derived from machine-specific entropy
3. Consider prompting for the password on each start rather than persisting it

---

### [C-07] Empty Keystore Password Passed to `staking-deposit-cli`

**Severity:** Critical
**Location:** `ethereum_client_scripts/keyManager.js` line 254

**Description:**
The key generation command passes `--keystore_password ""` to the deposit-cli, which may result in unencrypted or weakly-encrypted keystores depending on the CLI version's handling of empty strings.

```javascript
`"${depositCliBin}" new-mnemonic ` +
  `--chain mainnet ` +
  `--num_validators ${numValidators} ` +
  `--execution_address ${withdrawalAddress} ` +
  `--keystore_password "" ` +
```

**Impact:** Validator private keys may be stored without encryption, making them trivially extractable by any process with filesystem access.

**Recommendation:**
Remove the `--keystore_password ""` argument and let the deposit-cli prompt the user interactively for a password, or pass the password from the already-collected `promptAndSavePassword()` result.

---

### [H-01] SSRF via User-Provided Checkpoint URLs

**Severity:** High
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
**Location:** `index.js` line 62

**Description:**
JWT secret generation uses `execSync` with string interpolation of the `jwtDir` path:

```javascript
execSync(`cd "${jwtDir}" && openssl rand -hex 32 > jwt.hex`, {
  stdio: "inherit",
});
```

If `jwtDir` contains shell metacharacters (e.g., from a crafted `--directory` option), command injection is possible.

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
**Location:** `commandLineOptions.js` lines 287-295

**Description:**
The port validation condition is logically incorrect and can never be true:

```javascript
executionPeerPort = parseInt(argv.executionpeerport, 10);
if (executionPeerPort === "number" && !isNaN(executionPeerPort)) {
```

A number can never `===` the string `"number"`, so the validation is always bypassed. Any value (including negative numbers, 0, or ports above 65535) will be accepted.

**Impact:** Invalid port numbers could cause client crashes or bind to unintended ports.

**Recommendation:**
```javascript
executionPeerPort = parseInt(argv.executionpeerport, 10);
if (isNaN(executionPeerPort) || executionPeerPort < 1 || executionPeerPort > 65535) {
  console.log("Invalid option for --executionpeerport (-ep). Must be a number between 1 and 65535.");
  process.exit(1);
}
```

---

### [H-04] Lock File TOCTOU Race Condition

**Severity:** High
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
**Location:** `commandLineOptions.js` line 156

**Description:**
The options file is parsed with `JSON.parse()` without schema validation:

```javascript
const options = JSON.parse(fs.readFileSync(optionsFilePath, "utf8"));
```

A manually crafted or corrupted `options.json` could contain unexpected types, `__proto__` pollution payloads, or values that bypass validation (since loaded options skip CLI validation).

**Impact:** Prototype pollution, bypassed validation, or unexpected behavior.

**Recommendation:**
Validate the parsed JSON against a schema before using values. At minimum, validate types and ranges for each field.

---

### [H-06] Wildcard CORS and WebSocket Origins on Execution Clients

**Severity:** High
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
**Location:** `webSocketConnection.js` line 149

**Description:**
The WebSocket connection to the BuidlGuidl pool server has no authentication mechanism. Any client can connect and potentially impersonate a node operator by providing their Ethereum address.

**Impact:** Node impersonation, false check-ins, potential RPC reward theft.

**Recommendation:**
Implement signature-based authentication using the owner's Ethereum address to prove identity.

---

### [H-08] Sensitive System Data Transmitted to Remote Server

**Severity:** High
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
**Location:** `ethereum_client_scripts/keyManager.js` lines 64, 69, 74, 79, 469-480

**Description:**
Multiple `execSync()` calls construct shell commands by interpolating variables into strings. While the inputs are currently derived from controlled sources (platform detection, version constants), the pattern is fragile and any future modification could introduce injection.

**Recommendation:**
Use `execFileSync()` or `spawn()` with argument arrays instead of shell strings.

---

### [M-02] Path Traversal in `--validator-keys-dir` and `--directory`

**Severity:** Medium
**Location:** `commandLineOptions.js` lines 315-323, 354-361

**Description:**
The `isValidPath()` function only verifies the path exists and is a directory. It does not prevent path traversal (e.g., `--directory ../../../etc`). The `--validator-keys-dir` option has the same issue.

**Recommendation:**
Resolve paths to absolute form and validate they are within expected boundaries.

---

### [M-03] Incorrect `--secrets-dir` Configuration in Lighthouse Validator

**Severity:** Medium
**Location:** `ethereum_client_scripts/lighthouse_validator.js` line 85

**Description:**
The `--secrets-dir` flag points to the validator parent directory, but Lighthouse expects this directory to contain files named after the validator public key, each containing the keystore password. The current setup with a single `password.txt` may not match Lighthouse's expected structure.

**Impact:** Validator client may fail to start or fail to decrypt keystores.

**Recommendation:**
Create per-validator password files in the secrets directory matching the expected naming convention, or use the `--password-file` flag instead.

---

### [M-04] Signal Handler Re-entrancy Risk

**Severity:** Medium
**Location:** `index.js` lines 80-272

**Description:**
The `handleExit()` function uses a boolean `isExiting` flag to prevent re-entrancy, but this is not atomic. If two signals arrive in rapid succession before the flag is set, both could enter the handler.

**Recommendation:**
Use a more robust synchronization mechanism or accept the current risk with documentation.

---

### [M-05] Sensitive Data in Debug Logs

**Severity:** Medium
**Location:** Multiple files (all `debugToFile()` calls)

**Description:**
Debug logs include sensitive information:
- Full command-line arguments (including fee recipient addresses)
- File paths to keystores and password files
- Checkpoint URLs and peer addresses
- JWT paths

The debug log at `debug.log` is created with default permissions (world-readable on most systems).

**Recommendation:**
1. Set restrictive permissions on `debug.log` (0600)
2. Redact sensitive values in log output
3. Add a log level system to control verbosity

---

### [M-06] Prysm Beacon Node Uses `grpc-gateway` Instead of Standard Beacon API Port

**Severity:** Medium
**Location:** `ethereum_client_scripts/prysm.js` line 70; `ethereum_client_scripts/prysm_validator.js` line 75

**Description:**
The Prysm beacon node exposes gRPC gateway on port 5052, but the Prysm validator client connects via `--beacon-rpc-provider=localhost:4000` (gRPC, not gRPC gateway). The default Prysm gRPC port (4000) is not explicitly configured in the beacon node script, relying on Prysm's default.

**Impact:** If Prysm changes its default gRPC port, the validator client will fail to connect.

**Recommendation:**
Explicitly configure `--rpc-port=4000` on the beacon node and document the port dependency.

---

### [M-07] No Rate Limiting on Telegram Alert Endpoint

**Severity:** Medium
**Location:** `telegramAlert.js` line 34

**Description:**
The Telegram alert endpoint has no client-side rate limiting. A rapidly crashing client could flood the alert service and potentially be used for denial of service.

**Recommendation:**
Add client-side rate limiting (e.g., max 1 alert per minute per alert type).

---

### [M-08] Trusted Peer Addition Without Verification

**Severity:** Medium
**Location:** `ethereum_client_scripts/configureBGPeers.js` line 42

**Description:**
Peers fetched from the BuidlGuidl server are added as trusted peers without cryptographic verification. If the server is compromised, malicious peers could be injected.

**Impact:** Eclipse attacks, censorship, or targeted transaction manipulation.

**Recommendation:**
Sign peer lists with a known key, or allow users to verify/approve peer additions.

---

### [M-09] Staging URL in Production Telegram Alert Code

**Severity:** Medium
**Location:** `telegramAlert.js` line 34

**Description:**
The alert endpoint uses `stage.rpc.buidlguidl.com` instead of a production URL, which may be unintentional.

**Recommendation:**
Verify this is the correct endpoint. If not, update to the production URL.

---

### [M-10] Options File Persists Sensitive Configuration in Plaintext

**Severity:** Medium
**Location:** `commandLineOptions.js` line 150

**Description:**
The `options.json` file stores all CLI options in plaintext, including the owner's Ethereum address and fee recipient address. While `.gitignore` covers this file, it remains readable on the filesystem.

**Recommendation:**
Encrypt sensitive fields or set restrictive file permissions (0600).

---

### [M-11] Environment Variable Inheritance in Child Processes

**Severity:** Medium
**Location:** `index.js` line 389

**Description:**
Child processes inherit the full `process.env`, which may contain sensitive variables (API keys, tokens, credentials) from the parent environment.

**Recommendation:**
Whitelist only required environment variables when spawning child processes.

---

### [M-12] Infinite Retry Loop When Fetching Public IP

**Severity:** Medium
**Location:** `getSystemStats.js` lines 100-108

**Description:**
The public IP fetch retries indefinitely on failure, which could cause resource exhaustion or hang the process if the network is down.

**Recommendation:**
Add a maximum retry count and fallback behavior.

---

### [L-01] Floating Dependency Versions

**Severity:** Low
**Location:** `package.json`

**Description:**
All dependencies use caret (`^`) ranges, allowing automatic minor/patch updates that could introduce breaking changes or vulnerabilities.

**Recommendation:**
Pin exact versions or use a lockfile verification step in CI.

---

### [L-02] Known Dependency Vulnerabilities

**Severity:** Low
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
**Location:** `monitor_components/viemClients.js` line 32

**Description:**
`debugToFile` is called but not imported in this file. This will cause a runtime error if the error handling path is triggered.

**Recommendation:**
Add `import { debugToFile } from "../helpers.js";` at the top of the file.

---

### [L-04] Git Information Exposed in Dashboard

**Severity:** Low
**Location:** `monitor_components/header.js` lines 138, 147

**Description:**
The dashboard header displays the git branch and commit hash, which leaks information about the deployment state.

**Recommendation:**
Consider making this optional or removing it from the dashboard.

---

### [L-05] No Consensus Peer Port Range Validation

**Severity:** Low
**Location:** `commandLineOptions.js` lines 297-309; `ethereum_client_scripts/lighthouse.js` lines 16-18; `ethereum_client_scripts/prysm.js` lines 15-17

**Description:**
Consensus peer ports are parsed as integers but not validated against the valid port range (1-65535).

**Recommendation:**
Add range validation after parsing.

---

### [L-06] MAC Address Collected and Transmitted

**Severity:** Low (Privacy)
**Location:** `getSystemStats.js` lines 111-132; `webSocketConnection.js` line 277

**Description:**
The machine's MAC address is collected and sent to the BuidlGuidl server. MAC addresses are persistent hardware identifiers that can be used for device tracking.

**Recommendation:**
Hash the MAC address before transmission, or make collection opt-in.

---

### [L-07] Graffiti Not Sanitized for Special Characters

**Severity:** Low
**Location:** `ethereum_client_scripts/lighthouse_validator.js` line 99; `ethereum_client_scripts/prysm_validator.js` line 89

**Description:**
The graffiti string is length-validated (<=32 chars) but not sanitized for special characters. While passed via `spawn()` argument arrays (not shell strings), unusual characters could cause client-specific parsing issues.

**Recommendation:**
Restrict graffiti to alphanumeric characters, spaces, and common punctuation.

---

### [L-08] `numValidators` Input Not Fully Validated

**Severity:** Low
**Location:** `ethereum_client_scripts/keyManager.js` line 233

**Description:**
The number of validators is validated for range (1-100) but `parseInt` could parse unexpected formats like `"5abc"` as `5`.

**Recommendation:**
Use a stricter numeric validation.

---

### [L-09] Hardcoded MEV Relay URLs

**Severity:** Low / Informational
**Location:** `ethereum_client_scripts/mevboost.js` lines 19-28

**Description:**
MEV relay URLs are hardcoded. If any relay is decommissioned, compromised, or censoring, the user has no way to customize the relay list without modifying source code.

**Recommendation:**
Add a `--mev-relays` CLI option to allow users to specify custom relay URLs.

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

### Immediate (Critical/High)

1. **Replace shell command execution with native Node.js APIs or `spawn()` with argument arrays** throughout the codebase. This addresses C-01, C-02, H-02, and M-01.

2. **Add SHA256 checksum verification** for all downloaded binaries (C-03, C-04). Publish checksums alongside version constants in `install.js`.

3. **Fix the empty keystore password** in the key generation flow (C-07). Either prompt interactively or pass the saved password.

4. **Implement RPC method allowlisting** on the WebSocket proxy (C-05). Only forward safe read-only methods.

5. **Encrypt password storage** or use OS keychain integration (C-06).

6. **Fix the port validation logic error** in `commandLineOptions.js` (H-03).

7. **Update `axios`** to `>=1.13.5` to fix known vulnerabilities (L-02).

8. **Restrict CORS origins** on execution clients (H-06).

### Short-Term (Medium)

9. Add URL validation for checkpoint servers to prevent SSRF (H-01).
10. Use atomic lock file creation to prevent TOCTOU races (H-04).
11. Validate `options.json` schema after loading (H-05).
12. Set restrictive permissions on `debug.log` and redact sensitive data (M-05).
13. Fix the Lighthouse `--secrets-dir` configuration (M-03).
14. Add rate limiting to Telegram alerts (M-07).
15. Add max retry count to public IP fetching (M-12).

### Long-Term (Low/Informational)

16. Pin dependency versions and enable automated vulnerability scanning.
17. Add WebSocket authentication via message signing (H-07).
18. Hash MAC addresses before transmission (L-06).
19. Add `--mev-relays` CLI option for custom relay configuration (L-09).
20. Fix the missing `debugToFile` import in `viemClients.js` (L-03).

---

## Scope Notes

- This audit covers the JavaScript source code and dependencies only
- Smart contract interactions (Bread token ABI) were not audited
- The BuidlGuidl server-side infrastructure was not in scope
- Network-level attacks (DNS, BGP, TLS stripping) were not analyzed
- The audit does not cover the correctness of Ethereum client configurations for consensus safety

---

*End of Security Audit Report*
