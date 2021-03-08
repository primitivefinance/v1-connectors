import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address'
import chai, { expect } from 'chai'
import { solidity } from 'ethereum-waffle'
chai.use(solidity)
import { BigNumber, BigNumberish, Contract, Wallet } from 'ethers'
import { parseEther, formatEther } from 'ethers/lib/utils'
import { ethers, waffle } from 'hardhat'
import { deploy, deployTokens, deployWeth, batchApproval, tokenFromAddress } from './lib/erc20'
const { AddressZero } = ethers.constants

// Helper functions and constants
import * as utils from './lib/utils'
import * as setup from './lib/setup'
import constants from './lib/constants'
import { connect } from 'http2'
const { assertWithinError, verifyOptionInvariants, getTokenBalance } = utils

const { ONE_ETHER, FIVE_ETHER, TEN_ETHER, THOUSAND_ETHER, MILLION_ETHER } = constants.VALUES

const {
  ERR_ZERO,
  ERR_BAL_STRIKE,
  ERR_NOT_EXPIRED,
  ERC20_TRANSFER_AMOUNT,
  FAIL,
  ERR_PAUSED,
  ERR_OWNABLE,
} = constants.ERR_CODES
const { createFixtureLoader } = waffle
import { primitiveV1, OptionParameters, PrimitiveV1Fixture, Options } from './lib/fixtures'

describe('Connector', function () {
  let signers: SignerWithAddress[]
  let weth: Contract
  let router: Contract, connector: Contract, liquidity: Contract, swaps: Contract
  let Admin: Wallet, User: Wallet, Bob: string, trader: Contract
  let Alice: string
  let tokens: Contract[], comp: Contract, dai: Contract
  let core: Contract
  let underlyingToken, strikeToken, base, quote, expiry
  let factory: Contract, registry: Contract
  let Primitive: any
  let optionToken: Contract, redeemToken: Contract
  let uniswapRouter, uniswapFactory, value

  const deadline = Math.floor(Date.now() / 1000) + 60 * 20

  let wallet: Wallet, wallet1: Wallet, fixture: PrimitiveV1Fixture
  let params: OptionParameters, options: Options
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
    connector = fixture.connectorTest // connectorTest!!
    expiry = fixture.params.expiry
    router = fixture.router
    optionToken = fixture.optionToken
    redeemToken = fixture.redeemToken
    strikeToken = fixture.strikeToken
    uniswapRouter = fixture.uniswapRouter
    uniswapFactory = fixture.uniswapFactory
    underlyingToken = fixture.underlyingToken
    dai = fixture.dai
  })

  describe('main functions', () => {
    it('depositETH()', async () => {
      let beforeEth: BigNumber[] = [BigNumber.from(await wallet.getBalance())]
      params = utils.getParams(connector, 'depositETH', [])
      value = parseEther('0.1')
      await expect(router.executeCall(connector.address, params, { value: value }))
        .to.emit(router, 'Executed')
        .to.emit(connector, 'Log')
        .withArgs(wallet.address)
      let afterEth: BigNumber[] = [BigNumber.from(await wallet.getBalance())]
      let deltaEth: BigNumber[] = utils.applyFunction(afterEth, beforeEth, utils.subtract)
      utils.applyFunction(deltaEth, [value.mul(-1)], utils.withinError)
    })
    it('withdrawETH()', async () => {
      value = parseEther('0.1')
      await weth.deposit({ value: value })
      await weth.transfer(connector.address, value)
      let beforeEth: BigNumber[] = [BigNumber.from(await wallet.getBalance())]
      params = utils.getParams(connector, 'withdrawETH', [])
      await expect(router.executeCall(connector.address, params))
        .to.emit(router, 'Executed')
        .to.emit(connector, 'Log')
        .withArgs(wallet.address)
      let afterEth: BigNumber[] = [BigNumber.from(await wallet.getBalance())]
      let deltaEth: BigNumber[] = utils.applyFunction(afterEth, beforeEth, utils.subtract)
      utils.applyFunction(deltaEth, [value], utils.withinError)
    })

    it('transferFromCaller()', async () => {
      value = parseEther('0.1')
      let beforeEth: BigNumber[] = [BigNumber.from(await underlyingToken.balanceOf(wallet.address))]
      params = utils.getParams(connector, 'transferFromCaller', [underlyingToken.address, value])
      await expect(router.executeCall(connector.address, params))
        .to.emit(router, 'Executed')
        .to.emit(connector, 'Log')
        .withArgs(wallet.address)
      let afterEth: BigNumber[] = [BigNumber.from(await underlyingToken.balanceOf(wallet.address))]
      let deltaEth: BigNumber[] = utils.applyFunction(afterEth, beforeEth, utils.subtract)
      utils.applyFunction(deltaEth, [value.mul(-1)], utils.assertBNEqual)
    })

    it('transferToCaller()', async () => {
      value = parseEther('0.1')
      await underlyingToken.transfer(connector.address, value)
      let beforeEth: BigNumber[] = [BigNumber.from(await underlyingToken.balanceOf(wallet.address))]
      params = utils.getParams(connector, 'transferToCaller', [underlyingToken.address])
      await expect(router.executeCall(connector.address, params))
        .to.emit(router, 'Executed')
        .to.emit(connector, 'Log')
        .withArgs(wallet.address)
      let afterEth: BigNumber[] = [BigNumber.from(await underlyingToken.balanceOf(wallet.address))]
      let deltaEth: BigNumber[] = utils.applyFunction(afterEth, beforeEth, utils.subtract)
      utils.applyFunction(deltaEth, [value], utils.assertBNEqual)
    })
    it('transferFromCallerToReceiver()', async () => {
      value = parseEther('0.1')
      let beforeEth: BigNumber[] = [BigNumber.from(await underlyingToken.balanceOf(wallet.address))]
      params = utils.getParams(connector, 'transferFromCallerToReceiver', [underlyingToken.address, value, wallet1.address])
      await expect(router.executeCall(connector.address, params))
        .to.emit(router, 'Executed')
        .to.emit(connector, 'Log')
        .withArgs(wallet.address)
      let afterEth: BigNumber[] = [BigNumber.from(await underlyingToken.balanceOf(wallet.address))]
      let deltaEth: BigNumber[] = utils.applyFunction(afterEth, beforeEth, utils.subtract)
      utils.applyFunction(deltaEth, [value.mul(-1)], utils.assertBNEqual)
      utils.assertBNEqual(await underlyingToken.balanceOf(wallet1.address), value)
    })
    it('mintOptions()', async () => {
      value = parseEther('0.1')
      let beforeEth: BigNumber[] = await utils.balanceSnapshot(wallet, [underlyingToken, optionToken])
      params = utils.getParams(connector, 'mintOptions', [optionToken.address, value])
      await expect(router.executeCall(connector.address, params))
        .to.emit(router, 'Executed')
        .to.emit(connector, 'Log')
        .withArgs(wallet.address)
      let afterEth: BigNumber[] = await utils.balanceSnapshot(wallet, [underlyingToken, optionToken])
      let deltaEth: BigNumber[] = utils.applyFunction(afterEth, beforeEth, utils.subtract)
      utils.applyFunction(deltaEth, [value.mul(-1), '0'], utils.assertBNEqual)
      utils.assertBNEqual(await optionToken.balanceOf(connector.address), value)
    })
    it('mintOptionsToReceiver()', async () => {
      value = parseEther('0.1')
      let beforeEth: BigNumber[] = await utils.balanceSnapshot(wallet, [underlyingToken, optionToken])
      params = utils.getParams(connector, 'mintOptionsToReceiver', [optionToken.address, value, wallet1.address])
      await expect(router.executeCall(connector.address, params))
        .to.emit(router, 'Executed')
        .to.emit(connector, 'Log')
        .withArgs(wallet.address)
      let afterEth: BigNumber[] = await utils.balanceSnapshot(wallet, [underlyingToken, optionToken])
      let deltaEth: BigNumber[] = utils.applyFunction(afterEth, beforeEth, utils.subtract)
      utils.applyFunction(deltaEth, [value.mul(-1), '0'], utils.assertBNEqual)
      utils.assertBNEqual(await optionToken.balanceOf(wallet1.address), value)
    })
    it('mintOptionsFromCaller()', async () => {
      value = parseEther('0.1')
      let beforeEth: BigNumber[] = await utils.balanceSnapshot(wallet, [underlyingToken, optionToken])
      params = utils.getParams(connector, 'mintOptionsFromCaller', [optionToken.address, value])
      await expect(router.executeCall(connector.address, params))
        .to.emit(router, 'Executed')
        .to.emit(connector, 'Log')
        .withArgs(wallet.address)
      let afterEth: BigNumber[] = await utils.balanceSnapshot(wallet, [underlyingToken, optionToken])
      let deltaEth: BigNumber[] = utils.applyFunction(afterEth, beforeEth, utils.subtract)
      utils.applyFunction(deltaEth, [value.mul(-1), '0'], utils.assertBNEqual)
      utils.assertBNEqual(await optionToken.balanceOf(connector.address), value)
    })
    it('closeOptions()', async () => {
      value = parseEther('0.1')
      let short = parseEther('0.1').mul(quote).div(base)
      await underlyingToken.transfer(optionToken.address, value)
      await optionToken.mintOptions(wallet.address)
      let beforeEth: BigNumber[] = await utils.balanceSnapshot(wallet, [underlyingToken, optionToken])
      params = utils.getParams(connector, 'closeOptions', [optionToken.address, short])
      await expect(router.executeCall(connector.address, params))
        .to.emit(router, 'Executed')
        .to.emit(connector, 'Log')
        .withArgs(wallet.address)
      let afterEth: BigNumber[] = await utils.balanceSnapshot(wallet, [underlyingToken, optionToken])
      let deltaEth: BigNumber[] = utils.applyFunction(afterEth, beforeEth, utils.subtract)
      utils.applyFunction(deltaEth, ['0', value.mul(-1)], utils.assertBNEqual)
      utils.assertBNEqual(await underlyingToken.balanceOf(connector.address), value)
    })
    it('exerciseOptions()', async () => {
      value = parseEther('0.1')
      let short = parseEther('0.1').mul(quote).div(base)
      await underlyingToken.transfer(optionToken.address, value)
      await optionToken.mintOptions(wallet.address)
      let beforeEth: BigNumber[] = await utils.balanceSnapshot(wallet, [underlyingToken, optionToken])
      params = utils.getParams(connector, 'exerciseOptions', [optionToken.address, value, short])
      await expect(router.executeCall(connector.address, params))
        .to.emit(router, 'Executed')
        .to.emit(connector, 'Log')
        .withArgs(wallet.address)
      let afterEth: BigNumber[] = await utils.balanceSnapshot(wallet, [underlyingToken, optionToken])
      let deltaEth: BigNumber[] = utils.applyFunction(afterEth, beforeEth, utils.subtract)
      utils.applyFunction(deltaEth, [value, value.mul(-1)], utils.assertBNEqual)
    })
    it('redeemOptions()', async () => {
      value = parseEther('0.1').mul(quote).div(base)
      let short = parseEther('0.1').mul(quote).div(base)
      await underlyingToken.transfer(optionToken.address, value)
      await optionToken.mintOptions(wallet.address)
      await optionToken.transfer(optionToken.address, value)
      await strikeToken.transfer(optionToken.address, short)
      await optionToken.exerciseOptions(wallet.address, value, [])
      let beforeEth: BigNumber[] = await utils.balanceSnapshot(wallet, [underlyingToken, optionToken])
      params = utils.getParams(connector, 'redeemOptions', [optionToken.address, short])
      await expect(router.executeCall(connector.address, params))
        .to.emit(router, 'Executed')
        .to.emit(connector, 'Log')
        .withArgs(wallet.address)
      let afterEth: BigNumber[] = await utils.balanceSnapshot(wallet, [underlyingToken, optionToken])
      let deltaEth: BigNumber[] = utils.applyFunction(afterEth, beforeEth, utils.subtract)
      utils.applyFunction(deltaEth, ['0', '0'], utils.assertBNEqual)
    })
    it('transferBalanceToReceiver()', async () => {
      value = parseEther('0.1')
      await underlyingToken.transfer(connector.address, value)
      let beforeEth: BigNumber[] = await utils.balanceSnapshot(wallet, [underlyingToken, optionToken])
      params = utils.getParams(connector, 'transferBalanceToReceiver', [underlyingToken.address, wallet1.address])
      await expect(router.executeCall(connector.address, params))
        .to.emit(router, 'Executed')
        .to.emit(connector, 'Log')
        .withArgs(wallet.address)
      let afterEth: BigNumber[] = await utils.balanceSnapshot(wallet, [underlyingToken, optionToken])
      let deltaEth: BigNumber[] = utils.applyFunction(afterEth, beforeEth, utils.subtract)
      utils.applyFunction(deltaEth, ['0', '0'], utils.assertBNEqual)
      utils.assertBNEqual(await underlyingToken.balanceOf(wallet1.address), value)
    })
  })
})
