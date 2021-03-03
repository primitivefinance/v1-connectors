import chai, { assert, expect } from 'chai'
import { solidity } from 'ethereum-waffle'
chai.use(solidity)
import * as utils from './lib/utils'
import * as setup from './lib/setup'
import constants from './lib/constants'
import { parseEther, formatEther } from 'ethers/lib/utils'
import UniswapV2Pair from '@uniswap/v2-core/build/UniswapV2Pair.json'
import batchApproval from './lib/batchApproval'
import { sortTokens } from './lib/utils'
import { BigNumber, Contract } from 'ethers'
import { ethers, waffle } from 'hardhat'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address'
const { assertBNEqual, assertWithinError, verifyOptionInvariants, getTokenBalance } = utils
const { ONE_ETHER, MILLION_ETHER } = constants.VALUES
const { FAIL } = constants.ERR_CODES
import { deploy, deployTokens, deployWeth, tokenFromAddress } from './lib/erc20'
import { Done } from '@material-ui/icons'
const { AddressZero } = ethers.constants

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

const addShortLiquidityWithUnderlying = (connector: Contract, args: any[]) => {
  let params: any = connector.interface.encodeFunctionData('addShortLiquidityWithUnderlying', args)
  return params
}

const addShortLiquidityWithUnderlyingWithPermit = async (
  router: Contract,
  connector: Contract,
  args: any[],
  signer: SignerWithAddress
) => {
  let params: any = connector.interface.encodeFunctionData('addShortLiquidityWithUnderlyingWithPermit', args)
  await expect(router.connect(signer).executeCall(connector, params)).to.emit(connector, 'AddLiquidity')
}
const addShortLiquidityWithETH = async (connector: Contract, args: any[]) => {
  let params: any = connector.interface.encodeFunctionData('addShortLiquidityWithETH', args)
  return params
}

const removeShortLiquidityThenCloseOptions = (connector: Contract, args: any[]) => {
  let params: any = connector.interface.encodeFunctionData('removeShortLiquidityThenCloseOptions', args)
  return params
}

const removeShortLiquidityThenCloseOptionsWithPermit = (connector: Contract, args: any[]) => {
  let params: any = connector.interface.encodeFunctionData('removeShortLiquidityThenCloseOptionsWithPermit', args)
  return params
}

const openFlashLong = (connector: Contract, args: any[]) => {
  let params: any = connector.interface.encodeFunctionData('openFlashLong', args)
  return params
}

const getParams = (connector: Contract, method: string, args: any[]) => {
  let params: any = connector.interface.encodeFunctionData(method, args)
  return params
}

describe('PrimitiveLiquidity', function () {
  // ACCOUNTS
  let Admin, User, Alice, Bob

  let trader, teth, dai, optionToken, redeemToken, quoteToken, weth
  let underlyingToken, strikeToken
  let base, quote, expiry
  let Primitive, registry
  let uniswapFactory: Contract, uniswapRouter: Contract, primitiveRouter
  let premium, assertInvariant, reserves, reserve0, reserve1
  let connector, tokens, signers
  // regular deadline
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20

  /* assertInvariant = async function () {
    if (typeof optionToken === 'undefined') {
      return
    }
    assertBNEqual(await optionToken.balanceOf(primitiveRouter.address), '0')
    assertBNEqual(await redeemToken.balanceOf(primitiveRouter.address), '0')
    assertBNEqual(await teth.balanceOf(primitiveRouter.address), '0')
    assertBNEqual(await dai.balanceOf(primitiveRouter.address), '0')
  } */

  before(async function () {
    signers = await ethers.getSigners()

    // Signers
    Admin = signers[0]
    User = signers[1]

    // Addresses of Signers
    Alice = Admin.address
    Bob = User.address

    // Underlying and quote token instances
    weth = await deployWeth(Admin)
    tokens = await deployTokens(Admin, 2, ['teth', 'dai'])
    ;[teth, dai] = tokens
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
    trader = await setup.newTrader(Admin, weth.address)

    // Uniswap Connector contract
    primitiveRouter = await deploy('PrimitiveRouter', { from: signers[0], args: [weth.address, registry.address] })
    connector = await deploy('PrimitiveSwaps', {
      from: signers[0],
      args: [weth.address, primitiveRouter.address, registry.address, uniswapFactory.address, uniswapRouter.address],
    })
    await primitiveRouter.init(connector.address, connector.address, connector.address)

    // Approve all tokens and contracts
    await batchApproval(
      [trader.address, primitiveRouter.address, uniswapRouter.address],
      [underlyingToken, strikeToken, optionToken, redeemToken, teth, weth, dai],
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

  describe('public variables', function () {
    it('getRouter()', async function () {
      assert.equal(await connector.getRouter(), uniswapRouter.address)
    })
    it('getFactory()', async function () {
      assert.equal(await connector.getFactory(), uniswapFactory.address)
    })
  })

  describe('uniswapV2Call', () => {
    it('uniswapV2Call()', async () => {
      await expect(primitiveRouter.uniswapV2Call(Alice, '0', '0', ['1'])).to.be.reverted
    })
  })

  describe('openFlashLong()', () => {
    before(async () => {
      // Administrative contract instances
      registry = await setup.newRegistry(Admin)
      // Option and redeem instances
      Primitive = await setup.newPrimitive(Admin, registry, underlyingToken, strikeToken, base, quote, expiry)
      optionToken = Primitive.optionToken
      redeemToken = Primitive.redeemToken

      primitiveRouter = await deploy('PrimitiveRouter', { from: signers[0], args: [weth.address, registry.address] })
      connector = await deploy('PrimitiveSwaps', {
        from: signers[0],
        args: [weth.address, primitiveRouter.address, registry.address, uniswapFactory.address, uniswapRouter.address],
      })
      await primitiveRouter.init(connector.address, connector.address, connector.address)

      // Approve all tokens and contracts
      await batchApproval(
        [trader.address, primitiveRouter.address, uniswapRouter.address],
        [underlyingToken, strikeToken, optionToken, redeemToken, teth, weth, dai],
        [Admin]
      )

      premium = 10

      // Create UNISWAP PAIRS
      const ratio = 1050
      /* const totalOptions = parseEther('20')
      const totalRedeemForPair = totalOptions.mul(quote).div(base).mul(ratio).div(1000) */
      const totalOptions = '75716450507480110972130'
      const totalRedeemForPair = '286685334476675940449501'
      await trader.safeMint(optionToken.address, totalOptions, Alice)
      await trader.safeMint(optionToken.address, parseEther('100000'), Alice)

      // Add liquidity to redeem <> teth pair
      await uniswapRouter.addLiquidity(
        redeemToken.address,
        teth.address,
        totalRedeemForPair,
        totalOptions,
        0,
        0,
        Alice,
        deadline
      )
    })

    it('gets a flash loan for underlyings, mints options, swaps redeem to underlyings to pay back', async () => {
      // Create a Uniswap V2 Pair and add liquidity.

      let underlyingBalanceBefore = await underlyingToken.balanceOf(Alice)
      let quoteBalanceBefore = await quoteToken.balanceOf(Alice)
      let redeemBalanceBefore = await redeemToken.balanceOf(Alice)
      let optionBalanceBefore = await optionToken.balanceOf(Alice)

      // Get the pair instance to approve it to the primitiveRouter
      let amountOptions = parseEther('0.1')
      let path = [redeemToken.address, underlyingToken.address]
      let reserves = await getReserves(Admin, uniswapFactory, path[0], path[1])
      let premium = getPremium(amountOptions, base, quote, redeemToken, underlyingToken, reserves[0], reserves[1])
      premium = premium.gt(0) ? premium : parseEther('0')

      let params = getParams(connector, 'openFlashLong', [optionToken.address, amountOptions, premium])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params))
        .to.emit(connector, 'Buy')
        .withArgs(Alice, optionToken.address, amountOptions, premium)
        .to.emit(primitiveRouter, 'Executed')
      /* await expect(primitiveRouter.openFlashLong(optionToken.address, amountOptions, premium))
        .to.emit(primitiveRouter, 'FlashOpened')
        .withArgs(primitiveRouter.address, amountOptions, premium) */

      let underlyingBalanceAfter = await underlyingToken.balanceOf(Alice)
      let quoteBalanceAfter = await quoteToken.balanceOf(Alice)
      let redeemBalanceAfter = await redeemToken.balanceOf(Alice)
      let optionBalanceAfter = await optionToken.balanceOf(Alice)

      // Used underlyings to mint options (Alice)
      let underlyingChange = underlyingBalanceAfter.sub(underlyingBalanceBefore)
      // Purchased quoteTokens with our options (Alice)
      let quoteChange = quoteBalanceAfter.sub(quoteBalanceBefore)
      // Sold options for quoteTokens to the pair, pair has more options (Pair)
      let optionChange = optionBalanceAfter.sub(optionBalanceBefore)
      let redeemChange = redeemBalanceAfter.sub(redeemBalanceBefore)

      assert.equal(
        underlyingChange.toString() <= amountOptions.mul(-1).add(premium),
        true,
        `${formatEther(underlyingChange)} ${formatEther(amountOptions)}`
      )
      assertBNEqual(optionChange.toString(), amountOptions)
      assertBNEqual(quoteChange.toString(), '0')
      assertBNEqual(redeemChange.toString(), '0')
    })

    it('should revert if actual premium is above max premium', async () => {
      // Get the pair instance to approve it to the primitiveRouter
      let amountOptions = parseEther('0.1')
      let path = [redeemToken.address, underlyingToken.address]
      let reserves = await getReserves(Admin, uniswapFactory, path[0], path[1])
      let maxPremium = getPremium(amountOptions, base, quote, redeemToken, underlyingToken, reserves[0], reserves[1])
      maxPremium = maxPremium.gt(0) ? maxPremium : parseEther('0')
      let params = getParams(connector, 'openFlashLong', [optionToken.address, amountOptions, maxPremium.sub(1)])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params)).to.be.revertedWith(FAIL)
      /* await expect(primitiveRouter.openFlashLong(optionToken.address, amountOptions, maxPremium.sub(1))).to.be.revertedWith(
        'ERR_UNISWAPV2_CALL_FAIL'
      ) */
    })

    it('should do a normal flash close', async () => {
      // Get the pair instance to approve it to the primitiveRouter
      let amountRedeems = parseEther('0.1')
      let params = getParams(connector, 'closeFlashLong', [optionToken.address, amountRedeems, '1'])
      let closePremium = await connector.getClosePremium(optionToken.address, amountRedeems)
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params))
        .to.emit(connector, 'Sell')
        .withArgs(Alice, optionToken.address, amountRedeems, closePremium)
        .to.emit(primitiveRouter, 'Executed')
      /* await expect(primitiveRouter.closeFlashLong(optionToken.address, amountRedeems, '1')).to.emit(
        primitiveRouter,
        'FlashClosed'
      ) */
    })

    it('should revert with premium over max', async () => {
      // Get the pair instance to approve it to the primitiveRouter
      let amountRedeems = parseEther('0.1')
      let params = getParams(connector, 'closeFlashLong', [optionToken.address, amountRedeems, amountRedeems])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params)).to.be.revertedWith(FAIL)
      /*  await expect(primitiveRouter.closeFlashLong(optionToken.address, amountRedeems, amountRedeems)).to.be.revertedWith(
        'ERR_UNISWAPV2_CALL_FAIL'
      ) */
    })

    it('should revert flash loan quantity is zero', async () => {
      // Get the pair instance to approve it to the primitiveRouter
      let amountOptions = parseEther('0')
      let path = [redeemToken.address, underlyingToken.address]
      let reserves = await getReserves(Admin, uniswapFactory, path[0], path[1])
      let amountOutMin = getPremium(amountOptions, base, quote, redeemToken, underlyingToken, reserves[0], reserves[1])

      let params = getParams(connector, 'openFlashLong', [optionToken.address, amountOptions, amountOutMin.add(1)])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params)).to.be.revertedWith(FAIL)
      /* await expect(
        primitiveRouter.openFlashLong(optionToken.address, amountOptions, amountOutMin.add(1))
      ).to.be.revertedWith('INSUFFICIENT_OUTPUT_AMOUNT') */
    })
  })

  describe('closeFlashLong()', () => {
    before(async () => {
      // Administrative contract instances
      registry = await setup.newRegistry(Admin)
      // Option and redeem instances
      Primitive = await setup.newPrimitive(Admin, registry, underlyingToken, strikeToken, base, quote, expiry)
      optionToken = Primitive.optionToken
      redeemToken = Primitive.redeemToken

      primitiveRouter = await deploy('PrimitiveRouter', { from: signers[0], args: [weth.address, registry.address] })
      connector = await deploy('PrimitiveSwaps', {
        from: signers[0],
        args: [weth.address, primitiveRouter.address, registry.address, uniswapFactory.address, uniswapRouter.address],
      })
      await primitiveRouter.init(connector.address, connector.address, connector.address)

      // Approve all tokens and contracts
      await batchApproval(
        [trader.address, primitiveRouter.address, uniswapRouter.address],
        [underlyingToken, strikeToken, optionToken, redeemToken, teth, weth, dai],
        [Admin]
      )

      premium = 10

      // Create UNISWAP PAIRS
      const ratio = 950
      const totalOptions = parseEther('20')
      const totalRedeemForPair = totalOptions.mul(quote).div(base).mul(ratio).div(1000)
      await trader.safeMint(optionToken.address, totalOptions.add(parseEther('10')), Alice)

      // Add liquidity to redeem <> teth pair
      await uniswapRouter.addLiquidity(
        redeemToken.address,
        teth.address,
        totalRedeemForPair,
        totalOptions,
        0,
        0,
        Alice,
        deadline
      )

      let pair = new ethers.Contract(
        await uniswapFactory.getPair(underlyingToken.address, redeemToken.address),
        UniswapV2Pair.abi,
        Admin
      )
      reserves = await pair.getReserves()
      reserve0 = reserves._reserve0
      reserve1 = reserves._reserve1
    })

    it('should revert on flash close because it would cost the user a negative payout', async () => {
      // Get the pair instance to approve it to the primitiveRouter
      let amountRedeems = parseEther('0.1')
      let params = getParams(connector, 'closeFlashLong', [optionToken.address, amountRedeems, '1'])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params)).to.be.revertedWith(FAIL)
      /* await expect(primitiveRouter.closeFlashLong(optionToken.address, amountRedeems, '1')).to.be.revertedWith(
        'ERR_UNISWAPV2_CALL_FAIL'
      ) */
    })

    it('should flash close a long position at the expense of the user', async () => {
      // Get the pair instance to approve it to the primitiveRouter
      let underlyingBalanceBefore = await underlyingToken.balanceOf(Alice)
      let quoteBalanceBefore = await quoteToken.balanceOf(Alice)
      let redeemBalanceBefore = await redeemToken.balanceOf(Alice)
      let optionBalanceBefore = await optionToken.balanceOf(Alice)

      let amountRedeems = parseEther('0.01')
      let params = getParams(connector, 'closeFlashLong', [optionToken.address, amountRedeems, '0'])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params))
        .to.emit(connector, 'Sell')
        .withArgs(Alice, optionToken.address, amountRedeems, premium)
        .to.emit(primitiveRouter, 'Executed')
      /* await expect(primitiveRouter.closeFlashLong(optionToken.address, amountRedeems, '0')).to.emit(
        primitiveRouter,
        'FlashClosed'
      ) */

      let underlyingBalanceAfter = await underlyingToken.balanceOf(Alice)
      let quoteBalanceAfter = await quoteToken.balanceOf(Alice)
      let redeemBalanceAfter = await redeemToken.balanceOf(Alice)
      let optionBalanceAfter = await optionToken.balanceOf(Alice)

      // Used underlyings to mint options (Alice)
      let underlyingChange = underlyingBalanceAfter.sub(underlyingBalanceBefore)
      // Purchased quoteTokens with our options (Alice)
      let quoteChange = quoteBalanceAfter.sub(quoteBalanceBefore)
      // Sold options for quoteTokens to the pair, pair has more options (Pair)
      let optionChange = optionBalanceAfter.sub(optionBalanceBefore)
      let redeemChange = redeemBalanceAfter.sub(redeemBalanceBefore)

      assert.equal(underlyingChange.toString() <= '0', true, `${formatEther(underlyingChange)}`)
      assertBNEqual(optionChange.toString(), amountRedeems.mul(base).div(quote).mul(-1))
      assertBNEqual(quoteChange.toString(), '0')
      assertBNEqual(redeemChange.toString(), '0')
    })
  })

  describe('negative Premium handling()', () => {
    before(async () => {
      // Administrative contract instances
      registry = await setup.newRegistry(Admin)
      // Option and redeem instances
      Primitive = await setup.newPrimitive(Admin, registry, underlyingToken, strikeToken, base, quote, expiry)
      optionToken = Primitive.optionToken
      redeemToken = Primitive.redeemToken

      primitiveRouter = await deploy('PrimitiveRouter', { from: signers[0], args: [weth.address, registry.address] })
      connector = await deploy('PrimitiveSwaps', {
        from: signers[0],
        args: [weth.address, primitiveRouter.address, registry.address, uniswapFactory.address, uniswapRouter.address],
      })
      await primitiveRouter.init(connector.address, connector.address, connector.address)

      // Approve all tokens and contracts
      await batchApproval(
        [trader.address, primitiveRouter.address, uniswapRouter.address],
        [underlyingToken, strikeToken, optionToken, redeemToken, teth, weth, dai],
        [Admin]
      )

      premium = 10

      // Create UNISWAP PAIRS
      const ratio = 950
      const totalOptions = parseEther('20')
      const totalRedeemForPair = totalOptions.mul(quote).div(base).mul(ratio).div(1000)
      await trader.safeMint(optionToken.address, totalOptions.add(parseEther('10')), Alice)

      // Add liquidity to redeem <> teth pair
      await uniswapRouter.addLiquidity(
        redeemToken.address,
        teth.address,
        totalRedeemForPair,
        totalOptions,
        0,
        0,
        Alice,
        deadline
      )

      let pair = new ethers.Contract(
        await uniswapFactory.getPair(underlyingToken.address, redeemToken.address),
        UniswapV2Pair.abi,
        Admin
      )
      reserves = await pair.getReserves()
      reserve0 = reserves._reserve0
      reserve1 = reserves._reserve1
    })

    it('returns a loanRemainder amount of 0 in the event FlashOpened because negative premium', async () => {
      // Get the pair instance to approve it to the primitiveRouter
      let amountOptions = parseEther('0.01')
      let path = [redeemToken.address, underlyingToken.address]
      let reserves = await getReserves(Admin, uniswapFactory, path[0], path[1])
      let amountOutMin = getPremium(amountOptions, base, quote, redeemToken, underlyingToken, reserves[0], reserves[1])
      amountOutMin = amountOutMin.gt(0) ? amountOutMin : parseEther('0')
      let params = getParams(connector, 'openFlashLong', [optionToken.address, amountOptions, amountOutMin])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params))
        .to.emit(connector, 'Buy')
        .withArgs(Alice, optionToken.address, amountOptions, amountOutMin)
        .to.emit(primitiveRouter, 'Executed')
      /*  await expect(primitiveRouter.openFlashLong(optionToken.address, amountOptions, amountOutMin))
        .to.emit(primitiveRouter, 'FlashOpened')
        .withArgs(primitiveRouter.address, amountOptions, '0') */
    })
  })
})
