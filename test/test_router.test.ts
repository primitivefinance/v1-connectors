import { assert, expect } from 'chai'
import chai from 'chai'
import { solidity } from 'ethereum-waffle'
chai.use(solidity)
import * as utils from './lib/utils'
import * as setup from './lib/setup'
import constants from './lib/constants'
import { parseEther, formatEther } from 'ethers/lib/utils'
import UniswapV2Pair from '@uniswap/v2-core/build/UniswapV2Pair.json'
import batchApproval from './lib/batchApproval'
import { sortTokens } from './lib/utils'
import { BigNumber } from 'ethers'
import { ethers, waffle } from 'hardhat'
const { assertBNEqual } = utils
const { ONE_ETHER, MILLION_ETHER } = constants.VALUES

const _addLiquidity = async (router, reserves, amountADesired, amountBDesired, amountAMin, amountBMin) => {
  let amountA, amountB
  let amountBOptimal = await router.quote(amountADesired, reserves[0], reserves[1])
  if (amountBOptimal <= amountBDesired) {
    assert.equal(amountBOptimal >= amountBMin, true, `${formatEther(amountBOptimal)} !>= ${formatEther(amountBMin)}`)
    ;[amountA, amountB] = [amountADesired, amountBOptimal]
  } else {
    let amountAOptimal = await router.quote(amountBDesired, reserves[1], reserves[0])

    assert.equal(amountAOptimal >= amountAMin, true, `${formatEther(amountAOptimal)} !>= ${formatEther(amountAMin)}`)
    ;[amountA, amountB] = [amountAOptimal, amountBDesired]
  }

  return [amountA, amountB]
}

const getReserves = async (signer, factory, tokenA, tokenB) => {
  let tokens = sortTokens(tokenA, tokenB)
  let token0 = tokens[0]
  let pair = new ethers.Contract(await factory.getPair(tokenA, tokenB), UniswapV2Pair.abi, signer)
  let [_reserve0, _reserve1] = await pair.getReserves()

  let reserves = tokenA == token0 ? [_reserve0, _reserve1] : [_reserve1, _reserve0]
  return reserves
}

const getAmountsOutPure = (amountIn, path, reserveIn, reserveOut) => {
  let amounts = [amountIn]
  for (let i = 0; i < path.length; i++) {
    amounts[i + 1] = getAmountOut(amounts[i], reserveIn, reserveOut)
  }

  return amounts
}

const getAmountOut = (amountIn, reserveIn, reserveOut) => {
  let amountInWithFee = amountIn.mul(997)
  let numerator = amountInWithFee.mul(reserveOut)
  let denominator = reserveIn.mul(1000).add(amountInWithFee)
  let amountOut = numerator.div(denominator)
  return amountOut
}

const getAmountsInPure = (amountOut, path, reserveIn, reserveOut) => {
  let amounts = ['', amountOut]
  for (let i = path.length - 1; i > 0; i--) {
    amounts[i - 1] = getAmountIn(amounts[i], reserveIn, reserveOut)
  }

  return amounts
}

const getAmountIn = (amountOut, reserveIn, reserveOut) => {
  let numerator = reserveIn.mul(amountOut).mul(1000)
  let denominator = reserveOut.sub(amountOut).mul(997)
  let amountIn = numerator.div(denominator).add(1)
  return amountIn
}

const getPremium = (quantityOptions, base, quote, redeemToken, underlyingToken, reserveIn, reserveOut) => {
  // PREMIUM MATH
  let redeemsMinted = quantityOptions.mul(quote).div(base)
  let path = [redeemToken.address, underlyingToken.address]
  let amountsIn = getAmountsInPure(quantityOptions, path, reserveIn, reserveOut)
  let redeemsRequired = amountsIn[0]
  let redeemCostRemaining = redeemsRequired.sub(redeemsMinted)
  // if redeemCost > 0
  let amountsOut = getAmountsOutPure(redeemCostRemaining, path, reserveIn, reserveOut)
  //let loanRemainder = amountsOut[1].mul(101101).add(amountsOut[1]).div(100000)
  let loanRemainder = amountsOut[1].mul(100000).add(amountsOut[1].mul(301)).div(100000)

  let premium = loanRemainder

  return premium
}

describe('PrimitiveRouter', () => {
  // ACCOUNTS
  let Admin, User, Alice, Bob

  let trader, teth, dai, optionToken, redeemToken, quoteToken, weth
  let underlyingToken, strikeToken
  let base, quote, expiry
  let Primitive, registry
  let uniswapFactory, uniswapRouter, primitiveRouter, primitiveLiquidity, primitiveCore, primitiveSwaps
  let premium, assertInvariant, reserves, reserve0, reserve1
  // regular deadline
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20

  assertInvariant = async () => {
    if (typeof optionToken === 'undefined') {
      return
    }
    assertBNEqual(await optionToken.balanceOf(primitiveRouter.address), '0')
    assertBNEqual(await redeemToken.balanceOf(primitiveRouter.address), '0')
    assertBNEqual(await teth.balanceOf(primitiveRouter.address), '0')
    assertBNEqual(await dai.balanceOf(primitiveRouter.address), '0')
  }

  afterEach(async () => {
    await assertInvariant()
  })

  before(async () => {
    let signers = await setup.newWallets()

    // Signers
    Admin = signers[0]
    User = signers[1]

    // Addresses of Signers
    Alice = Admin.address
    Bob = User.address

    // Underlying and quote token instances
    weth = await setup.newWeth(Admin)
    teth = await setup.newERC20(Admin, 'TEST ETH', 'TETH', MILLION_ETHER)
    dai = await setup.newERC20(Admin, 'TEST DAI', 'DAI', MILLION_ETHER)
    quoteToken = dai

    // Administrative contract instances
    registry = await setup.newRegistry(Admin)
    // Uniswap V2
    const uniswap = await setup.newUniswap(Admin, Alice, weth)
    uniswapFactory = uniswap.uniswapFactory
    uniswapRouter = uniswap.uniswapRouter
    await uniswapFactory.setFeeTo(Alice)

    // Option parameters
    underlyingToken = teth
    strikeToken = dai
    base = parseEther('1')
    quote = parseEther('3')
    expiry = '1690868800' // May 30, 2020, 8PM UTC

    // Option and redeem instances
    Primitive = await setup.newPrimitive(Admin, registry, underlyingToken, strikeToken, base, quote, expiry)
    optionToken = Primitive.optionToken
    redeemToken = Primitive.redeemToken

    // Trader Instance
    trader = await setup.newTrader(Admin, teth.address)

    // Uniswap Connector contract
    primitiveRouter = await setup.newTestRouter(Admin, [
      weth.address,
      uniswapRouter.address,
      uniswapFactory.address,
      registry.address,
    ])

    primitiveCore = await setup.newPrimitiveCore(
      Admin,
      [
        weth.address,
        primitiveRouter.address,
        registry.address
      ]
    )

    primitiveLiquidity = await setup.newPrimitiveLiquidity(
      Admin,
      [
        weth.address,
        primitiveRouter.address,
        registry.address
      ]
    )

    primitiveSwaps = await setup.newPrimitiveSwaps(
      Admin,
      [
        weth.address,
        primitiveRouter.address,
        registry.address
      ]
    )

    await primitiveRouter.init(primitiveCore.address, primitiveLiquidity.address, primitiveSwaps.address)

    // Approve all tokens and contracts
    await batchApproval(
      [trader.address, primitiveRouter.address, uniswapRouter.address],
      [underlyingToken, strikeToken, optionToken, redeemToken],
      [Admin]
    )

    // Create UNISWAP PAIRS
    // option <> dai: 1:10 ($10 option) 1,000 options and 10,000 dai (1,000 teth)
    // teth <> dai: 1:100 ($100 teth) 1,000 teth and 100,000 dai
    // redeem <> dai: 1:1 ($1 redeem) 100,000 redeems and 100,000 dai
    // redeem <> teth: 100:1 ($1 redeem) 100,000 redeems and 1,000 teth

    const totalOptions = parseEther('20')
    const totalDai = parseEther('2100')
    const totalRedeemForPair = totalOptions.mul(quote).div(base)
    premium = 10

    // MINT 2,010 WETH
    //await teth.deposit({ from: Alice, value: parseEther('50') })

    // MINT 1,000 OPTIONS
    await trader.safeMint(optionToken.address, totalOptions, Alice)

    // Mint some options for tests
    await trader.safeMint(optionToken.address, parseEther('0.1'), Alice)

    // MINT 210,000 DAI
    await dai.mint(Alice, totalDai)

    // Add liquidity to redeem <> teth pair
    await uniswapRouter.addLiquidity(
      redeemToken.address,
      teth.address,
      totalRedeemForPair,
      totalRedeemForPair.mul(base).div(quote),
      0,
      0,
      Alice,
      deadline
    )
  })

  describe('public variables', () => {
    it('router()', async () => {
      assert.equal(await primitiveRouter.router(), uniswapRouter.address)
    })
    it('factory()', async () => {
      assert.equal(await primitiveRouter.factory(), uniswapFactory.address)
    })
  })

  describe('uniswapV2Call', () => {
    it('uniswapV2Call()', async () => {
      await expect(primitiveRouter.uniswapV2Call(Alice, '0', '0', ['1'])).to.be.reverted
    })
  })
})
