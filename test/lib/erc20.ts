import { ethers, waffle } from 'hardhat'
import { Contract, BigNumber, Signer } from 'ethers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address'
import WethArtifact from '@primitivefi/contracts/artifacts/WETH9.json'
import ERC20 from '../../build/@openzeppelin/contracts/token/ERC20/ERC20.sol/ERC20.json'
const { MaxUint256 } = ethers.constants
const { deployContract } = waffle

export const deploy = async (contractName: string, { from, args }: { from?: Signer; args: any }): Promise<Contract> => {
  let factory = await ethers.getContractFactory(contractName)
  if (from) {
    factory.connect(from)
  }
  const contract = await factory.deploy(...args)
  await contract.deployed()
  return contract
}

export const deployWeth = async (signer: Signer) => {
  const weth: Contract = await deployContract(signer, WethArtifact, [], {
    gasLimit: 9500000,
  })
  return weth
}

export const deployTokens = async (signer: Signer, quantity: number, names?: string[], totalSupply?: BigNumber) => {
  const amount = ethers.utils.parseEther('1000000000')
  let tokens: Contract[] = []

  for (let i = 0; i < quantity; i++) {
    let name = names ? names[i] : 'TestERC20'
    let token = await deploy('TestERC20', { from: signer, args: [name, name, totalSupply ? totalSupply : amount] })
    tokens.push(token)
  }

  return tokens
}

export const tokenFromAddress = (address: string, signer: Signer) => {
  let token = new ethers.Contract(address, ERC20.abi, signer)
  return token
}

export const batchApproval = async (
  arrayOfAddresses: string[],
  arrayOfTokens: Contract[],
  arrayOfSigners: SignerWithAddress[]
) => {
  // for each contract
  for (let c = 0; c < arrayOfAddresses.length; c++) {
    let address = arrayOfAddresses[c]
    // for each token
    for (let t = 0; t < arrayOfTokens.length; t++) {
      let token = arrayOfTokens[t]
      // for each owner
      for (let u = 0; u < arrayOfSigners.length; u++) {
        let signer = arrayOfSigners[u]
        let allowance = await token.connect(signer).allowance(signer.address, address)
        if (allowance < MaxUint256) {
          await token.connect(signer).approve(address, MaxUint256)
        }
      }
    }
  }
}
