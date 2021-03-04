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
 * @title   Contract to execute Primitive Connector functions.
 * @notice  Primitive Router - @primitivefi/v1-connectors@v2.0.0
 * @author  Primitive
 */

// Open Zeppelin
import {Context} from "@openzeppelin/contracts/GSN/Context.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {
    ReentrancyGuard
} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IWETH} from "./interfaces/IWETH.sol";
import {
    IRegistry
} from "@primitivefi/contracts/contracts/option/interfaces/IRegistry.sol";
import {
    IPrimitiveRouter,
    IUniswapV2Router02,
    IUniswapV2Factory,
    IOption,
    IERC20
} from "./interfaces/IPrimitiveRouter.sol";

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

contract PrimitiveRouter is IPrimitiveRouter, ReentrancyGuard, Context {
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
    bool public _halt;

    mapping(address => bool) internal _validOptions;

    event Initialized(address indexed from); // Emmitted on deployment
    event Executed(address indexed from, address indexed to, bytes params);

    address internal constant _NO_CALLER = address(0x0);
    /**
     * @dev If the `execute` function was called this block.
     */
    bool private _EXECUTING;
    /**
     * @dev If _EXECUTING, the orginal `_msgSender()` of the execute call.
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
        require(_halt == false, "CONTRACT_HALTED");
        _;
    }

    Route internal _route;

    // ===== Constructor =====

    constructor(address weth_, address registry_) public {
        require(address(weth) == address(0x0), "INIT");
        deployer = _msgSender();
        weth = IWETH(weth_);
        registry = IRegistry(registry_);
        _route = new Route();
        emit Initialized(_msgSender());
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
    ) external override notHalted nonReentrant returns (bool) {
        require(initialized == false, "ALREADY_INITIALIZED");
        initialized = true;
        validConnectors[core] = true;
        validConnectors[liquidity] = true;
        validConnectors[swaps] = true;
        return true;
    }

    function halt() external {
        require(deployer == _msgSender(), "NOT_DEPLOYER");
        _halt = true;
    }

    function validateOption(address option)
        external
        override
        notHalted
        returns (bool)
    {
        IOption _option = IOption(option);
        require(isRegistered(_option), "EVIL_OPTION");
        _validOptions[option] = true;
        return true;
    }

    /**
     * @notice  Checks an option against the Primitive Registry.
     * @return  Whether or not the option was deployed from the Primitive Registry.
     */
    function isRegistered(IOption option) internal view returns (bool) {
        return (address(option) ==
            registry.getOptionAddress(
                option.getUnderlyingTokenAddress(),
                option.getStrikeTokenAddress(),
                option.getBaseValue(),
                option.getQuoteValue(),
                option.getExpiryTime()
            ) &&
            address(option) != address(0));
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

    /**
     * @notice  Transfers ERC20 tokens from the executing `_CALLER` to an arbitrary address.
     * @param   token The address of the ERC20.
     * @param   amount The amount of ERC20 to transfer.
     * @return  Whether or not the transfer succeeded.
     */
    function transferFromCallerToReceiver(
        address token,
        uint256 amount,
        address receiver
    ) public override isExec notHalted returns (bool) {
        IERC20(token).safeTransferFrom(
            getCaller(), // Account to pull from
            receiver,
            amount
        );
        return true;
    }

    // ===== Execute =====

    function executeCall(address connector, bytes calldata params)
        external
        payable
        override
        notHalted
    {
        require(validConnectors[connector], "INVALID_CONNECTOR");
        _CALLER = _msgSender();
        _route.executeCall.value(msg.value)(connector, params);
        _CALLER = _NO_CALLER;
        emit Executed(_msgSender(), connector, params);
    }

    // ===== Fallback =====

    receive() external payable notHalted {
        assert(_msgSender() == address(weth)); // only accept ETH via fallback from the WETH contract
    }

    // ===== Execution Context =====

    function getRoute() public view override returns (address) {
        return address(_route);
    }

    function getCaller() public view override returns (address) {
        return _CALLER;
    }

    function validOptions(address option)
        external
        view
        override
        returns (bool)
    {
        return _validOptions[option];
    }

    function apiVersion() public pure override returns (string memory) {
        return "2.0.0";
    }
}
