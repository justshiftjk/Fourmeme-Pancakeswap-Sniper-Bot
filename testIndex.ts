import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

// BSC Mainnet addresses
const ADDRESSES = {
  WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  FACTORY: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73' as const, // PancakeSwap V2 Factory
  ROUTER: '0x10ED43C718714eb63d5aA57B78B54704E256024E' as const, // PancakeSwap V2 Router
  QUOTER_V2: '0xB048Bbc1B6aAD7B1bB7987a14F6d34bE1FBE9F6E' as const  // QuoterV2
} as const;

// Sniper Contract address (REQUIRED - deploy first and set in .env)
const SNIPER_CONTRACT_ADDRESS = process.env.SNIPER_CONTRACT_ADDRESS;

if (!SNIPER_CONTRACT_ADDRESS) {
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
] as const;

// Quoter ABI (for price estimation)
const QUOTER_ABI = [
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)',
] as const;

// ABI for SniperContract buy function
const SNIPER_ABI = [
  'function buy(address token, uint256 amountIn, uint256 deadlineOffset) external',
] as const;

// Initialize multiple RPC providers for broadcasting
const rpcProviders: ethers.JsonRpcProvider[] = BSC_RPC_ENDPOINTS.map(
  url => new ethers.JsonRpcProvider(url)
);

// OPTIMIZED: Multi-RPC broadcast - Submit signed tx to multiple RPCs simultaneously
async function submitRawTx(rawTx: string, timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  // Add 0x prefix if missing
  const txWithPrefix = rawTx.startsWith('0x') ? rawTx : '0x' + rawTx;
  console.log(' Broadcasting to', rpcProviders.length, 'RPC endpoints...');
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

      console.log(`RPC ${index + 1} accepted (${Date.now() - start}ms)`);
      return { success: true, hash: response.hash, provider: index };
    } catch (err: any) {
      console.log(`RPC ${index + 1} failed: ${err.message.substring(0, 50)}`);
      return { success: false, error: err.message, provider: index };
    }
  });

  // Wait for first successful response
  const results = await Promise.allSettled(submissions);
  // Find first successful submission
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.success && result.value.hash) {
      const txHash = result.value.hash;
      console.log('Transaction broadcast successful: ${ txHash }');

      // Let other submissions complete in background (don't await)
      Promise.allSettled(submissions).then(() => {
        const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
        console.log(` Final: ${successCount}/${rpcProviders.length} RPCs accepted tx`);
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
    console.log('Already approved: ${ token }');
    return;
  }
  console.log('Approving ${ token }...');
  const tx = await tokenContract.approve(ADDRESSES.ROUTER, ethers.MaxUint256);
  await tx.wait(1);
  console.log('Approved: ${ tx.hash }');
}

// === GET BALANCE ===
async function getTokenBalance(token: string): Promise<bigint> {
  const contract = new ethers.Contract(token, ERC20_ABI, provider);
  return await contract.balanceOf(wallet.address);
}

async function main() {
  console.log(' Starting Multi-RPC sniper...');
  console.log('Configured ${ rpcProviders.length } RPC endpoints for broadcasting');
  // Connect to BSC via WebSocket for events (read-only)
  console.log('Connected to BSC WebSocket provider (event monitoring)...');

  // Initialize Factory for events (read-only)
  const factory = new ethers.Contract(ADDRESSES.FACTORY, FACTORY_ABI, provider);

  // Initialize SniperContract with signer for swaps
  const sniperContract = new ethers.Contract(SNIPER_CONTRACT_ADDRESS!, SNIPER_ABI, wallet);
  const routerContract = new ethers.Contract(ADDRESSES.ROUTER, PANCAKE_ROUTER_ABI, wallet);
  console.log('Wallet address: ${ wallet.address }');
  console.log('Sniper Contract: ${ SNIPER_CONTRACT_ADDRESS }');

  // NEW: Manual nonce management for speed
  let currentNonce = await provider.getTransactionCount(wallet.address, 'pending');
  console.log('Starting nonce: ${ currentNonce }');

  // OPTIMIZED: Lightning-fast swap function (BNB → New Token via SniperContract) - Multi-RPC Broadcast
  async function executeSwap(newToken: string, amountInBNB: string, deadlineMinutes = 3, competitiveGas = false) {
    const start = Date.now(); try {
      console.log(`SWAP: ${amountInBNB} BNB → ${newToken} (via PancakeSwap Router)`);

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
        gasPrice = ethers.parseUnits('3', 'gwei');
      }

      // ---- READ ONCE ----
      const nonce = currentNonce;

      // CORRECT: Use proper deadline (timestamp), not offset
      const txRequest = await routerContract.swapExactETHForTokens.populateTransaction(
        0,  // amountOutMin = 0 (slippage tolerance: accept any output)
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

      // ---- NEW: schedule sell 1 s after buy ----
      scheduleSellAfterBuy(newToken, amountIn, txHash).catch(console.error);

      // Background confirmation
      provider.waitForTransaction(txHash, 1, 45000)
        .then(async (receipt) => {
          if (receipt?.status === 1) {
            console.log(`Confirmed in block ${receipt.blockNumber}`);
          }
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
    amountInBNB: bigint,
    buyTxHash: string
  ) {
    // 1. Wait for the buy to be mined
    const receipt = await provider.waitForTransaction(buyTxHash, 1, 60_000);
    if (!receipt || receipt.status !== 1) {
      console.log('Buy ${ buyTxHash } failed or reverted - dropped – no sell');
      return;
    }
    console.log('Buy confirmed in block ${ receipt.blockNumber }');
    // 2. Get the exact token amount we received
    const tokenBalance = await getTokenBalance(token);
    if (tokenBalance === 0n) {
      console.log(`Zero token balance after buy – nothing to sell`);
      return;
    }

    // 3. Wait 1 seconds
    await new Promise(r => setTimeout(r, 1000));
    // 4. Approve router (if needed)
    await approveToken(token, tokenBalance);

    // 5. Build sell tx (swapExactTokensForETH)
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 180);
    const gasPrice = ethers.parseUnits('3', 'gwei');      // you can make it dynamic

    currentNonce = await provider.getTransactionCount(wallet.address, 'pending');
    // ---- READ ONCE (after buy nonce already incremented) ----
    const nonce = currentNonce;

    const txReq = await routerContract.swapExactTokensForETH.populateTransaction(
      tokenBalance,               // amountIn = what we own
      0n,                         // amountOutMin = 0 → accept any BNB (you said “don’t care”)
      [token, ADDRESSES.WBNB],
      wallet.address,
      deadline,
      {
        gasLimit: 250_000n,
        gasPrice,
        nonce,
        chainId: 56n,
      }
    );

    const signed = await wallet.signTransaction(txReq);
    const raw = signed.slice(2);

    try {
      const sellHash = await submitRawTx(raw, 5_000);
      currentNonce++;     // ← ONLY ONE INCREMENT
      console.log(`SELL submitted ${sellHash} (≈${ethers.formatEther(tokenBalance)} tokens)`);

    } catch (e: any) {
      console.error(`SELL FAILED: ${e.message}`);
      // rollback nonce on broadcast error
      currentNonce = await provider.getTransactionCount(wallet.address, 'pending');
    }
  }  // OPTIMIZED: Subscribe to PairCreated events with fast filtering
  factory.on('PairCreated', async (token0: string, token1: string, pair: string, event: any) => {
    const eventStart = Date.now();// OPTIMIZATION: Fast lowercase comparison with pre-computed constant
    const token0Lower = token0.toLowerCase();
    const token1Lower = token1.toLowerCase();
    const wbnbLower = ADDRESSES.WBNB.toLowerCase();

    // Quick filter: Must be WBNB pair
    if (token0Lower !== wbnbLower && token1Lower !== wbnbLower) {
      return;     // Skip non-WBNB pairs instantly
    }

    const newToken = token0Lower === wbnbLower ? token1 : token0;

    // Target found! Log and execute
    console.log(`\n TARGET DETECTED (${Date.now() - eventStart}ms from event)`);
    console.log(`  Pair: ${pair}`);
    console.log(`  Token: ${newToken}`);
    console.log(`  Block: ${event.log?.blockNumber || 'unknown'}`);
    console.log(`  Time: ${new Date().toISOString()}`);
    console.log('─'.repeat(100));

    // CRITICAL: Execute swap immediately(normal gas - pair already created)
    executeSwap(newToken, '0.00000001', 3, false).catch(err => {
      console.error('Swap execution error:', err.message);
    });
  });


  setInterval(async () => {
    try {
      const pending = await provider.getTransactionCount(wallet.address, 'pending');
      if (pending > currentNonce) {
        console.log('Nonce drift → ${ currentNonce } → ${ pending }');
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

