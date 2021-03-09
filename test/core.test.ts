import chai, { expect } from 'chai'
import { solidity, MockProvider } from 'ethereum-waffle'
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
import { ecsign } from 'ethereumjs-util'
const { assertWithinError, verifyOptionInvariants, getTokenBalance } = utils

const { ONE_ETHER, FIVE_ETHER, TEN_ETHER, THOUSAND_ETHER, MILLION_ETHER } = constants.VALUES

const { ERR_ZERO, ERR_BAL_STRIKE, ERR_NOT_EXPIRED, ERC20_TRANSFER_AMOUNT, FAIL } = constants.ERR_CODES
const { createFixtureLoader } = waffle
import { primitiveV1, OptionParameters, PrimitiveV1Fixture, Options } from './lib/fixtures'

/**
 * @notice  Mints ETH Call options using ETH.
 */
const safeMintWithETH = async (wallet: Wallet, inputUnderlyings: BigNumber, fixture: PrimitiveV1Fixture) => {
  const optionToken = fixture.options.callEth
  const redeemToken = fixture.options.scallEth
  const underlyingToken = fixture.weth
  const strikeToken = fixture.strikeToken
  let mintparams = fixture.core.interface.encodeFunctionData('safeMintWithETH', [optionToken.address])
  // Calculate the strike price of each unit of underlying token
  let outputRedeems = inputUnderlyings.mul(fixture.params.quote).div(fixture.params.base)

  // The balance of the user we are checking before and after is their ether balance.
  let underlyingBal = await wallet.getBalance()
  let optionBal = await getTokenBalance(optionToken, wallet.address)
  let redeemBal = await getTokenBalance(redeemToken, wallet.address)

  // Since the user is sending ethers, the change in their balance will need to incorporate gas costs.
  let gasUsed = (
    await fixture.router.estimateGas.executeCall(fixture.core.address, mintparams, {
      value: inputUnderlyings,
    })
  ).mul(await wallet.getGasPrice())

  // Call the mint function and check that the event was emitted.
  await expect(
    fixture.router.connect(wallet).executeCall(fixture.core.address, mintparams, {
      value: inputUnderlyings,
    })
  )
    .to.emit(fixture.core, 'Minted')
    .withArgs(wallet.address, optionToken.address, inputUnderlyings.toString(), outputRedeems.toString())

  let underlyingsChange = (await wallet.getBalance()).sub(underlyingBal).add(gasUsed)
  let optionsChange = (await getTokenBalance(optionToken, wallet.address)).sub(optionBal)
  let redeemsChange = (await getTokenBalance(redeemToken, wallet.address)).sub(redeemBal)

  assertWithinError(underlyingsChange, inputUnderlyings.mul(-1))
  assertWithinError(optionsChange, inputUnderlyings)
  assertWithinError(redeemsChange, outputRedeems)

  await verifyOptionInvariants(underlyingToken, strikeToken, optionToken, redeemToken)
}

/**
 * @notice  Exercises ETH Call options to receive ETH.
 */
const safeExerciseForETH = async (wallet: Wallet, inputUnderlyings: BigNumber, fixture: PrimitiveV1Fixture) => {
  const optionToken = fixture.options.callEth
  const redeemToken = fixture.options.scallEth
  const underlyingToken = fixture.weth
  const strikeToken = fixture.strikeToken
  const Admin = wallet
  const Alice = wallet.address
  let exParams = fixture.core.interface.encodeFunctionData('safeExerciseForETH', [optionToken.address, inputUnderlyings])
  // Options:Underlyings are always at a 1:1 ratio.
  let inputOptions = inputUnderlyings
  // Calculate the amount of strike tokens necessary to exercise
  let inputStrikes = inputUnderlyings.mul(fixture.params.quote).div(fixture.params.base)

  // The balance of the user we are checking before and after is their ether balance.
  let underlyingBal = await Admin.getBalance()
  let optionBal = await getTokenBalance(optionToken, Alice)
  let strikeBal = await getTokenBalance(strikeToken, Alice)

  await expect(fixture.router.connect(Admin).executeCall(fixture.core.address, exParams))
    .to.emit(fixture.core, 'Exercised')
    .withArgs(Alice, optionToken.address, inputUnderlyings.toString())

  let underlyingsChange = (await Admin.getBalance()).sub(underlyingBal)
  let optionsChange = (await getTokenBalance(optionToken, Alice)).sub(optionBal)
  let strikesChange = (await getTokenBalance(strikeToken, Alice)).sub(strikeBal)

  assertWithinError(underlyingsChange, inputUnderlyings)
  assertWithinError(optionsChange, inputOptions.mul(-1))
  assertWithinError(strikesChange, inputStrikes.mul(-1))

  await verifyOptionInvariants(underlyingToken, strikeToken, optionToken, redeemToken)
}

/**
 * @notice  Redeems ETH put options for ETH.
 */
const safeRedeemForETH = async (wallet: Wallet, inputRedeems: BigNumber, fixture: PrimitiveV1Fixture) => {
  const optionToken = fixture.options.putEth
  const redeemToken = fixture.options.sputEth
  const underlyingToken = fixture.underlyingToken
  const strikeToken = fixture.weth
  const Admin = wallet
  const Alice = wallet.address
  let redeemParams = fixture.core.interface.encodeFunctionData('safeRedeemForETH', [optionToken.address, inputRedeems])
  let outputStrikes = inputRedeems

  let redeemBal = await getTokenBalance(redeemToken, Alice)
  // The balance of the user we are checking before and after is their ether balance.
  let strikeBal = await Admin.getBalance()

  await expect(fixture.router.connect(Admin).executeCall(fixture.core.address, redeemParams))
    .to.emit(fixture.core, 'Redeemed')
    .withArgs(Alice, optionToken.address, inputRedeems.toString())

  let redeemsChange = (await getTokenBalance(redeemToken, Alice)).sub(redeemBal)
  let strikesChange = (await Admin.getBalance()).sub(strikeBal)

  assertWithinError(redeemsChange, inputRedeems.mul(-1))
  assertWithinError(strikesChange, outputStrikes)

  await verifyOptionInvariants(underlyingToken, strikeToken, optionToken, redeemToken)
}

/**
 * @notice  Closes ETH call options for ETH.
 */
const safeCloseForETH = async (wallet: Wallet, inputOptions: BigNumber, fixture: PrimitiveV1Fixture) => {
  const optionToken = fixture.options.callEth
  const redeemToken = fixture.options.scallEth
  const underlyingToken = fixture.weth
  const strikeToken = fixture.strikeToken
  const Admin = wallet
  const Alice = wallet.address
  let closeParams = fixture.core.interface.encodeFunctionData('safeCloseForETH', [optionToken.address, inputOptions])
  let inputRedeems = inputOptions.mul(fixture.params.quote).div(fixture.params.base)

  // The balance of the user we are checking before and after is their ether balance.
  let underlyingBal = await Admin.getBalance()
  let optionBal = await getTokenBalance(optionToken, Alice)
  let redeemBal = await getTokenBalance(redeemToken, Alice)

  await expect(fixture.router.connect(Admin).executeCall(fixture.core.address, closeParams))
    .to.emit(fixture.core, 'Closed')
    .withArgs(Alice, optionToken.address, inputOptions.toString())

  let underlyingsChange = (await Admin.getBalance()).sub(underlyingBal)
  let optionsChange = (await getTokenBalance(optionToken, Alice)).sub(optionBal)
  let redeemsChange = (await getTokenBalance(redeemToken, Alice)).sub(redeemBal)

  assertWithinError(underlyingsChange, inputOptions)
  assertWithinError(optionsChange, inputOptions.mul(-1))
  assertWithinError(redeemsChange, inputRedeems.mul(-1))

  await verifyOptionInvariants(underlyingToken, strikeToken, optionToken, redeemToken)
}

/**
 * @notice  Exercises ETH puts using ETH.
 */
const safeExerciseWithETH = async (wallet: Wallet, inputUnderlyings: BigNumber, fixture: PrimitiveV1Fixture) => {
  const optionToken = fixture.options.putEth
  const redeemToken = fixture.options.sputEth
  const underlyingToken = fixture.dai
  const strikeToken = fixture.weth
  const Admin = wallet
  const Alice = wallet.address
  const base = fixture.params.quote // REVERSED SINCE PUT
  const quote = fixture.params.base // REVERSED SINCE PUT
  let exParams = fixture.core.interface.encodeFunctionData('safeExerciseWithETH', [optionToken.address])
  // Options:Underlyings are always at a 1:1 ratio.
  let inputOptions = inputUnderlyings
  // Calculate the amount of strike tokens necessary to exercise
  let inputStrikes = inputUnderlyings.mul(quote).div(base)

  // The balance of the user we are checking before and after is their ether balance.
  let underlyingBal = await Admin.getBalance()
  let optionBal = await getTokenBalance(optionToken, Alice)
  let strikeBal = await getTokenBalance(strikeToken, Alice)

  await expect(
    fixture.router.connect(Admin).executeCall(fixture.core.address, exParams, {
      value: inputStrikes,
    })
  )
    .to.emit(fixture.core, 'Exercised')
    .withArgs(Alice, optionToken.address, inputUnderlyings.toString())

  let underlyingsChange = (await Admin.getBalance()).sub(underlyingBal)
  let optionsChange = (await getTokenBalance(optionToken, Alice)).sub(optionBal)
  let strikesChange = (await getTokenBalance(strikeToken, Alice)).sub(strikeBal)

  assertWithinError(underlyingsChange, inputStrikes.mul(-1))
  assertWithinError(optionsChange, inputOptions.mul(-1))
  assertWithinError(strikesChange, parseEther('0'))
  await verifyOptionInvariants(underlyingToken, strikeToken, optionToken, redeemToken)
}

describe('PrimitiveCore', function () {
  let weth: Contract
  let router: Contract, connector: Contract
  let Admin: Wallet, User: Wallet, Bob: string
  let Alice: string
  let tokens: Contract[], comp: Contract, dai: Contract
  let core: Contract
  let underlyingToken, strikeToken, base, quote, expiry
  let factory: Contract, registry: Contract
  let Primitive: any
  let optionToken: Contract, redeemToken: Contract
  let wallet: Wallet, wallet1: Wallet, fixture: PrimitiveV1Fixture, options: Options, params: OptionParameters
  let trader: Contract, fnParams

  const deadline = Math.floor(Date.now() / 1000) + 60 * 20

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
    underlyingToken = fixture.underlyingToken
    dai = fixture.dai
  })

  describe('safeMintWithETH', () => {
    it('should revert if amount is 0', async () => {
      const option: Contract = options.callEth
      fnParams = connector.interface.encodeFunctionData('safeMintWithETH', [option.address])
      // Without sending any value, the transaction will revert due to the contract's nonZero modifier.
      await expect(router.executeCall(connector.address, fnParams)).to.be.revertedWith(FAIL)
    })

    it('should revert if option.address is an EOA', async () => {
      fnParams = connector.interface.encodeFunctionData('safeMintWithETH', [Alice])
      // Passing in the address of Alice for the option parameter will revert.
      await expect(router.executeCall(connector.address, fnParams, { value: 10 })).to.be.revertedWith(
        'Route: EXECUTION_FAIL'
      )
    })

    it('should revert if option.address is not a valid option contract', async () => {
      fnParams = connector.interface.encodeFunctionData('safeMintWithETH', [connector.address])
      // Passing in the address of Alice for the option parameter will revert.
      await expect(router.executeCall(connector.address, fnParams, { value: 10 })).to.be.revertedWith(
        'Route: EXECUTION_FAIL'
      )
    })

    it('should emit the mint event', async () => {
      const option: Contract = options.callEth
      fnParams = connector.interface.encodeFunctionData('safeMintWithETH', [option.address])
      let inputUnderlyings = parseEther('0.1')
      let outputRedeems = inputUnderlyings.mul(quote).div(base)
      await expect(
        router.executeCall(connector.address, fnParams, {
          value: inputUnderlyings,
        })
      )
        .to.emit(connector, 'Minted')
        .withArgs(Alice, option.address, inputUnderlyings.toString(), outputRedeems.toString())
    })

    it('should mint optionTokens and redeemTokens in correct amounts', async () => {
      // Use the function above to mint options, check emitted events, and check invariants.
      await safeMintWithETH(wallet, parseEther('0.1'), fixture)
    })

    it('should successfully call safe mint a few times in a row', async () => {
      // Make sure we can mint different values, multiple times in a row.
      await safeMintWithETH(wallet, parseEther('0.1'), fixture)
      await safeMintWithETH(wallet, parseEther('0.22'), fixture)
      await safeMintWithETH(wallet, parseEther('0.23526231124324'), fixture)
      await safeMintWithETH(wallet, parseEther('0.234345'), fixture)
    })
  })

  describe('safeExerciseForETH', () => {
    beforeEach(async () => {
      // Mint some options to the Alice address so the proceeding test can exercise them.
      await safeMintWithETH(wallet, parseEther('5'), fixture)
    })

    it('should revert if amount is 0', async () => {
      let option: Contract = options.callEth
      // If we pass in 0 as the exercise quantity, it will revert due to the contract's nonZero modifier.
      fnParams = connector.interface.encodeFunctionData('safeExerciseForETH', [option.address, '0'])
      await expect(router.executeCall(connector.address, fnParams)).to.be.revertedWith(FAIL)
    })

    it('should revert if option.address is a contract other than a legitimate option', async () => {
      fnParams = connector.interface.encodeFunctionData('safeExerciseForETH', [connector.address, parseEther('0.1')])
      await expect(router.executeCall(connector.address, fnParams)).to.be.revertedWith(FAIL)
    })

    it('should revert if user does not have enough option tokens', async () => {
      let option: Contract = options.callEth
      fnParams = connector.interface.encodeFunctionData('safeExerciseForETH', [option.address, MILLION_ETHER])
      // Fails early by checking the user's option balance against the quantity of options they wish to exercise.
      await expect(router.executeCall(connector.address, fnParams)).to.be.revertedWith(FAIL)
    })

    it('should revert if user does not have enough strike tokens', async () => {
      let option: Contract = options.callEth
      // Mint some option and redeem tokens to wallet1.address.
      await weth.approve(trader.address, MILLION_ETHER)
      await weth.deposit({ value: parseEther('0.1') })
      await trader.safeMint(option.address, parseEther('0.1'), wallet1.address)
      fnParams = connector.interface.encodeFunctionData('safeExerciseForETH', [option.address, parseEther('0.1')])
      // Send the strikeTokens that wallet1.address owns to Alice, so that wallet1.address has 0 strikeTokens.
      await strikeToken.connect(wallet1).transfer(Alice, await strikeToken.balanceOf(wallet1.address))
      // Attempting to exercise an option without having enough strikeTokens will cause a revert.
      await expect(router.connect(wallet1).executeCall(connector.address, fnParams)).to.be.revertedWith(FAIL)
    })

    it('should exercise consecutively', async () => {
      await strikeToken.mint(Alice, MILLION_ETHER)
      await safeExerciseForETH(wallet, parseEther('0.1'), fixture)
      await safeExerciseForETH(wallet, parseEther('0.32525'), fixture)
      await safeExerciseForETH(wallet, parseEther('0.442'), fixture)
    })
  })

  describe('safeCloseForETH', () => {
    beforeEach(async () => {
      // Mint some options to the Alice address so the proceeding test can exercise them.
      await safeMintWithETH(wallet, parseEther('1'), fixture)
    })

    it('should revert if amount is 0', async () => {
      let option: Contract = options.callEth
      fnParams = connector.interface.encodeFunctionData('safeCloseForETH', [option.address, 0])
      // Fails early if quantity of options to close is 0, because of the contract's nonZero modifier.
      await expect(router.executeCall(connector.address, fnParams)).to.be.revertedWith(FAIL)
    })

    it('should revert if user does not have enough redeemTokens', async () => {
      // Mint some option and redeem tokens to wallet1.address.
      let option: Contract = options.callEth
      let mintParams = connector.interface.encodeFunctionData('safeMintWithETH', [option.address])
      await router.connect(wallet1).executeCall(connector.address, mintParams, {
        value: ONE_ETHER,
      })

      // Send wallet1.address's redeemTokens to Alice, so that wallet1.address has 0 redeemTokens.
      await redeemToken.connect(wallet1).transfer(Alice, await redeemToken.balanceOf(wallet1.address))

      fnParams = connector.interface.encodeFunctionData('safeCloseForETH', [option.address, parseEther('0.1')])
      // Attempting to close options without enough redeemTokens will cause a revert.
      await expect(router.connect(wallet1).executeCall(connector.address, fnParams)).to.be.revertedWith(FAIL)
    })

    it('should revert if user does not have enough option tokens', async () => {
      // Mint some option and redeem tokens to wallet1.address.
      let option: Contract = options.callEth
      let mintParams = connector.interface.encodeFunctionData('safeMintWithETH', [option.address])
      await router.connect(wallet1).executeCall(connector.address, mintParams, {
        value: parseEther('0.1'),
      })

      // Send wallet1.address's optionTokens to Alice, so that wallet1.address has 0 optionTokens.
      await option.connect(wallet1).transfer(Alice, await option.balanceOf(wallet1.address))

      fnParams = connector.interface.encodeFunctionData('safeCloseForETH', [option.address, parseEther('0.1')])
      // Attempting to close a quantity of options that msg.sender does not have will cause a revert.
      await expect(router.connect(wallet1).executeCall(connector.address, fnParams)).to.be.revertedWith(FAIL)
    })

    it('should close consecutively', async () => {
      await safeMintWithETH(wallet, parseEther('1'), fixture)
      await safeCloseForETH(wallet, parseEther('0.1'), fixture)
      await safeCloseForETH(wallet, parseEther('0.25'), fixture)
      await safeCloseForETH(wallet, parseEther('0.5433451'), fixture)
    })
  })

  describe('full test', () => {
    it('should handle multiple transactions', async () => {
      // Start with 1000 options
      await safeMintWithETH(wallet, parseEther('1'), fixture)
      await safeCloseForETH(wallet, parseEther('0.1'), fixture)
      await safeCloseForETH(wallet, parseEther('0.1'), fixture)
      await safeExerciseForETH(wallet, parseEther('0.1'), fixture)
      await safeExerciseForETH(wallet, parseEther('0.1'), fixture)
      await safeExerciseForETH(wallet, parseEther('0.1'), fixture)
      await safeExerciseForETH(wallet, parseEther('0.1'), fixture)
      await safeCloseForETH(wallet, parseEther('0.2'), fixture)
      await safeCloseForETH(wallet, await fixture.options.callEth.balanceOf(Alice), fixture)

      // Assert option and redeem token balances are 0
      let optionBal = await fixture.options.callEth.balanceOf(Alice)

      assertWithinError(optionBal, 0)
    })
  })

  describe('safeRedeemForETH', () => {
    beforeEach(async () => {
      let option: Contract = options.putEth
      await dai.mint(Alice, parseEther('100'))
      await trader.safeMint(option.address, parseEther('100'), Alice)
    })
    it('should revert if amount is 0', async () => {
      let option: Contract = options.putEth
      fnParams = connector.interface.encodeFunctionData('safeRedeemForETH', [option.address, '0'])
      // Fails early if quantity input is 0, due to the contract's nonZero modifier.
      await expect(router.executeCall(connector.address, fnParams)).to.be.revertedWith(FAIL)
    })

    it('should revert if user does not have enough redeemToken tokens', async () => {
      let option: Contract = options.putEth
      fnParams = connector.interface.encodeFunctionData('safeRedeemForETH', [option.address, MILLION_ETHER])
      // Fails early if the user is attempting to redeem tokens that they don't have.
      await expect(router.executeCall(connector.address, fnParams)).to.be.revertedWith(FAIL)
    })

    it('should revert if contract does not have enough strike tokens', async () => {
      let option: Contract = options.putEth
      // If option tokens are not exercised, then no strikeTokens are stored in the option contract.
      // If no strikeTokens are stored in the contract, redeemTokens cannot be utilized until:
      // options are exercised, or become expired.
      fnParams = connector.interface.encodeFunctionData('safeRedeemForETH', [option.address, parseEther('0.1')])
      await expect(router.executeCall(connector.address, fnParams)).to.be.revertedWith(FAIL)
    })

    it('should redeem consecutively', async () => {
      let option: Contract = options.putEth
      let exParams = connector.interface.encodeFunctionData('safeExerciseWithETH', [option.address])
      await expect(router.executeCall(connector.address, exParams, { value: parseEther('1') })).to.emit(
        connector,
        'Exercised'
      )
      await safeRedeemForETH(wallet, parseEther('0.1'), fixture)
      await safeRedeemForETH(wallet, parseEther('0.32525'), fixture)
      await safeRedeemForETH(wallet, parseEther('0.5'), fixture)
    })
  })

  describe('safeExerciseWithETH', () => {
    beforeEach(async () => {
      let option: Contract = options.putEth
      await dai.mint(Alice, parseEther('100'))
      await trader.safeMint(option.address, parseEther('100'), Alice)
    })
    it('should revert if amount is 0', async () => {
      let option: Contract = options.putEth
      fnParams = connector.interface.encodeFunctionData('safeExerciseWithETH', [option.address])
      // Fails early if quantity input is 0, due to the contract's nonZero modifier.
      await expect(router.executeCall(connector.address, fnParams)).to.be.revertedWith(FAIL)
    })

    it('should exercise consecutively', async () => {
      await weth.deposit({ value: TEN_ETHER })
      await safeExerciseWithETH(wallet, parseEther('0.1'), fixture)
      await safeExerciseWithETH(wallet, parseEther('0.32525'), fixture)
      await safeExerciseWithETH(wallet, parseEther('0.1'), fixture)
    })
  })

  describe('safeMintWithPermit()', function () {
    it('use permitted underlyings to mint options, then provide short + underlying tokens as liquidity', async function () {
      let inputUnderlyings = parseEther('0.1')
      let outputRedeems = inputUnderlyings.mul(quote).div(base)
      const nonce = await underlyingToken.nonces(wallet.address)
      const digest = await utils.getApprovalDigest(
        underlyingToken,
        { owner: wallet.address, spender: router.address, value: inputUnderlyings },
        nonce,
        BigNumber.from(deadline)
      )
      const { v, r, s } = ecsign(Buffer.from(digest.slice(2), 'hex'), Buffer.from(wallet.privateKey.slice(2), 'hex'))

      let fnParams = await utils.getParams(connector, 'safeMintWithPermit', [
        optionToken.address,
        inputUnderlyings,
        deadline,
        v,
        r,
        s,
      ])
      await expect(router.connect(wallet).executeCall(connector.address, fnParams))
        .to.emit(connector, 'Minted')
        .withArgs(Alice, optionToken.address, inputUnderlyings, outputRedeems)
        .to.emit(router, 'Executed')
    })
  })
})
