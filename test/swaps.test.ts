import chai, { assert, expect } from 'chai'
import { solidity, MockProvider } from 'ethereum-waffle'
chai.use(solidity)
import * as utils from './lib/utils'
import * as setup from './lib/setup'
import constants from './lib/constants'
import { parseEther, formatEther } from 'ethers/lib/utils'
import UniswapV2Pair from '@uniswap/v2-core/build/UniswapV2Pair.json'
import batchApproval from './lib/batchApproval'
import { sortTokens } from './lib/utils'
import { BigNumber, Contract, Wallet } from 'ethers'
import { ethers, waffle } from 'hardhat'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address'
import { ecsign } from 'ethereumjs-util'
const {
  assertBNEqual,
  assertWithinError,
  verifyOptionInvariants,
  getTokenBalance,
  applyFunction,
  subtract,
  balanceSnapshot,
  withinError,
} = utils
const { ONE_ETHER, MILLION_ETHER } = constants.VALUES
const { FAIL } = constants.ERR_CODES
import { deploy, deployTokens, deployWeth, tokenFromAddress } from './lib/erc20'
const { AddressZero } = ethers.constants
const { createFixtureLoader } = waffle
import { primitiveV1, OptionParameters, PrimitiveV1Fixture, Options } from './lib/fixtures'

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

const getParams = (connector: Contract, method: string, args: any[]) => {
  let params: any = connector.interface.encodeFunctionData(method, args)
  return params
}

const addLiquidity = async function (wallet: Wallet, fixture: PrimitiveV1Fixture, ratio: number) {
  const base = fixture.params.base
  const quote = fixture.params.quote
  const totalOptions = parseEther('20')
  await fixture.underlyingToken.connect(wallet).mint(wallet.address, totalOptions)
  await fixture.underlyingToken.connect(wallet).mint(wallet.address, totalOptions.mul(ratio).div(1000))
  await fixture.trader
    .connect(wallet)
    .safeMint(fixture.optionToken.address, totalOptions.mul(ratio).div(1000), wallet.address)
  const totalRedeemForPair = totalOptions.mul(quote).div(base).mul(ratio).div(1000)
  await fixture.uniswapRouter
    .connect(wallet)
    .addLiquidity(
      await fixture.optionToken.redeemToken(),
      fixture.underlyingToken.address,
      totalRedeemForPair,
      totalOptions,
      0,
      0,
      wallet.address,
      deadline
    )
}
const addLiquidityETH = async function (wallet: Wallet, fixture: PrimitiveV1Fixture, ratio: number) {
  const base = fixture.params.base
  const quote = fixture.params.quote
  const option = fixture.options.callEth
  const redeem = fixture.options.scallEth
  const underlying = fixture.weth
  const totalOptions = parseEther('20')
  await underlying.connect(wallet).deposit({ value: totalOptions })
  await underlying.connect(wallet).deposit({ value: totalOptions.mul(ratio).div(1000) })
  await fixture.trader.connect(wallet).safeMint(option.address, totalOptions.mul(ratio).div(1000), wallet.address)
  const totalRedeemForPair = totalOptions.mul(quote).div(base).mul(ratio).div(1000)
  let pair: string = await fixture.uniswapFactory.getPair(redeem.address, underlying.address)
  if (pair !== AddressZero) return true
  await fixture.uniswapRouter
    .connect(wallet)
    .addLiquidity(redeem.address, underlying.address, totalRedeemForPair, totalOptions, 0, 0, wallet.address, deadline)
}

const addLiquidityDAI = async function (wallet: Wallet, fixture: PrimitiveV1Fixture, ratio: number) {
  const base = fixture.params.quote
  const quote = fixture.params.base
  const option = fixture.options.putEth
  const redeem = fixture.options.sputEth
  const underlying = fixture.dai
  const totalOptions = parseEther('20')
  await underlying.connect(wallet).mint(wallet.address, totalOptions)
  await underlying.connect(wallet).mint(wallet.address, totalOptions.mul(ratio).div(1000))
  await fixture.trader.connect(wallet).safeMint(option.address, totalOptions.mul(ratio).div(1000), wallet.address)
  const totalRedeemForPair = totalOptions.mul(quote).div(base).mul(ratio).div(1000)
  let pair: string = await fixture.uniswapFactory.getPair(redeem.address, underlying.address)
  if (pair !== AddressZero) return true
  await fixture.uniswapRouter
    .connect(wallet)
    .addLiquidity(redeem.address, underlying.address, totalRedeemForPair, totalOptions, 0, 0, wallet.address, deadline)
}
const deadline = Math.floor(Date.now() / 1000) + 60 * 20

describe('Swaps', function () {
  // ACCOUNTS
  let Admin, User, Alice, Bob

  let trader, teth, dai, optionToken, redeemToken, strikeToken, weth
  let underlyingToken
  let base, quote, expiry
  let Primitive, registry
  let uniswapFactory: Contract, uniswapRouter: Contract, primitiveRouter
  let premium, reserves, reserve0, reserve1
  let connector, tokens, signers
  let wallet: Wallet, wallet1: Wallet, fixture: PrimitiveV1Fixture
  let params: OptionParameters, options: Options
  // regular deadline

  const assertInvariant = async function () {
    assertBNEqual(await optionToken.balanceOf(primitiveRouter.address), '0')
    assertBNEqual(await redeemToken.balanceOf(primitiveRouter.address), '0')
    assertBNEqual(await strikeToken.balanceOf(primitiveRouter.address), '0')
    assertBNEqual(await underlyingToken.balanceOf(primitiveRouter.address), '0')
  }

  ;[wallet, wallet1] = waffle.provider.getWallets()
  const loadFixture = createFixtureLoader([wallet], waffle.provider)

  beforeEach(async function () {
    Admin = wallet
    User = wallet1
    Alice = Admin.address
    Bob = User.address

    fixture = await loadFixture(primitiveV1)
    weth = fixture.weth
    trader = fixture.trader
    params = fixture.params
    options = fixture.options
    base = fixture.params.base
    registry = fixture.registry
    quote = fixture.params.quote
    connector = fixture.swaps // swaps!!
    expiry = fixture.params.expiry
    primitiveRouter = fixture.router
    optionToken = fixture.optionToken
    redeemToken = fixture.redeemToken
    strikeToken = fixture.strikeToken
    uniswapRouter = fixture.uniswapRouter
    uniswapFactory = fixture.uniswapFactory
    underlyingToken = fixture.underlyingToken
    dai = fixture.dai
  })

  afterEach(async function () {
    await assertInvariant()
  })

  describe('public variables', function () {
    it('getRouter()', async function () {
      assert.equal(await connector.getRouter(), uniswapRouter.address)
    })
    it('getFactory()', async function () {
      assert.equal(await connector.getFactory(), uniswapFactory.address)
    })

    it('getOptionPair()', async function () {
      let optionPair = await connector.getOptionPair(optionToken.address)
      let actual = [
        await uniswapFactory.getPair(underlyingToken.address, redeemToken.address),
        underlyingToken.address,
        redeemToken.address,
      ]
      applyFunction(actual, optionPair, assert.equal)
    })
  })

  /* describe('uniswapV2Call', () => {
    it('uniswapV2Call()', async () => {
      let params = getParams(connector, 'uniswapV2Call', [Alice, '0', '0', ['1']])
      await expect(primitiveRouter.connect(Admin).executeCall(connector, params)).to.be.reverted
    })
  }) */

  describe('openFlashLong()', () => {
    beforeEach(async function () {
      await addLiquidity(wallet, fixture, 1050)
    })
    it('gets a flash loan for underlyings, mints options, swaps redeem to underlyings to pay back', async () => {
      let tokens: Contract[] = [underlyingToken, strikeToken, redeemToken, optionToken]
      let beforeBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)

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

      let afterBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)
      let deltaBalances: any[] = applyFunction(afterBalances, beforeBalances, subtract)
      applyFunction(deltaBalances, [premium.mul(-1), '0', '0', amountOptions], assertBNEqual)
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
    })

    it('should do a normal flash close', async () => {
      let amountRedeems = parseEther('0.1')
      let params = getParams(connector, 'closeFlashLong', [optionToken.address, amountRedeems, '1'])
      let [closePremium] = await connector.getClosePremium(optionToken.address, amountRedeems)
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params))
        .to.emit(connector, 'Sell')
        .withArgs(Alice, optionToken.address, amountRedeems, closePremium)
        .to.emit(primitiveRouter, 'Executed')
    })

    it('should revert with premium over max', async () => {
      let amountRedeems = parseEther('0.1')
      let params = getParams(connector, 'closeFlashLong', [optionToken.address, amountRedeems, amountRedeems])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params)).to.be.revertedWith(FAIL)
    })

    it('should revert flash loan quantity is zero', async () => {
      let amountOptions = parseEther('0')
      let path = [redeemToken.address, underlyingToken.address]
      let reserves = await getReserves(Admin, uniswapFactory, path[0], path[1])
      let amountOutMin = getPremium(amountOptions, base, quote, redeemToken, underlyingToken, reserves[0], reserves[1])
      let params = getParams(connector, 'openFlashLong', [optionToken.address, amountOptions, amountOutMin.add(1)])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params)).to.be.revertedWith(FAIL)
    })
  })

  describe('closeFlashLong()', () => {
    beforeEach(async function () {
      await addLiquidity(wallet, fixture, 950)
    })
    it('should revert on flash close because it would cost the user a negative payout', async () => {
      let amountRedeems = parseEther('0.1')
      let params = getParams(connector, 'closeFlashLong', [optionToken.address, amountRedeems, '1'])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params)).to.be.revertedWith(FAIL)
    })

    it('should flash close a long position at the expense of the user', async () => {
      let tokens: Contract[] = [underlyingToken, strikeToken, redeemToken, optionToken]
      let beforeBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)

      // Get the pair instance to approve it to the primitiveRouter
      let amountRedeems = parseEther('0.01')
      let path = [underlyingToken.address, redeemToken.address]
      let reserves = await getReserves(Admin, uniswapFactory, path[0], path[1])
      let [premium, negPremium] = await connector.getClosePremium(optionToken.address, amountRedeems)
      let params = getParams(connector, 'closeFlashLong', [optionToken.address, amountRedeems, '0'])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params))
        .to.emit(connector, 'Sell')
        .withArgs(Alice, optionToken.address, amountRedeems, premium)
        .to.emit(primitiveRouter, 'Executed')

      let afterBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)
      let deltaBalances: any[] = applyFunction(afterBalances, beforeBalances, subtract)
      applyFunction(deltaBalances, [negPremium.mul(-1), '0', '0', amountRedeems.mul(base).div(quote).mul(-1)], assertBNEqual)
    })
  })

  describe('openFlashLongWithPermit()', function () {
    beforeEach(async function () {
      await addLiquidity(wallet, fixture, 1050)
    })
    it('use permitted underlyings to buy options', async function () {
      await underlyingToken.mint(wallet.address, parseEther('0.1'))
      let tokens: Contract[] = [underlyingToken, strikeToken, redeemToken, optionToken]
      let beforeBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)

      // Get the pair instance to approve it to the primitiveRouter
      let amountOptions = parseEther('0.1')
      let path = [redeemToken.address, underlyingToken.address]
      let reserves = await getReserves(Admin, uniswapFactory, path[0], path[1])
      let premium = getPremium(amountOptions, base, quote, redeemToken, underlyingToken, reserves[0], reserves[1])
      premium = premium.gt(0) ? premium : parseEther('0')

      const nonce = await underlyingToken.nonces(wallet.address)
      const digest = await utils.getApprovalDigest(
        underlyingToken,
        { owner: wallet.address, spender: primitiveRouter.address, value: premium },
        nonce,
        BigNumber.from(deadline)
      )
      const { v, r, s } = ecsign(Buffer.from(digest.slice(2), 'hex'), Buffer.from(wallet.privateKey.slice(2), 'hex'))

      let params = getParams(connector, 'openFlashLongWithPermit', [
        optionToken.address,
        amountOptions,
        premium,
        deadline,
        v,
        r,
        s,
      ])
      await expect(primitiveRouter.connect(wallet).executeCall(connector.address, params))
        .to.emit(connector, 'Buy')
        .withArgs(wallet.address, optionToken.address, amountOptions, premium)
        .to.emit(primitiveRouter, 'Executed')

      let afterBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)
      let deltaBalances: any[] = applyFunction(afterBalances, beforeBalances, subtract)
      applyFunction(deltaBalances, [premium.mul(-1), '0', '0', amountOptions], assertBNEqual)
    })
  })

  describe('openFlashLongWithDAIPermit()', function () {
    beforeEach(async function () {
      await addLiquidityDAI(wallet, fixture, 1050)
    })
    it('use permitted DAI to buy options', async function () {
      const option: Contract = options.putEth
      const redeem: Contract = options.sputEth
      await dai.mint(wallet.address, parseEther('0.1'))
      let tokens: Contract[] = [dai, strikeToken, redeem, option]
      let beforeBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)

      // Get the pair instance to approve it to the primitiveRouter
      let amountOptions = parseEther('0.1')
      let path = [redeem.address, dai.address]
      let reserves = await getReserves(Admin, uniswapFactory, path[0], path[1])
      let premium = getPremium(amountOptions, params.quote, params.base, redeem, dai, reserves[0], reserves[1])
      premium = premium.gt(0) ? premium : parseEther('0')

      const nonce = await dai.nonces(wallet.address)
      const digest = await utils.getApprovalDigestDai(
        dai,
        { holder: wallet.address, spender: primitiveRouter.address, allowed: true },
        BigNumber.from(nonce),
        BigNumber.from(deadline)
      )
      const { v, r, s } = ecsign(Buffer.from(digest.slice(2), 'hex'), Buffer.from(wallet.privateKey.slice(2), 'hex'))

      let openParams = getParams(connector, 'openFlashLongWithDAIPermit', [
        option.address,
        amountOptions,
        premium,
        deadline,
        v,
        r,
        s,
      ])
      await expect(primitiveRouter.connect(wallet).executeCall(connector.address, openParams))
        .to.emit(connector, 'Buy')
        .withArgs(wallet.address, option.address, amountOptions, premium)
        .to.emit(primitiveRouter, 'Executed')

      let afterBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)
      let deltaBalances: any[] = applyFunction(afterBalances, beforeBalances, subtract)
      applyFunction(deltaBalances, [premium.mul(-1), '0', '0', amountOptions], assertBNEqual)
    })
  })

  describe('openFlashLongWithETH()', function () {
    beforeEach(async function () {
      await addLiquidityETH(wallet, fixture, 1050)
    })
    it('Use ETH to buy ETH call options', async function () {
      let option: Contract = options.callEth
      let redeem: Contract = options.scallEth
      let tokens: Contract[] = [weth, strikeToken, redeem, option]
      let beforeBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)
      let beforeEth: BigNumber[] = [await wallet.getBalance()]

      // Get the pair instance to approve it to the primitiveRouter
      let amountOptions = parseEther('0.1')
      let path = [redeem.address, weth.address]
      let reserves = await getReserves(Admin, uniswapFactory, path[0], path[1])
      let [premium] = await connector.getOpenPremium(option.address, amountOptions)
      premium = premium.gt(0) ? premium : parseEther('0')

      let params = getParams(connector, 'openFlashLongWithETH', [option.address, amountOptions])
      let gasUsed = (await primitiveRouter.estimateGas.executeCall(connector.address, params, { value: premium })).mul(
        await wallet.getGasPrice()
      )

      await expect(primitiveRouter.connect(wallet).executeCall(connector.address, params, { value: premium }))
        .to.emit(connector, 'Buy')
        .withArgs(wallet.address, option.address, amountOptions, premium)
        .to.emit(primitiveRouter, 'Executed')

      let afterBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)
      let deltaBalances: any[] = applyFunction(afterBalances, beforeBalances, subtract)
      let afterEth: BigNumber[] = [BigNumber.from(await wallet.getBalance())]
      let deltaEth: any[] = applyFunction(afterEth, beforeEth, subtract)
      applyFunction(deltaBalances, ['0', '0', '0', amountOptions], assertBNEqual)
      applyFunction(deltaEth, [premium.add(gasUsed).mul(-1)], withinError)
    })
  })

  describe('closeFlashLongForETH()', function () {
    beforeEach(async function () {
      await addLiquidityETH(wallet, fixture, 1050)
    })
    it('Close ETH call options for ETH', async function () {
      let option: Contract = options.callEth
      let redeem: Contract = options.scallEth
      let tokens: Contract[] = [weth, strikeToken, redeem, option]
      let beforeBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)
      let beforeEth: BigNumber[] = [await wallet.getBalance()]

      // Get the pair instance to approve it to the primitiveRouter
      let amountRedeems = parseEther('0.01')
      let path = [weth.address, redeem.address]
      let reserves = await getReserves(Admin, uniswapFactory, path[0], path[1])
      let [premium, negPremium] = await connector.getClosePremium(option.address, amountRedeems)

      let params = getParams(connector, 'closeFlashLongForETH', [option.address, amountRedeems, premium])
      let gasUsed = (await primitiveRouter.estimateGas.executeCall(connector.address, params)).mul(
        await wallet.getGasPrice()
      )
      await expect(primitiveRouter.connect(wallet).executeCall(connector.address, params))
        .to.emit(connector, 'Sell')
        .withArgs(Alice, option.address, amountRedeems, premium)
        .to.emit(primitiveRouter, 'Executed')

      let afterBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)
      let deltaBalances: any[] = applyFunction(afterBalances, beforeBalances, subtract)
      let afterEth: BigNumber[] = [await wallet.getBalance()]
      let deltaEth: any[] = applyFunction(afterEth, beforeEth, subtract)
      applyFunction(deltaBalances, ['0', '0', '0', amountRedeems.mul(base).div(quote).mul(-1)], assertBNEqual)
      applyFunction(deltaEth, [premium.sub(gasUsed)], withinError)
    })
  })

  describe('negative Premium handling()', () => {
    beforeEach(async () => {
      await addLiquidityETH(wallet, fixture, 950)
    })

    it('returns a loanRemainder amount of 0 in the event FlashOpened because negative premium', async () => {
      let option: Contract = options.callEth
      let redeem: Contract = options.scallEth
      let amountOptions = parseEther('0.01')
      let path = [redeem.address, weth.address]
      let reserves = await getReserves(Admin, uniswapFactory, path[0], path[1])
      let amountOutMin = getPremium(amountOptions, base, quote, redeem, weth, reserves[0], reserves[1])
      amountOutMin = amountOutMin.gt(0) ? amountOutMin : parseEther('0')
      let params = getParams(connector, 'openFlashLong', [option.address, amountOptions, amountOutMin])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params))
        .to.emit(connector, 'Buy')
        .withArgs(Alice, option.address, amountOptions, amountOutMin)
        .to.emit(primitiveRouter, 'Executed')
    })
  })
})
