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

import {
    IUniswapV2Router02
} from "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import {
    IUniswapV2Factory
} from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
import {
    IOption,
    IERC20
} from "@primitivefi/contracts/contracts/option/interfaces/IOption.sol";

interface IPrimitiveRouter {
    // ==== Flash Functions ====

    function flashMintShortOptionsThenSwap(
        address optionAddress,
        uint256 flashLoanQuantity,
        uint256 maxPremium,
        address to
    ) external payable returns (uint256, uint256);

    function flashCloseLongOptionsThenSwap(
        address optionAddress,
        uint256 flashLoanQuantity,
        uint256 minPayout,
        address to
    ) external returns (uint256, uint256);

    function openFlashLong(
        IOption optionToken,
        uint256 amountOptions,
        uint256 amountOutMin
    ) external returns (bool);

    function closeFlashLong(
        IOption optionToken,
        uint256 amountRedeems,
        uint256 minPayout
    ) external returns (bool);

    // ==== Liquidity Functions ====

    function addShortLiquidityWithUnderlying(
        address underlying,
        address strike,
        uint256 base,
        uint256 quote,
        uint256 expiry,
        uint256 quantityOptions,
        uint256 amountBMax,
        uint256 amountBMin,
        address to,
        uint256 deadline
    )
        external
        returns (
            uint256,
            uint256,
            uint256
        );

    function removeShortLiquidityThenCloseOptions(
        address optionAddress,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256, uint256);

    // ==== View ====

    function router() external view returns (IUniswapV2Router02);

    function factory() external view returns (IUniswapV2Factory);

    function getName() external pure returns (string memory);

    function getVersion() external pure returns (uint8);

    function getOpenPremium(IOption optionToken, uint256 quantityLong)
        external
        view
        returns (uint256, uint256);

    function getClosePremium(IOption optionToken, uint256 quantityShort)
        external
        view
        returns (uint256, uint256);
}
