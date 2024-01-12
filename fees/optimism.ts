import { Adapter, ProtocolType } from "../adapters/types";
import { OPTIMISM } from "../helpers/chains";
import { request, gql } from "graphql-request";
import { getBalance } from '@defillama/sdk/build/eth';
import { getPrices } from "../utils/prices";
import { getBlock } from "../helpers/getBlock";
import { ChainBlocks } from "../adapters/types";
import BigNumber from "bignumber.js";
import { getTimestamp24hAgo } from "../utils/date";
import postgres from "postgres";
import { queryFlipside } from "../helpers/flipsidecrypto";


async function getFees(toTimestamp:number, fromTimestamp:number, chainBlocks: ChainBlocks){
    const todaysBlock = (await getBlock(toTimestamp, OPTIMISM, chainBlocks));
    const yesterdaysBlock = (await getBlock(fromTimestamp, OPTIMISM, {}));

    const graphQuery = gql
        `query txFees {
        yesterday: withdrawns(id: "1", block: { number: ${yesterdaysBlock} }) {
            amount
        }
        today: withdrawns(id: "1", block: { number: ${todaysBlock} }) {
            amount
        }
      }`;

    const graphRes = await request("https://api.thegraph.com/subgraphs/name/ap0calyp/optimism-fee-withdrawn", graphQuery);

    const query = `
        SELECT
            sum(eth_value) as sum
        from
            optimism.core.fact_traces
        WHERE
            from_address in (
                '0x420000000000000000000000000000000000001a',
                '0x4200000000000000000000000000000000000019'
            )
            and to_address = '0x4200000000000000000000000000000000000010'
            and BLOCK_NUMBER > ${yesterdaysBlock} AND BLOCK_NUMBER < ${todaysBlock}
    `
    const value: string[] = (await queryFlipside(query, 260)).flat();
    const feeWalletAndBase = new BigNumber(value[0] || '0').multipliedBy(1e18);
    const dailyFee = new BigNumber(graphRes["today"][0].amount).minus(graphRes["yesterday"][0].amount).plus(feeWalletAndBase);

    const feeWallet = '0x4200000000000000000000000000000000000011';
    const l1FeeVault = '0x420000000000000000000000000000000000001a';
    const baseFeeVault = '0x4200000000000000000000000000000000000019';

    const [
        feeWalletStart,
        feeWalletEnd,
        l1FeeVaultStart,
        l1FeeVaultEnd,
        baseFeeVaultStart,
        baseFeeVaultEend
    ] = (await Promise.all([
        getBalance({
            target: feeWallet,
            block: yesterdaysBlock,
            chain: "optimism"
        }),
        getBalance({
            target: feeWallet,
            block: todaysBlock,
            chain: "optimism"
        }),
        getBalance({
            target: l1FeeVault,
            block: yesterdaysBlock,
            chain: "optimism"
        }),
        getBalance({
            target: l1FeeVault,
            block: todaysBlock,
            chain: "optimism"
        }),
        getBalance({
            target: baseFeeVault,
            block: yesterdaysBlock,
            chain: "optimism"
        }),
        getBalance({
            target: baseFeeVault,
            block: todaysBlock,
            chain: "optimism"
        })
    ])).map(i => i.output)
    const ethBalance = (new BigNumber(feeWalletEnd).minus(feeWalletStart))
        .plus((new BigNumber(l1FeeVaultEnd).minus(l1FeeVaultStart)))
        .plus((new BigNumber(baseFeeVaultEend).minus(baseFeeVaultStart)))

    return (ethBalance.plus(dailyFee)).div(1e18)
}

const feesAdapter = async (timestamp: number, chainBlocks: ChainBlocks) => {
    const sql = postgres(process.env.INDEXA_DB!);
    const now = new Date(timestamp * 1e3)
    const dayAgo = new Date(now.getTime() - 1000 * 60 * 60 * 24)
    try  {
        const fromTimestamp = timestamp - 60 * 60 * 24
        const toTimestamp = timestamp

        const ethAddress = "ethereum:0x0000000000000000000000000000000000000000";
        const pricesObj: any = await getPrices([ethAddress], toTimestamp);
        const latestPrice = pricesObj[ethAddress]["price"]
        const sequencerGas = sql`
        SELECT
            sum(ethereum.transactions.gas_used * ethereum.transactions.gas_price) / 10 ^ 18 AS sum
        FROM
            ethereum.transactions
            INNER JOIN ethereum.blocks ON ethereum.transactions.block_number = ethereum.blocks.number
        WHERE (to_address = '\\x6887246668a3b87F54DeB3b94Ba47a6f63F32985'::bytea
            OR to_address = '\\xFF00000000000000000000000000000000000010'::bytea
            OR to_address = '\\x473300df21D047806A082244b417f96b32f13A33'::bytea
            OR to_address = '\\xdfe97868233d1aa22e815a266982f2cf17685a27'::bytea) AND (block_time BETWEEN ${dayAgo.toISOString()} AND ${now.toISOString()});
        `
        const [totalFees, totalSpentBySequencer] = await Promise.all([
            getFees(toTimestamp, fromTimestamp, chainBlocks),
            sequencerGas
        ]);
        const finalDailyFee = totalFees.times(latestPrice)
        const revenue = (totalFees.minus(totalSpentBySequencer[0].sum)).times(latestPrice)
        await sql.end({ timeout: 3 })
        return {
            timestamp,
            dailyFees: finalDailyFee.toString(),
            dailyRevenue: revenue.toString(),
            dailyHoldersRevenue: '0',
        };
    } catch (error) {
        await sql.end({ timeout: 3 })
        console.error(error);
        throw error;
    }

}


const adapter: Adapter = {
    adapter: {
        [OPTIMISM]: {
            fetch: feesAdapter,
            start: async () => 1598671449,
        },
    },
    protocolType: ProtocolType.CHAIN
}

export default adapter;
