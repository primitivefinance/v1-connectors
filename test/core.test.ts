import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address'
import chai, { expect } from 'chai'
import { solidity } from 'ethereum-waffle'
chai.use(solidity)
import { BigNumber, BigNumberish, Contract } from 'ethers'
import { parseEther, formatEther } from 'ethers/lib/utils'
import { ethers, waffle } from 'hardhat'
import { deploy, deployTokens, deployWeth, batchApproval, tokenFromAddress } from './lib/erc20'
const { AddressZero } = ethers.constants

// Helper functions and constants
import * as utils from './lib/utils'
import * as setup from './lib/setup'
import constants from './lib/constants'
const { assertWithinError, verifyOptionInvariants, getTokenBalance } = utils

const { ONE_ETHER, FIVE_ETHER, TEN_ETHER, THOUSAND_ETHER, MILLION_ETHER } = constants.VALUES

const { ERR_ZERO, ERR_BAL_STRIKE, ERR_NOT_EXPIRED, ERC20_TRANSFER_AMOUNT, FAIL } = constants.ERR_CODES

describe('PrimitiveCore', function () {
  let signers: SignerWithAddress[]
  let weth: Contract
  let router: Contract, connector: Contract
  let signer: SignerWithAddress
  let Alice: string
  let tokens: Contract[], comp: Contract, dai: Contract
  let core: Contract
  let baseToken, quoteToken, base, quote, expiry
  let factory: Contract, registry: Contract
  let Primitive: any
  let optionToken: Contract, redeemToken: Contract
  let safeMintWithETH, safeExerciseWithETH, safeExerciseForETH, safeRedeemForETH, safeCloseForETH
  let params

  const deadline = Math.floor(Date.now() / 1000) + 60 * 20

  const venueDeposit = (connector: Contract, receiver: string, oid: string) => {
    let amount: BigNumber = parseEther('1')
    let params: any = connector.interface.encodeFunctionData('deposit', [oid, amount, receiver])
    return router.execute(0, connector.address, params)
  }

  before(async function () {
    signers = await ethers.getSigners()
    signer = signers[0]
    Alice = signer.address

    // 1. Administrative contract instances
    registry = await setup.newRegistry(signer)

    // 2. get weth, erc-20 tokens, and wrapped tokens
    weth = await deployWeth(signer)
    tokens = await deployTokens(signer, 2, ['comp', 'dai'])
    ;[comp, dai] = tokens

    // 3. select option params
    baseToken = weth
    quoteToken = dai
    base = parseEther('1')
    quote = parseEther('1000')
    expiry = 1615190111

    // 4. deploy router
    router = await deploy('PrimitiveRouter', { from: signers[0], args: [weth.address, registry.address] })

    // 5. deploy connector
    connector = await deploy('PrimitiveCore', { from: signers[0], args: [weth.address, router.address] })
    await router.init(connector.address, AddressZero, AddressZero)

    // Option and Redeem token instances for parameters
    Primitive = await setup.newPrimitive(signer, registry, baseToken, quoteToken, base, quote, expiry)

    // Long and short tokens
    optionToken = Primitive.optionToken
    await router.validateOption(optionToken.address)
    redeemToken = Primitive.redeemToken

    let contractNames: string[] = ['Router']
    let contracts: Contract[] = [router]
    let addresses: string[] = [signer.address]
    let addressNamesArray: string[] = ['Alice']
    tokens.push(optionToken)
    tokens.push(redeemToken)
    //await generateReport(contractNames, contracts, tokens, addresses, addressNamesArray)

    await baseToken.approve(router.address, ethers.constants.MaxUint256)
    await quoteToken.approve(router.address, ethers.constants.MaxUint256)
    await optionToken.approve(router.address, MILLION_ETHER)
    await redeemToken.approve(router.address, MILLION_ETHER)
    await optionToken.connect(signers[1]).approve(router.address, MILLION_ETHER)
    await redeemToken.connect(signers[1]).approve(router.address, MILLION_ETHER)
  })

  describe('safeMintWithETH', () => {
    safeMintWithETH = async (inputUnderlyings) => {
      let mintparams = connector.interface.encodeFunctionData('safeMintWithETH', [optionToken.address])
      // Calculate the strike price of each unit of underlying token
      let outputRedeems = inputUnderlyings.mul(quote).div(base)

      // The balance of the user we are checking before and after is their ether balance.
      let underlyingBal = await signer.getBalance()
      let optionBal = await getTokenBalance(optionToken, Alice)
      let redeemBal = await getTokenBalance(redeemToken, Alice)

      // Since the user is sending ethers, the change in their balance will need to incorporate gas costs.
      let gasUsed = await signer.estimateGas(
        router.executeCall(connector.address, mintparams, {
          value: inputUnderlyings,
        })
      )

      // Call the mint function and check that the event was emitted.
      await expect(
        router.connect(signer).executeCall(connector.address, mintparams, {
          value: inputUnderlyings,
        })
      )
        .to.emit(connector, 'Minted')
        .withArgs(Alice, optionToken.address, inputUnderlyings.toString(), outputRedeems.toString())

      let underlyingsChange = (await signer.getBalance()).sub(underlyingBal).add(gasUsed)
      let optionsChange = (await getTokenBalance(optionToken, Alice)).sub(optionBal)
      let redeemsChange = (await getTokenBalance(redeemToken, Alice)).sub(redeemBal)

      assertWithinError(underlyingsChange, inputUnderlyings.mul(-1))
      assertWithinError(optionsChange, inputUnderlyings)
      assertWithinError(redeemsChange, outputRedeems)

      await verifyOptionInvariants(baseToken, quoteToken, optionToken, redeemToken)
    }

    it('should revert if amount is 0', async () => {
      params = connector.interface.encodeFunctionData('safeMintWithETH', [optionToken.address])
      // Without sending any value, the transaction will revert due to the contract's nonZero modifier.
      await expect(router.executeCall(connector.address, params)).to.be.revertedWith(FAIL)
    })

    it('should revert if optionToken.address is an EOA', async () => {
      params = connector.interface.encodeFunctionData('safeMintWithETH', [Alice])
      // Passing in the address of Alice for the optionToken parameter will revert.
      await expect(router.executeCall(connector.address, params, { value: 10 })).to.be.revertedWith('Route: EXECUTION_FAIL')
    })

    it('should revert if optionToken.address is not a valid option contract', async () => {
      params = connector.interface.encodeFunctionData('safeMintWithETH', [connector.address])
      // Passing in the address of Alice for the optionToken parameter will revert.
      await expect(router.executeCall(connector.address, params, { value: 10 })).to.be.revertedWith('Route: EXECUTION_FAIL')
    })

    it('should emit the mint event', async () => {
      params = connector.interface.encodeFunctionData('safeMintWithETH', [optionToken.address])
      let inputUnderlyings = parseEther('0.1')
      let outputRedeems = inputUnderlyings.mul(quote).div(base)
      await expect(
        router.executeCall(connector.address, params, {
          value: inputUnderlyings,
        })
      )
        .to.emit(connector, 'Minted')
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
      let exParams = connector.interface.encodeFunctionData('safeExerciseForETH', [optionToken.address, inputUnderlyings])
      // Options:Underlyings are always at a 1:1 ratio.
      let inputOptions = inputUnderlyings
      // Calculate the amount of strike tokens necessary to exercise
      let inputStrikes = inputUnderlyings.mul(quote).div(base)

      // The balance of the user we are checking before and after is their ether balance.
      let underlyingBal = await signer.getBalance()
      let optionBal = await getTokenBalance(optionToken, Alice)
      let strikeBal = await getTokenBalance(quoteToken, Alice)

      await expect(router.connect(signer).executeCall(connector.address, exParams))
        .to.emit(connector, 'Exercised')
        .withArgs(Alice, optionToken.address, inputUnderlyings.toString())

      let underlyingsChange = (await signer.getBalance()).sub(underlyingBal)
      let optionsChange = (await getTokenBalance(optionToken, Alice)).sub(optionBal)
      let strikesChange = (await getTokenBalance(quoteToken, Alice)).sub(strikeBal)

      assertWithinError(underlyingsChange, inputUnderlyings)
      assertWithinError(optionsChange, inputOptions.mul(-1))
      assertWithinError(strikesChange, inputStrikes.mul(-1))

      await verifyOptionInvariants(baseToken, quoteToken, optionToken, redeemToken)
    }

    it('should revert if amount is 0', async () => {
      // If we pass in 0 as the exercise quantity, it will revert due to the contract's nonZero modifier.
      params = connector.interface.encodeFunctionData('safeExerciseForETH', [optionToken.address, '0'])
      await expect(router.executeCall(connector.address, params)).to.be.revertedWith(FAIL)
    })

    it('should revert if optionToken.address is a contract other than a legitimate option', async () => {
      params = connector.interface.encodeFunctionData('safeExerciseForETH', [connector.address, parseEther('0.1')])
      await expect(router.executeCall(connector.address, params)).to.be.revertedWith(FAIL)
    })

    it('should revert if user does not have enough optionToken tokens', async () => {
      params = connector.interface.encodeFunctionData('safeExerciseForETH', [optionToken.address, MILLION_ETHER])
      // Fails early by checking the user's optionToken balance against the quantity of options they wish to exercise.
      await expect(router.executeCall(connector.address, params)).to.be.revertedWith(FAIL)
    })

    it('should revert if user does not have enough strike tokens', async () => {
      // Mint some option and redeem tokens to signers[1].address.
      let mintParams = connector.interface.encodeFunctionData('safeMintWithETH', [optionToken.address])
      await router.connect(signers[1]).executeCall(connector.address, mintParams, {
        value: parseEther('0.1'),
      })
      params = connector.interface.encodeFunctionData('safeExerciseForETH', [optionToken.address, parseEther('0.1')])
      // Send the strikeTokens that signers[1].address owns to Alice, so that signers[1].address has 0 strikeTokens.
      await quoteToken.connect(signers[1]).transfer(Alice, await quoteToken.balanceOf(signers[1].address))
      // Attempting to exercise an option without having enough strikeTokens will cause a revert.
      await expect(router.connect(signers[1]).executeCall(connector.address, params)).to.be.revertedWith(FAIL)
    })

    it('should exercise consecutively', async () => {
      await quoteToken.mint(Alice, MILLION_ETHER)
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
      let closeParams = connector.interface.encodeFunctionData('safeCloseForETH', [optionToken.address, inputOptions])
      let inputRedeems = inputOptions.mul(quote).div(base)

      // The balance of the user we are checking before and after is their ether balance.
      let underlyingBal = await signer.getBalance()
      let optionBal = await getTokenBalance(optionToken, Alice)
      let redeemBal = await getTokenBalance(redeemToken, Alice)

      await expect(router.connect(signer).executeCall(connector.address, closeParams))
        .to.emit(connector, 'Closed')
        .withArgs(Alice, optionToken.address, inputOptions.toString())

      let underlyingsChange = (await signer.getBalance()).sub(underlyingBal)
      let optionsChange = (await getTokenBalance(optionToken, Alice)).sub(optionBal)
      let redeemsChange = (await getTokenBalance(redeemToken, Alice)).sub(redeemBal)

      assertWithinError(underlyingsChange, inputOptions)
      assertWithinError(optionsChange, inputOptions.mul(-1))
      assertWithinError(redeemsChange, inputRedeems.mul(-1))

      await verifyOptionInvariants(baseToken, quoteToken, optionToken, redeemToken)
    }

    it('should revert if amount is 0', async () => {
      params = connector.interface.encodeFunctionData('safeCloseForETH', [optionToken.address, 0])
      // Fails early if quantity of options to close is 0, because of the contract's nonZero modifier.
      await expect(router.executeCall(connector.address, params)).to.be.revertedWith(FAIL)
    })

    it('should revert if user does not have enough redeemTokens', async () => {
      // Mint some option and redeem tokens to signers[1].address.
      let mintParams = connector.interface.encodeFunctionData('safeMintWithETH', [optionToken.address])
      await router.connect(signers[1]).executeCall(connector.address, mintParams, {
        value: ONE_ETHER,
      })

      // Send signers[1].address's redeemTokens to Alice, so that signers[1].address has 0 redeemTokens.
      await redeemToken.connect(signers[1]).transfer(Alice, await redeemToken.balanceOf(signers[1].address))

      params = connector.interface.encodeFunctionData('safeCloseForETH', [optionToken.address, parseEther('0.1')])
      // Attempting to close options without enough redeemTokens will cause a revert.
      await expect(router.connect(signers[1]).executeCall(connector.address, params)).to.be.revertedWith(FAIL)
    })

    it('should revert if user does not have enough optionToken tokens', async () => {
      // Mint some option and redeem tokens to signers[1].address.
      let mintParams = connector.interface.encodeFunctionData('safeMintWithETH', [optionToken.address])
      await router.connect(signers[1]).executeCall(connector.address, mintParams, {
        value: parseEther('0.1'),
      })

      // Send signers[1].address's optionTokens to Alice, so that signers[1].address has 0 optionTokens.
      await optionToken.connect(signers[1]).transfer(Alice, await optionToken.balanceOf(signers[1].address))

      params = connector.interface.encodeFunctionData('safeCloseForETH', [optionToken.address, parseEther('0.1')])
      // Attempting to close a quantity of options that msg.sender does not have will cause a revert.
      await expect(router.connect(signers[1]).executeCall(connector.address, params)).to.be.revertedWith(FAIL)
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
      // Deploy a new router & connector instance
      router = await setup.newTestRouter(signer, [weth.address, weth.address, weth.address, registry.address])
      connector = await deploy('PrimitiveCore', { from: signers[0], args: [weth.address, router.address] })
      await router.init(connector.address, AddressZero, AddressZero)
      await router.validateOption(optionToken.address)
      // Approve the tokens that are being used
      await baseToken.approve(router.address, MILLION_ETHER)
      await quoteToken.approve(router.address, MILLION_ETHER)
      await optionToken.approve(router.address, MILLION_ETHER)
      await redeemToken.approve(router.address, MILLION_ETHER)
    })

    it('should handle multiple transactions', async () => {
      // Start with 1000 options
      //await baseToken.deposit({ value: THOUSAND_ETHER })
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
      registry = await setup.newRegistry(signer)
      // Option Parameters
      baseToken = dai // Different from the option tested in above tests.
      quoteToken = weth // This option is a WETH put option. Above tests use a WETH call option.
      base = parseEther('200').toString()
      quote = parseEther('1').toString()
      expiry = '1690868800'

      // Option and Redeem token instances for parameters
      Primitive = await setup.newPrimitive(signer, registry, dai, weth, base, quote, expiry)

      optionToken = Primitive.optionToken
      redeemToken = Primitive.redeemToken

      // Mint some option and redeem tokens to use in the tests.
      await dai.transfer(optionToken.address, parseEther('2000'))
      await weth.deposit({ value: parseEther('1.5') })
      await optionToken.mintOptions(Alice)

      // Deploy a new router instance
      router = await setup.newTestRouter(signer, [weth.address, weth.address, weth.address, registry.address])
      connector = await deploy('PrimitiveCore', { from: signers[0], args: [weth.address, router.address] })
      await router.init(connector.address, AddressZero, AddressZero)
      await router.validateOption(optionToken.address)

      // Approve tokens for router to use
      await weth.approve(router.address, MILLION_ETHER)
      await dai.approve(router.address, MILLION_ETHER)
      await optionToken.approve(router.address, MILLION_ETHER)
      await redeemToken.approve(router.address, MILLION_ETHER)
    })

    safeRedeemForETH = async (inputRedeems) => {
      let redeemParams = connector.interface.encodeFunctionData('safeRedeemForETH', [optionToken.address, inputRedeems])
      let outputStrikes = inputRedeems

      let redeemBal = await getTokenBalance(redeemToken, Alice)
      // The balance of the user we are checking before and after is their ether balance.
      let strikeBal = await signer.getBalance()

      await expect(router.connect(signer).executeCall(connector.address, redeemParams))
        .to.emit(connector, 'Redeemed')
        .withArgs(Alice, optionToken.address, inputRedeems.toString())

      let redeemsChange = (await getTokenBalance(redeemToken, Alice)).sub(redeemBal)
      let strikesChange = (await signer.getBalance()).sub(strikeBal)

      assertWithinError(redeemsChange, inputRedeems.mul(-1))
      assertWithinError(strikesChange, outputStrikes)

      await verifyOptionInvariants(baseToken, quoteToken, optionToken, redeemToken)
    }

    it('should revert if amount is 0', async () => {
      params = connector.interface.encodeFunctionData('safeRedeemForETH', [optionToken.address, '0'])
      // Fails early if quantity input is 0, due to the contract's nonZero modifier.
      await expect(router.executeCall(connector.address, params)).to.be.revertedWith(FAIL)
    })

    it('should revert if user does not have enough redeemToken tokens', async () => {
      params = connector.interface.encodeFunctionData('safeRedeemForETH', [optionToken.address, MILLION_ETHER])
      // Fails early if the user is attempting to redeem tokens that they don't have.
      await expect(router.executeCall(connector.address, params)).to.be.revertedWith(FAIL)
    })

    it('should revert if contract does not have enough strike tokens', async () => {
      // If option tokens are not exercised, then no strikeTokens are stored in the option contract.
      // If no strikeTokens are stored in the contract, redeemTokens cannot be utilized until:
      // options are exercised, or become expired.
      params = connector.interface.encodeFunctionData('safeRedeemForETH', [optionToken.address, parseEther('0.1')])
      await expect(router.executeCall(connector.address, params)).to.be.revertedWith(FAIL)
    })

    it('should redeem consecutively', async () => {
      let exParams = connector.interface.encodeFunctionData('safeExerciseWithETH', [optionToken.address])
      await expect(router.executeCall(connector.address, exParams, { value: parseEther('1') })).to.emit(
        connector,
        'Exercised'
      )
      await safeRedeemForETH(parseEther('0.1'))
      await safeRedeemForETH(parseEther('0.32525'))
      await safeRedeemForETH(parseEther('0.5'))
    })
  })

  describe('safeExerciseWithETH', () => {
    safeExerciseWithETH = async (inputUnderlyings) => {
      let exParams = connector.interface.encodeFunctionData('safeExerciseWithETH', [optionToken.address])
      // Options:Underlyings are always at a 1:1 ratio.
      let inputOptions = inputUnderlyings
      // Calculate the amount of strike tokens necessary to exercise
      let inputStrikes = inputUnderlyings.mul(quote).div(base)

      // The balance of the user we are checking before and after is their ether balance.
      let underlyingBal = await signer.getBalance()
      let optionBal = await getTokenBalance(optionToken, Alice)
      let strikeBal = await getTokenBalance(quoteToken, Alice)

      await expect(
        router.connect(signer).executeCall(connector.address, exParams, {
          value: inputStrikes,
        })
      )
        .to.emit(connector, 'Exercised')
        .withArgs(Alice, optionToken.address, inputUnderlyings.toString())

      let underlyingsChange = (await signer.getBalance()).sub(underlyingBal)
      let optionsChange = (await getTokenBalance(optionToken, Alice)).sub(optionBal)
      let strikesChange = (await getTokenBalance(quoteToken, Alice)).sub(strikeBal)

      assertWithinError(underlyingsChange, inputUnderlyings)
      assertWithinError(optionsChange, inputOptions.mul(-1))
      assertWithinError(strikesChange, inputStrikes.mul(-1))

      await verifyOptionInvariants(baseToken, quoteToken, optionToken, redeemToken)
    }

    it('should revert if amount is 0', async () => {
      params = connector.interface.encodeFunctionData('safeExerciseWithETH', [optionToken.address])
      // Fails early if quantity input is 0, due to the contract's nonZero modifier.
      await expect(router.executeCall(connector.address, params)).to.be.revertedWith(FAIL)
    })

    it('should exercise consecutively', async () => {
      await quoteToken.deposit({ value: TEN_ETHER })
      await safeExerciseWithETH(parseEther('0.1'))
      await safeExerciseWithETH(parseEther('0.32525'))
      await safeExerciseWithETH(parseEther('0.1'))
    })
  })
})
