# CRE Price Snapshot Workflow

A Chainlink Runtime Environment (CRE) workflow that reads the current USD price of a token from a Chainlink Data Feed on Ethereum Sepolia and records it on-chain via a consumer contract.

---

## Architecture

```
HTTP POST { "token": "ETH" }
         │
         ▼
  ┌─────────────────────────────────────────┐
  │   CRE Workflow  (snapshot-workflow)     │
  │                                         │
  │  1. Parse token from HTTP body          │
  │  2. EVM Read  ──► AggregatorV3          │
  │     • latestRoundData()                 │
  │     • binary-search block for updatedAt │
  │  3. Encode Record struct                │
  │  4. runtime.report()  (consensus sign)  │
  │  5. EVM Write ──► KeystoneForwarder     │
  └─────────────────────────────────────────┘
                      │
                      ▼
          KeystoneForwarder.sol (Chainlink)
                      │
                      ▼
          SnapshotRecorder.onReport()
          stores: token, price, blockNumber, timestamp
```

---

## Prerequisites

| Tool | Version | Link |
|------|---------|------|
| Node.js | ≥ 20 | https://nodejs.org |
| CRE CLI | latest | https://docs.chain.link/cre/getting-started/cli-installation |
| Foundry | latest | https://getfoundry.sh |
| Sepolia ETH | — | https://faucets.chain.link/sepolia |

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/aniketsahu115/chainlink-cre-assignment
cd chainlink-cre-assignment/my-workflow
npm install
cd .. 
```

### 2. Set up environment

```bash
cp .env.example .env
# Edit .env and fill in SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY

cp secrets.yaml.example secrets.yaml
# Edit secrets.yaml and fill in your privateKey (no 0x prefix)
```

> **Security:** `.env` and `secrets.yaml` are in `.gitignore`. Never commit them.

### 3. Log in to CRE

```bash
cre login
```

---

## Deploy the Smart Contract

### Install Foundry dependencies

```bash
forge install OpenZeppelin/openzeppelin-contracts 
```

### Deploy to Sepolia

```bash
source .env

forge script scripts/DeploySnapshotRecorder.s.sol \
  --rpc-url $SEPOLIA_RPC_URL \
  --broadcast \
  --private-key $DEPLOYER_PRIVATE_KEY \
  -vvvv
```

The script prints the deployed address. Copy it and:

1. Set `SNAPSHOT_RECORDER_ADDRESS` in `.env`
2. Replace `"REPLACE_WITH_DEPLOYED_CONTRACT_ADDRESS"` in  
   `my-workflows/config.staging.json`

### (Optional) Verify on Etherscan

```bash
source .env
forge verify-contract $SNAPSHOT_RECORDER_ADDRESS \
  contracts/SnapshotRecorder.sol:SnapshotRecorder \
  --chain-id 11155111 \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address)" 0x2ED413D5e63563F6bA5f9B4DEF2EA0Aae6f25e05)
```

---

## Configure CRE

### Register a target (first time only)

```bash
cre login
# Follow the prompts to create or link your organisation
```

The `project.yaml` and `workflow.yaml` files are already configured for `staging-settings` on `ethereum-testnet-sepolia`.

---

## Simulate the Workflow

### Dry-run (no real transaction broadcast)

```bash
cre workflow simulate my-workflow \
  --target staging-settings \
  --http-payload my-workflow/payload.json
```

### With real on-chain write (`--broadcast`)

```bash
cre workflow simulate my-workflow \
  --target staging-settings \
  --http-payload my-workflow/payload.json \
  --broadcast
```

The exact command required by the assignment:

```bash
cre workflow simulate snapshot-workflow --broadcast
```

> If your `project.yaml` has only one target the `--target` flag can be omitted.

---

## Example HTTP Payload

```json
{ "token": "ETH" }
```

Other supported tokens:

```json
{ "token": "BTC" }
{ "token": "LINK" }
```

---

## Supported Data Feeds (Sepolia)

| Token | Feed Address |
|-------|-------------|
| ETH/USD | `0x694AA1769357215DE4FAC081bf1f309aDC325306` |
| BTC/USD | `0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43` |
| LINK/USD | `0xc59E3633BAAC79493d908e63626716e204A45EdF` |

Source: https://docs.chain.link/data-feeds/price-feeds/addresses?network=ethereum&page=1&search=sepolia

---

## Contract Details

**SnapshotRecorder.sol** at `contracts/SnapshotRecorder.sol`

```solidity
struct Record {
    string  token;       // e.g. "ETH"
    uint256 price;       // 8-decimal integer (300000000000 = $3000.00)
    uint256 blockNumber; // block where the feed answer was last updated
    uint256 timestamp;   // updatedAt from latestRoundData()
}
```

- `snapshot()` – returns the latest `Record`
- `snapshots(uint256 id)` – returns a historic record by ID
- `snapshotCount()` – total number of snapshots stored
- `onReport(bytes, bytes)` – called by KeystoneForwarder; restricted to forwarder only

---

## Project Structure


---

## How the Workflow Works (Explained)

### 1. How the workflow reads a Chainlink Data Feed

The workflow uses the **EVM Read capability** (`EVMClient.callContract`) to call `latestRoundData()` on the AggregatorV3Interface at the feed address. This is a consensus-verified read: every node in the Workflow DON executes the call independently, and results are compared via BFT consensus before being returned—eliminating any single point of failure.

### 2. How `latestRoundData()` is decoded

`latestRoundData()` returns `(uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)`. The workflow uses viem's `decodeFunctionResult()` to decode the raw return bytes into these named fields. The `answer` field is the raw price with 8 decimal places (e.g. `300000000000` = $3,000.00).

### 3. How the feed update block number is obtained

Chainlink feeds store a timestamp (`updatedAt`) but not the block number. The workflow fetches the latest block header, then binary-searches backwards using `EVMClient.headerByNumber` to find the block whose timestamp matches `updatedAt`. This is reliable and costs at most ~10 EVM Read calls (well within the 15-call quota).

### 4. Why the forwarder check is required

CRE writes data via the `KeystoneForwarder`, a Chainlink contract that validates the DON's aggregate BFT signature before forwarding the call to your consumer. The `onReport` modifier `if (msg.sender != forwarder) revert OnlyForwarder(...)` ensures that **only** the authorised forwarder can write to your contract. Without it, anyone could call `onReport()` directly and inject fake price data.

### 5. Triggers vs Capabilities

| Component | Type | Role |
|-----------|------|------|
| `HTTPCapability.trigger({})` | **Trigger** | Fires the workflow when a POST request is received |
| `EVMClient.callContract()` | **Capability** (EVM Read) | Reads `latestRoundData()` from the Data Feed |
| `EVMClient.headerByNumber()` | **Capability** (EVM Read) | Fetches block headers for block-number lookup |
| `runtime.report()` | **Capability** (Consensus) | Aggregates DON observations into a signed report |
| `EVMClient.writeReport()` | **Capability** (EVM Write) | Submits the signed report to the KeystoneForwarder |

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `SEPOLIA_RPC_URL` | Yes | Sepolia JSON-RPC endpoint (used in `project.yaml`) |
| `DEPLOYER_PRIVATE_KEY` | Yes (deploy) | Wallet private key for Foundry deployment |
| `SNAPSHOT_RECORDER_ADDRESS` | After deploy | Deployed contract address (update config.staging.json too) |
| `ETHERSCAN_API_KEY` | No | For Etherscan contract verification |

`secrets.yaml` → `privateKey` — wallet used by the CRE simulator for write transactions.
