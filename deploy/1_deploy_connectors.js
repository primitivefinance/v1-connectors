const hre = require('hardhat')

const REGISTRY = {
  1: require('@primitivefi/contracts/deployments/live_1/Registry.json').address,
  4: require('@primitivefi/contracts/deployments/rinkeby/Registry.json').address,
}

const UNISWAPV2_ROUTER02 = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
const UNISWAPV2_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'
const SUSHISWAP_ROUTER02 = '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F'
const SUSHISWAP_FACTORY = '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac'
const WETH = {
  1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  4: require('@primitivefi/contracts/deployments/rinkeby/ETH.json').address,
}

module.exports = async ({ getNamedAccounts, deployments }) => {
  const { log, deploy } = deployments
  const { deployer } = await getNamedAccounts()
  const chain = await hre.getChainId()
  const signer = ethers.provider.getSigner(deployer)

  const router = await deploy('PrimitiveRouter', {
    from: deployer,
    contractName: 'PrimitiveRouter',
    args: [WETH[chain], REGISTRY[chain]],
  })

  const core = await deploy('PrimitiveCore', {
    from: deployer,
    contractName: 'PrimitiveCore',
    args: [WETH[chain], router.address],
  })
  const swaps = await deploy('PrimitiveSwaps', {
    from: deployer,
    contractName: 'PrimitiveSwaps',
    args: [WETH[chain], router.address, SUSHISWAP_FACTORY, SUSHISWAP_ROUTER02],
  })
  const liquidity = await deploy('PrimitiveLiquidity', {
    from: deployer,
    contractName: 'PrimitiveLiquidity',
    args: [WETH[chain], router.address, SUSHISWAP_FACTORY, SUSHISWAP_ROUTER02],
  })

  const instance = new ethers.Contract(router.address, router.abi, signer)
  const tx = await instance.setRegisteredConnectors([core.address, swaps.address, liquidity.address], [true, true, true])
  let deployed = [router, core, swaps, liquidity]
  for (let i = 0; i < deployed.length; i++) {
    if (deployed[i].newlyDeployed)
      log(`Contract deployed at ${deployed[i].address} using ${deployed[i].receipt.gasUsed} gas on chain ${chain}`)
  }
}

module.exports.tags = ['Periphery']
