// SPDX-License-Identifier: MIT
// Copyright 2021 Primitive Finance
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of
// this software and associated documentation files (the "Software"), to deal in
// the Software without restriction, including without limitation the rights to
// use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
// of the Software, and to permit persons to whom the Software is furnished to do
// so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

pragma solidity ^0.6.2;

/**
 * @title   A user-friendly smart contract to interface with the Primitive and Uniswap protocols.
 * @notice  Primitive Router - @primitivefi/v1-connectors@v1.3.0
 * @author  Primitive
 */

// Open Zeppelin
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {
    ReentrancyGuard
} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
// WETH Interface
import {IWETH} from "./interfaces/IWETH.sol";
// Uniswap V2 & Primitive V1
import {
    IUniswapV2Callee
} from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Callee.sol";
import {
    IUniswapV2Pair
} from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import {
    IPrimitiveRouter,
    IUniswapV2Router02,
    IUniswapV2Factory,
    IOption,
    IERC20
} from "./interfaces/IPrimitiveRouter.sol";
import {PrimitiveRouterLib} from "./libraries/PrimitiveRouterLib.sol";
import {
  IRegistry
} from "@primitivefi/contracts/contracts/option/interfaces/IRegistry.sol";

import "hardhat/console.sol";

contract PrimitiveRouter is
    IPrimitiveRouter,
    IUniswapV2Callee,
    ReentrancyGuard
{
    using SafeERC20 for IERC20; // Reverts when `transfer` or `transferFrom` erc20 calls don't return proper data
    using SafeMath for uint256; // Reverts on math underflows/overflows

    IUniswapV2Factory public override factory =
        IUniswapV2Factory(0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f); // The Uniswap V2 factory contract to get pair addresses from
    IUniswapV2Router02 public override router =
        IUniswapV2Router02(0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D); // The Uniswap contract used to interact with the protocol
    IWETH public weth;
    IRegistry public registry;
    // TODO interfaces for these
    address public core;
    address public uni;

    event Initialized(address indexed from); // Emmitted on deployment
    event FlashOpened(address indexed from, uint256 quantity, uint256 premium); // Emmitted on flash opening a long position
    event FlashClosed(address indexed from, uint256 quantity, uint256 payout);
    event WroteOption(address indexed from, uint256 quantity);
    event Minted(
        address indexed from,
        address indexed optionToken,
        uint256 longQuantity,
        uint256 shortQuantity
    );
    event Exercised(
        address indexed from,
        address indexed optionToken,
        uint256 quantity
    );
    event Redeemed(
        address indexed from,
        address indexed optionToken,
        uint256 quantity
    );
    event Closed(
        address indexed from,
        address indexed optionToken,
        uint256 quantity
    );

    // ===== Constructor =====

    constructor(address weth_, address registry_, address _core, address _uni) public {
        require(address(weth) == address(0x0), "INIT");
        weth = IWETH(weth_);
        core = _core;
        _uni = _uni;
        emit Initialized(msg.sender);
        registry = IRegistry(registry_);
    }

    receive() external payable {
        assert(msg.sender == address(weth)); // only accept ETH via fallback from the WETH contract
    }

    function executeCallCore(bytes calldata params) external payable {
        (bool success, bytes memory returnData) = core.call{value: msg.value}(params);
        require(success, "EXECUTION_FAIL");
    }

    function executeCallUni(bytes calldata params) external payable {
        (bool success, bytes memory returnData) = uni.call{value: msg.value}(params);
        require(success, "EXECUTION_FAIL");
    }

    // ===== Callback Implementation =====

    /**
     * @dev     The callback function triggered in a UniswapV2Pair.swap() call when the `data` parameter has data.
     * @param   sender The original msg.sender of the UniswapV2Pair.swap() call.
     * @param   amount0 The quantity of token0 received to the `to` address in the swap() call.
     * @param   amount1 The quantity of token1 received to the `to` address in the swap() call.
     * @param   data The payload passed in the `data` parameter of the swap() call.
     */
    function uniswapV2Call(
        address sender,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external override {
      assert(msg.sender == factory.getPair(IUniswapV2Pair(msg.sender).token0(), IUniswapV2Pair(msg.sender).token1())); /// ensure that msg.sender is actually a V2 pair
      (bool success, bytes memory returnData) = address(this).call(data);
      require(
          success &&
              (returnData.length == 0 || abi.decode(returnData, (bool))),
          "UNI"
      );
    }
}
