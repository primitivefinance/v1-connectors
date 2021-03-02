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
 * @title   A Connector with Ether abstractions for Primitive Option tokens.
 * @notice  Primitive Core - @primitivefi/v1-connectors@v2.0.0
 * @author  Primitive
 */

// Open Zeppelin
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {
    ReentrancyGuard
} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
// Primitive
import {CoreLib} from "../libraries/CoreLib.sol";
import {
    IPrimitiveCore,
    IOption,
    IERC20Permit
} from "../interfaces/IPrimitiveCore.sol";
import {PrimitiveConnector} from "./PrimitiveConnector.sol";

import "hardhat/console.sol";

contract PrimitiveCore is PrimitiveConnector, IPrimitiveCore, ReentrancyGuard {
    using SafeERC20 for IERC20; // Reverts when `transfer` or `transferFrom` erc20 calls don't return proper data
    using SafeMath for uint256; // Reverts on math underflows/overflows

    event Initialized(address indexed from); // Emmitted on deployment
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

    constructor(
        address weth_,
        address primitiveRouter_,
        address registry_
    ) public PrimitiveConnector(weth_, primitiveRouter_, registry_) {
        emit Initialized(_msgSender());
    }

    // ===== Weth Abstraction =====

    /**
     * @dev     Mints msg.value quantity of options and "quote" (option parameter) quantity of redeem tokens.
     * @notice  This function is for options that have WETH as the underlying asset.
     * @param   optionToken The address of the option token to mint.
     */
    function safeMintWithETH(IOption optionToken)
        public
        payable
        override
        onlyRegistered(optionToken)
        returns (uint256, uint256)
    {
        // Check to make sure we are minting a WETH call option.
        require(
            address(_weth) == optionToken.getUnderlyingTokenAddress(),
            "PrimitiveCore: NOT_WETH"
        );
        bool success = _depositETH();
        require(success, "PrimitiveCore: ZERO");
        (uint256 long, uint256 short) = _mintOptions(optionToken);
        _transferToCaller(address(optionToken));
        _transferToCaller(optionToken.redeemToken());
        emit Minted(getCaller(), address(optionToken), long, short);
        return (long, short);
    }

    /**
     * @dev     Mints "amount" quantity of options and "quote" (option parameter) quantity of redeem tokens.
     * @notice  This function is for options that have an EIP2612 (permit) enabled token as the underlying asset.
     * @param   optionToken The address of the option token to mint.
     * @param   amount The quantity of options to mint.
     */
    function safeMintWithPermit(
        IOption optionToken,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256, uint256) {
        // Permit minting using the caller's underlying tokens
        IERC20Permit(optionToken.getUnderlyingTokenAddress()).permit(
            getCaller(),
            address(this),
            uint256(-1),
            deadline,
            v,
            r,
            s
        );
        (uint256 long, uint256 short) =
            _mintOptionsPermitted(optionToken, amount);
        emit Minted(getCaller(), address(optionToken), long, short);
        return (long, short);
    }

    /**
     * @dev     Swaps msg.value of strikeTokens (ethers) to underlyingTokens.
     *          Uses the strike ratio as the exchange rate. Strike ratio = base / quote.
     *          Msg.value (quote units) * base / quote = base units (underlyingTokens) to withdraw.
     * @notice  This function is for options with WETH as the strike asset.
     *          Burns option tokens, accepts ethers, and pushes out underlyingTokens.
     * @param   optionToken The address of the option contract.
     */
    function safeExerciseWithETH(IOption optionToken)
        public
        payable
        override
        returns (uint256, uint256)
    {
        require(msg.value > 0, "PrimitiveCore: ZERO");
        // Require one of the option's assets to be WETH.
        require(
            optionToken.getStrikeTokenAddress() == address(_weth),
            "PrimitiveCore: NOT_WETH"
        );

        _depositETH();
        uint256 long =
            CoreLib.getProportionalLongOptions(optionToken, msg.value);
        _transferFromCaller(address(optionToken), long);

        (uint256 strikes, uint256 options) =
            _exerciseOptions(optionToken, long);

        emit Exercised(getCaller(), address(optionToken), long);
        return (strikes, options);
    }

    /**
     * @dev     Swaps strikeTokens to underlyingTokens, WETH, which is converted to ethers before withdrawn.
     *          Uses the strike ratio as the exchange rate. Strike ratio = base / quote.
     * @notice  This function is for options with WETH as the underlying asset.
     *          Burns option tokens, pulls strikeTokens, and pushes out ethers.
     * @param   optionToken The address of the option contract.
     * @param   exerciseQuantity Quantity of optionTokens to exercise.
     */
    function safeExerciseForETH(IOption optionToken, uint256 exerciseQuantity)
        public
        override
        returns (uint256, uint256)
    {
        address underlying = optionToken.getUnderlyingTokenAddress();
        address strike = optionToken.getStrikeTokenAddress();
        // Require the underlying token to be Weth.
        require(underlying == address(_weth), "PrimitiveCore: NOT_WETH");

        uint256 strikeQuantity =
            CoreLib.getProportionalShortOptions(optionToken, exerciseQuantity);
        // Pull tokens to this contract
        bool success =
            _transferFromCaller(address(optionToken), exerciseQuantity);
        require(success, "PrimitiveCore: ZERO");
        _transferFromCaller(strike, strikeQuantity);

        // Push tokens to option contract
        IERC20(strike).safeTransfer(address(optionToken), strikeQuantity);
        IERC20(address(optionToken)).safeTransfer(
            address(optionToken),
            exerciseQuantity
        );

        (uint256 strikesPaid, uint256 options) =
            optionToken.exerciseOptions(
                address(this),
                exerciseQuantity,
                new bytes(0)
            );

        // Converts the withdrawn WETH to ethers, then sends the ethers to the getCaller() address.
        _withdrawETH();
        emit Exercised(getCaller(), address(optionToken), exerciseQuantity);
        return (strikesPaid, options);
    }

    /**
     * @dev     Burns redeem tokens to withdraw strike tokens (ethers) at a 1:1 ratio.
     * @notice  This function is for options that have WETH as the strike asset.
     *          Converts WETH to ethers, and withdraws ethers to the receiver address.
     * @param   optionToken The address of the option contract.
     * @param   redeemQuantity The quantity of redeemTokens to burn.
     */
    function safeRedeemForETH(IOption optionToken, uint256 redeemQuantity)
        public
        override
        returns (uint256)
    {
        address strike = optionToken.getStrikeTokenAddress();
        // Require the strike token to be Weth.
        require(strike == address(_weth), "PrimitiveCore: NOT_WETH");
        address redeem = optionToken.redeemToken();
        console.log("pulling");
        // Pull redeems
        _transferFromCaller(redeem, redeemQuantity);
        // Push redeems to option contract
        IERC20(redeem).safeTransfer(address(optionToken), redeemQuantity);
        console.log("calling redeem", redeemQuantity);
        uint256 short = optionToken.redeemStrikeTokens(address(this));
        console.log("withdrawing");
        _withdrawETH();
        emit Redeemed(getCaller(), address(optionToken), redeemQuantity);
        return short;
    }

    /**
     * @dev Burn optionTokens and redeemTokens to withdraw underlyingTokens (ethers).
     * @notice This function is for options with WETH as the underlying asset.
     * WETH underlyingTokens are converted to ethers before being sent to receiver.
     * The redeemTokens to burn is equal to the optionTokens * strike ratio.
     * inputOptions = inputRedeems / strike ratio = outUnderlyings
     * @param optionToken The address of the option contract.
     * @param closeQuantity Quantity of optionTokens to burn and an input to calculate how many redeems to burn.
     */
    function safeCloseForETH(IOption optionToken, uint256 closeQuantity)
        public
        override
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        address redeem = optionToken.redeemToken();
        address underlying = optionToken.getUnderlyingTokenAddress();
        require(underlying == address(_weth), "PrimitiveCore: NOT_WETH");

        uint256 short =
            CoreLib.getProportionalShortOptions(optionToken, closeQuantity);
        // Pull tokens
        _transferFromCaller(redeem, short);

        if (optionToken.getExpiryTime() >= now) {
            _transferFromCaller(address(optionToken), closeQuantity);
            // Push tokens to option contract
            IERC20(address(optionToken)).safeTransfer(
                address(optionToken),
                closeQuantity
            );
        }
        IERC20(redeem).safeTransfer(address(optionToken), short);
        (uint256 inputRedeems, uint256 inputOptions, uint256 outUnderlyings) =
            optionToken.closeOptions(address(this));

        _withdrawETH();
        emit Closed(getCaller(), address(optionToken), closeQuantity);
        return (inputRedeems, inputOptions, outUnderlyings);
    }
}
