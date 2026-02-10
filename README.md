# 📡 BuidlGuidl Client
This project will download client executables, start an execution + consensus client pair, and provide a terminal dashboard view of client and machine info. It also supports running a validator client for solo staking with optional MEV-boost.

&nbsp;
&nbsp;
## Hardware Requirements
See this [Rocket Pool Hardware Guide](https://docs.rocketpool.net/guides/node/local/hardware) for a nice rundown of node hardware requirements.

- Node operation doesn't require too much CPU power. We've ran the BG Client using both i3 and i5 versions of the [ASUS NUC 13 PRO](https://www.asus.com/us/displays-desktops/nucs/nuc-mini-pcs/asus-nuc-13-pro/). Note that there are some gotchas if you plan to use a Celeron processor. ([Rocket Pool Hardware Guide](https://docs.rocketpool.net/guides/node/local/hardware)).
- 32 GB of RAM works well with plenty of overhead.
- Selecting a suitable NVMe SSD is the trickiest part. You will need at least a 2 TB drive that includes a DRAM cache and DOES NOT use a Quad-level cell (QLC) architecture. The [Rocket Pool Hardware Guide](https://docs.rocketpool.net/guides/node/local/hardware) goes into more detail. This [SSD List GitHub Gist](https://gist.github.com/yorickdowne/f3a3e79a573bf35767cd002cc977b038) has a nice list of SSDs that have been tested and confirmed to work for running nodes.

&nbsp;
&nbsp;
## Dependencies
For Linux & MacOS:
- node (https://nodejs.org/en)
- yarn (https://yarnpkg.com/migration/overview)
- GNU Make (https://www.gnu.org/software/make/)

Additional MacOS Specifics:
- gnupg (https://gnupg.org/)
- Perl-Digest-SHA (https://metacpan.org/pod/Digest::SHA)

Hint: See the one line command below if you don't want to install the dependencies manually.

&nbsp;
&nbsp;
## Quickstart
To get a full node started using a Reth + Lighthouse client pair:
  ```bash
  git clone git@github.com:kmjones1979/buidlguidl-client.git
  cd buidlguidl-client
  yarn install
  node index.js
  ```

------------ OR ------------

Run this fancy one line command to check for/install dependencies and clone/run this repo (see https://client.buidlguidl.com/):
  ```bash
  /bin/bash -c "$(curl -fsSL https://bgclient.io)"
  ```

&nbsp;
&nbsp;

By default, client executables, databases, and logs will be established within buidlguidl-client/ethereum_clients. After initialization steps, the script displays a terminal view with scrolling client logs and some plots showing some machine and chain stats. Full client logs are located in buidlguidl-client/ethereum_clients/reth/logs and buidlguidl-client/ethereum_clients/lighthouse/logs. Exiting the terminal view (control-c or q) will also gracefully close your clients (can take 15 seconds or so).

&nbsp;
&nbsp;

## Startup Options

Use the --archive flag to perform an archive sync for the execution client:
  ```bash
  node index.js --archive
  ```

Omitting the --archive flag will make the execution clients perform a pruned sync that will give you full access to data from the last 10,064 blocks for Reth or the last 128 blocks for Geth.

&nbsp;
&nbsp;

You can opt in to the BuidlGuidl distributed RPC system and earn [BuidlGuidl Bread](https://bread.buidlguidl.com/) for serving RPC requests to the BuidlGuidl network by passing your eth address to the --owner (-o) option:
  ```bash
  node index.js --owner <your ENS name or eth address>
  ```

&nbsp;
You can also opt-in to receive Telegram alerts for client crashes when --owner is set. To do so, message /start to @BG_Client_Alert_Bot on Telegram.

&nbsp;
&nbsp;

If you want to specify a non-standard location for the ethereum_clients directory, pass a --directory (-d) option to index.js:
  ```bash
  node index.js --directory path/for/directory/containing/ethereum_clients
  ```

&nbsp;
&nbsp;

If you want to use a Geth + Prysm client pair, pass those as --executionclient (-e) and --consensusclient (-c) options to index.js:
  ```bash
  node index.js --executionclient geth --consensusclient prysm
  ```

&nbsp;
&nbsp;

Pass the --update option to update the execution and consensus clients to the latest versions (that have been tested with the BG Client):
  ```bash
  node index.js --update
  ```

&nbsp;
&nbsp;

## Validator Mode (Solo Staking)

You can run a validator client alongside your full node for solo staking (32 ETH per validator). Enable validator mode with the `--validator` flag and a `--fee-recipient` address:

  ```bash
  node index.js --validator --fee-recipient 0xYourEthAddress
  ```

On first run with `--validator`, you will be prompted to either generate new validator keys or import existing ones. Generated keys use the official [staking-deposit-cli](https://github.com/ethereum/staking-deposit-cli). After key generation, you must complete your 32 ETH deposit at the [Ethereum Launchpad](https://launchpad.ethereum.org/).

To import existing validator keystores:
  ```bash
  node index.js --validator --fee-recipient 0xYourEthAddress --validator-keys-dir ~/path/to/keystores
  ```

To enable MEV-boost for additional execution layer rewards:
  ```bash
  node index.js --validator --fee-recipient 0xYourEthAddress --mev-boost
  ```

Custom block graffiti (default: "BuidlGuidl"):
  ```bash
  node index.js --validator --fee-recipient 0xYourEthAddress --graffiti "MyValidator"
  ```

To require YubiKey touch as a second factor before the validator starts:
  ```bash
  node index.js --validator --fee-recipient 0xYourEthAddress --yubikey
  ```

**Security model:**

Your validator private keys (BLS keys) are stored on disk inside **keystore JSON files** encrypted with your **keystore password** (standard [EIP-2335](https://eips.ethereum.org/EIPS/eip-2335) format using scrypt). The password is the sole cryptographic protection for the keys at rest -- without it, the keys cannot be decrypted. A minimum password length of 8 characters is enforced.

On every startup, two things happen in sequence before the validator client launches:

1. **Password prompt** -- you enter your keystore password. It is held **only in RAM** (tmpfs on Linux, RAM disk on macOS) for the duration of the session and never written to physical disk. The validator client reads this password from the RAM-backed file to decrypt your keystores. It is destroyed when the process exits.
2. **YubiKey touch** (optional, `--yubikey` flag) -- you must physically tap your YubiKey. This proves you are physically present at the machine and prevents a remote attacker (e.g., someone with SSH access) from starting the validator, even if they know the password. The YubiKey OTP is a one-time code validated locally; it is **not** used for encryption.

> **Note:** The YubiKey is a startup authorization gate, not an encryption mechanism. The password alone encrypts the keys on disk. You cannot use a blank password with only a YubiKey -- the keystore encryption requires a password. If you want the strongest protection, use both a strong password (encrypts keys at rest) and a YubiKey (prevents unauthorized startup).

**Important safety notes:**
- **Slashing risk:** Never run the same validator keys on multiple machines simultaneously. This will result in slashing and loss of ETH.
- **Doppelganger protection** is enabled by default to detect duplicate validators before attesting.
- **Back up your mnemonic** securely and offline. Anyone with the mnemonic can control your validator.
- Keystore files are stored with restrictive file permissions (0600).
- Downloaded staking-deposit-cli binaries are verified against official SHA256 checksums before use.
- Telegram crash alerts are sent with critical priority for validator client failures.

&nbsp;
&nbsp;

Use the --help (-h) option to see all command line options:
  ```bash
  node index.js --help

  -e, --executionclient <client>            Specify the execution client ('reth' or 'geth')
                                            Default: reth
                                            Note: geth is only supported on Ubuntu/Linux

  -c, --consensusclient <client>            Specify the consensus client ('lighthouse' or 'prysm')
                                            Default: lighthouse

       --archive                            Perform an archive sync for the execution client

  -ep, --executionpeerport <port>           Specify the execution peer port (must be a number between 1 and 65535)
                                            Default: 30303

  -cp, --consensuspeerports <port>,<port>   Specify the consensus peer ports (must be two comma-separated numbers between 1 and 65535)
                                            lighthouse defaults: 9000,9001. prysm defaults: 12000,13000

  -cc, --consensuscheckpoint <url>          Specify a custom consensus checkpoint server URL
                                            If not provided, the fastest and most current checkpoint server will be automatically
                                            selected from 8 public servers (see: https://eth-clients.github.io/checkpoint-sync-endpoints)

  -d, --directory <path>                    Specify ethereum client executable, database, and logs directory
                                            Default: buidlguidl-client/ethereum_clients

  -o, --owner <eth address>                 Specify a owner eth address to opt in to the points system, distributed RPC network, and Telegram alerts
                                            To set up Telegram alerts for clients crashes, message /start to @BG_Client_Alert_Bot on Telegram

  -v, --validator                           Enable validator mode (runs a validator client alongside the beacon node)

  -fr, --fee-recipient <address>            Specify the fee recipient ETH address for execution layer rewards
                                            Required when --validator is enabled

       --graffiti <string>                  Specify custom graffiti for proposed blocks (max 32 chars, alphanumeric + _-.:!@#)
                                            Default: "BuidlGuidl"

       --validator-keys-dir <path>          Specify a directory containing existing validator keystore files to import

       --mev-boost                          Enable MEV-boost for additional execution layer rewards (optional)

       --yubikey                            Require YubiKey touch (OTP) as 2FA before validator starts (optional)

      --update                              Update the execution and consensus clients to the latest version.

  -h, --help                                Display this help message and exit
  ```

&nbsp;
&nbsp;
## Common Questions and Issues
The consensus clients (Lighthouse and Prysm) require a checkpoint sync server URL to initiate sync. Connection to checkpoint servers can fail depending on your location. If the consensus client fails to start the sync and you see an error message in the Lighthouse/Prysm logs like this:

```bash
Nov 21 17:45:41.833 INFO Starting checkpoint sync                remote_url: https://mainnet-checkpoint-sync.stakely.io/, service: beacon
Nov 21 17:45:51.842 CRIT Failed to start beacon node             reason: Error loading checkpoint state from remote: HttpClient(, kind: timeout, detail: operation timed out)
Nov 21 17:45:51.843 INFO Internal shutdown received              reason: Failed to start beacon node
Nov 21 17:45:51.843 INFO Shutting down..                         reason: Failure("Failed to start beacon node")
Failed to start beacon node
```

You will need to specify a different checkpoint server URL using the --consensuscheckpoint (-cc) option. See https://eth-clients.github.io/checkpoint-sync-endpoints/ for a list of public checkpoint sync servers.

&nbsp;
&nbsp;

The consensus client logs can output many warnings while syncing (see below for some Lighthouse examples). These warnings can be ignored and will resolve after the execution client has synced. They look scary but it's expected behavior.

```bash
Nov 21 20:58:53.309 INFO Block production disabled               reason: no eth1 backend configured
Nov 21 21:01:16.144 WARN Blocks and blobs request for range received invalid data, error: MissingBlobs, sender_id: BackfillSync { batch_id: Epoch(326557) }, peer_id: 16Uiu2HAkv5priPv8S7bawF8u96aAMgAbtkh95x4PkDvm7WSdH3ER, service: sync
Nov 21 21:01:17.001 WARN Head is optimistic                      execution_block_hash: 0x16410f3d5cb5044dcf596b301a34ec88ffce09dd4346f04aea95d442b1456e62, info: chain not fully verified, block and attestation production disabled until execution engine syncs, service: slot_notifier
Nov 21 21:01:44.997 WARN Execution engine call failed            error: InvalidClientVersion("Input must be exactly 8 characters long (excluding any '0x' prefix)"), service: exec
Nov 21 21:01:59.013 WARN Error signalling fork choice waiter     slot: 10449907, error: ForkChoiceSignalOutOfOrder { current: Slot(10449908), latest: Slot(10449907) }, service: beacon
``` 