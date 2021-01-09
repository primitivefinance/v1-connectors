// SPDX-License-Identifier: MIT
pragma solidity 0.6.2;

/**
 * @title   A Test Contract Version of the Primitive Router for Custom Uniswap Addresses
 * @notice  Primitive Router - @primitivefi/v1-connectors@v1.3.0
 * @author  Primitive
 */

import {PrimitiveRouter, IUniswapV2Factory, IUniswapV2Router02} from "../PrimitiveRouter.sol";

contract PrimitiveRouterTest is
    PrimitiveRouter
{

    constructor(address weth_, address router_, address factory_) public PrimitiveRouter(weth_) {
        factory = IUniswapV2Factory(factory_);
        router = IUniswapV2Router02(router_);
    }
}
