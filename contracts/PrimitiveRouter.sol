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
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {
    ReentrancyGuard
} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import {
    IPrimitiveRouter,
    IUniswapV2Router02,
    IUniswapV2Factory,
    IRegistry,
    IOption,
    IERC20,
    IWETH
} from "./interfaces/IPrimitiveRouter.sol";

/**
 * @notice  Used to execute calls on behalf of the Router contract.
 * @dev     Changes `msg.sender` context so the Router is not `msg.sender`.
 */
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
    Ownable,
    Pausable,
    ReentrancyGuard
{
    using SafeERC20 for IERC20; // Reverts when `transfer` or `transferFrom` erc20 calls don't return proper data
    using SafeMath for uint256; // Reverts on math underflows/overflows

    address private constant _NO_CALLER = address(0x0); // Default state for `_CALLER`.

    event Initialized(address indexed from); // Emmitted on deployment
    event Executed(address indexed from, address indexed to, bytes params);
    event RegisteredOption(address indexed option, bool registered);
    event RegisteredConnector(address indexed connector, bool registered);

    IUniswapV2Factory public factory =
        IUniswapV2Factory(0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f); // The Uniswap V2 factory contract to get pair addresses from
    IUniswapV2Router02 public router;

    IRegistry private _registry;
    IWETH private _weth;
    Route private _route;

    bool public initialized;

    mapping(address => bool) private _registeredConnectors;
    mapping(address => bool) private _registeredOptions;

    /**
     * @dev If the `execute` function was called this block.
     */
    bool private _EXECUTING;
    /**
     * @dev If _EXECUTING, the orginal `_msgSender()` of the execute call.
     */
    address private _CALLER = _NO_CALLER;

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

    // ===== Constructor =====

    constructor(address weth_, address registry_) public {
        require(address(_weth) == address(0x0), "INIT");
        _weth = IWETH(weth_);
        _registry = IRegistry(registry_);
        _route = new Route();
        emit Initialized(_msgSender());
    }

    /**
     * @notice  Initialize Router with its registered connectors contracts.
     * @notice  Can only be called once, while initialized == false.
     */
    function init(address[] calldata connectors, bool[] calldata isValid)
        external
        override
        onlyOwner
        nonReentrant
        returns (bool)
    {
        require(initialized == false, "ALREADY_INITIALIZED");
        initialized = true;
        return setRegisteredConnectors(connectors, isValid);
    }

    function halt() external override onlyOwner {
        if (paused()) {
            _unpause();
        } else {
            _pause();
        }
    }

    function setRegisteredOptions(
        address[] memory optionAddresses,
        bool[] memory isValid
    ) public override onlyOwner returns (bool) {
        uint256 len = optionAddresses.length;
        require(len == isValid.length, "PrimitiveRouter: LENGTHS");
        for (uint256 i = 0; i < len; i++) {
            address option = optionAddresses[i];
            bool status = isValid[i];
            require(
                isRegistered(IOption(option)),
                "PrimitiveRouter: EVIL_OPTION"
            );
            _registeredOptions[option] = isValid[i];
            emit RegisteredOption(option, status);
        }
        return true;
    }

    function setRegisteredConnectors(
        address[] memory connectors,
        bool[] memory isValid
    ) public override onlyOwner returns (bool) {
        uint256 len = connectors.length;
        require(len == isValid.length, "PrimitiveRouter: LENGTHS");
        for (uint256 i = 0; i < len; i++) {
            address connector = connectors[i];
            bool status = isValid[i];
            _registeredOptions[connector] = isValid[i];
            emit RegisteredConnector(connector, status);
        }
        return true;
    }

    /**
     * @notice  Checks an option against the Primitive Registry.
     * @return  Whether or not the option was deployed from the Primitive Registry.
     */
    function isRegistered(IOption option) internal view returns (bool) {
        return (address(option) ==
            _registry.getOptionAddress(
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
        whenNotPaused
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
    ) public override isExec whenNotPaused returns (bool) {
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
        whenNotPaused
    {
        require(_registeredConnectors[connector], "INVALID_CONNECTOR");
        _CALLER = _msgSender();
        _route.executeCall.value(msg.value)(connector, params);
        _CALLER = _NO_CALLER;
        emit Executed(_msgSender(), connector, params);
    }

    // ===== Fallback =====

    receive() external payable whenNotPaused {
        assert(_msgSender() == address(_weth)); // only accept ETH via fallback from the WETH contract
    }

    // ===== Execution Context =====

    function getWeth() public view override returns (IWETH) {
        return _weth;
    }

    function getRegistry() public view override returns (IRegistry) {
        return _registry;
    }

    function getRoute() public view override returns (address) {
        return address(_route);
    }

    function getCaller() public view override returns (address) {
        return _CALLER;
    }

    function getRegisteredOption(address option)
        external
        view
        override
        returns (bool)
    {
        return _registeredOptions[option];
    }

    function getRegisteredConnector(address connector)
        external
        view
        override
        returns (bool)
    {
        return _registeredConnectors[connector];
    }

    function apiVersion() public pure override returns (string memory) {
        return "2.0.0";
    }
}
