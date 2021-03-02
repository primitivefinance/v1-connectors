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
 * @title   The execution entry point for using Primitive Connector contracts.
 * @notice  Primitive Router - @primitivefi/v1-connectors@v1.3.0
 * @author  Primitive
 */

// Open Zeppelin
import {Context} from "@openzeppelin/contracts/GSN/Context.sol";
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
import {
    IRegistry
} from "@primitivefi/contracts/contracts/option/interfaces/IRegistry.sol";

import "hardhat/console.sol";

contract Route {
    function executeCall(address target, bytes calldata params)
        external
        payable
    {
        (bool success, bytes memory returnData) =
            target.call.value(msg.value)(params);
        require(success, "Route: EXECUTION_FAIL");
    }
}

contract PrimitiveRouter is
    IPrimitiveRouter,
    IUniswapV2Callee,
    ReentrancyGuard,
    Context
{
    using SafeERC20 for IERC20; // Reverts when `transfer` or `transferFrom` erc20 calls don't return proper data
    using SafeMath for uint256; // Reverts on math underflows/overflows

    // fix for testing
    IUniswapV2Factory public factory =
        IUniswapV2Factory(0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f); // The Uniswap V2 factory contract to get pair addresses from
    IUniswapV2Router02 public router;

    IWETH public weth;
    IRegistry public registry;

    address public deployer;

    mapping(address => bool) public validConnectors;
    bool public initialized;
    bool public halt;

    event Initialized(address indexed from); // Emmitted on deployment
    event Executed(address indexed from, address indexed to, bytes params);

    address internal constant _NO_CALLER = address(0x0);
    /**
     * @dev If the `execute` function was called this block.
     */
    bool private _EXECUTING;
    /**
     * @dev If _EXECUTING, the orginal `msg.sender` of the execute call.
     */
    address internal _CALLER = _NO_CALLER;

    /**
     * @notice  A mutex to use during an `execute` call.
     */
    modifier isExec() {
        require(_CALLER != _NO_CALLER, "Router: NO_CALLER");
        require(!_EXECUTING, "Router: IN_EXECUTION");
        _EXECUTING = true;
        _;
        _EXECUTING = false;
    }

    modifier notHalted() {
      require(halt == false, "CONTRACT_HALTED");
      _;
    }

    Route internal _route;

    // ===== Constructor =====

    constructor(
        address weth_,
        address registry_
    ) public {
        require(address(weth) == address(0x0), "INIT");
        deployer = msg.sender;
        weth = IWETH(weth_);
        registry = IRegistry(registry_);
        _route = new Route();
        emit Initialized(msg.sender);
    }

    /**
     * @notice  Initialize router with its valid connectors.
     * @notice  Can only be called once, while initialized == false.
     * @param   core The address of PrimitiveCore.sol
     * @param   liquidity The address of PrimitiveLiquidity.sol
     * @param   swaps The address of PrimitiveSwaps.sol
     */
    function init(
      address core,
      address liquidity,
      address swaps
    ) external notHalted {
      require(initialized == false, "ALREADY_INITIALIZED");
      initialized = true;
      validConnectors[core] = true;
      validConnectors[liquidity] = true;
      validConnectors[swaps] = true;
    }

    function halt() external {
      require(deployer == msg.sender, "NOT_DEPLOYER");
      halt = true;
    }

    // ===== Operations =====

    /**
     * @notice  Transfers ERC20 tokens from the executing `_CALLER` to the executing `_CONNECTOR`.
     * @param   token The address of the ERC20.
     * @param   amount The amount of ERC20 to transfer.
     * @return  Whether or not the transfer succeeded.
     */
    function transferFromCaller(address token, uint256 amount)
        public
        override
        isExec
        notHalted
        returns (bool)
    {
        IERC20(token).safeTransferFrom(
            getCaller(), // Account to pull from
            _msgSender(), // The connector
            amount
        );
        return true;
    }

    // ===== Execute =====

    function executeCall(address connector, bytes calldata params) external payable override notHalted {
        require(validConnectors[connector], "INVALID_CONNECTOR");
        _CALLER = _msgSender();
        _route.executeCall(connector, params);
        _CALLER = _NO_CALLER;
        emit Executed(_msgSender(), connector, params);
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
    ) external override notHalted {
        assert(
            msg.sender ==
                factory.getPair(
                    IUniswapV2Pair(msg.sender).token0(),
                    IUniswapV2Pair(msg.sender).token1()
                )
        ); /// ensure that msg.sender is actually a V2 pair
        (bool success, bytes memory returnData) = address(this).call(data);
        require(
            success &&
                (returnData.length == 0 || abi.decode(returnData, (bool))),
            "UNI"
        );
    }

    // ===== Fallback =====

    receive() external payable notHalted {
        assert(msg.sender == address(weth)); // only accept ETH via fallback from the WETH contract
    }

    // ===== Execution Context =====

    function getCaller() public view override returns (address) {
        return _CALLER;
    }
}
