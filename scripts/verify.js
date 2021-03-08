/**
 * @dev Verifies the Trader and UniswapConnector contracts.
 */
const verifyUniswapConnector = async () => {
  let UniswapConnector = await deployments.get('UniswapConnector03')
  try {
    await run('verify', {
      address: UniswapConnector.address,
      contractName: 'contracts/UniswapConnector03.sol:UniswapConnector03',
      constructorArguments: UniswapConnector.args,
    })
  } catch (err) {
    console.error(err)
  }
}

const verifyConnectors = async () => {
  let PrimitiveCore = await deployments.get('PrimitiveCore')
  try {
    await run('verify', {
      address: PrimitiveCore.address,
      contractName: 'contracts/PrimitiveCore.sol:PrimitiveCore',
      constructorArguments: PrimitiveCore.args,
    })
  } catch (err) {
    console.error(err)
  }

  let PrimitiveSwaps = await deployments.get('PrimitiveSwaps')
  try {
    await run('verify', {
      address: PrimitiveSwaps.address,
      contractName: 'contracts/PrimitiveSwaps.sol:PrimitiveSwaps',
      constructorArguments: PrimitiveSwaps.args,
    })
  } catch (err) {
    console.error(err)
  }

  let PrimitiveLiquidity = await deployments.get('PrimitiveLiquidity')
  try {
    await run('verify', {
      address: PrimitiveLiquidity.address,
      contractName: 'contracts/PrimitiveLiquidity.sol:PrimitiveLiquidity',
      constructorArguments: PrimitiveLiquidity.args,
    })
  } catch (err) {
    console.error(err)
  }
}

const verifyRouter = async () => {
  let PrimitiveRouter = await deployments.get('PrimitiveRouter')
  try {
    await run('verify', {
      address: PrimitiveRouter.address,
      contractName: 'contracts/PrimitiveRouter.sol:PrimitiveRouter',
      constructorArguments: PrimitiveRouter.args,
    })
  } catch (err) {
    console.error(err)
  }
}

const verifyDai = async () => {
  let Dai = await deployments.get('Dai')
  try {
    await run('verify', {
      address: Dai.address,
      contractName: 'contracts/Dai.sol:Dai',
      constructorArguments: Dai.args,
    })
  } catch (err) {
    console.error(err)
  }
}
/**
 * @dev Calling this verify script with the --network tag will verify them on etherscan automatically.
 */
async function main() {
  await verifyRouter()
  await verifyConnectors()
  await verifyDai()
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
