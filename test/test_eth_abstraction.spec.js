// Testing suite tools
const { assert, expect } = require('chai')
const chai = require('chai')
const { solidity } = require('ethereum-waffle')
chai.use(solidity)

// Convert to wei
const { parseEther } = require('ethers/lib/utils')

// Helper functions and constants
const utils = require('./lib/utils')
const setup = require('./lib/setup')
const constants = require('./lib/constants')
const { assertWithinError, verifyOptionInvariants, getTokenBalance } = utils

const { ONE_ETHER, FIVE_ETHER, TEN_ETHER, THOUSAND_ETHER, MILLION_ETHER } = constants.VALUES

const { ERR_ZERO, ERR_BAL_STRIKE, ERR_NOT_EXPIRED, ERC20_TRANSFER_AMOUNT } = constants.ERR_CODES

describe('PrimitiveRouter: Eth Abstraction', () => {
  // Accounts
  let Admin, User, Alice, Bob

  // Tokens
  let weth, dai, optionToken, redeemToken

  // Option Parameters
  let underlyingToken, strikeToken, base, quote, expiry

  // Periphery and Administrative contracts
  let registry, primitiveRouter

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
    dai = await setup.newERC20(Admin, 'TEST DAI', 'DAI', MILLION_ETHER)

    // Administrative contract instances
    registry = await setup.newRegistry(Admin)

    // Option Parameters
    underlyingToken = weth
    strikeToken = dai
    base = parseEther('200').toString()
    quote = parseEther('1').toString()
    expiry = '1690868800'

    // Option and Redeem token instances for parameters
    Primitive = await setup.newPrimitive(Admin, registry, underlyingToken, strikeToken, base, quote, expiry)

    // Long and short tokens
    optionToken = Primitive.optionToken
    redeemToken = Primitive.redeemToken

    // Router contract instance
    primitiveRouter = await setup.newTestRouter(Admin, [weth.address, weth.address, weth.address, registry.address])

    // Approve tokens for primitiveRouter to use
    await underlyingToken.approve(primitiveRouter.address, MILLION_ETHER)
    await strikeToken.approve(primitiveRouter.address, MILLION_ETHER)
    await optionToken.approve(primitiveRouter.address, MILLION_ETHER)
    await redeemToken.approve(primitiveRouter.address, MILLION_ETHER)
    await underlyingToken.connect(User).approve(primitiveRouter.address, MILLION_ETHER)
    await strikeToken.connect(User).approve(primitiveRouter.address, MILLION_ETHER)
    await optionToken.connect(User).approve(primitiveRouter.address, MILLION_ETHER)
    await redeemToken.connect(User).approve(primitiveRouter.address, MILLION_ETHER)
  })

  describe('Constructor', () => {
    it('should return the correct weth address', async () => {
      expect(await primitiveRouter.weth()).to.be.equal(weth.address)
    })
  })

  describe('safeMintWithETH', () => {
    safeMintWithETH = async (inputUnderlyings) => {
      // Calculate the strike price of each unit of underlying token
      let outputRedeems = inputUnderlyings.mul(quote).div(base)

      // The balance of the user we are checking before and after is their ether balance.
      let underlyingBal = await Admin.getBalance()
      let optionBal = await getTokenBalance(optionToken, Alice)
      let redeemBal = await getTokenBalance(redeemToken, Alice)

      // Since the user is sending ethers, the change in their balance will need to incorporate gas costs.
      let gasUsed = await Admin.estimateGas(
        primitiveRouter.safeMintWithETH(optionToken.address, Alice, {
          value: inputUnderlyings,
        })
      )

      // Call the mint function and check that the event was emitted.
      await expect(
        primitiveRouter.safeMintWithETH(optionToken.address, Alice, {
          value: inputUnderlyings,
        })
      )
        .to.emit(primitiveRouter, 'Minted')
        .withArgs(Alice, optionToken.address, inputUnderlyings.toString(), outputRedeems.toString())

      let underlyingsChange = (await Admin.getBalance()).sub(underlyingBal).add(gasUsed)
      let optionsChange = (await getTokenBalance(optionToken, Alice)).sub(optionBal)
      let redeemsChange = (await getTokenBalance(redeemToken, Alice)).sub(redeemBal)

      assertWithinError(underlyingsChange, inputUnderlyings.mul(-1))
      assertWithinError(optionsChange, inputUnderlyings)
      assertWithinError(redeemsChange, outputRedeems)

      await verifyOptionInvariants(underlyingToken, strikeToken, optionToken, redeemToken)
    }

    it('should revert if amount is 0', async () => {
      // Without sending any value, the transaction will revert due to the contract's nonZero modifier.
      await expect(primitiveRouter.safeMintWithETH(optionToken.address, Alice)).to.be.revertedWith(ERR_ZERO)
    })

    it('should revert if optionToken.address is not an option ', async () => {
      // Passing in the address of Alice for the optionToken parameter will revert.
      await expect(primitiveRouter.safeMintWithETH(Alice, Alice, { value: 10 })).to.be.reverted
    })

    it('should emit the mint event', async () => {
      let inputUnderlyings = parseEther('0.1')
      let outputRedeems = inputUnderlyings.mul(quote).div(base)
      await expect(
        primitiveRouter.safeMintWithETH(optionToken.address, Alice, {
          value: inputUnderlyings,
        })
      )
        .to.emit(primitiveRouter, 'Minted')
        .withArgs(Alice, optionToken.address, inputUnderlyings.toString(), outputRedeems.toString())
    })

    it('should mint optionTokens and redeemTokens in correct amounts', async () => {
      // Use the function above to mint options, check emitted events, and check invariants.
      await safeMintWithETH(parseEther('0.1'))
    })

    it('should successfully call safe mint a few times in a row', async () => {
      // Make sure we can mint different values, multiple times in a row.
      await safeMintWithETH(parseEther('0.1'))
      await safeMintWithETH(parseEther('0.22'))
      await safeMintWithETH(parseEther('0.23526231124324'))
      await safeMintWithETH(parseEther('0.234345'))
    })
  })

  describe('safeExerciseForETH', () => {
    beforeEach(async () => {
      // Mint some options to the Alice address so the proceeding test can exercise them.
      await safeMintWithETH(parseEther('5'))
    })

    safeExerciseForETH = async (inputUnderlyings) => {
      // Options:Underlyings are always at a 1:1 ratio.
      let inputOptions = inputUnderlyings
      // Calculate the amount of strike tokens necessary to exercise
      let inputStrikes = inputUnderlyings.mul(quote).div(base)

      // The balance of the user we are checking before and after is their ether balance.
      let underlyingBal = await Admin.getBalance()
      let optionBal = await getTokenBalance(optionToken, Alice)
      let strikeBal = await getTokenBalance(strikeToken, Alice)

      await expect(primitiveRouter.safeExerciseForETH(optionToken.address, inputUnderlyings, Alice))
        .to.emit(primitiveRouter, 'Exercised')
        .withArgs(Alice, optionToken.address, inputUnderlyings.toString())

      let underlyingsChange = (await Admin.getBalance()).sub(underlyingBal)
      let optionsChange = (await getTokenBalance(optionToken, Alice)).sub(optionBal)
      let strikesChange = (await getTokenBalance(strikeToken, Alice)).sub(strikeBal)

      assertWithinError(underlyingsChange, inputUnderlyings)
      assertWithinError(optionsChange, inputOptions.mul(-1))
      assertWithinError(strikesChange, inputStrikes.mul(-1))

      await verifyOptionInvariants(underlyingToken, strikeToken, optionToken, redeemToken)
    }

    it('should revert if amount is 0', async () => {
      // If we pass in 0 as the exercise quantity, it will revert due to the contract's nonZero modifier.
      await expect(primitiveRouter.safeExerciseForETH(optionToken.address, 0, Alice)).to.be.revertedWith(ERR_ZERO)
    })

    it('should revert if user does not have enough optionToken tokens', async () => {
      // Fails early by checking the user's optionToken balance against the quantity of options they wish to exercise.
      await expect(primitiveRouter.safeExerciseForETH(optionToken.address, MILLION_ETHER, Alice)).to.be.revertedWith(ERC20_TRANSFER_AMOUNT)
    })

    it('should revert if user does not have enough strike tokens', async () => {
      // Mint some option and redeem tokens to Bob.
      await primitiveRouter.safeMintWithETH(optionToken.address, Bob, {
        value: parseEther('0.1'),
      })

      // Send the strikeTokens that Bob owns to Alice, so that Bob has 0 strikeTokens.
      await strikeToken.connect(User).transfer(Alice, await strikeToken.balanceOf(Bob))
      // Attempting to exercise an option without having enough strikeTokens will cause a revert.
      await expect(primitiveRouter.connect(User).safeExerciseForETH(optionToken.address, parseEther('0.1'), Bob)).to.be.revertedWith(
        ERC20_TRANSFER_AMOUNT
      )
    })

    it('should exercise consecutively', async () => {
      await strikeToken.mint(Alice, TEN_ETHER)
      await safeExerciseForETH(parseEther('0.1'))
      await safeExerciseForETH(parseEther('0.32525'))
      await safeExerciseForETH(parseEther('0.442'))
    })
  })

  describe('safeCloseForETH', () => {
    beforeEach(async () => {
      // Mint some options to the Alice address so the proceeding test can exercise them.
      await safeMintWithETH(parseEther('1'))
    })

    safeCloseForETH = async (inputOptions) => {
      let inputRedeems = inputOptions.mul(quote).div(base)

      // The balance of the user we are checking before and after is their ether balance.
      let underlyingBal = await Admin.getBalance()
      let optionBal = await getTokenBalance(optionToken, Alice)
      let redeemBal = await getTokenBalance(redeemToken, Alice)

      await expect(primitiveRouter.safeCloseForETH(optionToken.address, inputOptions, Alice))
        .to.emit(primitiveRouter, 'Closed')
        .withArgs(Alice, optionToken.address, inputOptions.toString())

      let underlyingsChange = (await Admin.getBalance()).sub(underlyingBal)
      let optionsChange = (await getTokenBalance(optionToken, Alice)).sub(optionBal)
      let redeemsChange = (await getTokenBalance(redeemToken, Alice)).sub(redeemBal)

      assertWithinError(underlyingsChange, inputOptions)
      assertWithinError(optionsChange, inputOptions.mul(-1))
      assertWithinError(redeemsChange, inputRedeems.mul(-1))

      await verifyOptionInvariants(underlyingToken, strikeToken, optionToken, redeemToken)
    }

    it('should revert if amount is 0', async () => {
      // Fails early if quantity of options to close is 0, because of the contract's nonZero modifier.
      await expect(primitiveRouter.safeCloseForETH(optionToken.address, 0, Alice)).to.be.revertedWith(ERR_ZERO)
    })

    it('should revert if user does not have enough redeemTokens', async () => {
      // Mint some option and redeem tokens to Bob.
      await primitiveRouter.safeMintWithETH(optionToken.address, Bob, {
        value: ONE_ETHER,
      })

      // Send Bob's redeemTokens to Alice, so that Bob has 0 redeemTokens.
      await redeemToken.connect(User).transfer(Alice, await redeemToken.balanceOf(Bob))

      // Attempting to close options without enough redeemTokens will cause a revert.
      await expect(primitiveRouter.connect(User).safeCloseForETH(optionToken.address, parseEther('0.1'), Bob)).to.be.revertedWith(
        ERC20_TRANSFER_AMOUNT
      )
    })

    it('should revert if user does not have enough optionToken tokens', async () => {
      // Mint some option and redeem tokens to Bob.
      await primitiveRouter.safeMintWithETH(optionToken.address, Bob, {
        value: parseEther('0.1'),
      })

      // Send Bob's optionTokens to Alice, so that Bob has 0 optionTokens.
      await optionToken.connect(User).transfer(Alice, await optionToken.balanceOf(Bob))

      // Attempting to close a quantity of options that msg.sender does not have will cause a revert.
      await expect(primitiveRouter.connect(User).safeCloseForETH(optionToken.address, parseEther('0.1'), Bob)).to.be.revertedWith(
        ERC20_TRANSFER_AMOUNT
      )
    })

    it('should close consecutively', async () => {
      await safeMintWithETH(parseEther('1'))
      await safeCloseForETH(parseEther('0.1'))
      await safeCloseForETH(parseEther('0.25'))
      await safeCloseForETH(parseEther('0.5433451'))
    })
  })

  describe('full test', () => {
    beforeEach(async () => {
      // Deploy a new primitiveRouter instance
      primitiveRouter = await setup.newTestRouter(Admin, [weth.address, weth.address, weth.address, registry.address])
      // Approve the tokens that are being used
      await underlyingToken.approve(primitiveRouter.address, MILLION_ETHER)
      await strikeToken.approve(primitiveRouter.address, MILLION_ETHER)
      await optionToken.approve(primitiveRouter.address, MILLION_ETHER)
      await redeemToken.approve(primitiveRouter.address, MILLION_ETHER)
    })

    it('should handle multiple transactions', async () => {
      // Start with 1000 options
      //await underlyingToken.deposit({ value: THOUSAND_ETHER })
      await safeMintWithETH(parseEther('1'))

      await safeCloseForETH(parseEther('0.1'))
      await safeCloseForETH(parseEther('0.1'))
      await safeExerciseForETH(parseEther('0.1'))
      await safeExerciseForETH(parseEther('0.1'))
      await safeExerciseForETH(parseEther('0.1'))
      await safeExerciseForETH(parseEther('0.1'))
      await safeCloseForETH(parseEther('0.2'))
      await safeCloseForETH(await optionToken.balanceOf(Alice))

      // Assert option and redeem token balances are 0
      let optionBal = await optionToken.balanceOf(Alice)

      assertWithinError(optionBal, 0)
    })
  })

  describe('safeRedeemForETH', () => {
    before(async () => {
      // Administrative contract instances
      registry = await setup.newRegistry(Admin)
      // Option Parameters
      underlyingToken = dai // Different from the option tested in above tests.
      strikeToken = weth // This option is a WETH put option. Above tests use a WETH call option.
      base = parseEther('200').toString()
      quote = parseEther('1').toString()
      expiry = '1690868800'

      // Option and Redeem token instances for parameters
      Primitive = await setup.newPrimitive(Admin, registry, dai, weth, base, quote, expiry)

      optionToken = Primitive.optionToken
      redeemToken = Primitive.redeemToken

      // Mint some option and redeem tokens to use in the tests.
      await dai.transfer(optionToken.address, parseEther('2000'))
      await weth.deposit({ value: parseEther('1.5') })
      await optionToken.mintOptions(Alice)

      // Deploy a new primitiveRouter instance
      primitiveRouter = await setup.newTestRouter(Admin, [weth.address, weth.address, weth.address, registry.address])

      // Approve tokens for primitiveRouter to use
      await weth.approve(primitiveRouter.address, MILLION_ETHER)
      await dai.approve(primitiveRouter.address, MILLION_ETHER)
      await optionToken.approve(primitiveRouter.address, MILLION_ETHER)
      await redeemToken.approve(primitiveRouter.address, MILLION_ETHER)
    })

    safeRedeemForETH = async (inputRedeems) => {
      let outputStrikes = inputRedeems

      let redeemBal = await getTokenBalance(redeemToken, Alice)
      // The balance of the user we are checking before and after is their ether balance.
      let strikeBal = await Admin.getBalance()

      await expect(primitiveRouter.safeRedeemForETH(optionToken.address, inputRedeems, Alice))
        .to.emit(primitiveRouter, 'Redeemed')
        .withArgs(Alice, optionToken.address, inputRedeems.toString())

      let redeemsChange = (await getTokenBalance(redeemToken, Alice)).sub(redeemBal)
      let strikesChange = (await Admin.getBalance()).sub(strikeBal)

      assertWithinError(redeemsChange, inputRedeems.mul(-1))
      assertWithinError(strikesChange, outputStrikes)

      await verifyOptionInvariants(underlyingToken, strikeToken, optionToken, redeemToken)
    }

    it('should revert if amount is 0', async () => {
      // Fails early if quantity input is 0, due to the contract's nonZero modifier.
      await expect(primitiveRouter.safeRedeemForETH(optionToken.address, 0, Alice)).to.be.revertedWith(ERR_ZERO)
    })

    it('should revert if user does not have enough redeemToken tokens', async () => {
      // Fails early if the user is attempting to redeem tokens that they don't have.
      await expect(primitiveRouter.safeRedeemForETH(optionToken.address, MILLION_ETHER, Alice)).to.be.revertedWith(ERC20_TRANSFER_AMOUNT)
    })

    it('should revert if contract does not have enough strike tokens', async () => {
      // If option tokens are not exercised, then no strikeTokens are stored in the option contract.
      // If no strikeTokens are stored in the contract, redeemTokens cannot be utilized until:
      // options are exercised, or become expired.
      await expect(primitiveRouter.safeRedeemForETH(optionToken.address, parseEther('0.1'), Alice)).to.be.revertedWith("ERR_BAL_STRIKE")
    })

    it('should redeemToken consecutively', async () => {
      await primitiveRouter.safeExerciseWithETH(optionToken.address, Alice, {
        value: parseEther('1'),
      })
      await safeRedeemForETH(parseEther('0.1'))
      await safeRedeemForETH(parseEther('0.32525'))
      await safeRedeemForETH(parseEther('0.5'))
    })
  })

  describe('safeExerciseWithETH', () => {
    safeExerciseWithETH = async (inputUnderlyings) => {
      // Options:Underlyings are always at a 1:1 ratio.
      let inputOptions = inputUnderlyings
      // Calculate the amount of strike tokens necessary to exercise
      let inputStrikes = inputUnderlyings.mul(quote).div(base)

      // The balance of the user we are checking before and after is their ether balance.
      let underlyingBal = await Admin.getBalance()
      let optionBal = await getTokenBalance(optionToken, Alice)
      let strikeBal = await getTokenBalance(strikeToken, Alice)

      await expect(
        primitiveRouter.safeExerciseWithETH(optionToken.address, Alice, {
          value: inputStrikes,
        })
      )
        .to.emit(primitiveRouter, 'Exercised')
        .withArgs(Alice, optionToken.address, inputUnderlyings.toString())

      let underlyingsChange = (await Admin.getBalance()).sub(underlyingBal)
      let optionsChange = (await getTokenBalance(optionToken, Alice)).sub(optionBal)
      let strikesChange = (await getTokenBalance(strikeToken, Alice)).sub(strikeBal)

      assertWithinError(underlyingsChange, inputUnderlyings)
      assertWithinError(optionsChange, inputOptions.mul(-1))
      assertWithinError(strikesChange, inputStrikes.mul(-1))

      await verifyOptionInvariants(underlyingToken, strikeToken, optionToken, redeemToken)
    }

    it('should revert if amount is 0', async () => {
      // Fails early if quantity input is 0, due to the contract's nonZero modifier.
      await expect(primitiveRouter.safeExerciseWithETH(optionToken.address, Alice)).to.be.revertedWith(ERR_ZERO)
    })

    it('should exercise consecutively', async () => {
      await strikeToken.deposit({ value: TEN_ETHER })
      await safeExerciseWithETH(parseEther('0.1'))
      await safeExerciseWithETH(parseEther('0.32525'))
      await safeExerciseWithETH(parseEther('0.1'))
    })
  })
})
