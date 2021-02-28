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
 * @title   Low-level abstract contract for Primitive Connectors to inherit from.
 * @notice  Primitive Connector - @primitivefi/v1-connectors@v2.0.0
 * @author  Primitive
 */

// Open Zeppelin
import {Context} from "@openzeppelin/contracts/GSN/Context.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

// WETH Interface
import {IPrimitiveRouter} from "../interfaces/IPrimitiveRouter.sol";
import {IWETH} from "../interfaces/IWETH.sol";

import "hardhat/console.sol";

abstract contract PrimitiveConnector is Context {
    using SafeERC20 for IERC20; // Reverts when `transfer` or `transferFrom` erc20 calls don't return proper data

    IWETH internal _weth;
    IPrimitive internal _router;
    mapping(address => mapping(address => bool)) internal _approved;

    // ===== Constructor =====

    constructor(address weth_, address router_) public {
        require(address(weth_) == address(0x0), "Connector: INITIALIZED");
        _weth = IWETH(weth_);
        _router = IPrimitiveRouter(router_);
        checkApproval(weth_, router_);
    }

    // ===== Functions =====

    /**
     * @notice  Approves the `spender` to pull `token` from this contract.
     * @dev     This contract does not hold funds, infinite approvals cannot be exploited for profit.
     */
    function checkApproval(address token, address spender)
        public
        returns (bool)
    {
        if (!_approved[token][spender]) {
            IERC20(token).safeApprove(spender, uint256(-1));
            _approved[token][spender] = true;
        }
        return true;
    }

    /**
     * @notice Deposits `msg.value` into the Weth contract for Weth tokens.
     */
    function _depositETH() internal returns (bool) {
        if (msg.value > 0) {
            _weth.deposit.value(msg.value)("");
            return true;
        }
        return false;
    }

    /**
     * @notice Pulls Weth from this contract, and returns ether to `getCaller()`.
     */
    function _withdrawETH() internal returns (bool) {
        uint256 quantity = IERC20(address(_weth)).balanceOf(address(this));
        if (quantity > 0) {
            // Withdraw ethers with weth.
            _weth.withdraw(quantity);
            // Send ether.
            (bool success, ) = getCaller().call.value(quantity)("");
            // Revert is call is unsuccessful.
            require(success, "PrimitiveV1: ERR_SENDING_ETHER");
            return success;
        }
        return true;
    }

    /**
     * @notice  Calls the Router to pull `token` from the getCaller() and send them to this contract.
     * @dev     This eliminates the need for users to approve the Router and each connector.
     */
    function _transferFromCaller(address token, uint256 quantity)
        internal
        returns (bool)
    {
        if (quantity > 0) {
            _router.transferFromCaller(token, quantity);
        }
        return true;
    }

    /**
     * @notice  Pushes this contract's balance of `token` to `getCaller()`.
     * @dev     getCaller() is the original `msg.sender` of the Router's `execute` fn.
     */
    function _transferToCaller(address token) internal returns (bool) {
        uint256 quantity = IERC20(token).balanceOf(address(this));
        if (quantity > 0) {
            IERC20(token).safeTransfer(getCaller(), quantity);
        }
        return true;
    }

    function _mintOptions(IOption optionToken)
        internal
        returns (uint256, uint256)
    {
        address underlying = optionToken.getUnderlyingTokenAddress();
        uint256 quantity = IERC20(underlying).balanceOf(address(this));
        if (quantity > 0) {
            IERC20(underlying).safeTransfer(optionAddress, quantity);
            return optionToken.mintOptions(address(this));
        }

        return (0, 0);
    }

    // ===== Fallback =====
    receive() external payable {
        assert(_msgSender() == address(_weth)); // only accept ETH via fallback from the WETH contract
    }

    // ===== View =====

    function getWeth() public view returns (IWETH) {
        return _weth;
    }

    function getRouter() public view returns (IPrimitiveRouter) {
        return _router;
    }

    function getCaller() public view returns (address) {
        return _router.getCaller();
    }
}
