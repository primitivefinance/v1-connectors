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

const { ERR_ZERO, ERR_BAL_STRIKE, ERR_NOT_EXPIRED, ERC20_TRANSFER_AMOUNT, FAIL } = constants.ERR_CODES

describe('Core', function () {
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
  let safeMintWithETH
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
    baseToken = comp
    quoteToken = dai
    base = parseEther('1')
    quote = parseEther('1000')
    expiry = 1615190111

    // 4. deploy router
    router = await deploy('PrimitiveRouter', { from: signers[0], args: [weth.address, registry.address] })

    // 5. deploy connector
    connector = await deploy('PrimitiveCore', { from: signers[0], args: [weth.address, router.address, registry.address] })
    await router.init(connector.address, AddressZero, AddressZero)

    // Option Parameters
    baseToken = weth
    quoteToken = dai
    base = parseEther('200').toString()
    quote = parseEther('1').toString()
    expiry = '1690868800'

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
    //console.log(await redeemToken.symbol(), await optionToken.symbol(), optionToken.address == redeemToken.address)
    //await generateReport(contractNames, contracts, tokens, addresses, addressNamesArray)

    // approve base tokens to be pulled from caller
    await baseToken.approve(router.address, ethers.constants.MaxUint256)
    // approve base tokens to be pulled from caller
    await quoteToken.approve(router.address, ethers.constants.MaxUint256)
  })

  describe('safeMintWithETH', () => {
    before(function () {
      params = connector.interface.encodeFunctionData('safeMintWithETH', [optionToken.address])
    })
    safeMintWithETH = async (inputUnderlyings) => {
      // Calculate the strike price of each unit of underlying token
      let outputRedeems = inputUnderlyings.mul(quote).div(base)

      // The balance of the user we are checking before and after is their ether balance.
      let underlyingBal = await signer.getBalance()
      let optionBal = await getTokenBalance(optionToken, Alice)
      let redeemBal = await getTokenBalance(redeemToken, Alice)

      // Since the user is sending ethers, the change in their balance will need to incorporate gas costs.
      let gasUsed = await signer.estimateGas(
        router.executeCall(connector.address, params, {
          value: inputUnderlyings,
        })
      )

      // Call the mint function and check that the event was emitted.
      await expect(
        router.executeCall(connector.address, params, {
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
      // Without sending any value, the transaction will revert due to the contract's nonZero modifier.
      await expect(router.executeCall(connector.address, params)).to.be.revertedWith(FAIL)
    })

    it('should revert if optionToken.address is not an option ', async () => {
      // Passing in the address of Alice for the optionToken parameter will revert.
      await expect(router.executeCall(connector.address, params, { value: 10 })).to.be.reverted
    })

    it('should emit the mint event', async () => {
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
})
