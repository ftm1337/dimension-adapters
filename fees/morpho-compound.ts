import { Adapter, ChainBlocks, FetchResultFees } from "../adapters/types"
import { CHAIN } from "../helpers/chains";
import { getBlock } from "../helpers/getBlock";
import * as sdk from "@defillama/sdk";
import { ethers, BigNumberish } from "ethers";
import { getPrices } from "../utils/prices";


interface IPrices {
  [address: string]: {
    decimals: number;
    price: number;
    symbol: string;
    timestamp: number;
  };
}

interface IContext {
  currentTimestamp: number;
  startTimestamp: number;
  endTimestamp: number;
  startBlock: number;
  endBlock: number;
  markets: string[];
  underlyings: string[];
  reserveFactors: string[];
  prices: IPrices;
}
interface IAccrueInterestLog {
  market: string;
  cashPrior: BigNumberish;
  interestAccumulated: BigNumberish;
  borrowIndexNew: BigNumberish;
  totalBorrowsNew: BigNumberish;
}

interface ITx {
  address: string;
  data: string;
  topics: string[];
  transactionHash: string;
}

const unitroller = "0x930f1b46e1d081ec1524efd95752be3ece51ef67";
const comptrollerABI = {
  getAllMarkets: "function getAllMarkets() external view returns (address[])",
};

const topic0_accue_interest = '0x4dec04e750ca11537cabcd8a9eab06494de08da3735bc8871cd41250e190bc04';

const tokenABI = {
  underlying: "function underlying() external view returns (address)",
  accrueInterest:"event AccrueInterest(uint256 cashPrior,uint256 interestAccumulated,uint256 borrowIndex,uint256 totalBorrows)",
  reserveFactorMantissa: "function reserveFactorMantissa() external view returns (uint256)",
};

const contract_interface = new ethers.Interface(Object.values(tokenABI));

const fetch = async (timestamp: number): Promise<FetchResultFees> => {
  const context = await getContext(timestamp, {});
  const { dailyProtocolFees, dailyProtocolRevenue } = await getDailyProtocolFees(context);
  const dailySupplySideRevenue = (dailyProtocolFees - dailyProtocolRevenue);
  return {
    timestamp,
    dailyFees: dailyProtocolFees.toString(),
    dailyRevenue: dailyProtocolRevenue.toString(),
    dailyHoldersRevenue: dailyProtocolRevenue.toString(),
    dailySupplySideRevenue: `${dailySupplySideRevenue}`
  }
}

const getAllMarkets = async (
  unitroller: string,
  chain: CHAIN
): Promise<string[]> => {
  return (
    await sdk.api2.abi.call({
      target: unitroller,
      abi: comptrollerABI.getAllMarkets,
      chain: chain,
    })
  );
};

const getContext = async (timestamp: number, _: ChainBlocks): Promise<IContext> => {
  const fromTimestamp = timestamp - 60 * 60 * 24
  const toTimestamp = timestamp
  const fromBlock = (await getBlock(fromTimestamp, CHAIN.ETHEREUM, {}));
  const toBlock = (await getBlock(toTimestamp, CHAIN.ETHEREUM, {}));

  const allMarketAddressess = await getAllMarkets(unitroller, CHAIN.ETHEREUM);
  const { underlyings, reserveFactors } = await getMarketDetails(allMarketAddressess,CHAIN.ETHEREUM);

  const prices = await getPrices(
    [
      ...underlyings.filter((e: string) => e).map((x: string) => `${CHAIN.ETHEREUM}:${x.toLowerCase()}`),
    ],
    timestamp
  );

  return {
    currentTimestamp: timestamp,
    startTimestamp: fromTimestamp,
    endTimestamp: toTimestamp,
    startBlock: fromBlock,
    endBlock: toBlock,
    markets: allMarketAddressess,
    underlyings,
    reserveFactors,
    prices,
  };
};

const getMarketDetails = async (markets: string[], chain: CHAIN): Promise<{underlyings: string[], reserveFactors:string[]}> => {
  const underlyings = await sdk.api2.abi.multiCall({
    calls: markets.map((market: string) => ({
      target: market,
    })),
    abi: tokenABI.underlying,
    chain: chain,
    permitFailure: true,
  });

  const reserveFactors = await sdk.api2.abi.multiCall({
    calls: markets.map((market: string) => ({
      target: market,
    })),
    abi: tokenABI.reserveFactorMantissa,
    chain: chain,
    permitFailure: true,
  });
  const _underlyings =  underlyings;
  return {
    underlyings: _underlyings,
    reserveFactors: reserveFactors,
  };
};


const getDailyProtocolFees = async ({
  markets,
  underlyings,
  reserveFactors,
  prices,
  startBlock,
  endBlock,
}: IContext) => {
  let dailyProtocolFees = 0;
  let dailyProtocolRevenue = 0;
  const logs: ITx[] = (await Promise.all(
    markets.map((address: string) => sdk.getEventLogs({
      target: address,
      toBlock: endBlock,
      fromBlock: startBlock,
      chain: CHAIN.ETHEREUM,
      topics: [topic0_accue_interest]
  })))).flat();

  const raw_data: IAccrueInterestLog[] = logs.map((e: ITx) => {
    const x =  contract_interface.parseLog(e);
    return {
      market: e.address,
      cashPrior: x!.args.cashPrior,
      interestAccumulated: x!.args.interestAccumulated,
      borrowIndexNew: x!.args.borrowIndex,
      totalBorrowsNew: x!.args.totalBorrows,
    }
  });

  raw_data.forEach((log: IAccrueInterestLog) => {
    const marketIndex = markets.findIndex((e: string) => e === log.market);
    const underlying = underlyings[marketIndex].toLowerCase();
    const price = prices[`${CHAIN.ETHEREUM}:${underlying?.toLowerCase()}`];

    const interestTokens = +ethers.formatUnits(
      log.interestAccumulated,
      price.decimals
    );
    const reserveFactor = +ethers.formatUnits(
      reserveFactors[marketIndex],
      18
    );
    const interestUSD = interestTokens * price.price;

    dailyProtocolFees += interestUSD;
    dailyProtocolRevenue += interestUSD * reserveFactor;
  });

  return {
    dailyProtocolFees,
    dailyProtocolRevenue,
  };
};


const adapter: Adapter = {
  adapter: {
    [CHAIN.ETHEREUM]: {
      fetch: fetch,
      start: async () => 1697932800,
      runAtCurrTime: true,
    },
  },
};

export default adapter;
