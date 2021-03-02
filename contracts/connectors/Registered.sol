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
 * @title   Low-level abstract contract for verifying Primitive Options against the Registry.
 * @notice  Registered - @primitivefi/v1-connectors@v2.0.0
 * @author  Primitive
 */

// Primitive
import {
    IRegistry
} from "@primitivefi/contracts/contracts/option/interfaces/IRegistry.sol";
import {
    IOption
} from "@primitivefi/contracts/contracts/option/interfaces/IOption.sol";

contract Registered {
    IRegistry internal _registry;

    // ===== Constructor =====

    constructor(address registry_) public {
        //require(address(registry_) == address(0x0), "Registered: INITIALIZED");
        _registry = IRegistry(registry_);
    }

    /**
     * @notice Reverts if the `option` is not deployed from the Primitive Registry.
     */
    modifier onlyRegistered(IOption option) {
        require(isRegistered(option), "PrimitiveSwaps: EVIL_OPTION");
        _;
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

    /**
     * @notice Gets the Primitive Registry.
     */
    function getRegistry() public view returns (IRegistry) {
        return _registry;
    }
}
