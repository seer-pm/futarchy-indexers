import { BigInt, Address, BigDecimal, log } from "@graphprotocol/graph-ts"
import { NewProposal } from "../generated/FutarchyFactory/FutarchyFactory"
import { Pool as PoolCreated } from "../generated/AlgebraFactory/AlgebraFactory"
import {
    Swap as SwapEvent,
    Mint as MintEvent,
    Burn as BurnEvent,
    Initialize as InitializeEvent
} from "../generated/templates/AlgebraPool/AlgebraPool"
import { AlgebraPool } from "../generated/templates"
import { FutarchyProposal } from "../generated/FutarchyFactory/FutarchyProposal"
import { ERC20 } from "../generated/FutarchyFactory/ERC20"
import { WhitelistedToken, Pool, Candle, Proposal, Swap } from "../generated/schema"

// Constants
// Constants
// Constants
export const ROLE_YES_COMPANY = "YES_COMPANY"
export const ROLE_NO_COMPANY = "NO_COMPANY"
export const ROLE_YES_CURRENCY = "YES_CURRENCY"
export const ROLE_NO_CURRENCY = "NO_CURRENCY"
export const ROLE_COLLATERAL = "COLLATERAL"

// Pool Types
export const TYPE_EXPECTED_VALUE = "EXPECTED_VALUE"
export const TYPE_PREDICTION = "PREDICTION"
export const TYPE_CONDITIONAL = "CONDITIONAL"
export const TYPE_UNKNOWN = "UNKNOWN"


export function handleNewProposal(event: NewProposal): void {
    let proposalAddress = event.params.proposal
    let proposal = FutarchyProposal.bind(proposalAddress)

    // 1. Register Collaterals
    // Collateral 1 is usually Company Token - we might treat it generic or specific if needed. 
    // For now, let's just log it but the pools usually pair against Collat 2.
    // Collateral 1 is Company Token
    let collateral1 = proposal.try_collateralToken1()
    let companyTokenHex: string | null = null
    if (!collateral1.reverted) {
        saveToken(collateral1.value, "COMPANY", null)
        companyTokenHex = collateral1.value.toHexString()
    }

    // Collateral 2 is Currency Token (Quote)
    let collateral2 = proposal.try_collateralToken2()
    let currencyTokenHex: string | null = null
    if (!collateral2.reverted) {
        saveToken(collateral2.value, ROLE_COLLATERAL, null)
        currencyTokenHex = collateral2.value.toHexString()
    }

    // 2. Register Outcome Tokens
    let roles = [ROLE_YES_COMPANY, ROLE_NO_COMPANY, ROLE_YES_CURRENCY, ROLE_NO_CURRENCY]
    let outcomeTokenIds: string[] = []

    for (let i = 0; i < 4; i++) {
        let res = proposal.try_wrappedOutcome(BigInt.fromI32(i))
        if (!res.reverted) {
            // Get the address (this is the token itself)
            let tokenAddress = res.value.getWrapped1155()
            saveToken(tokenAddress, roles[i], proposalAddress)
            outcomeTokenIds.push(tokenAddress.toHexString())
        }
    }

    // 3. Create Proposal Entity
    let p = new Proposal(proposalAddress.toHexString())

    let mName = proposal.try_marketName()
    if (!mName.reverted) {
        p.marketName = mName.value
    } else {
        p.marketName = "Questions" // Default fallback
    }

    // Save Token Links
    if (companyTokenHex) p.companyToken = companyTokenHex!
    if (currencyTokenHex) p.currencyToken = currencyTokenHex!

    // Save Outcomes Array (Many-to-Many support)
    p.outcomeTokens = outcomeTokenIds

    p.save()
}



function saveToken(address: Address, role: string, proposal: Address | null): void {
    let id = address.toHexString()
    let token = WhitelistedToken.load(id)
    if (!token) {
        token = new WhitelistedToken(id)
        token.role = role
        if (proposal) token.proposal = proposal.toHexString()

        // Attempt to fetch symbol, but don't break if fail
        // Using ERC20 binding from generic ABI if present or generic ERC20 interaction
        let contract = ERC20.bind(address)
        let sym = contract.try_symbol()
        if (!sym.reverted) {
            token.symbol = sym.value
        } else {
            token.symbol = "UNK"
        }

        let dec = contract.try_decimals()
        if (!dec.reverted) {
            token.decimals = BigInt.fromI32(dec.value)
        } else {
            token.decimals = BigInt.fromI32(18)
        }

        token.save()
        log.info("Whitelisted Token: {} ({}) with Role: {}", [id, token.symbol!, role])
    } else if (token.role != role && (role == ROLE_YES_COMPANY || role == ROLE_NO_COMPANY || role == ROLE_YES_CURRENCY || role == ROLE_NO_CURRENCY)) {
        // Upgrade role if needed (prefer specific OUTCOME over generic if conflict occurs)
        token.role = role
        // Also update proposal if missing? Maybe better not to overwrite if it exists (collision?)
        // Assuming Outcomes are unique, Collaterals are shared.
        if (proposal) token.proposal = proposal.toHexString()
        token.save()
    }
}

export function handlePoolCreated(event: PoolCreated): void {
    let token0Addr = event.params.token0.toHexString()
    let token1Addr = event.params.token1.toHexString()
    let poolId = event.params.pool.toHexString()

    let token0 = WhitelistedToken.load(token0Addr)
    let token1 = WhitelistedToken.load(token1Addr)

    // FILTER: BOTH tokens must be whitelisted
    // User Request: "need two tokens known"
    if (!token0 || !token1) {
        log.warning("Ignoring Pool {} ({} / {}): One or both tokens not whitelisted", [poolId, token0Addr, token1Addr])
        return
    }

    let pool = new Pool(poolId)

    pool.token0 = token0Addr
    pool.token1 = token1Addr
    // Explicit casting probably safer but direct assignment worked in algebra-candles
    pool.fee = BigInt.fromI32(0)
    pool.liquidity = BigInt.fromI32(0)
    pool.sqrtPrice = BigInt.fromI32(0)
    pool.tick = BigInt.fromI32(0)
    pool.isInverted = false
    pool.price = BigDecimal.fromString("0")
    pool.volumeToken0 = BigDecimal.fromString("0")
    pool.volumeToken1 = BigDecimal.fromString("0")


    // NORMALIZATION CHECK
    // Logic:
    // 1. If one of them is COLLATERAL (Currency), that logic MUST be Quote.
    // 2. If one is OUTCOME_2/3 (Yes/No Currency) and other is OUTCOME_0/1 (Yes/No Company), then Currency is Quote.
    // 3. Otherwise Default (keep as is) unless flagged inverted.

    if (token0 && token1) {
        let r0 = token0.role
        let r1 = token1.role
        let s0 = token0.symbol ? token0.symbol! : "?"
        let s1 = token1.symbol ? token1.symbol! : "?"

        // Initialize defaults
        pool.type = TYPE_UNKNOWN
        pool.name = s0 + " / " + s1

        // RULE 1: Collateral is always Quote
        if (r0 == ROLE_COLLATERAL && r1 != ROLE_COLLATERAL) {
            pool.isInverted = true // Base/Quote -> Quote is T0 -> Inverted

            // Classification
            if (r1 == ROLE_YES_COMPANY || r1 == ROLE_NO_COMPANY) {
                pool.type = TYPE_EXPECTED_VALUE
            } else if (r1 == ROLE_YES_CURRENCY || r1 == ROLE_NO_CURRENCY) {
                pool.type = TYPE_PREDICTION
            }
            pool.name = s1 + " / " + s0
        } else if (r1 == ROLE_COLLATERAL) {
            pool.isInverted = false // Quote is T1 -> Normal

            // Classification
            if (r0 == ROLE_YES_COMPANY || r0 == ROLE_NO_COMPANY) {
                pool.type = TYPE_EXPECTED_VALUE
            } else if (r0 == ROLE_YES_CURRENCY || r0 == ROLE_NO_CURRENCY) {
                pool.type = TYPE_PREDICTION
            }
            pool.name = s0 + " / " + s1
        }

        // RULE 2: Conditional Pools (Company vs Currency Outcome)
        // We want Price of Company (Base) in terms of Currency (Quote)
        else if ((r0 == ROLE_YES_CURRENCY || r0 == ROLE_NO_CURRENCY) && (r1 == ROLE_YES_COMPANY || r1 == ROLE_NO_COMPANY)) {
            // T0 is Currency Outcome (Quote), T1 is Company Outcome (Base) -> Inverted
            pool.isInverted = true
            pool.type = TYPE_CONDITIONAL
            pool.name = s1 + " / " + s0
        }
        else if ((r1 == ROLE_YES_CURRENCY || r1 == ROLE_NO_CURRENCY) && (r0 == ROLE_YES_COMPANY || r0 == ROLE_NO_COMPANY)) {
            // T1 is Currency Outcome (Quote), T0 is Base -> Normal
            pool.isInverted = false
            pool.type = TYPE_CONDITIONAL
            pool.name = s0 + " / " + s1
        }

    } else if (token0 && !token1) {
        // Fallback for partial data
        if (token0.role == ROLE_COLLATERAL || token0.role == ROLE_YES_CURRENCY || token0.role == ROLE_NO_CURRENCY) {
            pool.isInverted = true
        }
    }

    if (pool.isInverted) {
        let s0 = token0 ? token0.symbol : "?"
        let s1 = token1 ? token1.symbol : "?"
        log.info("Inverted Pool Detected: {} ({} / {})", [poolId, s1!, s0!])
    }

    // LINK POOL TO PROPOSAL
    if (token0 && token0.proposal) {
        pool.proposal = token0.proposal!
    } else if (token1 && token1.proposal) {
        pool.proposal = token1.proposal!
    }

    // DETERMINE OUTCOME SIDE (YES/NO) for filtering
    // If any token involves YES, it's YES side. If NO, it's NO side.
    if (token0 && token1) {
        let r0 = token0.role
        let r1 = token1.role
        if (r0 == ROLE_YES_COMPANY || r0 == ROLE_YES_CURRENCY || r1 == ROLE_YES_COMPANY || r1 == ROLE_YES_CURRENCY) {
            pool.outcomeSide = "YES"
        } else if (r0 == ROLE_NO_COMPANY || r0 == ROLE_NO_CURRENCY || r1 == ROLE_NO_COMPANY || r1 == ROLE_NO_CURRENCY) {
            pool.outcomeSide = "NO"
        }
    }
    pool.save()

    // Start Indexing
    AlgebraPool.create(event.params.pool)
    log.info("Indexing Proposal Pool: {}", [poolId])
}

// Handle Initialize event - captures initial pool price before any swaps
const CANDLE_PERIODS: i32[] = [60, 300, 900, 3600, 14400, 86400]

export function handleInitialize(event: InitializeEvent): void {
    let poolId = event.address.toHexString()
    let pool = Pool.load(poolId)
    if (!pool) {
        log.warning("Initialize event for unknown pool: {}", [poolId])
        return
    }

    // LOAD TOKENS FOR DECIMALS
    let t0 = WhitelistedToken.load(pool.token0)
    let t1 = WhitelistedToken.load(pool.token1)
    let d0 = BigInt.fromI32(18)
    if (t0 && t0.decimals) {
        d0 = t0.decimals!
    }

    let d1 = BigInt.fromI32(18)
    if (t1 && t1.decimals) {
        d1 = t1.decimals!
    }

    // Convert BigInt decimals to exponents
    let pow0 = BigInt.fromI32(10).pow(d0.toI32() as u8).toBigDecimal()
    let pow1 = BigInt.fromI32(10).pow(d1.toI32() as u8).toBigDecimal()

    // --- PRICE CALCULATION (same logic as handleSwap) ---
    // Algebra exposes price directly (not sqrtPriceX96)
    let priceRaw = convertSqrtPriceX96(event.params.price)

    // Adjust for Decimals
    let decimalAdjust = pow0.div(pow1)
    let priceAdjusted = priceRaw.times(decimalAdjust)

    // User Perspective (Inversion)
    let priceUser = priceAdjusted
    if (pool.isInverted) {
        if (priceAdjusted.gt(BigDecimal.zero())) {
            priceUser = BigDecimal.fromString("1").div(priceAdjusted)
        }
    }

    // UPDATE POOL INITIAL PRICE
    pool.sqrtPrice = event.params.price
    pool.tick = BigInt.fromI32(event.params.tick)
    pool.price = priceUser
    pool.save()

    // SEED CANDLES
    // Candles were only ever written from handleSwap, so a pool that has been
    // initialized but never traded had a price and no candles at all — every
    // chart reading candles rendered empty until the first swap. Futarchy
    // pools are sparse (~2 swaps/day), so that window is long and visible.
    // Zero volume: no trade has happened, only a starting price.
    if (priceUser.gt(BigDecimal.zero())) {
        for (let i = 0; i < CANDLE_PERIODS.length; i++) {
            updateCandle(
                poolId,
                event.block.timestamp,
                priceUser,
                event.block.number,
                CANDLE_PERIODS[i],
                BigDecimal.zero(),
                BigDecimal.zero()
            )
        }
    }

    log.info("Pool {} Initialized with price: {}", [poolId, priceUser.toString()])
}


export function handleSwap(event: SwapEvent): void {
    let poolId = event.address.toHexString()
    let pool = Pool.load(poolId)
    if (!pool) return

    // LOAD TOKENS FOR DECIMALS
    let t0 = WhitelistedToken.load(pool.token0)
    let t1 = WhitelistedToken.load(pool.token1)
    let d0 = BigInt.fromI32(18)
    if (t0 && t0.decimals) {
        d0 = t0.decimals!
    }

    let d1 = BigInt.fromI32(18)
    if (t1 && t1.decimals) {
        d1 = t1.decimals!
    }

    // Convert BigInt decimals to exponents
    // 10^d0 and 10^d1
    let pow0 = BigInt.fromI32(10).pow(d0.toI32() as u8).toBigDecimal()
    let pow1 = BigInt.fromI32(10).pow(d1.toI32() as u8).toBigDecimal()

    let timestamp = event.block.timestamp

    // --- PRICE CALCULATION ---
    // 1. Raw price from SqrtPriceX96 (Token1 per Token0, disregarding decimals)
    let priceRaw = convertSqrtPriceX96(event.params.price)

    // 2. Adjust for Decimals: Price = priceRaw * (10^d0 / 10^d1)
    // Corresponds to: (Amount1 / 10^d1) / (Amount0 / 10^d0) = (Amount1/Amount0) * (10^d0/10^d1)
    let decimalAdjust = pow0.div(pow1)
    let priceAdjusted = priceRaw.times(decimalAdjust)

    // 3. User Perspective (Inversion)
    let priceUser = priceAdjusted
    if (pool.isInverted) {
        if (priceAdjusted.gt(BigDecimal.zero())) {
            priceUser = BigDecimal.fromString("1").div(priceAdjusted)
        }
    }

    // UPDATE POOL LATEST PRICE
    pool.sqrtPrice = event.params.price
    pool.price = priceUser

    // --- VOLUME CALCULATION ---
    let amount0Abs = event.params.amount0.abs().toBigDecimal().div(pow0)
    let amount1Abs = event.params.amount1.abs().toBigDecimal().div(pow1)

    pool.volumeToken0 = pool.volumeToken0.plus(amount0Abs)
    pool.volumeToken1 = pool.volumeToken1.plus(amount1Abs)

    pool.save()


    // --- SWAP ENTITY -------------------------------------
    // Use transaction hash + log index for unique ID
    let swapId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString()
    let swap = new Swap(swapId)
    swap.transactionHash = event.transaction.hash
    swap.timestamp = timestamp
    swap.pool = poolId
    swap.sender = event.params.sender
    swap.recipient = event.params.recipient
    swap.origin = event.transaction.from // ACTUAL USER ADDRESS

    // Raw Amounts (Wei -> Decimal)
    let amount0 = event.params.amount0.toBigDecimal().div(pow0)
    let amount1 = event.params.amount1.toBigDecimal().div(pow1)

    swap.amount0 = amount0
    swap.amount1 = amount1
    swap.price = priceUser

    // Determine Direction (In/Out)
    // Algebra/UniV3: Negative = Exact Input (User pay), Positive = Exact Output (User receive)
    // Actually:
    // amount > 0: Pool pays user (Output)
    // amount < 0: User pays pool (Input)

    // We need to verify if Token 0 or Token 1 is Input
    let tokenInAddr: string
    let tokenOutAddr: string
    let amountIn: BigDecimal
    let amountOut: BigDecimal

    if (amount0.lt(BigDecimal.zero())) {
        // T0 is Input (User paid T0), T1 is Output (User received T1)
        tokenInAddr = pool.token0
        tokenOutAddr = pool.token1
        amountIn = amount0.times(BigDecimal.fromString("-1"))
        amountOut = amount1
    } else {
        // T1 is Input (User paid T1), T0 is Output (User received T0)
        tokenInAddr = pool.token1
        tokenOutAddr = pool.token0
        amountIn = amount1.times(BigDecimal.fromString("-1"))
        amountOut = amount0
    }

    swap.tokenIn = tokenInAddr
    swap.tokenOut = tokenOutAddr
    swap.amountIn = amountIn
    swap.amountOut = amountOut

    swap.save()
    // -----------------------------------------------------

    for (let i = 0; i < CANDLE_PERIODS.length; i++) {
        let period = CANDLE_PERIODS[i]
        updateCandle(poolId, timestamp, priceUser, event.block.number, period, amount0Abs, amount1Abs)
    }
}

export function handleMint(event: MintEvent): void {
    let pool = Pool.load(event.address.toHexString())
    if (pool) {
        pool.liquidity = pool.liquidity.plus(event.params.liquidityAmount)
        pool.save()
    }
}

export function handleBurn(event: BurnEvent): void {
    let pool = Pool.load(event.address.toHexString())
    if (pool) {
        pool.liquidity = pool.liquidity.minus(event.params.liquidityAmount)
        pool.save()
    }
}

function updateCandle(poolId: string, timestamp: BigInt, price: BigDecimal, blockNumber: BigInt, period: i32, vol0: BigDecimal, vol1: BigDecimal): void {
    let periodStartUnix = (timestamp.toI32() / period) * period
    let candleId = poolId.concat("-").concat(period.toString()).concat("-").concat(periodStartUnix.toString())

    let candle = Candle.load(candleId)
    if (!candle) {
        candle = new Candle(candleId)
        candle.time = BigInt.fromI32(periodStartUnix)
        candle.period = BigInt.fromI32(period)
        candle.periodStartUnix = BigInt.fromI32(periodStartUnix)
        candle.pool = poolId
        candle.block = blockNumber
        candle.open = price
        candle.high = price
        candle.low = price
        candle.close = price
        candle.volumeToken0 = vol0
        candle.volumeToken1 = vol1
        candle.volumeUSD = BigDecimal.fromString("0")
    } else {
        if (price.gt(candle.high)) candle.high = price
        if (price.lt(candle.low)) candle.low = price
        candle.close = price
        candle.volumeToken0 = candle.volumeToken0.plus(vol0)
        candle.volumeToken1 = candle.volumeToken1.plus(vol1)
    }

    candle.save()
}

function convertSqrtPriceX96(sqrtPriceX96: BigInt): BigDecimal {
    let q96 = BigInt.fromI32(2).pow(96)
    let sqrtPrice = sqrtPriceX96.toBigDecimal().div(q96.toBigDecimal())
    return sqrtPrice.times(sqrtPrice)
}
