import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import { isAddress } from '@validate-ethereum-address/core';


// Load env vars (e.g., PRIVATE_KEY, SNIPER_CONTRACT_ADDRESS)
dotenv.config();

// === GLOBAL STATE LOCK ===
let isSnipingActive = false;        // ← This prevents multiple concurrent snipes
let currentTargetToken: string | null = null;
let isListeningToEvents = false;    // Track if event listener is active

// === STATUS LOGGING ===
function logBotStatus() {
  const status = {
    'Sniping Active': isSnipingActive ? '✅ YES' : '❌ NO',
    'Current Target': currentTargetToken || 'None',
    'Event Listener': isListeningToEvents ? '✅ ACTIVE' : '❌ INACTIVE',
  };
  
  console.log('\n📊 Bot Status:');
  console.log('─'.repeat(50));
  Object.entries(status).forEach(([key, value]) => {
    console.log(`  ${key}: ${value}`);
  });
  console.log('─'.repeat(50) + '\n');
}

const sendBNB = String(process.env.SEND_BNB);

// Token filter configuration (from .env)
// Set TOKEN_NAME_CONTAINS to filter OUT tokens by name containing string(s) (case-insensitive)
// Multiple keywords can be separated by commas - tokens containing ANY of them will be SKIPPED
// Leave empty to disable filtering (buy all tokens)
// Example: "Moon,DOGE,Pepe" will SKIP tokens containing "Moon" OR "DOGE" OR "Pepe"
const TOKEN_NAME_CONTAINS = process.env.TOKEN_NAME_CONTAINS?.trim() || '';
const TOKEN_NAME_KEYWORDS = TOKEN_NAME_CONTAINS
  ? TOKEN_NAME_CONTAINS.split(',').map(k => k.trim()).filter(k => k.length > 0)
  : [];

// Minimum liquidity filter (from .env)
// Set MIN_LIQUIDITY_BNB to minimum WBNB liquidity required (in BNB, e.g., "1.0" for 1 BNB)
// Pools with less WBNB liquidity than this will be skipped
// Leave empty or 0 to disable liquidity filtering
const MIN_LIQUIDITY_BNB = process.env.MIN_LIQUIDITY_BNB ? parseFloat(process.env.MIN_LIQUIDITY_BNB) : 0;

// BSC Mainnet addresses
const ADDRESSES = {
  WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  FACTORY: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73' as const, // PancakeSwap V2 Factory
  ROUTER: '0x10ED43C718714eb63d5aA57B78B54704E256024E' as const, // PancakeSwap V2 Router
  QUOTER_V2: '0xB048Bbc1B6aAD7B1bB7987a14F6d34bE1FBE9F6E' as const  // QuoterV2
} as const;

// Sniper Contract address (REQUIRED - deploy first and set in .env)
const SNIPER_CONTRACT_ADDRESS = process.env.SNIPER_CONTRACT_ADDRESS;
if (!SNIPER_CONTRACT_ADDRESS || isAddress(SNIPER_CONTRACT_ADDRESS, false) === false) {
  throw new Error('SNIPER_CONTRACT_ADDRESS not set in .env file! Deploy the contract first.');
}

// Primary QuickNode WebSocket URL (for critical operations - event monitoring, swaps)
const PROVIDER_URL = process.env.WS_PROVIDER_URL!;
const RPC_PROVIDER_URL = process.env.RPC_PROVIDER_URL!;

// Multiple BSC RPC endpoints for multi-broadcast (faster propagation)
const BSC_RPC_ENDPOINTS = [
  RPC_PROVIDER_URL,
  // 'https://bsc-dataseed1.binance.org',
  // 'https://bsc-dataseed2.binance.org',
  // 'https://bsc-dataseed3.binance.org',
  // 'https://bsc-dataseed4.binance.org',
  // 'https://bsc-dataseed1.defibit.io',
  // 'https://bsc-dataseed2.defibit.io',
  // 'https://bsc-dataseed1.ninicoin.io',
  // 'https://bsc-dataseed2.ninicoin.io',
  // 'https://bsc.publicnode.com',
  // 'https://bsc-rpc.publicnode.com',
  // 'https://bsc.blockpi.network/v1/rpc/public',
  // 'https://bsc-mainnet.nodereal.io/v1/64af0f4c1b77460b8a2f64c5c3b6d9e5',
];

// Private key from env (REQUIRED for swaps)
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY not set in .env file!');
}

const provider = new ethers.WebSocketProvider(PROVIDER_URL);

const wallet = new ethers.Wallet(PRIVATE_KEY!, provider);

// Minimal ABI for Factory (unchanged)
const FACTORY_ABI = [
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
  'function allPairsLength() view returns (uint)',
] as const;

const PANCAKE_ROUTER_ABI = [
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns(uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'
] as const

const PAIR_ABI = [
  'function getReserves() external view returns (uint112,uint112,uint32)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
] as const;

// ERC20 ABI (for approve & balance)
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
] as const;

// Quoter ABI (for price estimation)
const QUOTER_ABI = [
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)',
] as const;

// ABI for SniperContract buy function
const SNIPER_ABI = [
  'function buy(address token, uint256 amountIn, uint256 deadlineOffset) external',
] as const;


async function safeGetReserves(
  pairAddress: string,
  maxRetries = 10,
  initialDelay = 60   // ms — tuned for BSC
): Promise<{ reserve0: bigint; reserve1: bigint; token0: string; token1: string } | null> {
  const pairContract = new ethers.Contract(pairAddress, PAIR_ABI, provider);

  for (let i = 0; i < maxRetries; i++) {
    try {
      const [token0, token1, [r0, r1]] = await Promise.all([
        pairContract.token0(),
        pairContract.token1(),
        pairContract.getReserves()
      ]);

      if (r0 > 0n && r1 > 0n) {
        return { reserve0: r0, reserve1: r1, token0, token1 };
      }
    } catch (err) {
      // silent – just retry
    }

    // Exponential backoff: 60ms → 120ms → 240ms → ...
    await new Promise(r => setTimeout(r, initialDelay * (2 ** i)));
  }

  return null;
}

// Initialize multiple RPC providers for broadcasting
const rpcProviders: ethers.JsonRpcProvider[] = BSC_RPC_ENDPOINTS.map(
  url => new ethers.JsonRpcProvider(url)
);


// OPTIMIZED: Multi-RPC broadcast - Submit signed tx to multiple RPCs simultaneously
async function submitRawTx(rawTx: string, timeoutMs = 5000): Promise<string> {
  const start = Date.now();

  // Add 0x prefix if missing
  const txWithPrefix = rawTx.startsWith('0x') ? rawTx : '0x' + rawTx;

  // console.log(txWithPrefix);

  console.log('Broadcasting to', rpcProviders.length, 'RPC endpoints...');

  // Submit to all RPCs simultaneously
  const submissions = rpcProviders.map(async (provider, index) => {
    try {
      const response = await Promise.race([
        provider.broadcastTransaction(txWithPrefix),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), timeoutMs)
        )
      ]);

      if (!response || !response.hash) {
        throw new Error('No transaction hash returned');
      }

      console.log(`  ✅ RPC ${index + 1} accepted (${Date.now() - start}ms)`);
      return { success: true, hash: response.hash, provider: index };
    } catch (err: any) {
      console.log(err.message);
      console.log(`  ⚠️  RPC ${index + 1} failed: ${err.message.substring(0, 50)}`);
      return { success: false, error: err.message, provider: index };
    }
  });

  // Wait for first successful response
  const results = await Promise.allSettled(submissions);

  // Find first successful submission
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.success && result.value.hash) {
      const txHash = result.value.hash;
      console.log(`✅ Transaction broadcast successful: ${txHash}`);

      // Let other submissions complete in background (don't await)
      Promise.allSettled(submissions).then(() => {
        const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
        console.log(`📊 Final: ${successCount}/${rpcProviders.length} RPCs accepted tx`);
      });

      return txHash;
    }
  }

  // All failed
  throw new Error('All RPC endpoints failed to broadcast transaction');
}

// === APPROVE TOKEN ===
async function approveToken(token: string, amount: bigint): Promise<void> {
  const tokenContract = new ethers.Contract(token, ERC20_ABI, wallet);
  const allowance = await tokenContract.allowance(wallet.address, ADDRESSES.ROUTER);

  if (allowance >= amount) {
    console.log(`Already approved: ${token}`);
    return;
  }

  console.log(`Approving ${token}...`);
  const tx = await tokenContract.approve(ADDRESSES.ROUTER, ethers.MaxUint256);
  await tx.wait(1);
  console.log(`Approved: ${tx.hash}`);
}

// === GET BALANCE ===
async function getTokenBalance(token: string): Promise<bigint> {
  const contract = new ethers.Contract(token, ERC20_ABI, provider);
  return await contract.balanceOf(wallet.address);
}

// === GET TOKEN INFO ===
async function getTokenInfo(token: string): Promise<{ name: string; symbol: string } | null> {
  try {
    const contract = new ethers.Contract(token, ERC20_ABI, provider);
    const [name, symbol] = await Promise.race([
      Promise.all([contract.name(), contract.symbol()]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
    ]);
    return { name: name || '', symbol: symbol || '' };
  } catch (err: any) {
    console.log(`Failed to fetch token info for ${token}: ${err.message}`);
    return null;
  }
}

// === TOKEN FILTER ===
function shouldBuyToken(name: string): boolean {
  // If no filter is set, buy all tokens
  if (TOKEN_NAME_KEYWORDS.length === 0) {
    return true;
  }

  // Check if token name contains ANY of the keywords - if yes, SKIP it (return false)
  const nameLower = name.toLowerCase();
  const containsKeyword = TOKEN_NAME_KEYWORDS.some(keyword => 
    nameLower.includes(keyword.toLowerCase())
  );
  
  // Return false if it contains keywords (skip), true if it doesn't (buy)
  return !containsKeyword;
}

// === GET CURRENT PRICE FROM RESERVES (WBNB / Token) ===

// async function getCurrentPriceFromReserves(pairAddress: string, tokenIsToken1: boolean): Promise<bigint> {
//   try {
//     const pairContract = new ethers.Contract(pairAddress, PAIR_ABI, provider);
//     const [reserve0, reserve1] = await pairContract.getReserves();

//     // Depending on token order: (WBNB, Token) or (Token, WBNB)
//     const reserveWBNB = tokenIsToken1 ? reserve0 : reserve1;
//     const reserveToken = tokenIsToken1 ? reserve1 : reserve0;

//     if (reserveToken === 0n) return 0n;

//     // Price in BNB per 1e18 tokens (fixed point)
//     // price = reserveWBNB / reserveToken → but scaled to 1e18

//     console.log("token price ==>> ", ethers.formatUnits((BigInt(reserveWBNB) * 1_000_000n * 10n ** 18n) / BigInt(reserveToken), 18));

//     return (BigInt(reserveWBNB) * 1_000_000n * 10n ** 18n) / BigInt(reserveToken); // 6 decimals precision boost

//   } catch (e) {
//     return 0n;
//   }
// }

async function getCurrentPriceFromReservesSafe(pairAddress: string, tokenIsToken1: boolean): Promise<bigint> {
  const maxRetries = 5;
  const providersToTry = [provider, ...rpcProviders]; // try WS first, then HTTP fallbacks

  for (let i = 0; i < maxRetries; i++) {
    for (const prov of providersToTry) {
      try {
        const pairContract = new ethers.Contract(pairAddress, PAIR_ABI, prov);
        const [reserve0, reserve1,] = await Promise.race([
          pairContract.getReserves(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
        ]);

        if (reserve0 > 0n && reserve1 > 0n) {
          const reserveWBNB = tokenIsToken1 ? reserve0 : reserve1;
          const reserveToken = tokenIsToken1 ? reserve1 : reserve0;

          if (reserveToken === 0n) continue;
          console.log("token price ==>> ", ethers.formatUnits((BigInt(reserveWBNB) * 1_000_000n * 10n ** 18n) / BigInt(reserveToken), 18));
          const price = (reserveWBNB * 1_000_000n * 10n ** 18n) / reserveToken;
          return price;
        }
      } catch (err) {
        // silent — try next
      }
    }

    // Wait before retry
    await new Promise(r => setTimeout(r, 800));
  }

  return 0n; // final failure
}

async function main() {
  console.log('🚀 Starting Multi-RPC sniper...');
  console.log(`📡 Configured ${rpcProviders.length} RPC endpoints for broadcasting`);

  // Connect to BSC via WebSocket for events (read-only)
  console.log('Connected to BSC WebSocket provider (event monitoring)...');
  isListeningToEvents = true;

  // Initialize Factory for events (read-only)
  const factory = new ethers.Contract(ADDRESSES.FACTORY, FACTORY_ABI, provider);

  // Initialize SniperContract with signer for swaps
  const sniperContract = new ethers.Contract(SNIPER_CONTRACT_ADDRESS!, SNIPER_ABI, wallet);
  const routerContract = new ethers.Contract(ADDRESSES.ROUTER, PANCAKE_ROUTER_ABI, wallet);

  console.log(`Wallet address: ${wallet.address}`);
  // console.log(`Sniper Contract: ${SNIPER_CONTRACT_ADDRESS}`);

  // NEW: Manual nonce management for speed
  let currentNonce = await provider.getTransactionCount(wallet.address, 'pending');
  console.log(`Starting nonce: ${currentNonce}`);

  // OPTIMIZED: Lightning-fast swap function (BNB → New Token via SniperContract) - Multi-RPC Broadcast
  async function executeSwap(newToken: string, amountInBNB: string, deadlineMinutes = 3, competitiveGas = false) {
    const start = Date.now();

    try {
      console.log(`SWAP: ${amountInBNB} BNB → ${newToken} (via PancakeSwap Router)`);
      console.log(`Target token: https://bscscan.com/address/${newToken}`);

      const amountIn = ethers.parseEther(amountInBNB);

      // CORRECT: deadline = current Unix time + X minutes
      const deadline = BigInt(Math.floor(Date.now() / 1000)) + BigInt(deadlineMinutes * 60);

      // OPTIMIZATION: Dynamic gas pricing
      const gasLimit = 300000n;
      let gasPrice: bigint;

      if (competitiveGas) {
        const feeData = await provider.getFeeData();
        const networkGas = feeData.gasPrice || ethers.parseUnits('3', 'gwei');
        gasPrice = (networkGas * 150n) / 100n;
        console.log(`  Using COMPETITIVE gas: ${ethers.formatUnits(gasPrice, 'gwei')} Gwei`);
      } else {
        gasPrice = ethers.parseUnits('0.05', 'gwei');
      }

      // ---- READ ONCE ----
      const nonce = currentNonce;

      // CORRECT: Use proper deadline (timestamp), not offset
      const txRequest = await routerContract.swapExactETHForTokens.populateTransaction(
        0, // amountOutMin = 0 (slippage tolerance: accept any output)
        [ADDRESSES.WBNB, newToken],
        wallet.address,
        deadline, // ← NOW A VALID FUTURE TIMESTAMP
        {
          value: amountIn,
          gasLimit,
          gasPrice,
          nonce,
          chainId: 56n,
        }
      );

      const signedTx = await wallet.signTransaction(txRequest);
      const rawTx = signedTx.slice(2);

      const signTime = Date.now() - start;
      const txHash = await submitRawTx(rawTx, 5000);

      // ---- INCREMENT ONLY HERE ----
      currentNonce++;

      const submitTime = Date.now() - start;
      console.log(`Buy submitted (sign: ${signTime}ms, submit: ${submitTime}ms): ${txHash}`);
      console.log(`Buy tx: https://bscscan.com/tx/${txHash}`);

      // Background confirmation
      provider.waitForTransaction(txHash, 1, 45000)
        .then(async (receipt) => {
          if (receipt?.status === 1) {
            console.log(`Confirmed in block ${receipt.blockNumber}`);
          } else return
        })
        .catch(err => {
          console.error(`Confirmation timeout for ${txHash}: ${err.message}`);
        });

      return { txHash, success: true, submitTime };

    } catch (error: any) {
      console.error(`Buy failed (${Date.now() - start}ms): ${error.message}`);

      if (error.message.includes('nonce') || error.message.includes('already known')) {
        console.log('Resyncing nonce...');
        currentNonce = await provider.getTransactionCount(wallet.address, 'pending');
      }

      return { success: false, error: error.message, time: Date.now() - start };
    }
  }

  // ---- sell after Buy  ----

  async function scheduleSellAfterBuy(
    token: string,
    buyTxHash: string,
    pairAddress: string,
    tokenIsToken1: boolean  // true if token is token1 (i.e. token0 = WBNB)
  ) {

    // 1. Wait for buy confirmation
    const receipt = await provider.waitForTransaction(buyTxHash, 1, 90_000);
    if (!receipt || receipt.status !== 1) {
      console.log(`Buy failed/reverted: ${buyTxHash}`);
      isSnipingActive = false;
      currentTargetToken = null;
      console.log(`🔓 Sniping unlocked (buy failed/reverted)`);
      logBotStatus();
      return;
    }

    // Keep isSnipingActive = true during monitoring (don't unlock until sell completes)
    console.log(`Buy confirmed in block ${receipt.blockNumber}`);

    // 2. Get exact tokens received
    const tokenBalance = await getTokenBalance(token);
    if (tokenBalance <= 0n) {
      console.log(`No tokens received – aborting sell monitor`);
      isSnipingActive = false;
      currentTargetToken = null;
      console.log(`🔓 Sniping unlocked (no tokens received)`);
      logBotStatus();
      return;
    }

    // 3. Get initial price and liquidity (our entry point)
    const initialPrice = await getCurrentPriceFromReservesSafe(pairAddress, tokenIsToken1);
    if (initialPrice === 0n) {
      console.log(`Could not fetch initial price – skipping profit tracking`);
      isSnipingActive = false;
      currentTargetToken = null;
      console.log(`🔓 Sniping unlocked (could not fetch price)`);
      logBotStatus();
      return;
    }

    // Get initial liquidity for safety check
    let initialLiquidityBNB = 0;
    if (MIN_LIQUIDITY_BNB > 0) {
      try {
        const pairContract = new ethers.Contract(pairAddress, PAIR_ABI, provider);
        const [r0, r1] = await pairContract.getReserves();
        const wbnbReserve = tokenIsToken1 ? r0 : r1;
        const wbnbLiquidityBNB = Number(ethers.formatEther(wbnbReserve));
        initialLiquidityBNB = wbnbLiquidityBNB * 2; // Total liquidity
        console.log(`Initial liquidity: ${initialLiquidityBNB.toFixed(4)} BNB`);
      } catch (err) {
        console.log(`⚠️  Could not fetch initial liquidity - will monitor anyway`);
      }
    }

    console.log(`Monitoring profit for ${token}`);
    console.log(`Entry price: ${ethers.formatUnits(initialPrice, 18)} BNB per 1 Token (scaled)`);
    // console.log(`Bought: ${ethers.formatUnits(tokenBalance, 18)} tokens with ${ethers.formatEther(amountInBNB)} BNB`);

    const targetPrice = (initialPrice * 105n) / 100n;     // +5%
    console.log(`Take-profit target: +5% → ${ethers.formatUnits(targetPrice, 18)} BNB/Token`);

    let highestPriceSeen = initialPrice;
    let sold = false;

    // Helper function to execute sell
    async function executeSell(reason: string) {
      if (sold) return;
      clearInterval(interval);
      sold = true;
      console.log(`🚨 ${reason} - Selling immediately...`);

      await approveToken(token, tokenBalance);

      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

      try {
        currentNonce = await provider.getTransactionCount(wallet.address, 'pending');
        const nonce = currentNonce;

        const gasPrice = ethers.parseUnits('0.05', 'gwei');

        const txReq = await routerContract.swapExactTokensForETH.populateTransaction(
          tokenBalance,
          0n,   // accept any output
          [token, ADDRESSES.WBNB],
          wallet.address,
          deadline,
          {
            gasLimit: 300000n,
            gasPrice,
            nonce,
            chainId: 56n,
          }
        );

        const signed = await wallet.signTransaction(txReq);
        const sellTxHash = await submitRawTx(signed.slice(2));
        currentNonce++;
        console.log(`SELL EXECUTED SUCCESSFULLY: ${sellTxHash}`);
        console.log(`Sell tx: https://bscscan.com/tx/${sellTxHash}`);

        // === CRITICAL: Unlock sniping ONLY after successful sell ===
        console.log(`Profit taken on ${token} → Ready for next snipe!`);
        isSnipingActive = false;
        currentTargetToken = null;
        console.log(`🔓 Sniping unlocked - ready for next opportunity`);
        logBotStatus();

      } catch (err: any) {
        console.error(`SELL FAILED: ${err.message}`);
        // Unlock on sell failure so we can try other tokens
        isSnipingActive = false;
        currentTargetToken = null;
        console.log(`🔓 Sniping unlocked (sell failed)`);
        logBotStatus();
        sold = true;
      }
    }

    // === POLL RESERVES EVERY 1 SECOND (super fast) ===
    const interval = setInterval(async () => {
      if (sold) return;

      // === SAFETY CHECK: Monitor liquidity first (rug pull protection) ===
      if (MIN_LIQUIDITY_BNB > 0 && initialLiquidityBNB > 0) {
        try {
          const pairContract = new ethers.Contract(pairAddress, PAIR_ABI, provider);
          const [r0, r1] = await pairContract.getReserves();
          const wbnbReserve = tokenIsToken1 ? r0 : r1;
          const wbnbLiquidityBNB = Number(ethers.formatEther(wbnbReserve));
          const currentLiquidityBNB = wbnbLiquidityBNB * 2; // Total liquidity

          // If liquidity dropped below minimum, sell immediately (rug pull protection)
          if (currentLiquidityBNB < MIN_LIQUIDITY_BNB) {
            console.log(`⚠️  LIQUIDITY DROP DETECTED!`);
            console.log(`   Initial: ${initialLiquidityBNB.toFixed(4)} BNB → Current: ${currentLiquidityBNB.toFixed(4)} BNB`);
            console.log(`   Minimum required: ${MIN_LIQUIDITY_BNB} BNB`);
            await executeSell('LIQUIDITY DROP BELOW MINIMUM - Possible rug pull');
            return;
          }
        } catch (err) {
          // If we can't check liquidity, continue with price monitoring
          console.log(`⚠️  Could not check liquidity this tick`);
        }
      }

      const currentPrice = await getCurrentPriceFromReservesSafe(pairAddress, tokenIsToken1);
      if (currentPrice === 0n) return;

      // Update peak
      if (currentPrice > highestPriceSeen) {
        highestPriceSeen = currentPrice;
        console.log(`New high: ${ethers.formatUnits(currentPrice, 18)} BNB/Token (+${((Number(currentPrice) * 100 / Number(initialPrice)) - 100).toFixed(1)}%)`);
      }

      // === TAKE PROFIT CONDITION ===
      if (currentPrice >= targetPrice) {
        await executeSell('TARGET HIT! Selling at +10% or more');
      }
    }, 1000); // every 1 second

  }

  // OPTIMIZED: Subscribe to PairCreated events with fast filtering
  console.log('✅ Event listener active - monitoring for new pairs...');
  logBotStatus();

  factory.on('PairCreated', async (token0: string, token1: string, pair: string, event: any) => {
    const eventStart = Date.now();

    // OPTIMIZATION: Fast lowercase comparison with pre-computed constant
    const token0Lower = token0.toLowerCase();
    const token1Lower = token1.toLowerCase();
    const wbnbLower = ADDRESSES.WBNB.toLowerCase();

    // Quick filter: Must be WBNB pair
    if (token0Lower !== wbnbLower && token1Lower !== wbnbLower) {
      return;   // Skip non-WBNB pairs instantly
    }

    let r0: bigint, r1: bigint;
    try {
      const pairContract = new ethers.Contract(pair, PAIR_ABI, provider);
      // console.log("pair ==>>", pair);
      [r0, r1] = await pairContract.getReserves();
      // console.log("reserve0 ==>>", r0);
      // console.log("reserve1 ==>>", r1);
      if (r0 === 0n || r1 === 0n) return;
    } catch (err: any) {
      console.log(`getReserves failed for pair ${pair} - skipping (possibly honeypot or RPC lag)`);
      // Do NOT crash the listener
      return;
    }

    const newToken = token0Lower === wbnbLower ? token1 : token0;
    const tokenIsToken1 = token0Lower === wbnbLower;    // if true → token1 is new token

    // === CHECK MINIMUM LIQUIDITY ===
    if (MIN_LIQUIDITY_BNB > 0) {
      // Calculate WBNB liquidity (WBNB is either token0 or token1)
      const wbnbReserve = token0Lower === wbnbLower ? r0 : r1;
      const wbnbLiquidityBNB = Number(ethers.formatEther(wbnbReserve));
      
      // Total liquidity in BNB = 2 * WBNB reserve (since AMM pools maintain equal value on both sides)
      const totalLiquidityBNB = wbnbLiquidityBNB * 2;
      
      console.log(`  Liquidity: ${totalLiquidityBNB.toFixed(4)} BNB (WBNB side: ${wbnbLiquidityBNB.toFixed(4)} BNB)`);
      
      if (totalLiquidityBNB < MIN_LIQUIDITY_BNB) {
        console.log(`❌ Liquidity ${totalLiquidityBNB.toFixed(4)} BNB is below minimum ${MIN_LIQUIDITY_BNB} BNB - skipping`);
        return;
      }
    }

    // === REJECT IF WE'RE ALREADY SNIPING SOMETHING ===
    if (isSnipingActive) {
      console.log(`Busy sniping ${currentTargetToken}... → Skipping ${newToken}...`);
      return;
    }

    // === FETCH TOKEN INFO AND APPLY FILTER ===
    const tokenInfo = await getTokenInfo(newToken);
    if (!tokenInfo) {
      console.log(`⚠️  Could not fetch token info for ${newToken} - skipping`);
      return;
    }

    const { name, symbol } = tokenInfo;
    console.log(`\n🔍 Token Info: ${name} (${symbol})`);
    console.log(`  Address: ${newToken}`);

    // Apply filter
    if (!shouldBuyToken(name)) {
      console.log(`❌ Token "${name}" (${symbol}) name contains one of: ${TOKEN_NAME_KEYWORDS.join(', ')} - skipping`);
      return;
    }

    // === DOUBLE-CHECK: REJECT IF WE'RE ALREADY SNIPING (race condition protection) ===
    // This check happens AFTER async operations to prevent missing tokens
    // that arrive while another token is being filtered
    if (isSnipingActive) {
      console.log(`⚠️  Another token is being sniped while filtering ${newToken}... → Skipping ${newToken}...`);
      return;
    }

    // Target found! Log and execute
    console.log(`\n🚨 TARGET DETECTED (${Date.now() - eventStart}ms from event)`);
    console.log(`  Pair: ${pair}`);
    console.log(`  Token: ${newToken}`);
    console.log(`  Name: ${name}`);
    console.log(`  Symbol: ${symbol}`);
    // console.log(`  Block: ${event.log?.blockNumber || 'unknown'}`);
    console.log(`  Time: ${new Date().toISOString()}`);
    console.log('─'.repeat(100));
    await new Promise(r => setTimeout(r, 80));

    // === LOCK THE SNIPER ===
    // Final check before locking (atomic operation)
    if (isSnipingActive) {
      console.log(`⚠️  Another token started sniping while processing ${newToken}... → Skipping ${newToken}...`);
      return;
    }
    isSnipingActive = true;
    currentTargetToken = newToken;
    console.log(`🔒 Sniping locked for token: ${newToken}`);
    logBotStatus();

    if (!sendBNB) {
      console.log("Missed SEND_BNB in env!")
      process.exit(1);
    }
    const result = await executeSwap(newToken, sendBNB, 3, false);    // increase size if you want

    if (result.success && result.txHash) {
      scheduleSellAfterBuy(newToken, result.txHash, pair, tokenIsToken1).catch(err => {
        console.error("Sell monitor crashed:", err);
        // Even if monitor crashes → unlock so we don't get stuck forever
        isSnipingActive = false;
        currentTargetToken = null;
        console.log(`🔓 Sniping unlocked (monitor crashed)`);
        logBotStatus();
      });
    } else {
      // Buy failed → unlock immediately
      console.log("Buy failed → unlocking sniper");
      isSnipingActive = false;
      currentTargetToken = null;
      console.log(`🔓 Sniping unlocked (buy failed)`);
      logBotStatus();
    }

  });

  setInterval(async () => {
    try {
      const pending = await provider.getTransactionCount(wallet.address, 'pending');
      if (pending > currentNonce) {
        console.log(`Nonce drift → ${currentNonce} → ${pending}`);
        currentNonce = pending;
      }
    } catch { }
  }, 8_000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n Shutting down...');
    provider.destroy();
    process.exit(0);
  });
}

main().catch(console.error);
