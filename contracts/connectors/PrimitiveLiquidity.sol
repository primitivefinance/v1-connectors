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
 * @title   Primitive Liquidity
 * @author  Primitive
 * @notice  Manage liquidity on Uniswap & Sushiswap Venues.
 * @dev     @primitivefi/v1-connectors@v2.0.0
 */

// Open Zeppelin
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
// Interfaces
import {
    IPrimitiveLiquidity,
    IUniswapV2Router02,
    IUniswapV2Factory,
    IUniswapV2Pair,
    IERC20Permit,
    IOption
} from "../interfaces/IPrimitiveLiquidity.sol";
// Primitive
import {PrimitiveConnector} from "./PrimitiveConnector.sol";
import {CoreLib, SafeMath} from "../libraries/CoreLib.sol";

interface DaiPermit {
    function permit(
        address holder,
        address spender,
        uint256 nonce,
        uint256 expiry,
        bool allowed,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

contract PrimitiveLiquidity is PrimitiveConnector, IPrimitiveLiquidity, ReentrancyGuard {
    using SafeERC20 for IERC20; // Reverts when `transfer` or `transferFrom` erc20 calls don't return proper data
    using SafeMath for uint256; // Reverts on math underflows/overflows

    event Initialized(address indexed from); // Emitted on deployment.
    event AddLiquidity(address indexed from, address indexed option, uint256 liquidity);
    event RemoveLiquidity(
        address indexed from,
        address indexed option,
        uint256 totalUnderlying
    );

    IUniswapV2Factory private _factory; // The Uniswap V2 factory contract to get pair addresses from.
    IUniswapV2Router02 private _router; // The Uniswap Router contract used to interact with the protocol.

    // ===== Constructor =====
    constructor(
        address weth_,
        address primitiveRouter_,
        address factory_,
        address router_
    ) public PrimitiveConnector(weth_, primitiveRouter_) {
        _factory = IUniswapV2Factory(factory_);
        _router = IUniswapV2Router02(router_);
        emit Initialized(_msgSender());
    }

    // ===== Liquidity Operations =====

    /**
     * @dev     Adds redeemToken liquidity to a redeem<>underlyingToken pair by minting redeemTokens with underlyingTokens.
     * @notice  Pulls underlying tokens from _msgSender() and pushes UNI-V2 liquidity tokens to the "getCaller()" address.
     *          underlyingToken -> redeemToken -> UNI-V2.
     * @param   optionAddress The address of the optionToken to get the redeemToken to mint then provide liquidity for.
     * @param   quantityOptions The quantity of underlyingTokens to use to mint option + redeem tokens.
     * @param   amountBMax The quantity of underlyingTokens to add with redeemTokens to the Uniswap V2 Pair.
     * @param   amountBMin The minimum quantity of underlyingTokens expected to provide liquidity with.
     * @param   to The address that receives UNI-V2 shares.
     * @param   deadline The timestamp to expire a pending transaction.
     */
    function addShortLiquidityWithUnderlying(
        address optionAddress,
        uint256 quantityOptions,
        uint256 amountBMax,
        uint256 amountBMin,
        address to,
        uint256 deadline
    )
        public
        override
        nonReentrant
        onlyRegistered(IOption(optionAddress))
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        uint256 amountA;
        uint256 amountB;
        uint256 liquidity;
        address underlying = IOption(optionAddress).getUnderlyingTokenAddress();
        // Pulls total = (quantityOptions + amountBMax) of underlyingTokens from `getCaller()` to this contract.
        {
            uint256 sum = quantityOptions.add(amountBMax);
            _transferFromCaller(underlying, sum);
        }
        // Pushes underlyingTokens to option contract and mints option + redeem tokens to this contract.
        IERC20(underlying).safeTransfer(optionAddress, quantityOptions);
        (, uint256 outputRedeems) = IOption(optionAddress).mintOptions(address(this));

        {
            // scope for adding exact liquidity, avoids stack too deep errors
            IOption optionToken = IOption(optionAddress);
            address redeem = optionToken.redeemToken();
            AddAmounts memory params;
            params.amountAMax = outputRedeems;
            params.amountBMax = amountBMax;
            params.amountAMin = outputRedeems;
            params.amountBMin = amountBMin;
            params.deadline = deadline;
            // Approves Uniswap V2 Pair pull tokens from this contract.
            checkApproval(redeem, address(_router));
            checkApproval(underlying, address(_router));
            // Adds liquidity to Uniswap V2 Pair and returns liquidity shares to the "getCaller()" address.
            (amountA, amountB, liquidity) = _addLiquidity(redeem, underlying, params);
            // Check for exact liquidity provided.
            assert(amountA == outputRedeems);
            // Return remaining tokens
            _transferToCaller(underlying);
            _transferToCaller(redeem);
            _transferToCaller(address(optionToken));
        }
        emit AddLiquidity(getCaller(), optionAddress, liquidity);
        return (amountA, amountB, liquidity);
    }

    /**
     * @dev     Adds redeemToken liquidity to a redeem<>underlyingToken pair by minting shortOptionTokens with underlyingTokens.
     * @notice  Pulls underlying tokens from _msgSender() and pushes UNI-V2 liquidity tokens to the "getCaller()" address.
     *          underlyingToken -> redeemToken -> UNI-V2. Uses permit so user does not need to `approve()` our contracts.
     * @param   optionAddress The address of the optionToken to get the redeemToken to mint then provide liquidity for.
     * @param   quantityOptions The quantity of underlyingTokens to use to mint option + redeem tokens.
     * @param   amountBMax The quantity of underlyingTokens to add with shortOptionTokens to the Uniswap V2 Pair.
     * @param   amountBMin The minimum quantity of underlyingTokens expected to provide liquidity with.
     * @param   to The address that receives UNI-V2 shares.
     * @param   deadline The timestamp to expire a pending transaction.
     */
    function addShortLiquidityWithUnderlyingWithPermit(
        address optionAddress,
        uint256 quantityOptions,
        uint256 amountBMax,
        uint256 amountBMin,
        address to,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    )
        external
        override
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        {
            // avoids stack too deep errors
            address underlying = IOption(optionAddress).getUnderlyingTokenAddress();
            uint256 sum = quantityOptions.add(amountBMax);
            IERC20Permit(underlying).permit(
                getCaller(),
                address(_primitiveRouter),
                sum,
                deadline,
                v,
                r,
                s
            );
        }
        return
            addShortLiquidityWithUnderlying(
                optionAddress,
                quantityOptions,
                amountBMax,
                amountBMin,
                to,
                deadline
            );
    }

    /**
     * @notice  Specialized function for `permit` calling on Put options (DAI).
     */
    function addShortLiquidityWithUnderlyingWithDaiPermit(
        address optionAddress,
        uint256 quantityOptions,
        uint256 amountBMax,
        uint256 amountBMin,
        address to,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    )
        external
        override
        nonReentrant
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        address underlying = IOption(optionAddress).getUnderlyingTokenAddress();
        DaiPermit(underlying).permit(
            getCaller(),
            address(this),
            IERC20Permit(underlying).nonces(getCaller()),
            deadline,
            true,
            v,
            r,
            s
        );
        return
            addShortLiquidityWithUnderlying(
                optionAddress,
                quantityOptions,
                amountBMax,
                amountBMin,
                to,
                deadline
            );
    }

    /**
     * @dev     Adds redeemToken liquidity to a redeem<>underlyingToken pair by minting shortOptionTokens with underlyingTokens.
     * @notice  Pulls underlying tokens from _msgSender() and pushes UNI-V2 liquidity tokens to the "getCaller()" address.
     *          underlyingToken -> redeemToken -> UNI-V2.
     * @param   optionAddress The address of the optionToken to get the redeemToken to mint then provide liquidity for.
     * @param   quantityOptions The quantity of underlyingTokens to use to mint option + redeem tokens.
     * @param   amountBMax The quantity of underlyingTokens to add with shortOptionTokens to the Uniswap V2 Pair.
     * @param   amountBMin The minimum quantity of underlyingTokens expected to provide liquidity with.
     * @param   to The address that receives UNI-V2 shares.
     * @param   deadline The timestamp to expire a pending transaction.
     */
    function addShortLiquidityWithETH(
        address optionAddress,
        uint256 quantityOptions,
        uint256 amountBMax,
        uint256 amountBMin,
        address to,
        uint256 deadline
    )
        public
        payable
        override
        nonReentrant
        onlyRegistered(IOption(optionAddress))
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        require(
            quantityOptions.add(amountBMax) >= msg.value,
            "PrimitiveLiquidity: INSUFFICIENT"
        );

        uint256 amountA;
        uint256 amountB;
        uint256 liquidity;
        address underlying = IOption(optionAddress).getUnderlyingTokenAddress();
        require(underlying == address(_weth), "PrimitiveLiquidity: NOT_WETH");

        _depositETH(); // Wraps `msg.value` to Weth.
        // Pushes Weth to option contract and mints option + redeem tokens to this contract.
        IERC20(underlying).safeTransfer(optionAddress, quantityOptions);
        (, uint256 outputRedeems) = IOption(optionAddress).mintOptions(address(this));

        {
            // scope for adding exact liquidity, avoids stack too deep errors
            IOption optionToken = IOption(optionAddress);
            address redeem = optionToken.redeemToken();
            AddAmounts memory params;
            params.amountAMax = outputRedeems;
            params.amountBMax = amountBMax;
            params.amountAMin = outputRedeems;
            params.amountBMin = amountBMin;
            params.deadline = deadline;

            // Approves Uniswap V2 Pair pull tokens from this contract.
            checkApproval(redeem, address(_router));
            checkApproval(underlying, address(_router));
            // Adds liquidity to Uniswap V2 Pair.
            (amountA, amountB, liquidity) = _addLiquidity(redeem, underlying, params);
            assert(amountA == outputRedeems); // Check for exact liquidity provided.
            // Return remaining tokens and ether.
            _withdrawETH();
            _transferToCaller(redeem);
            _transferToCaller(address(optionToken));
        }
        emit AddLiquidity(getCaller(), optionAddress, liquidity);
        return (amountA, amountB, liquidity);
    }

    struct AddAmounts {
        uint256 amountAMax;
        uint256 amountBMax;
        uint256 amountAMin;
        uint256 amountBMin;
        uint256 deadline;
    }

    /**
     * @notice  Calls UniswapV2Router02.addLiquidity() function using this contract's tokens.
     * @param   tokenA The first token of the Uniswap Pair to add as liquidity.
     * @param   tokenB The second token of the Uniswap Pair to add as liquidity.
     * @param   params The amounts specified to be added as liquidity. Adds exact short options.
     * @return  Returns the (amountTokenA, amountTokenB, liquidity).
     */
    function _addLiquidity(
        address tokenA,
        address tokenB,
        AddAmounts memory params
    )
        internal
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        return
            _router.addLiquidity(
                tokenA,
                tokenB,
                params.amountAMax,
                params.amountBMax,
                params.amountAMin,
                params.amountBMin,
                getCaller(),
                params.deadline
            );
    }

    /**
     * @dev     Combines Uniswap V2 Router "removeLiquidity" function with Primitive "closeOptions" function.
     * @notice  Pulls UNI-V2 liquidity shares with shortOption<>underlying token, and optionTokens from _msgSender().
     *          Then closes the longOptionTokens and withdraws underlyingTokens to the "getCaller()" address.
     *          Sends underlyingTokens from the burned UNI-V2 liquidity shares to the "getCaller()" address.
     *          UNI-V2 -> optionToken -> underlyingToken.
     * @param   optionAddress The address of the option that will be closed from burned UNI-V2 liquidity shares.
     * @param   liquidity The quantity of liquidity tokens to pull from _msgSender() and burn.
     * @param   amountAMin The minimum quantity of shortOptionTokens to receive from removing liquidity.
     * @param   amountBMin The minimum quantity of underlyingTokens to receive from removing liquidity.
     * @param   to The address that receives underlyingTokens from burned UNI-V2, and underlyingTokens from closed options.
     * @param   deadline The timestamp to expire a pending transaction.
     */
    function removeShortLiquidityThenCloseOptions(
        address optionAddress,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    )
        public
        override
        nonReentrant
        onlyRegistered(IOption(optionAddress))
        returns (uint256)
    {
        IOption optionToken = IOption(optionAddress);
        (IUniswapV2Pair pair, address underlying, address redeem) =
            getOptionPair(optionToken);
        // Gets amounts struct.
        RemoveAmounts memory params;
        params.liquidity = liquidity;
        params.amountAMin = amountAMin;
        params.amountBMin = amountBMin;
        params.deadline = deadline;
        _transferFromCaller(address(pair), liquidity); // Pulls lp tokens from `getCaller()`.
        checkApproval(address(pair), address(_router)); // Checks lp tokens can be pulled from here.
        // Calls removeLiquidity on the UniswapV2Router02.
        (, uint256 underlyingAmount) = _removeLiquidity(redeem, underlying, params);
        uint256 underlyingProceeds = _closeOptions(optionToken); // Returns amount of underlying tokens released.
        // Return remaining tokens/ether.
        _transferToCaller(redeem); // Push any remaining redeemTokens from removing liquidity (dust).
        if (underlying == address(_weth)) {
            _withdrawETH(); // Unwraps Weth and sends ether to `getCaller()`.
        } else {
            _transferToCaller(underlying); // Pushes underlying token to `getCaller()`.
        }
        uint256 sum = underlyingProceeds.add(underlyingAmount); // Total underlyings sent to `getCaller()`.
        emit RemoveLiquidity(getCaller(), address(optionToken), sum);
        return sum;
    }

    struct RemoveAmounts {
        uint256 liquidity;
        uint256 amountAMin;
        uint256 amountBMin;
        uint256 deadline;
    }

    /**
     * @notice  Calls UniswapV2Router02.removeLiquidity() to burn LP tokens for pair tokens.
     * @param   tokenA The first token of the pair.
     * @param   tokenB The second token of the pair.
     * @param   params The amounts to specify the amount to remove and minAmounts to withdraw.
     * @return  Returns (amountTokenA, amountTokenB) to this contract.
     */
    function _removeLiquidity(
        address tokenA,
        address tokenB,
        RemoveAmounts memory params
    ) internal returns (uint256, uint256) {
        return
            _router.removeLiquidity(
                tokenA,
                tokenB,
                params.liquidity,
                params.amountAMin,
                params.amountBMin,
                address(this),
                params.deadline
            );
    }

    /**
     * @notice  Pulls LP tokens, burns them, removes liquidity, pull option token, burns then, pushes all underlying tokens.
     * @dev     Uses permit to pull LP tokens.
     * @param   optionAddress The address of the option that will be closed from burned UNI-V2 liquidity shares.
     * @param   liquidity The quantity of liquidity tokens to pull from _msgSender() and burn.
     * @param   amountAMin The minimum quantity of shortOptionTokens to receive from removing liquidity.
     * @param   amountBMin The minimum quantity of underlyingTokens to receive from removing liquidity.
     * @param   to The address that receives underlyingTokens from burned UNI-V2, and underlyingTokens from closed options.
     * @param   deadline The timestamp to expire a pending transaction and `permit` call.
     */
    function removeShortLiquidityThenCloseOptionsWithPermit(
        address optionAddress,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external override onlyRegistered(IOption(optionAddress)) returns (uint256) {
        IOption optionToken = IOption(optionAddress);
        uint256 liquidity_ = liquidity;
        uint256 deadline_ = deadline;
        uint256 amountAMin_ = amountAMin;
        uint256 amountBMin_ = amountBMin;
        address to_ = to;
        {
            uint8 v_ = v;
            bytes32 r_ = r;
            bytes32 s_ = s;
            (IUniswapV2Pair pair, , ) = getOptionPair(optionToken);
            pair.permit(
                getCaller(),
                address(_primitiveRouter),
                liquidity_,
                deadline_,
                v_,
                r_,
                s_
            );
        }
        return
            removeShortLiquidityThenCloseOptions(
                address(optionToken),
                liquidity_,
                amountAMin_,
                amountBMin_,
                to_,
                deadline_
            );
    }

    // ===== View =====

    /**
     * @notice  Gets the UniswapV2Router02 contract address.
     */
    function getRouter() public view override returns (IUniswapV2Router02) {
        return _router;
    }

    /**
     * @notice  Gets the UniswapV2Factory contract address.
     */
    function getFactory() public view override returns (IUniswapV2Factory) {
        return _factory;
    }

    /**
     * @notice  Fetchs the Uniswap Pair for an option's redeemToken and underlyingToken params.
     * @param   option The option token to get the corresponding UniswapV2Pair market.
     * @return  The pair address, as well as the tokens of the pair.
     */
    function getOptionPair(IOption option)
        public
        view
        override
        returns (
            IUniswapV2Pair,
            address,
            address
        )
    {
        address redeem = option.redeemToken();
        address underlying = option.getUnderlyingTokenAddress();
        IUniswapV2Pair pair = IUniswapV2Pair(_factory.getPair(redeem, underlying));
        return (pair, underlying, redeem);
    }
}
