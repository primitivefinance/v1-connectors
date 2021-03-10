const hre = require('hardhat')

module.exports = async ({ getNamedAccounts, deployments }) => {
  const { log, deploy } = deployments
  const { deployer } = await getNamedAccounts()
  const chain = await hre.getChainId()
  const signer = ethers.provider.getSigner(deployer)

  const dai =
    +chain == 4
      ? await deploy('Dai', {
          from: deployer,
          contractName: 'Dai',
          args: [chain],
        })
      : null

  let deployed = [dai]
  for (let i = 0; i < deployed.length; i++) {
    if (deployed[i].newlyDeployed)
      log(`Contract deployed at ${deployed[i].address} using ${deployed[i].receipt.gasUsed} gas on chain ${chain}`)
  }
}

module.exports.tags = ['Test']
