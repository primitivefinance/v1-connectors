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
const { assertBNEqual, assertWithinError, verifyOptionInvariants, getTokenBalance } = utils
const { ONE_ETHER, MILLION_ETHER } = constants.VALUES
const { FAIL } = constants.ERR_CODES
import { deploy, deployTokens, deployWeth, tokenFromAddress } from './lib/erc20'
//import { Done } from '@material-ui/icons'
const { AddressZero } = ethers.constants
import { ecsign } from 'ethereumjs-util'

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
const addShortLiquidityWithETH = async (router: Contract, connector: Contract, args: any[], signer: SignerWithAddress) => {
  let params: any = connector.interface.encodeFunctionData('addShortLiquidityWithETH', args)
  await expect(
    router.connect(signer).executeCall(connector, params, { value: BigNumber.from(args[1]).add(args[2]) })
  ).to.emit(connector, 'AddLiquidity')
}

const removeShortLiquidityThenCloseOptions = (connector: Contract, args: any[]) => {
  let params: any = connector.interface.encodeFunctionData('removeShortLiquidityThenCloseOptions', args)
  return params
}

const removeShortLiquidityThenCloseOptionsWithPermit = (connector: Contract, args: any[]) => {
  let params: any = connector.interface.encodeFunctionData('removeShortLiquidityThenCloseOptionsWithPermit', args)
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
  let wallet: Wallet
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
    connector = await deploy('PrimitiveLiquidity', {
      from: signers[0],
      args: [weth.address, primitiveRouter.address, uniswapFactory.address, uniswapRouter.address],
    })
    await primitiveRouter.init(connector.address, connector.address, connector.address)
    await primitiveRouter.validateOption(optionToken.address)

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

  describe('addShortLiquidityWithUnderlying()', function () {
    before(async function () {
      // Administrative contract instances
      registry = await setup.newRegistry(Admin)
      // Option and redeem instances
      Primitive = await setup.newPrimitive(Admin, registry, underlyingToken, strikeToken, base, quote, expiry)
      optionToken = Primitive.optionToken
      redeemToken = Primitive.redeemToken

      primitiveRouter = await deploy('PrimitiveRouter', { from: signers[0], args: [weth.address, registry.address] })
      connector = await deploy('PrimitiveLiquidity', {
        from: signers[0],
        args: [weth.address, primitiveRouter.address, uniswapFactory.address, uniswapRouter.address],
      })
      await primitiveRouter.init(connector.address, connector.address, connector.address)
      await primitiveRouter.validateOption(optionToken.address)

      // Approve all tokens and contracts
      await batchApproval(
        [trader.address, primitiveRouter.address, uniswapRouter.address],
        [underlyingToken, strikeToken, optionToken, redeemToken, teth, weth, dai],
        [Admin]
      )

      premium = 10

      // Create UNISWAP PAIRS
      const ratio = 1050
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
    })

    it('use underlyings to mint options, then provide short + underlying tokens as liquidity', async function () {
      let underlyingBalanceBefore = await underlyingToken.balanceOf(Alice)
      let redeemBalanceBefore = await redeemToken.balanceOf(Alice)
      let optionBalanceBefore = await optionToken.balanceOf(Alice)

      let optionAddress = optionToken.address
      let amountOptions = parseEther('0.1')
      let amountADesired = amountOptions.mul(quote).div(base) // amount of options to mint 1:100
      let amountBMin = 0
      let to = Alice

      let path = [redeemToken.address, underlyingToken.address]

      let [reserveA, reserveB] = await getReserves(Admin, uniswapFactory, path[0], path[1])
      reserves = [reserveA, reserveB]

      let amountBDesired = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1])
      let amountBOptimal = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1])
      let amountAOptimal = await uniswapRouter.quote(amountBDesired, reserves[1], reserves[0])

      ;[, amountBMin] = await _addLiquidity(
        uniswapRouter,
        reserves,
        amountADesired,
        amountBDesired,
        amountAOptimal,
        amountBOptimal
      )

      let params = await addShortLiquidityWithUnderlying(connector, [
        optionAddress,
        amountOptions,
        amountBDesired,
        amountBMin,
        to,
        deadline,
      ])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params))
        .to.emit(connector, 'AddLiquidity')
        .to.emit(primitiveRouter, 'Executed')

      let underlyingBalanceAfter = await underlyingToken.balanceOf(Alice)
      let redeemBalanceAfter = await redeemToken.balanceOf(Alice)
      let optionBalanceAfter = await optionToken.balanceOf(Alice)

      // Used underlyings to mint options (Alice)
      let underlyingChange = underlyingBalanceAfter.sub(underlyingBalanceBefore)
      // Sold options for quoteTokens to the pair, pair has more options (Pair)
      let optionChange = optionBalanceAfter.sub(optionBalanceBefore)
      let redeemChange = redeemBalanceAfter.sub(redeemBalanceBefore)

      const expectedUnderlyingChange = amountOptions.mul(quote).div(base).mul(reserveB).div(reserveA).add(amountOptions)

      assertBNEqual(optionChange.toString(), amountOptions) // kept options
      assertBNEqual(redeemChange.toString(), '0') // kept options
      assertBNEqual(underlyingChange, expectedUnderlyingChange.mul(-1))
    })

    it('should revert if amountBMin is greater than optimal amountB', async () => {
      // assume the pair has a ratio of redeem : teth of 100 : 1.
      // If we attempt to provide 100 short tokens, we need to imply a price ratio when we call the function.
      // If we imply a ratio that is less than 100 : 1, it should revert.

      let optionAddress = optionToken.address
      let amountOptions = parseEther('0.1')
      // skew the amountADesired ratio to be more, so the transaction reverts
      let amountADesired = amountOptions.mul(quote).div(base) // amount of options to mint 1:100
      let amountBMin = 0
      let to = Alice

      let path = [redeemToken.address, underlyingToken.address]

      let [reserveA, reserveB] = await getReserves(Admin, uniswapFactory, path[0], path[1])
      reserves = [reserveA, reserveB]

      let amountBDesired = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1])
      let amountBOptimal = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1])
      let amountAOptimal = await uniswapRouter.quote(amountBDesired, reserves[1], reserves[0])

      ;[, amountBMin] = await _addLiquidity(
        uniswapRouter,
        reserves,
        amountADesired,
        amountBDesired,
        amountAOptimal,
        amountBOptimal
      )

      let params = await addShortLiquidityWithUnderlying(connector, [
        optionAddress,
        amountOptions,
        amountBDesired.add(1),
        BigNumber.from(amountBMin).add(1),
        to,
        deadline,
      ])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params)).to.be.revertedWith(FAIL)

      /* await expect(
        primitiveRouter.addShortLiquidityWithUnderlying(
          optionAddress,
          amountOptions,
          amountBDesired.add(1),
          BigNumber.from(amountBMin).add(1),
          to,
          deadline
        )
      ).to.be.revertedWith('UniswapV2Router: INSUFFICIENT_B_AMOUNT') */
    })

    it('should revert if amountAMin is less than amountAOptimal', async () => {
      // assume the pair has a ratio of redeem : teth of 100 : 1.
      // If we attempt to provide 100 short tokens, we need to imply a ratio.
      // If we imply a ratio that is less than 100 : 1, it should revert.

      let optionAddress = optionToken.address
      let amountOptions = parseEther('0.1')
      let amountADesired = amountOptions.mul(quote).div(base) // amount of options to mint 1:100
      let amountBMin = 0
      let to = Alice

      let path = [redeemToken.address, underlyingToken.address]

      let [reserveA, reserveB] = await getReserves(Admin, uniswapFactory, path[0], path[1])
      reserves = [reserveA, reserveB]

      let amountBDesired = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1])
      let amountBOptimal = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1])
      let amountAOptimal = await uniswapRouter.quote(amountBDesired, reserves[1], reserves[0])

      ;[, amountBMin] = await _addLiquidity(
        uniswapRouter,
        reserves,
        amountADesired,
        amountBDesired,
        amountAOptimal,
        amountBOptimal
      )

      let params = await addShortLiquidityWithUnderlying(connector, [
        optionAddress,
        amountOptions,
        amountBDesired.sub(1),
        amountBMin,
        to,
        deadline,
      ])
      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params)).to.be.revertedWith(FAIL)

      /* await expect(
        primitiveRouter.addShortLiquidityWithUnderlying(
          optionAddress,
          amountOptions,
          amountBDesired.sub(1),
          amountBMin,
          to,
          deadline
        )
      ).to.be.revertedWith('UniswapV2Router: INSUFFICIENT_A_AMOUNT') */
    })
  })

  describe('addShortLiquidityWithUnderlyingWithPermit()', function () {
    before(async function () {
      const provider = waffle.provider
      ;[wallet] = provider.getWallets()
      // Administrative contract instances
      registry = await setup.newRegistry(Admin)
      // Option and redeem instances
      Primitive = await setup.newPrimitive(Admin, registry, underlyingToken, strikeToken, base, quote, expiry)
      optionToken = Primitive.optionToken
      redeemToken = Primitive.redeemToken

      primitiveRouter = await deploy('PrimitiveRouter', { from: Admin, args: [weth.address, registry.address] })
      connector = await deploy('PrimitiveLiquidity', {
        from: Admin,
        args: [weth.address, primitiveRouter.address, uniswapFactory.address, uniswapRouter.address],
      })
      await primitiveRouter.init(connector.address, connector.address, connector.address)
      await primitiveRouter.validateOption(optionToken.address)

      // Approve all tokens and contracts
      await batchApproval(
        [trader.address, primitiveRouter.address, uniswapRouter.address],
        [underlyingToken, strikeToken, optionToken, redeemToken, teth, weth, dai],
        [Admin]
      )

      premium = 10

      // Create UNISWAP PAIRS
      const ratio = 1050
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
    })

    it('use permitted underlyings to mint options, then provide short + underlying tokens as liquidity', async function () {
      let underlyingBalanceBefore = await underlyingToken.balanceOf(wallet.address)
      let redeemBalanceBefore = await redeemToken.balanceOf(wallet.address)
      let optionBalanceBefore = await optionToken.balanceOf(wallet.address)

      let optionAddress = optionToken.address
      let amountOptions = parseEther('0.1')
      let amountADesired = amountOptions.mul(quote).div(base) // amount of options to mint 1:100
      let amountBMin = 0
      let to = wallet.address

      let path = [redeemToken.address, underlyingToken.address]

      let [reserveA, reserveB] = await getReserves(Admin, uniswapFactory, path[0], path[1])
      reserves = [reserveA, reserveB]

      let amountBDesired = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1])
      let amountBOptimal = await uniswapRouter.quote(amountADesired, reserves[0], reserves[1])
      let amountAOptimal = await uniswapRouter.quote(amountBDesired, reserves[1], reserves[0])

      ;[, amountBMin] = await _addLiquidity(
        uniswapRouter,
        reserves,
        amountADesired,
        amountBDesired,
        amountAOptimal,
        amountBOptimal
      )

      const nonce = await underlyingToken.nonces(wallet.address)
      const digest = await utils.getApprovalDigest(
        underlyingToken,
        { owner: wallet.address, spender: primitiveRouter.address, value: amountOptions.add(amountBDesired) },
        nonce,
        BigNumber.from(deadline)
      )
      const { v, r, s } = ecsign(Buffer.from(digest.slice(2), 'hex'), Buffer.from(wallet.privateKey.slice(2), 'hex'))

      let params = await utils.getParams(connector, 'addShortLiquidityWithUnderlyingWithPermit', [
        optionAddress,
        amountOptions,
        amountBDesired,
        amountBMin,
        to,
        deadline,
        v,
        r,
        s,
      ])
      await expect(primitiveRouter.connect(wallet).executeCall(connector.address, params))
        .to.emit(connector, 'AddLiquidity')
        .to.emit(primitiveRouter, 'Executed')

      let underlyingBalanceAfter = await underlyingToken.balanceOf(wallet.address)
      let redeemBalanceAfter = await redeemToken.balanceOf(wallet.address)
      let optionBalanceAfter = await optionToken.balanceOf(wallet.address)

      // Used underlyings to mint options (wallet.address)
      let underlyingChange = underlyingBalanceAfter.sub(underlyingBalanceBefore)
      // Sold options for quoteTokens to the pair, pair has more options (Pair)
      let optionChange = optionBalanceAfter.sub(optionBalanceBefore)
      let redeemChange = redeemBalanceAfter.sub(redeemBalanceBefore)

      const expectedUnderlyingChange = amountOptions.mul(quote).div(base).mul(reserveB).div(reserveA).add(amountOptions)

      assertBNEqual(optionChange.toString(), amountOptions) // kept options
      assertBNEqual(redeemChange.toString(), '0') // kept options
      assertBNEqual(underlyingChange, expectedUnderlyingChange.mul(-1))
    })
  })

  describe('removeShortLiquidityThenCloseOptions()', function () {
    before(async () => {
      // Administrative contract instances
      registry = await setup.newRegistry(Admin)
      // Option and redeem instances
      Primitive = await setup.newPrimitive(Admin, registry, underlyingToken, strikeToken, base, quote, expiry)
      optionToken = Primitive.optionToken
      redeemToken = Primitive.redeemToken

      primitiveRouter = await deploy('PrimitiveRouter', { from: signers[0], args: [weth.address, registry.address] })
      connector = await deploy('PrimitiveLiquidity', {
        from: signers[0],
        args: [weth.address, primitiveRouter.address, uniswapFactory.address, uniswapRouter.address],
      })
      await primitiveRouter.init(connector.address, connector.address, connector.address)
      await primitiveRouter.validateOption(optionToken.address)

      // Approve all tokens and contracts
      await batchApproval(
        [trader.address, primitiveRouter.address, uniswapRouter.address],
        [underlyingToken, strikeToken, optionToken, redeemToken, teth, weth, dai],
        [Admin]
      )

      premium = 10

      // Create UNISWAP PAIRS
      const ratio = 1050
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
    })

    it('burns UNI-V2 lp shares, then closes the withdrawn shortTokens', async () => {
      let underlyingBalanceBefore = await underlyingToken.balanceOf(Alice)
      let quoteBalanceBefore = await quoteToken.balanceOf(Alice)
      let redeemBalanceBefore = await redeemToken.balanceOf(Alice)
      let optionBalanceBefore = await optionToken.balanceOf(Alice)

      let optionAddress = optionToken.address
      let liquidity = parseEther('0.1')
      let path = [redeemToken.address, teth.address]
      let pairAddress = await uniswapFactory.getPair(path[0], path[1])
      let pair = new ethers.Contract(pairAddress, UniswapV2Pair.abi, Admin)
      await pair.connect(Admin).approve(primitiveRouter.address, MILLION_ETHER)
      assert.equal((await pair.balanceOf(Alice)) >= liquidity, true, 'err not enough pair tokens')
      assert.equal(pairAddress != constants.ADDRESSES.ZERO_ADDRESS, true, 'err pair not deployed')

      let totalSupply = await pair.totalSupply()
      let amount0 = liquidity.mul(await redeemToken.balanceOf(pairAddress)).div(totalSupply)
      let amount1 = liquidity.mul(await teth.balanceOf(pairAddress)).div(totalSupply)

      let amountAMin = amount0
      let amountBMin = amount1
      let to = Alice

      let params = removeShortLiquidityThenCloseOptions(connector, [
        optionAddress,
        liquidity,
        amountAMin,
        amountBMin,
        to,
        deadline,
      ])

      await expect(primitiveRouter.connect(Admin).executeCall(connector.address, params))
        .to.emit(connector, 'RemoveLiquidity')
        .to.emit(primitiveRouter, 'Executed')

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

      assertBNEqual(underlyingChange.toString(), amountAMin.mul(base).div(quote).add(amountBMin))
      assertBNEqual(optionChange.toString(), amountAMin.mul(base).div(quote).mul(-1))
      assertBNEqual(quoteChange.toString(), '0')
      assert(redeemChange.gt(0) || redeemChange.isZero() == true, `Redeem change is not gt 0`)
    })
  })

  describe('removeShortLiquidityThenCloseOptionsWithPermit()', function () {
    before(async function () {
      const provider = waffle.provider
      ;[wallet] = provider.getWallets()
      // Administrative contract instances
      registry = await setup.newRegistry(Admin)
      // Option and redeem instances
      Primitive = await setup.newPrimitive(Admin, registry, underlyingToken, strikeToken, base, quote, expiry)
      optionToken = Primitive.optionToken
      redeemToken = Primitive.redeemToken

      primitiveRouter = await deploy('PrimitiveRouter', { from: Admin, args: [weth.address, registry.address] })
      connector = await deploy('PrimitiveLiquidity', {
        from: Admin,
        args: [weth.address, primitiveRouter.address, uniswapFactory.address, uniswapRouter.address],
      })
      await primitiveRouter.init(connector.address, connector.address, connector.address)
      await primitiveRouter.validateOption(optionToken.address)

      // Approve all tokens and contracts
      await batchApproval(
        [trader.address, primitiveRouter.address, uniswapRouter.address],
        [underlyingToken, strikeToken, optionToken, redeemToken, teth, weth, dai],
        [Admin]
      )

      premium = 10

      // Create UNISWAP PAIRS
      const ratio = 1050
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
    })

    it('use permitted underlyings to mint options, then provide short + underlying tokens as liquidity', async function () {
      let underlyingBalanceBefore = await underlyingToken.balanceOf(Alice)
      let quoteBalanceBefore = await quoteToken.balanceOf(Alice)
      let redeemBalanceBefore = await redeemToken.balanceOf(Alice)
      let optionBalanceBefore = await optionToken.balanceOf(Alice)

      let optionAddress = optionToken.address
      let liquidity = parseEther('0.1')
      let path = [redeemToken.address, teth.address]
      let pairAddress = await uniswapFactory.getPair(path[0], path[1])
      let pair = new ethers.Contract(pairAddress, UniswapV2Pair.abi, Admin)
      await pair.connect(Admin).approve(primitiveRouter.address, MILLION_ETHER)
      assert.equal((await pair.balanceOf(Alice)) >= liquidity, true, 'err not enough pair tokens')
      assert.equal(pairAddress != constants.ADDRESSES.ZERO_ADDRESS, true, 'err pair not deployed')

      let totalSupply = await pair.totalSupply()
      let amount0 = liquidity.mul(await redeemToken.balanceOf(pairAddress)).div(totalSupply)
      let amount1 = liquidity.mul(await teth.balanceOf(pairAddress)).div(totalSupply)

      let amountAMin = amount0
      let amountBMin = amount1
      let to = Alice

      const nonce = await pair.nonces(wallet.address)
      const digest = await utils.getApprovalDigest(
        pair,
        { owner: wallet.address, spender: primitiveRouter.address, value: liquidity },
        nonce,
        BigNumber.from(deadline)
      )
      const { v, r, s } = ecsign(Buffer.from(digest.slice(2), 'hex'), Buffer.from(wallet.privateKey.slice(2), 'hex'))

      let params = await utils.getParams(connector, 'removeShortLiquidityThenCloseOptionsWithPermit', [
        optionAddress,
        liquidity,
        amountAMin,
        amountBMin,
        to,
        deadline,
        v,
        r,
        s,
      ])
      await expect(primitiveRouter.connect(wallet).executeCall(connector.address, params))
        .to.emit(connector, 'RemoveLiquidity')
        .to.emit(primitiveRouter, 'Executed')

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

      assertBNEqual(underlyingChange.toString(), amountAMin.mul(base).div(quote).add(amountBMin))
      assertBNEqual(optionChange.toString(), amountAMin.mul(base).div(quote).mul(-1))
      assertBNEqual(quoteChange.toString(), '0')
      assert(redeemChange.gt(0) || redeemChange.isZero() == true, `Redeem change is not gt 0`)
    })
  })
})
