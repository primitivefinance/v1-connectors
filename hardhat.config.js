// == Libraries ==
const path = require('path')
const bip39 = require('bip39')
const crypto = require('crypto')
const ethers = require('ethers')
require('dotenv').config()

// == Plugins ==
require('@nomiclabs/hardhat-etherscan')
require('@nomiclabs/hardhat-waffle')
require('hardhat-deploy')
require('solidity-coverage')

// == Environment ==
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || crypto.randomBytes(20).toString('base64')
const rinkeby = process.env.RINKEBY || new ethers.providers.InfuraProvider('rinkeby').connection.url
const mainnet = process.env.MAINNET || new ethers.providers.InfuraProvider('mainnet').connection.url
const mnemonic = process.env.TEST_MNEMONIC || bip39.generateMnemonic()
const live = process.env.MNEMONIC || mnemonic

// == hardhat Config ==
Object.assign(module.exports, {
  networks: {
    coverage: {
      url: 'http://localhost:8555',
      gas: 12000000,
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
      gasPrice: 80000000000,
    },
    rinkeby: {
      url: rinkeby,
      accounts: {
        mnemonic: mnemonic,
      },
      chainId: 4,
    },
  },
  mocha: {
    timeout: 100000000,
    useColors: true,
  },
  etherscan: {
    url: 'https://api-rinkeby.etherscan.io/api',
    apiKey: ETHERSCAN_API_KEY,
    etherscanApiKey: ETHERSCAN_API_KEY,
  },
  solidity: {
    version: '0.6.2',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
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
})
