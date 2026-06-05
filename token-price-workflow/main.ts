
import {
  HTTPCapability,
  EVMClient,
  handler,
  Runner,
  type Runtime,
  type HTTPPayload,
  getNetwork,
  LAST_FINALIZED_BLOCK_NUMBER,
  encodeCallMsg,
  bytesToHex,
  hexToBase64,
  protoBigIntToBigint,
  bigintToProtoBigInt,
} from "@chainlink/cre-sdk"
import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
  zeroAddress,
} from "viem"


type Config = {
  chainName: string
  snapshotRecorderAddress: string
  gasLimit: string
  feeds: Record<string, string>
}

const aggregatorABI = parseAbi([
  "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
])

type WorkflowResult = {
  token: string
  price: string       
  blockNumber: string
  timestamp: string
  txHash: string
}

const initWorkflow = (config: Config) => {
  const http = new HTTPCapability()
  return [handler(http.trigger({}), onHttpTrigger)]
}

const onHttpTrigger = (
  runtime: Runtime<Config>,
  triggerOutput: HTTPPayload, 
): WorkflowResult => {

  const bodyText = new TextDecoder().decode(triggerOutput.input)
  const payload = JSON.parse(bodyText) as { token?: string }

  const token = payload.token?.toUpperCase()
  if (!token) {
    throw new Error("Missing 'token' field in HTTP body")
  }

  runtime.log(`[snapshot] Received request for token: ${token}`)

  const feedAddress = runtime.config.feeds[token]
  if (!feedAddress) {
    const supported = Object.keys(runtime.config.feeds).join(", ")
    throw new Error(`Unsupported token "${token}". Supported: ${supported}`)
  }

  runtime.log(`[snapshot] Using feed: ${feedAddress}`)

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: runtime.config.chainName,
    isTestnet: true,
  })
  if (!network) {
    throw new Error(`Unknown chain: ${runtime.config.chainName}`)
  }

  const chainSelector = network.chainSelector.selector
  const evmClient = new EVMClient(chainSelector)

  const latestRoundDataCalldata = encodeFunctionData({
    abi: aggregatorABI,
    functionName: "latestRoundData",
  })

  runtime.log("[snapshot] Calling latestRoundData() on the Data Feed…")

  const readResult = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: feedAddress as `0x${string}`,
        data: latestRoundDataCalldata,
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result()

  const decoded = decodeFunctionResult({
    abi: aggregatorABI,
    functionName: "latestRoundData",
    data: bytesToHex(readResult.data),
  }) as readonly [bigint, bigint, bigint, bigint, bigint]

  const [, answer, , updatedAt] = decoded

  const price = answer < 0n ? 0n : answer

  runtime.log(`[snapshot] Price (raw 8-dec int): ${price}`)
  runtime.log(`[snapshot] updatedAt timestamp:   ${updatedAt}`)

  const latestHeader = evmClient.headerByNumber(runtime, {}).result()

  const latestBlockNum = latestHeader.header?.blockNumber
    ? protoBigIntToBigint(latestHeader.header.blockNumber)
    : 0n

  runtime.log(`[snapshot] Latest block: ${latestBlockNum}`)

  const updatedAtBlock = findBlockByTimestamp(
    runtime,
    evmClient,
    latestBlockNum,
    updatedAt,
  )

  runtime.log(`[snapshot] Feed last-updated block: ${updatedAtBlock}`)

  const reportPayload = encodeAbiParameters(
    parseAbiParameters("string token, uint256 price, uint256 blockNumber, uint256 timestamp"),
    [token, price, updatedAtBlock, updatedAt],
  )

  runtime.log("[snapshot] Generating signed consensus report…")

  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportPayload),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result()

  runtime.log("[snapshot] Submitting report to SnapshotRecorder…")

  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: runtime.config.snapshotRecorderAddress,
      report: reportResponse,
      gasConfig: {
        gasLimit: runtime.config.gasLimit,
      },
    })
    .result()

  const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32))

  runtime.log(`[snapshot] Tx hash: ${txHash}`)
  runtime.log(`[snapshot] https://sepolia.etherscan.io/tx/${txHash}`)

  return {
    token,
    price: price.toString(),
    blockNumber: updatedAtBlock.toString(),
    timestamp: updatedAt.toString(),
    txHash,
  }
}

function findBlockByTimestamp(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  latestBlock: bigint,
  targetTimestamp: bigint,
): bigint {
  if (latestBlock === 0n) return 0n

  let lo = latestBlock > 300n ? latestBlock - 300n : 0n
  let hi = latestBlock

  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n

    const header = evmClient
      .headerByNumber(runtime, { blockNumber: bigintToProtoBigInt(mid) })
      .result()

    const ts: bigint = header.header?.timestamp ?? 0n

    if (ts <= targetTimestamp) {
      lo = mid
    } else {
      hi = mid - 1n
    }
  }

  return lo
}


export async function main() {
  const runner = await Runner.newRunner<Config>()
  await runner.run(initWorkflow)
}
