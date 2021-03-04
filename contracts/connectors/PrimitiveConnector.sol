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
// Primitive
import {CoreLib, IOption} from "../libraries/CoreLib.sol";
import {
    IPrimitiveConnector,
    IPrimitiveRouter,
    IWETH
} from "../interfaces/IPrimitiveConnector.sol";

import "hardhat/console.sol";

abstract contract PrimitiveConnector is IPrimitiveConnector, Context {
    using SafeERC20 for IERC20; // Reverts when `transfer` or `transferFrom` erc20 calls don't return proper data

    IWETH internal _weth;
    IPrimitiveRouter internal _primitiveRouter;
    mapping(address => mapping(address => bool)) internal _approved;

    // ===== Constructor =====

    constructor(address weth_, address primitiveRouter_) public {
        _weth = IWETH(weth_);
        _primitiveRouter = IPrimitiveRouter(primitiveRouter_);
        checkApproval(weth_, primitiveRouter_);
    }

    /**
     * @notice Reverts if the `option` is not deployed from the Primitive Registry.
     */
    modifier onlyRegistered(IOption option) {
        require(
            _primitiveRouter.getRegisteredOption(address(option)),
            "PrimitiveSwaps: EVIL_OPTION"
        );
        _;
    }

    // ===== Functions =====

    /**
     * @notice  Approves the `spender` to pull `token` from this contract.
     * @dev     This contract does not hold funds, infinite approvals cannot be exploited for profit.
     */
    function checkApproval(address token, address spender)
        public
        override
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
            _weth.deposit.value(msg.value)();
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
            _primitiveRouter.transferFromCaller(token, quantity);
            return true;
        }
        return false;
    }

    /**
     * @notice  Pushes this contract's balance of `token` to `getCaller()`.
     * @dev     getCaller() is the original `msg.sender` of the Router's `execute` fn.
     */
    function _transferToCaller(address token) internal returns (bool) {
        uint256 quantity = IERC20(token).balanceOf(address(this));
        if (quantity > 0) {
            IERC20(token).safeTransfer(getCaller(), quantity);
            return true;
        }
        return false;
    }

    /**
     * @notice  Calls the Router to pull `token` from the getCaller() and send them to this contract.
     * @dev     This eliminates the need for users to approve the Router and each connector.
     */
    function _transferFromCallerToReceiver(
        address token,
        uint256 quantity,
        address receiver
    ) internal returns (bool) {
        if (quantity > 0) {
            _primitiveRouter.transferFromCallerToReceiver(
                token,
                quantity,
                receiver
            );
            return true;
        }
        return false;
    }

    function _mintOptions(IOption optionToken)
        internal
        returns (uint256, uint256)
    {
        address underlying = optionToken.getUnderlyingTokenAddress();
        _transferBalanceToReceiver(underlying, address(optionToken));
        return optionToken.mintOptions(address(this));
    }

    function _mintOptionsToReceiver(IOption optionToken, address receiver)
        internal
        returns (uint256, uint256)
    {
        address underlying = optionToken.getUnderlyingTokenAddress();
        _transferBalanceToReceiver(underlying, address(optionToken));
        return optionToken.mintOptions(receiver);
    }

    function _mintOptionsPermitted(IOption optionToken, uint256 quantity)
        internal
        returns (uint256, uint256)
    {
        require(quantity > 0, "ERR_ZERO");
        _transferFromCallerToReceiver(
            optionToken.getUnderlyingTokenAddress(),
            quantity,
            address(optionToken)
        );
        return optionToken.mintOptions(address(this));
    }

    function _closeOptions(IOption optionToken) internal returns (uint256) {
        address redeem = optionToken.redeemToken();
        uint256 quantity =
            _transferBalanceToReceiver(redeem, address(optionToken));

        if (optionToken.getExpiryTime() >= now) {
            _transferFromCallerToReceiver(
                address(optionToken),
                CoreLib.getProportionalLongOptions(optionToken, quantity),
                address(optionToken)
            );
        }

        (, , uint256 outputUnderlyings) =
            optionToken.closeOptions(address(this));
        return outputUnderlyings;
    }

    function _exerciseOptions(IOption optionToken, uint256 amount)
        internal
        returns (uint256, uint256)
    {
        address strike = optionToken.getStrikeTokenAddress();
        _transferBalanceToReceiver(strike, address(optionToken));
        IERC20(address(optionToken)).safeTransfer(address(optionToken), amount);
        return optionToken.exerciseOptions(getCaller(), amount, new bytes(0));
    }

    function _redeemOptions(IOption optionToken) internal returns (uint256) {
        address redeem = optionToken.redeemToken();
        _transferBalanceToReceiver(redeem, address(optionToken));
        return optionToken.redeemStrikeTokens(getCaller());
    }

    function _transferBalanceToReceiver(address token, address receiver)
        internal
        returns (uint256)
    {
        uint256 quantity = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(receiver, quantity);
        return quantity;
    }

    // ===== Fallback =====
    receive() external payable {
        assert(_msgSender() == address(_weth)); // only accept ETH via fallback from the WETH contract
    }

    // ===== View =====

    function isApproved(address token, address spender)
        public
        view
        override
        returns (bool)
    {
        return _approved[token][spender];
    }

    function getWeth() public view override returns (IWETH) {
        return _weth;
    }

    function getPrimitiveRouter()
        public
        view
        override
        returns (IPrimitiveRouter)
    {
        return _primitiveRouter;
    }

    function getCaller() public view override returns (address) {
        return _primitiveRouter.getCaller();
    }
}
