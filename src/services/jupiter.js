const axios = require('axios');
const config = require('../../config.json');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

function toRawAmount(amount, decimals) {
    return Math.floor(Number(amount) * Math.pow(10, decimals)).toString();
}

function fromRawAmount(rawAmount, decimals) {
    return Number(rawAmount) / Math.pow(10, decimals);
}

function getExecutionConfig() {
    return {
        quoteEndpoint: config.jupiter?.quoteEndpoint || 'https://quote-api.jup.ag/v6/quote',
        slippageBps: config.jupiter?.slippageBps ?? 500,
        maxPriceImpactPct: config.jupiter?.maxPriceImpactPct ?? 10,
        minPositionSizeSol: config.jupiter?.minPositionSizeSol ?? 0.03,
        positionSizeRetryMultipliers: config.jupiter?.positionSizeRetryMultipliers || [1, 0.75, 0.5, 0.25],
        estimatedSwapFeeSol: config.costs?.estimatedSwapFeeSol ?? 0,
        estimatedPriorityFeeSol: config.costs?.estimatedPriorityFeeSol ?? 0
    };
}

class PriceImpactError extends Error {
    constructor(message, priceImpactPct, maxPriceImpactPct) {
        super(message);
        this.name = 'PriceImpactError';
        this.priceImpactPct = priceImpactPct;
        this.maxPriceImpactPct = maxPriceImpactPct;
    }
}

class JupiterService {
    async getQuote(inputMint, outputMint, amountRaw, options = {}) {
        const execConfig = getExecutionConfig();
        const response = await axios.get(execConfig.quoteEndpoint, {
            timeout: 8000,
            params: {
                inputMint,
                outputMint,
                amount: amountRaw,
                slippageBps: options.slippageBps ?? execConfig.slippageBps,
                onlyDirectRoutes: false
            }
        });

        if (!response.data || !response.data.outAmount) {
            throw new Error('Jupiter quote tidak mengembalikan outAmount.');
        }

        const maxPriceImpactPct = options.maxPriceImpactPct ?? execConfig.maxPriceImpactPct;
        const priceImpactPct = Number(response.data.priceImpactPct || 0);
        if (Number.isFinite(priceImpactPct) && priceImpactPct > maxPriceImpactPct) {
            throw new PriceImpactError(
                `Price impact Jupiter terlalu tinggi: ${priceImpactPct}% > ${maxPriceImpactPct}%`,
                priceImpactPct,
                maxPriceImpactPct
            );
        }

        return response.data;
    }

    estimateSwapCostSol() {
        const execConfig = getExecutionConfig();
        return execConfig.estimatedSwapFeeSol + execConfig.estimatedPriorityFeeSol;
    }

    buildBuyExecution(tokenMint, positionSizeSol, tokenDecimals, buyQuote, solUsdQuote, selectedMultiplier, quoteAttempts) {
        const tokenAmount = fromRawAmount(buyQuote.outAmount, tokenDecimals);
        const solUsdValue = fromRawAmount(solUsdQuote.outAmount, USDC_DECIMALS);

        if (!tokenAmount || !solUsdValue) {
            throw new Error('Gagal menghitung harga entry dari quote Jupiter.');
        }

        const entryPriceUsd = solUsdValue / tokenAmount;
        const estimatedFeeSol = this.estimateSwapCostSol();

        return {
            source: 'jupiter_quote',
            inputMint: SOL_MINT,
            outputMint: tokenMint,
            selectedMultiplier,
            requestedPositionSizeSol: config.trading?.positionSize,
            executedPositionSizeSol: positionSizeSol,
            solInRaw: buyQuote.inAmount,
            tokenOutRaw: buyQuote.outAmount,
            tokenAmount,
            solUsdValue,
            entryPriceUsd,
            priceImpactPct: Number(buyQuote.priceImpactPct || 0),
            estimatedFeeSol,
            quoteAttempts,
            quote: buyQuote
        };
    }

    async getBuyExecution(tokenMint, requestedPositionSizeSol, tokenDecimals) {
        const execConfig = getExecutionConfig();
        const multipliers = execConfig.positionSizeRetryMultipliers;
        const quoteAttempts = [];

        for (const multiplier of multipliers) {
            const candidatePositionSizeSol = Number((requestedPositionSizeSol * multiplier).toFixed(9));
            if (candidatePositionSizeSol < execConfig.minPositionSizeSol) {
                quoteAttempts.push({
                    multiplier,
                    positionSizeSol: candidatePositionSizeSol,
                    skipped: true,
                    reason: `Di bawah minPositionSizeSol ${execConfig.minPositionSizeSol}`
                });
                continue;
            }

            try {
                const solInRaw = toRawAmount(candidatePositionSizeSol, SOL_DECIMALS);
                const [buyQuote, solUsdQuote] = await Promise.all([
                    this.getQuote(SOL_MINT, tokenMint, solInRaw),
                    this.getQuote(SOL_MINT, USDC_MINT, solInRaw, { maxPriceImpactPct: 100 })
                ]);

                quoteAttempts.push({
                    multiplier,
                    positionSizeSol: candidatePositionSizeSol,
                    priceImpactPct: Number(buyQuote.priceImpactPct || 0),
                    accepted: true
                });

                return this.buildBuyExecution(
                    tokenMint,
                    candidatePositionSizeSol,
                    tokenDecimals,
                    buyQuote,
                    solUsdQuote,
                    multiplier,
                    quoteAttempts
                );
            } catch (error) {
                quoteAttempts.push({
                    multiplier,
                    positionSizeSol: candidatePositionSizeSol,
                    rejected: true,
                    priceImpactPct: error.priceImpactPct,
                    reason: error.message
                });
            }
        }

        throw new Error(`Semua ukuran entry ditolak oleh price impact guard. Attempts: ${JSON.stringify(quoteAttempts)}`);
    }

    async getSellExecution(tokenMint, tokenAmountRaw, tokenDecimals) {
        const [sellQuote, tokenUsdQuote] = await Promise.all([
            this.getQuote(tokenMint, SOL_MINT, tokenAmountRaw),
            this.getQuote(tokenMint, USDC_MINT, tokenAmountRaw, { maxPriceImpactPct: 100 })
        ]);

        const tokenAmount = fromRawAmount(tokenAmountRaw, tokenDecimals);
        const exitSolAmount = fromRawAmount(sellQuote.outAmount, SOL_DECIMALS);
        const exitUsdValue = fromRawAmount(tokenUsdQuote.outAmount, USDC_DECIMALS);
        const exitPriceUsd = tokenAmount > 0 ? exitUsdValue / tokenAmount : 0;
        const estimatedFeeSol = this.estimateSwapCostSol();

        if (!exitSolAmount || !exitPriceUsd) {
            throw new Error('Gagal menghitung harga exit dari quote Jupiter.');
        }

        return {
            source: 'jupiter_quote',
            inputMint: tokenMint,
            outputMint: SOL_MINT,
            tokenInRaw: tokenAmountRaw,
            solOutRaw: sellQuote.outAmount,
            tokenAmount,
            exitSolAmount,
            exitUsdValue,
            exitPriceUsd,
            priceImpactPct: Number(sellQuote.priceImpactPct || 0),
            estimatedFeeSol,
            quote: sellQuote
        };
    }
}

module.exports = new JupiterService();
module.exports.SOL_MINT = SOL_MINT;
module.exports.USDC_MINT = USDC_MINT;
module.exports.PriceImpactError = PriceImpactError;
