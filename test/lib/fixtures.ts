import { ethers, waffle } from 'hardhat'
import { Wallet, Contract, BigNumber } from 'ethers'
import { deployContract, link } from 'ethereum-waffle'
import { formatEther, parseEther } from 'ethers/lib/utils'
import constants from './constants'
import batchApproval from './batchApproval'
const { OPTION_TEMPLATE_LIB, REDEEM_TEMPLATE_LIB } = constants.LIBRARIES

import Weth from '@primitivefi/contracts/artifacts/WETH9.json'
import Flash from '@primitivefi/contracts/artifacts/Flash.json'
import Trader from '@primitivefi/contracts/artifacts/Trader.json'
import Option from '@primitivefi/contracts/artifacts/Option.json'
import Redeem from '@primitivefi/contracts/artifacts/Redeem.json'
import Registry from '@primitivefi/contracts/artifacts/Registry.json'
import OptionTest from '@primitivefi/contracts/artifacts/OptionTest.json'
import OptionFactory from '@primitivefi/contracts/artifacts/OptionFactory.json'
import RedeemFactory from '@primitivefi/contracts/artifacts/RedeemFactory.json'
import OptionTemplateLib from '@primitivefi/contracts/artifacts/OptionTemplateLib.json'
import RedeemTemplateLib from '@primitivefi/contracts/artifacts/RedeemTemplateLib.json'

import TestERC20 from '../../build/contracts/test/TestERC20.sol/TestERC20.json'
import PrimitiveCore from '../../build/contracts/connectors/PrimitiveCore.sol/PrimitiveCore.json'
import PrimitiveSwaps from '../../build/contracts/connectors/PrimitiveSwaps.sol/PrimitiveSwaps.json'
import PrimitiveRouter from '../../build/contracts/PrimitiveRouter.sol/PrimitiveRouter.json'
import PrimitiveLiquidity from '../../build/contracts/connectors/PrimitiveLiquidity.sol/PrimitiveLiquidity.json'
import PrimitiveRouterTest from '../../build/contracts/test/PrimitiveRouterTest.sol/PrimitiveRouterTest.json'

import UniswapV2Factory from '@uniswap/v2-core/build/UniswapV2Factory.json'
import UniswapV2Router02 from '@uniswap/v2-periphery/build/UniswapV2Router02.json'

const overrides = { gasLimit: 9500000 }

interface WethFixture {
  weth: Contract
}

export async function wethFixture([wallet]: Wallet[], provider): Promise<WethFixture> {
  const weth = await deployContract(wallet, Weth, [], overrides)
  return { weth }
}

interface RegistryFixture {
  registry: Contract
  optionFactory: Contract
  redeemFactory: Contract
}

export async function registryFixture([wallet]: Wallet[], provider): Promise<RegistryFixture> {
  const registry = await deployContract(wallet, Registry, [], overrides)
  let oLib = await deployContract(wallet, OptionTemplateLib, [], overrides)
  let opFacContract = Object.assign(OptionFactory, {
    evm: { bytecode: { object: OptionFactory.bytecode } },
  })
  link(opFacContract, OPTION_TEMPLATE_LIB, oLib.address)

  let optionFactory = await deployContract(wallet, opFacContract, [registry.address], overrides)
  let rLib = await deployContract(wallet, RedeemTemplateLib, [], overrides)

  let reFacContract = Object.assign(RedeemFactory, {
    evm: { bytecode: { object: RedeemFactory.bytecode } },
  })
  link(reFacContract, REDEEM_TEMPLATE_LIB, rLib.address)

  let redeemFactory = await deployContract(wallet, reFacContract, [registry.address], overrides)
  await optionFactory.deployOptionTemplate()
  await redeemFactory.deployRedeemTemplate()
  await registry.setOptionFactory(optionFactory.address)
  await registry.setRedeemFactory(redeemFactory.address)
  return {
    registry,
    optionFactory,
    redeemFactory,
  }
}

interface UniswapFixture {
  uniswapRouter: Contract
  uniswapFactory: Contract
  weth: Contract
}

export async function uniswapFixture([wallet]: Wallet[], provider): Promise<UniswapFixture> {
  const { weth } = await wethFixture([wallet], provider)
  const uniswapFactory = await deployContract(wallet, UniswapV2Factory, [wallet.address], overrides)
  const uniswapRouter = await deployContract(wallet, UniswapV2Router02, [uniswapFactory.address, weth.address], overrides)
  return { uniswapRouter, uniswapFactory, weth }
}

interface TokenFixture {
  tokenA: Contract
  tokenB: Contract
}

export async function tokenFixture([wallet]: Wallet[], provider): Promise<TokenFixture> {
  const amount = ethers.utils.parseEther('1000000000')
  const tokenA = await deployContract(wallet, TestERC20, ['COMP', 'COMP', amount])
  const tokenB = await deployContract(wallet, TestERC20, ['DAI', 'DAI', amount])
  return { tokenA, tokenB }
}

export interface OptionParameters {
  underlying: string
  strike: string
  base: BigNumber
  quote: BigNumber
  expiry: string
}

interface OptionFixture {
  registry: Contract
  optionToken: Contract
  redeemToken: Contract
  underlyingToken: Contract
  strikeToken: Contract
  params: OptionParameters
}

/**
 * @notice  Gets a call option with a $100 strike price.
 */
export async function optionFixture([wallet]: Wallet[], provider): Promise<OptionFixture> {
  const { registry } = await registryFixture([wallet], provider)
  const { tokenA, tokenB } = await tokenFixture([wallet], provider)
  const underlyingToken = tokenA
  const strikeToken = tokenB
  await registry.verifyToken(underlyingToken.address)
  await registry.verifyToken(strikeToken.address)
  const base = parseEther('1')
  const quote = parseEther('100')
  const expiry = '1690868800'
  await registry.deployOption(underlyingToken.address, strikeToken.address, base, quote, expiry)
  const optionToken = new ethers.Contract(
    await registry.allOptionClones(((await registry.getAllOptionClonesLength()) - 1).toString()),
    Option.abi,
    wallet
  )
  const redeemToken = new ethers.Contract(await optionToken.redeemToken(), Redeem.abi, wallet)
  const params = {
    underlying: underlyingToken.address,
    strike: strikeToken.address,
    base: base,
    quote: quote,
    expiry: expiry,
  }
  return { registry, optionToken, redeemToken, underlyingToken, strikeToken, params }
}

export interface PrimitiveV1Fixture {
  registry: Contract
  optionToken: Contract
  redeemToken: Contract
  underlyingToken: Contract
  strikeToken: Contract
  uniswapRouter: Contract
  uniswapFactory: Contract
  weth: Contract
  trader: Contract
  router: Contract
  core: Contract
  swaps: Contract
  liquidity: Contract
  params: OptionParameters
}

export async function primitiveV1([wallet]: Wallet[], provider): Promise<PrimitiveV1Fixture> {
  const { registry, optionToken, redeemToken, underlyingToken, strikeToken, params } = await optionFixture(
    [wallet],
    provider
  )
  const { uniswapRouter, uniswapFactory, weth } = await uniswapFixture([wallet], provider)
  const trader = await deployContract(wallet, Trader, [weth.address], overrides)
  const router = await deployContract(wallet, PrimitiveRouter, [weth.address, registry.address], overrides)
  const core = await deployContract(wallet, PrimitiveCore, [weth.address, router.address], overrides)
  const swaps = await deployContract(
    wallet,
    PrimitiveSwaps,
    [weth.address, router.address, uniswapFactory.address, uniswapRouter.address],
    overrides
  )
  const liquidity = await deployContract(
    wallet,
    PrimitiveLiquidity,
    [weth.address, router.address, uniswapFactory.address, uniswapRouter.address],
    overrides
  )

  await router.setRegisteredConnectors([core.address, swaps.address, liquidity.address], [true, true, true])
  await router.setRegisteredOptions([optionToken.address])
  await batchApproval(
    [trader.address, router.address, uniswapRouter.address],
    [underlyingToken, strikeToken, optionToken, redeemToken, weth],
    [wallet]
  )
  return {
    registry,
    optionToken,
    redeemToken,
    underlyingToken,
    strikeToken,
    uniswapRouter,
    uniswapFactory,
    weth,
    trader,
    router,
    core,
    swaps,
    liquidity,
    params,
  }
}
