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

describe('Router', function () {
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
  let uniswapRouter, uniswapFactory

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
    connector = fixture.core // core!!
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

  describe('view functions', () => {
    it('getWeth()', async () => {
      expect(await router.getWeth()).to.eq(weth.address)
    })
    it('getCaller()', async () => {
      expect(await router.getCaller()).to.eq(AddressZero)
    })
    it('getRegistry()', async () => {
      expect(await router.getRegistry()).to.eq(registry.address)
    })
    it('getRegisteredOption() on registered option', async () => {
      expect(await router.getRegisteredOption(optionToken.address)).to.eq(true)
    })
    it('getRegisteredOption() on unregisteredOption', async () => {
      expect(await router.getRegisteredOption(Alice)).to.eq(false)
    })
    it('getRegisteredConnector() on registered connector', async () => {
      expect(await router.getRegisteredConnector(connector.address)).to.eq(true)
    })
    it('getRegisteredConnector() on unregistered connector', async () => {
      expect(await router.getRegisteredConnector(Alice)).to.eq(false)
    })
    it('apiVersion()', async () => {
      expect(await router.apiVersion()).to.eq('2.0.0')
    })
  })

  describe('halt', () => {
    it('halt()', async () => {
      await expect(router.halt()).to.emit(router, 'Paused')
    })
    it('halt() when already halted to unpause', async () => {
      await expect(router.halt()).to.emit(router, 'Paused')
      await expect(router.halt()).to.emit(router, 'Unpaused')
    })
    it('Router should be unusable when halted', async () => {
      let inputUnderlyings = parseEther('1')
      let mintparams = fixture.core.interface.encodeFunctionData('safeMintWithETH', [optionToken.address])
      await router.halt()

      await expect(
        router.executeCall(fixture.core.address, mintparams, {
          value: inputUnderlyings,
        })
      ).to.be.revertedWith(ERR_PAUSED)
    })

    it('Only deployer can halt', async () => {
      await expect(router.connect(wallet1).halt()).to.be.revertedWith(ERR_OWNABLE)
    })
  })

  describe('direct calling', () => {
    it('transferFromCaller() fails if called directly', async () => {
      await expect(router.transferFromCaller(Alice, '0')).to.be.revertedWith('Router: NOT_CONNECTOR')
    })
    it('transferFromCallerToReceiver() fails if called directly', async () => {
      await expect(router.transferFromCallerToReceiver(Alice, '0', Alice)).to.be.revertedWith('Router: NOT_CONNECTOR')
    })
  })
})
