import { ethers } from 'hardhat'

// build
import TestERC20 from '../../build/contracts/test/TestERC20.sol/TestERC20.json'
import OptionFactory from '@primitivefi/contracts/artifacts/OptionFactory.json'
import RedeemFactory from '@primitivefi/contracts/artifacts/RedeemFactory.json'
import Option from '@primitivefi/contracts/artifacts/Option.json'
import OptionTest from '@primitivefi/contracts/artifacts/OptionTest.json'
import Redeem from '@primitivefi/contracts/artifacts/Redeem.json'
import Registry from '@primitivefi/contracts/artifacts/Registry.json'
import Flash from '@primitivefi/contracts/artifacts/Flash.json'
import Weth from '@primitivefi/contracts/artifacts/WETH9.json'
import Trader from '@primitivefi/contracts/artifacts/Trader.json'
import OptionTemplateLib from '@primitivefi/contracts/artifacts/OptionTemplateLib.json'
import RedeemTemplateLib from '@primitivefi/contracts/artifacts/RedeemTemplateLib.json'
import PrimitiveRouter from '../../build/contracts/PrimitiveRouter.sol/PrimitiveRouter.json'
import PrimitiveRouterTest from '../../build/contracts/test/PrimitiveRouterTest.sol/PrimitiveRouterTest.json'
import PrimitiveCore from '../../build/contracts/connectors/PrimitiveCore.sol/PrimitiveCore.json'
import PrimitiveLiquidity from '../../build/contracts/connectors/PrimitiveLiquidity.sol/PrimitiveLiquidity.json'
import PrimitiveSwaps from '../../build/contracts/connectors/PrimitiveSwaps.sol/PrimitiveSwaps.json'


// Constants and Utility functions
import constants from './constants'
import { deployContract, link } from 'ethereum-waffle'
const { MILLION_ETHER } = constants.VALUES
const { OPTION_TEMPLATE_LIB, REDEEM_TEMPLATE_LIB } = constants.LIBRARIES

// Uniswap related build and addresses
import UniswapV2Router02 from '@uniswap/v2-periphery/build/UniswapV2Router02.json'
import UniswapV2Factory from '@uniswap/v2-core/build/UniswapV2Factory.json'
const { RINKEBY_UNI_ROUTER02, RINKEBY_UNI_FACTORY } = constants.ADDRESSES

/**
 * @dev Gets signers from ethers.
 */
export const newWallets = async () => {
  const wallets = await ethers.getSigners()
  return wallets
}

/**
 * @dev Deploys a new ERC-20 token contract.
 * @param {*} signer An ethers js Signer object
 * @param {*} name The name for the ERC-20 token.
 * @param {*} symbol The symbol for the ERC-20 token.
 * @param {*} totalSupply The initial supply for the token.
 */
export const newERC20 = async (signer, name, symbol, totalSupply) => {
  const ERC20 = await deployContract(signer, TestERC20, [name, symbol, totalSupply], {
    gasLimit: 9500000,
  })
  return ERC20
}

/**
 * @dev Deploys a new WETH contract using the canonical-weth package.
 * @param {*} signer An ethers js Signer object.
 */
export const newWeth = async (signer) => {
  const weth = await deployContract(signer, Weth, [], {
    gasLimit: 9500000,
  })
  return weth
}

/**
 * @dev Deploys a test contract Flash.sol.
 * @param {*} signer
 * @param {*} optionToken The address of an Option contract
 */
export const newFlash = async (signer, optionToken) => {
  const flash = await deployContract(signer, Flash, [optionToken], {
    gasLimit: 9500000,
  })
  return flash
}

/**
 * @dev Deploys a Registry instance and initializes it with the correct factories.
 * @param signer A Signer object from ethers js.
 */
export const newRegistry = async (signer) => {
  const registry = await deployContract(signer, Registry, [], {
    gasLimit: 9500000,
  })
  let oLib = await deployContract(signer, OptionTemplateLib, [], {
    gasLimit: 9500000,
  })
  let opFacContract = Object.assign(OptionFactory, {
    evm: { bytecode: { object: OptionFactory.bytecode } },
  })
  link(opFacContract, OPTION_TEMPLATE_LIB, oLib.address)

  let optionFactory = await deployContract(signer, opFacContract, [registry.address], {
    gasLimit: 9500000,
  })
  let rLib = await deployContract(signer, RedeemTemplateLib, [], {
    gasLimit: 9500000,
  })

  let reFacContract = Object.assign(RedeemFactory, {
    evm: { bytecode: { object: RedeemFactory.bytecode } },
  })
  link(reFacContract, REDEEM_TEMPLATE_LIB, rLib.address)

  let redeemTokenFactory = await deployContract(signer, reFacContract, [registry.address], {
    gasLimit: 9500000,
  })
  await optionFactory.deployOptionTemplate()
  await redeemTokenFactory.deployRedeemTemplate()
  await registry.setOptionFactory(optionFactory.address)
  await registry.setRedeemFactory(redeemTokenFactory.address)
  return registry
}

/**
 * @dev Deploys new option and redeem factory instances and links the necessary libraries.
 * @param {*} signer
 * @param {*} registry The registry contract instance.
 */
export const newOptionFactory = async (signer, registry) => {
  let oLib = await deployContract(signer, OptionTemplateLib, [], {
    gasLimit: 9500000,
  })
  let opFacContract = Object.assign(OptionFactory, {
    evm: { bytecode: { object: OptionFactory.bytecode } },
  })
  link(opFacContract, OPTION_TEMPLATE_LIB, oLib.address)

  let optionFactory = await deployContract(signer, opFacContract, [registry.address], {
    gasLimit: 9500000,
  })
  let rLib = await deployContract(signer, RedeemTemplateLib, [], {
    gasLimit: 9500000,
  })

  let reFacContract = Object.assign(RedeemFactory, {
    evm: { bytecode: { object: RedeemFactory.bytecode } },
  })
  link(reFacContract, REDEEM_TEMPLATE_LIB, rLib.address)

  let redeemTokenFactory = await deployContract(signer, reFacContract, [registry.address], {
    gasLimit: 9500000,
  })
  await optionFactory.deployOptionTemplate()
  await redeemTokenFactory.deployRedeemTemplate()
  await registry.setOptionFactory(optionFactory.address)
  await registry.setRedeemFactory(redeemTokenFactory.address)
  return optionFactory
}

/**
 * @dev Deploys a TestOption contract instance and returns it.
 * @param {*} signer
 * @param {*} underlyingToken The address of the underlying token.
 * @param {*} strikeToken The address of the strike token.
 * @param {*} base The quantity of underlying tokens per unit of quote strike tokens.
 * @param {*} quote The quantity of strike tokens per unit of base underlying tokens.
 * @param {*} expiry The unix timestamp for when the option token expires.
 */
export const newTestOption = async (signer, underlyingToken, strikeToken, base, quote, expiry) => {
  const optionToken = await deployContract(signer, OptionTest, [], {
    gasLimit: 9500000,
  })
  await optionToken.initialize(underlyingToken, strikeToken, base, quote, expiry)
  return optionToken
}

/**
 *
 * @param {*} signer
 * @param {*} factory The address of the redeem factory contract.
 * @param {*} optionToken The address of the option token linked to the redeem token.
 * @param {*} underlying The address of the underlying token for the option token.
 */
export const newTestRedeem = async (signer, factory, optionToken) => {
  const redeemToken = await deployContract(signer, Redeem, [], {
    gasLimit: 9500000,
  })
  await redeemToken.initialize(factory, optionToken)
  return redeemToken
}

/**
 * @dev Deploys a new Trader contract instance.
 * @param {*} signer
 * @param {*} weth The address of WETH for the respective network.
 */
export const newTrader = async (signer, weth) => {
  const trader = await deployContract(signer, Trader, [weth], {
    gasLimit: 9500000,
  })
  return trader
}

/**
 * @dev Deploys a new Option contract instance through the Registry contract instance.
 * @param {*} signer
 * @param {*} registry The instance of the Registry contract.
 * @param {*} underlyingToken The address of the underlying token.
 * @param {*} strikeToken The address of the strike token.
 * @param {*} base The quantity of underlying tokens per unit of quote strike tokens.
 * @param {*} quote The quantity of strike tokens per unit of base underlying tokens.
 * @param {*} expiry The unix timestamp for when the option expires.
 */
export const newOption = async (signer, registry, underlyingToken, strikeToken, base, quote, expiry) => {
  await registry.verifyToken(underlyingToken)
  await registry.verifyToken(strikeToken)
  await registry.deployOption(underlyingToken, strikeToken, base, quote, expiry)
  let optionToken = new ethers.Contract(
    await registry.allOptionClones(((await registry.getAllOptionClonesLength()) - 1).toString()),
    Option.abi,
    signer
  )
  return optionToken
}

/**
 * @dev Gets the Redeem token contract instance by getting the address through the option token.
 * @param {*} signer
 * @param {*} optionToken The instance of the option token contract.
 */
export const newRedeem = async (signer, optionToken) => {
  let redeemTokenAddress = await optionToken.redeemToken()
  let redeemToken = new ethers.Contract(redeemTokenAddress, Redeem.abi, signer)
  return redeemToken
}

/**
 * @dev Deploys new Option and Redeem contract instances and returns them.
 * @param {*} signer
 * @param {*} registry The instance contract of the Registry.
 * @param {*} underlyingToken The instance contract for the underlying token.
 * @param {*} strikeToken The instance contract for the strike token.
 * @param {*} base The quantity of underlying tokens per unit of quote stike tokens.
 * @param {*} quote The quantity of strike tokens per unit of base underlying tokens.
 * @param {*} expiry The unix timestamp for when the option expires.
 */
export const newPrimitive = async (signer, registry, underlyingToken, strikeToken, base, quote, expiry) => {
  let optionToken = await newOption(signer, registry, underlyingToken.address, strikeToken.address, base, quote, expiry)
  let redeemToken = await newRedeem(signer, optionToken)

  const Primitive = {
    underlyingToken: underlyingToken,
    strikeToken: strikeToken,
    optionToken: optionToken,
    redeemToken: redeemToken,
  }
  return Primitive
}

/**
 * @dev A generalized function to update approval state for any ERC-20 token.
 * @param {*} token The contract instance of the token that should update its approval.
 * @param {*} signer The address which is approving.
 * @param {*} spender The address which should be approved.
 */
export const approveToken = async (token, signer, spender) => {
  await token.approve(spender, MILLION_ETHER, { from: signer })
}

export const newRouter = async (signer, params) => {
  const router = await deployContract(signer, PrimitiveRouter, params, {
    gasLimit: 9500000,
  })
  return router
}

export const newTestRouter = async (signer, params) => {
  const router = await deployContract(signer, PrimitiveRouterTest, params, {
    gasLimit: 9500000,
  })
  return router
}

export const newPrimitiveCore = async (signer, params) => {
  const core = await deployContract(signer, PrimitiveCore, params, {
    gasLimit: 9500000,
  })
  return core
}

export const newPrimitiveLiquidity = async (signer, params) => {
  const liquid = await deployContract(signer, PrimitiveLiquidity, params, {
    gasLimit: 9500000,
  })
  return liquid
}

export const newPrimitiveSwaps = async (signer, params) => {
  const swaps = await deployContract(signer, PrimitiveSwaps, params, {
    gasLimit: 9500000,
  })
  return swaps
}

/**
 * @dev Deploys a new Uniswap factory and router instance for testing.
 * @param {*} signer
 * @param {*} feeToSetter The address which receives fees from the uniswap contracts.
 * @param {*} WETH The address of WETH for the respective chain ID.
 */
export const newUniswap = async (signer, feeToSetter, WETH) => {
  const uniswapFactory = await deployContract(signer, UniswapV2Factory, [feeToSetter], {
    gasLimit: 9500000,
  })
  const uniswapRouter = await deployContract(signer, UniswapV2Router02, [uniswapFactory.address, WETH.address], {
    gasLimit: 9500000,
  })
  return { uniswapRouter, uniswapFactory }
}

/**
 * @dev Gets the contract instances for Uniswap's Router and Factory for Rinkeby.
 */
export const newUniswapRinkeby = async (signer) => {
  const uniswapRouter = new ethers.Contract(RINKEBY_UNI_ROUTER02, UniswapV2Router02.abi, signer)
  const uniswapFactory = new ethers.Contract(RINKEBY_UNI_FACTORY, UniswapV2Factory.abi, signer)
  return { uniswapRouter, uniswapFactory }
}
