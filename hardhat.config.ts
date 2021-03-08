// == Libraries ==
import path from 'path'
import bip39 from 'bip39'
import crypto from 'crypto'
import ethers from 'ethers'
import { config as dotenvConfig } from 'dotenv'
import { resolve } from 'path'
import { HardhatUserConfig } from 'hardhat/config'
dotenvConfig({ path: resolve(__dirname, './.env') })

// == Plugins ==
import '@nomiclabs/hardhat-ethers'
import '@nomiclabs/hardhat-etherscan'
import '@nomiclabs/hardhat-waffle'
import 'hardhat-deploy'
import 'hardhat-gas-reporter'
import 'solidity-coverage'
import 'prettier-plugin-solidity'

// == Environment ==
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || crypto.randomBytes(20).toString('base64')
const rinkeby = process.env.RINKEBY || ''
const kovan = process.env.KOVAN || ''
const ropsten = process.env.ROPSTEN || ''
const goerli = process.env.GOERLI || ''
const mainnet = process.env.MAINNET || ''
const mnemonic = process.env.TEST_MNEMONIC || ''
const live = process.env.MNEMONIC || mnemonic

// == hardhat Config ==

const config: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  networks: {
    hardhat: {
      chainId: 1337,
      blockGasLimit: 12500000,
    },
    local: {
      url: 'http://127.0.0.1:8545',
      gasPrice: 80000000000,
      timeout: 1000000,
    },
    live: {
      url: mainnet,
      accounts: {
        mnemonic: live,
      },
      chainId: 1,
      from: '0xaF31D3C2972F62Eb08F96a1Fe29f579d61b4294D',
      gasPrice: 30000000000,
    },
    ropsten: {
      url: ropsten,
      accounts: {
        mnemonic: mnemonic,
      },
      chainId: 3,
    },
    rinkeby: {
      url: rinkeby,
      accounts: {
        mnemonic: mnemonic,
      },
      chainId: 4,
    },
    goerli: {
      url: goerli,
      accounts: {
        mnemonic: mnemonic,
      },
      chainId: 5,
    },
    kovan: {
      url: kovan,
      accounts: {
        mnemonic: mnemonic,
      },
      chainId: 42,
    },
  },
  mocha: {
    timeout: 100000000,
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
  gasReporter: {
    currency: 'USD',
    showTimeSpent: true,
    enabled: true,
  },
  solidity: {
    compilers: [
      {
        version: '0.5.12',
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      {
        version: '0.7.1',
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      {
        version: '0.6.2',
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    ],
  },
  namedAccounts: {
    deployer: {
      default: 0, // here this will by default take the first account as deployer
      1: '0xaF31D3C2972F62Eb08F96a1Fe29f579d61b4294D',
      4: '0xE7D58d8554Eb0D5B5438848Af32Bf33EbdE477E7',
    },
  },
  paths: {
    sources: path.join(__dirname, 'contracts'),
    tests: path.join(__dirname, 'test'),
    artifacts: path.join(__dirname, 'build'),
    deploy: path.join(__dirname, 'deploy'),
    deployments: path.join(__dirname, 'deployments'),
  },
}

export default config
