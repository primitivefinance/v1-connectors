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

describe('Router', function () {
  let signers: SignerWithAddress[]
  let weth: Contract
  let router: Contract, connector: Contract, liquidity: Contract, swaps: Contract
  let signer: SignerWithAddress
  let Alice: string
  let tokens: Contract[], comp: Contract, dai: Contract
  let core: Contract
  let baseToken, quoteToken, base, quote, expiry
  let factory: Contract, registry: Contract
  let Primitive: any
  let optionToken: Contract, redeemToken: Contract
  let safeMintWithETH, safeExerciseWithETH, safeExerciseForETH, safeRedeemForETH, safeCloseForETH
  let params, uniswapRouter, uniswapFactory

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
    const uniswap = await setup.newUniswap(signer, Alice, weth)
    uniswapFactory = uniswap.uniswapFactory
    uniswapRouter = uniswap.uniswapRouter
    await uniswapFactory.setFeeTo(Alice)

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
    liquidity = await deploy('PrimitiveLiquidity', {
      from: signers[0],
      args: [weth.address, router.address, uniswapFactory.address, uniswapRouter.address],
    })
    swaps = await deploy('PrimitiveSwaps', {
      from: signers[0],
      args: [weth.address, router.address, uniswapFactory.address, uniswapRouter.address],
    })

    await router.setRegisteredConnectors([connector.address, liquidity.address, swaps.address], [true, true, true])

    // Option and Redeem token instances for parameters
    Primitive = await setup.newPrimitive(signer, registry, baseToken, quoteToken, base, quote, expiry)

    // Long and short tokens
    optionToken = Primitive.optionToken
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

  describe('halt', () => {
    beforeEach(async () => {
      // Deploy a new router & connector instance
      // 4. deploy router
      router = await deploy('PrimitiveRouter', { from: signers[0], args: [weth.address, registry.address] })

      // 5. deploy connector
      connector = await deploy('PrimitiveCore', { from: signers[0], args: [weth.address, router.address] })
      liquidity = await deploy('PrimitiveLiquidity', {
        from: signers[0],
        args: [weth.address, router.address, uniswapFactory.address, uniswapRouter.address],
      })
      swaps = await deploy('PrimitiveSwaps', {
        from: signers[0],
        args: [weth.address, router.address, uniswapFactory.address, uniswapRouter.address],
      })
      await router.setRegisteredConnectors([connector.address, liquidity.address, swaps.address], [true, true, true])
      // Approve the tokens that are being used
      await baseToken.approve(router.address, MILLION_ETHER)
      await quoteToken.approve(router.address, MILLION_ETHER)
      await optionToken.approve(router.address, MILLION_ETHER)
      await redeemToken.approve(router.address, MILLION_ETHER)
    })

    it('Router should be unusable when halted', async () => {
      let inputUnderlyings = parseEther('1')
      let mintparams = connector.interface.encodeFunctionData('safeMintWithETH', [optionToken.address])
      await router.halt()

      await expect(
        router.executeCall(connector.address, mintparams, {
          value: inputUnderlyings,
        })
      ).to.be.revertedWith(ERR_PAUSED)
    })

    it('Only deployer can halt', async () => {
      await expect(router.connect(signers[2]).halt()).to.be.revertedWith(ERR_OWNABLE)
    })
  })
})
