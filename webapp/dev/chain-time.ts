// anvil mines a block a second, so the chain is read this often, for a receipt or its time; viem would poll every 4 s
export const BLOCK_POLL_MS = 250

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The contract checks a commitment's age by block time: once the latest block reaches it, every block after does too.
export async function untilChainTime(seconds: number, chainNow: () => Promise<number>): Promise<void> {
  const early = seconds * 1000 - Date.now()
  if (early > 0) await sleep(early)
  while ((await chainNow()) < seconds) await sleep(BLOCK_POLL_MS)
}
