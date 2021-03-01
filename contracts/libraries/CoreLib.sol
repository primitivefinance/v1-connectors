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
 * @title   Library for Core Logic for Primitive Option tokens.
 * @notice  Primitive Swaps Lib - @primitivefi/v1-connectors@2.0.0
 * @author  Primitive
 */

// Primitive
import {
    IOption
} from "@primitivefi/contracts/contracts/option/interfaces/ITrader.sol";
// Open Zeppelin
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";

library CoreLib {
    using SafeMath for uint256; // Reverts on math underflows/overflows

    /**
     * @dev    Calculates the proportional quantity of long option tokens per short option token.
     * @notice For each long option token, there is quoteValue / baseValue quantity of short option tokens.
     */
    function getProportionalLongOptions(
        IOption optionToken,
        uint256 quantityShort
    ) internal view returns (uint256) {
        uint256 quantityLong =
            quantityShort.mul(optionToken.getBaseValue()).div(
                optionToken.getQuoteValue()
            );

        return quantityLong;
    }

    /**
     * @dev    Calculates the proportional quantity of short option tokens per long option token.
     * @notice For each short option token, there is baseValue / quoteValue quantity of long option tokens.
     */
    function getProportionalShortOptions(
        IOption optionToken,
        uint256 quantityLong
    ) internal view returns (uint256) {
        uint256 quantityShort =
            quantityLong.mul(optionToken.getQuoteValue()).div(
                optionToken.getBaseValue()
            );

        return quantityShort;
    }
}
