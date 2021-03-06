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
const { createFixtureLoader } = waffle
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address'
const { assertBNEqual, assertWithinError, verifyOptionInvariants, getTokenBalance } = utils
const { ONE_ETHER, MILLION_ETHER } = constants.VALUES
const { FAIL } = constants.ERR_CODES
import { deploy, deployTokens, deployWeth, tokenFromAddress } from './lib/erc20'
const { AddressZero } = ethers.constants
import { ecsign } from 'ethereumjs-util'
import { primitiveV1, OptionParameters, PrimitiveV1Fixture } from './lib/fixtures'

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
  let amountsOut = getAmountsOutPure(redeemCostRemaining, path, reserveIn, reserveOut)
  let loanRemainder = amountsOut[1].mul(100000).add(amountsOut[1].mul(301)).div(100000)
  let premium = loanRemainder
  return premium
}

const addLiquidity = async function (wallet: Wallet, fixture: PrimitiveV1Fixture, ratio: number) {
  const base = fixture.params.base
  const quote = fixture.params.quote
  const totalOptions = parseEther('20')
  await fixture.underlyingToken.connect(wallet).mint(wallet.address, totalOptions)
  await fixture.underlyingToken.connect(wallet).mint(wallet.address, totalOptions)
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

const balanceSnapshot = async function (wallet: Wallet, tokens: Contract[], account?: string): Promise<BigNumber[]> {
  let balances: BigNumber[] = []
  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i]
    let bal = BigNumber.from(await token.balanceOf(account ? account : wallet.address))
    balances.push(bal)
  }
  return balances
}

const applyFunction = function (array1: any[], array2: any[], fn: any): any[] {
  let differences: any[] = []
  array1.map((item, i) => {
    let diff = fn(item, array2[i])
    differences.push(diff)
  })
  return differences
}

const subtract = function (item1: BigNumber, item2: BigNumber): BigNumber {
  return item1.sub(item2)
}

const getOptionAmount = function (amount: BigNumber, base: BigNumber, quote: BigNumber, reserves: BigNumber[]): BigNumber {
  const denominator: BigNumber = quote.mul(parseEther('1')).div(base).mul(reserves[1]).div(reserves[0]).add(parseEther('1'))
  const amountOptions = denominator.isZero()
    ? BigNumber.from(amount)
    : BigNumber.from(amount).mul(parseEther('1')).div(denominator)
  return amountOptions
}

const deadline = Math.floor(Date.now() / 1000) + 60 * 20
describe('PrimitiveLiquidity', function () {
  // ACCOUNTS
  let Admin, User, Alice, Bob

  let trader, optionToken, redeemToken, weth
  let underlyingToken, strikeToken
  let base, quote, expiry, params
  let registry
  let uniswapFactory: Contract, uniswapRouter: Contract, primitiveRouter
  let reserves
  let connector
  let wallet: Wallet, wallet1: Wallet

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

    const fixture = await loadFixture(primitiveV1)
    weth = fixture.weth
    trader = fixture.trader
    params = fixture.params
    dai = fixture.strikeToken
    base = fixture.params.base
    registry = fixture.registry
    quote = fixture.params.quote
    connector = fixture.liquidity
    expiry = fixture.params.expiry
    teth = fixture.underlyingToken
    primitiveRouter = fixture.router
    optionToken = fixture.optionToken
    redeemToken = fixture.redeemToken
    strikeToken = fixture.strikeToken
    uniswapRouter = fixture.uniswapRouter
    uniswapFactory = fixture.uniswapFactory
    underlyingToken = fixture.underlyingToken

    await addLiquidity(wallet, fixture, 1050)
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
  })

  describe('addShortLiquidityWithUnderlying()', function () {
    it('use underlyings to mint options, then provide short + underlying tokens as liquidity', async function () {
      let tokens: Contract[] = [underlyingToken, redeemToken, optionToken]
      let beforeBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)

      let path = [redeemToken.address, underlyingToken.address]
      let [reserveA, reserveB] = await getReserves(Admin, uniswapFactory, path[0], path[1])
      reserves = [reserveA, reserveB]

      const amount: BigNumber = parseEther('0.1') // Total deposit amount
      const amountOptions = getOptionAmount(amount, params.base, params.quote, reserves) // Amount of deposit used for option minting

      let amountADesired = amountOptions.mul(quote).div(base) // Quantity of short options provided as liquidity
      let amountBDesired = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1]) // Remaining underlying to deposit.

      let addParams = await utils.getParams(connector, 'addShortLiquidityWithUnderlying', [
        optionToken.address,
        amountOptions,
        amountBDesired,
        amountBDesired,
        Alice,
        deadline,
      ])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, addParams))
        .to.emit(connector, 'AddLiquidity')
        .to.emit(primitiveRouter, 'Executed')

      let afterBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)
      let deltaBalances: any[] = await applyFunction(afterBalances, beforeBalances, subtract)
      const expectedUnderlyingChange = amountADesired.mul(reserveB).div(reserveA).add(amountOptions)
      await applyFunction(deltaBalances, [expectedUnderlyingChange.mul(-1), '0', amountOptions], assertBNEqual)
    })

    it('should revert if amountBMin is greater than optimal amountB', async () => {
      let path = [redeemToken.address, underlyingToken.address]
      let [reserveA, reserveB] = await getReserves(Admin, uniswapFactory, path[0], path[1])
      reserves = [reserveA, reserveB]

      const amount: BigNumber = parseEther('0.1') // Total deposit amount
      const amountOptions = getOptionAmount(amount, params.base, params.quote, reserves) // Amount of deposit used for option minting

      let amountADesired = amountOptions.mul(quote).div(base) // Quantity of short options provided as liquidity
      let amountBDesired = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1]) // Remaining underlying to deposit.

      let addParams = await utils.getParams(connector, 'addShortLiquidityWithUnderlying', [
        optionToken.address,
        amountOptions,
        amountBDesired.add(1),
        amountBDesired.add(1),
        Alice,
        deadline,
      ])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, addParams)).to.be.revertedWith(FAIL)
    })

    it('should revert if amountAMin is less than amountAOptimal', async () => {
      let path = [redeemToken.address, underlyingToken.address]
      let [reserveA, reserveB] = await getReserves(Admin, uniswapFactory, path[0], path[1])
      reserves = [reserveA, reserveB]

      const amount: BigNumber = parseEther('0.1') // Total deposit amount
      const amountOptions = getOptionAmount(amount, params.base, params.quote, reserves) // Amount of deposit used for option minting

      let amountADesired = amountOptions.mul(quote).div(base) // Quantity of short options provided as liquidity
      let amountBDesired = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1]) // Remaining underlying to deposit.

      let addParams = await utils.getParams(connector, 'addShortLiquidityWithUnderlying', [
        optionToken.address,
        amountOptions,
        amountBDesired.sub(1),
        amountBDesired,
        Alice,
        deadline,
      ])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, addParams)).to.be.revertedWith(FAIL)
    })
  })

  describe('addShortLiquidityWithUnderlyingWithPermit()', function () {
    it('use permitted underlyings to mint options, then provide short + underlying tokens as liquidity', async function () {
      let tokens: Contract[] = [underlyingToken, redeemToken, optionToken]
      let beforeBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)

      let path = [redeemToken.address, underlyingToken.address]
      let [reserveA, reserveB] = await getReserves(Admin, uniswapFactory, path[0], path[1])
      reserves = [reserveA, reserveB]

      const amount: BigNumber = parseEther('0.1') // Total deposit amount
      const amountOptions = getOptionAmount(amount, params.base, params.quote, reserves) // Amount of deposit used for option minting

      let amountADesired = amountOptions.mul(quote).div(base) // Quantity of short options provided as liquidity
      let amountBDesired = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1]) // Remaining underlying to deposit.
      const nonce = await underlyingToken.nonces(wallet.address)
      const digest = await utils.getApprovalDigest(
        underlyingToken,
        { owner: wallet.address, spender: primitiveRouter.address, value: amountOptions.add(amountBDesired) },
        nonce,
        BigNumber.from(deadline)
      )
      const { v, r, s } = ecsign(Buffer.from(digest.slice(2), 'hex'), Buffer.from(wallet.privateKey.slice(2), 'hex'))

      let addParams = await utils.getParams(connector, 'addShortLiquidityWithUnderlyingWithPermit', [
        optionToken.address,
        amountOptions,
        amountBDesired,
        amountBDesired,
        Alice,
        deadline,
        v,
        r,
        s,
      ])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, addParams))
        .to.emit(connector, 'AddLiquidity')
        .to.emit(primitiveRouter, 'Executed')

      let afterBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)
      let deltaBalances: any[] = await applyFunction(afterBalances, beforeBalances, subtract)
      const expectedUnderlyingChange = amountADesired.mul(reserveB).div(reserveA).add(amountOptions)
      await applyFunction(deltaBalances, [expectedUnderlyingChange.mul(-1), '0', amountOptions], assertBNEqual)
    })
  })

  describe('removeShortLiquidityThenCloseOptions()', function () {
    it('burns UNI-V2 lp shares, then closes the withdrawn shortTokens', async () => {
      let tokens: Contract[] = [underlyingToken, strikeToken, redeemToken, optionToken]
      let beforeBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)

      let optionAddress = optionToken.address
      let liquidity = parseEther('0.1')
      let path = [redeemToken.address, underlyingToken.address]
      let pairAddress = await uniswapFactory.getPair(path[0], path[1])
      let pair = new ethers.Contract(pairAddress, UniswapV2Pair.abi, Admin)
      await pair.connect(Admin).approve(primitiveRouter.address, MILLION_ETHER)
      assert.equal((await pair.balanceOf(Alice)) >= liquidity, true, 'err not enough pair tokens')
      assert.equal(pairAddress != constants.ADDRESSES.ZERO_ADDRESS, true, 'err pair not deployed')

      let totalSupply = await pair.totalSupply()
      let amount0 = liquidity.mul(await redeemToken.balanceOf(pairAddress)).div(totalSupply)
      let amount1 = liquidity.mul(await underlyingToken.balanceOf(pairAddress)).div(totalSupply)

      let amountAMin = amount0
      let amountBMin = amount1

      let removeParams = await utils.getParams(connector, 'removeShortLiquidityThenCloseOptions', [
        optionAddress,
        liquidity,
        amountAMin,
        amountBMin,
        Alice,
        deadline,
      ])

      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, removeParams))
        .to.emit(connector, 'RemoveLiquidity')
        .to.emit(primitiveRouter, 'Executed')

      let afterBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)
      let deltaBalances: any[] = await applyFunction(afterBalances, beforeBalances, subtract)
      const expectedUnderlyingChange = amountAMin.mul(base).div(quote).add(amountBMin)
      await applyFunction(
        deltaBalances,
        [expectedUnderlyingChange, '0', '0', amountAMin.mul(base).div(quote).mul(-1)],
        assertBNEqual
      )
    })
  })

  describe('removeShortLiquidityThenCloseOptionsWithPermit()', function () {
    it('use permitted underlyings to mint options, then provide short + underlying tokens as liquidity', async function () {
      let tokens: Contract[] = [underlyingToken, strikeToken, redeemToken, optionToken]
      let beforeBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)

      let optionAddress = optionToken.address
      let liquidity = parseEther('0.1')
      let path = [redeemToken.address, underlyingToken.address]
      let pairAddress = await uniswapFactory.getPair(path[0], path[1])
      let pair = new ethers.Contract(pairAddress, UniswapV2Pair.abi, Admin)
      await pair.connect(Admin).approve(primitiveRouter.address, MILLION_ETHER)
      assert.equal((await pair.balanceOf(Alice)) >= liquidity, true, 'err not enough pair tokens')
      assert.equal(pairAddress != constants.ADDRESSES.ZERO_ADDRESS, true, 'err pair not deployed')

      let totalSupply = await pair.totalSupply()
      let amount0 = liquidity.mul(await redeemToken.balanceOf(pairAddress)).div(totalSupply)
      let amount1 = liquidity.mul(await underlyingToken.balanceOf(pairAddress)).div(totalSupply)

      let amountAMin = amount0
      let amountBMin = amount1

      const nonce = await pair.nonces(wallet.address)
      const digest = await utils.getApprovalDigest(
        pair,
        { owner: wallet.address, spender: primitiveRouter.address, value: liquidity },
        nonce,
        BigNumber.from(deadline)
      )
      const { v, r, s } = ecsign(Buffer.from(digest.slice(2), 'hex'), Buffer.from(wallet.privateKey.slice(2), 'hex'))

      let removeParams = await utils.getParams(connector, 'removeShortLiquidityThenCloseOptionsWithPermit', [
        optionAddress,
        liquidity,
        amountAMin,
        amountBMin,
        Alice,
        deadline,
        v,
        r,
        s,
      ])

      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, removeParams))
        .to.emit(connector, 'RemoveLiquidity')
        .to.emit(primitiveRouter, 'Executed')

      let afterBalances: BigNumber[] = await balanceSnapshot(wallet, tokens)
      let deltaBalances: any[] = await applyFunction(afterBalances, beforeBalances, subtract)
      const expectedUnderlyingChange = amountAMin.mul(base).div(quote).add(amountBMin)
      await applyFunction(
        deltaBalances,
        [expectedUnderlyingChange, '0', '0', amountAMin.mul(base).div(quote).mul(-1)],
        assertBNEqual
      )
    })
  })
})
