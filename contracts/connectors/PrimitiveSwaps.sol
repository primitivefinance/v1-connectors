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
 * @title   A user-friendly smart contract to interface with the Primitive and Uniswap protocols.
 * @notice  Primitive Router - @primitivefi/v1-connectors@v1.3.0
 * @author  Primitive
 */

// Open Zeppelin
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {
    ReentrancyGuard
} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// Interfaces
import {
    IUniswapV2Callee
} from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Callee.sol";
import {
    IUniswapV2Pair
} from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import {
    IPrimitiveSwaps,
    IUniswapV2Router02,
    IUniswapV2Factory,
    IOption,
    IERC20Permit
} from "../interfaces/IPrimitiveSwaps.sol";
// Primitive
import {PrimitiveConnector} from "./PrimitiveConnector.sol";
import {SwapsLib} from "../libraries/SwapsLib.sol";

import "hardhat/console.sol";

contract PrimitiveSwaps is
    PrimitiveConnector,
    IPrimitiveSwaps,
    IUniswapV2Callee,
    ReentrancyGuard
{
    using SafeERC20 for IERC20; // Reverts when `transfer` or `transferFrom` erc20 calls don't return proper data
    using SafeMath for uint256; // Reverts on math underflows/overflows

    /**
     * @dev Emitted on deployment.
     */
    event Initialized(address indexed from);

    /**
     * @dev Emmitted on purchasing long option tokens.
     */
    event Buy(
        address indexed from,
        address indexed option,
        uint256 quantity,
        uint256 premium
    );

    /**
     * @dev Emmitted on selling long option tokens.
     */
    event Sell(
        address indexed from,
        address indexed option,
        uint256 quantity,
        uint256 payout
    );

    IUniswapV2Factory public factory =
        IUniswapV2Factory(0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f); // The Uniswap V2 factory contract to get pair addresses from
    IUniswapV2Router02 public router =
        IUniswapV2Router02(0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D); // The Uniswap contract used to interact with the protocol

    modifier onlySelf() {
        require(_msgSender() == address(this), "PrimitiveSwaps: NOT_SELF");
        _;
    }

    // ===== Constructor =====
    constructor(
        address weth_,
        address primitiveRouter_,
        address factory_,
        address router_
    ) public PrimitiveConnector(weth_, primitiveRouter_) {
        factory = IUniswapV2Factory(factory_);
        router = IUniswapV2Router02(router_);
        emit Initialized(_msgSender());
    }

    // ===== Swap Operations =====

    /**
     * @dev    Opens a longOptionToken position by minting long + short tokens, then selling the short tokens.
     * @notice IMPORTANT: amountOutMin parameter is the price to swap shortOptionTokens to underlyingTokens.
     *         IMPORTANT: If the ratio between shortOptionTokens and underlyingTokens is 1:1, then only the swap fee (0.30%) has to be paid.
     * @param optionToken The option address.
     * @param amountOptions The quantity of longOptionTokens to purchase.
     * @param maxPremium The maximum quantity of underlyingTokens to pay for the optionTokens.
     */
    function openFlashLong(
        IOption optionToken,
        uint256 amountOptions,
        uint256 maxPremium
    ) public override nonReentrant onlyRegistered(optionToken) returns (bool) {
        // Calls pair.swap(), and executes a fn in the `uniswapV2Callee` callback.
        (IUniswapV2Pair pair, address underlying, ) =
            getOptionPair(optionToken);
        _flashSwap(
            pair, // Pair to flash swap from
            underlying, // Token to swap to, i.e. receive optimistically
            amountOptions, // Amount of underlying to optimistically receive
            abi.encodeWithSelector(
                bytes4(
                    keccak256(
                        bytes(
                            "flashMintShortOptionsThenSwap(address,uint256,uint256)"
                        )
                    )
                ), // function to call in this contract
                optionToken, // option token to mint with flash loaned tokens
                amountOptions, // quantity of underlyingTokens from flash loan to use to mint options
                maxPremium // total price paid (in underlyingTokens) for selling shortOptionTokens
            ) // Function to execute in the `uniswapV2Callee` callback.
        );
        return true;
    }

    function openFlashLongWithPermit(
        IOption optionToken,
        uint256 amountOptions,
        uint256 maxPremium,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public override nonReentrant onlyRegistered(optionToken) returns (bool) {
        // Calls pair.swap(), and executes a fn in the `uniswapV2Callee` callback.
        (IUniswapV2Pair pair, address underlying, ) =
            getOptionPair(optionToken);
        IERC20Permit(underlying).permit(
            getCaller(),
            address(this),
            maxPremium,
            deadline,
            v,
            r,
            s
        );
        _flashSwap(
            pair, // Pair to flash swap from
            underlying, // Token to swap to, i.e. receive optimistically
            amountOptions, // Amount of underlying to optimistically receive
            abi.encodeWithSelector(
                bytes4(
                    keccak256(
                        bytes(
                            "flashMintShortOptionsThenSwap(address,uint256,uint256)"
                        )
                    )
                ), // function to call in this contract
                optionToken, // option token to mint with flash loaned tokens
                amountOptions, // quantity of underlyingTokens from flash loan to use to mint options
                maxPremium // total price paid (in underlyingTokens) for selling shortOptionTokens
            ) // Function to execute in the `uniswapV2Callee` callback.
        );
        return true;
    }

    /**
     * @dev     Opens a longOptionToken position by minting long + short tokens, then selling the short tokens.
     * @notice  IMPORTANT: amountOutMin parameter is the price to swap shortOptionTokens to underlyingTokens.
     *          IMPORTANT: If the ratio between shortOptionTokens and underlyingTokens is 1:1, then only the swap fee (0.30%) has to be paid.
     * @param   optionToken The option address.
     * @param   amountOptions The quantity of longOptionTokens to purchase.
     */
    function openFlashLongWithETH(IOption optionToken, uint256 amountOptions)
        external
        payable
        override
        onlyRegistered(optionToken)
        returns (bool)
    {
        require(msg.value > 0, "PrimitiveSwaps: ZERO");
        // Calls pair.swap(), and executes a fn in the `uniswapV2Callee` callback.
        (IUniswapV2Pair pair, address underlying, ) =
            getOptionPair(optionToken);
        _flashSwap(
            pair,
            underlying,
            amountOptions,
            abi.encodeWithSelector(
                bytes4(
                    keccak256(
                        bytes(
                            "flashMintShortOptionsThenSwapWithETH(address,uint256,uint256)"
                        )
                    )
                ), // function to call in this contract
                optionToken, // option token to mint with flash loaned tokens
                amountOptions, // quantity of underlyingTokens from flash loan to use to mint options
                msg.value // total price paid (in underlyingTokens) for selling shortOptionTokens
            )
        );
        return true;
    }

    /**
     * @dev     Closes a longOptionToken position by flash swapping in redeemTokens,
     *          closing the option, and paying back in underlyingTokens.
     * @notice  IMPORTANT: If minPayout is 0, this function will cost the caller to close the option, for no gain.
     * @param   optionToken The address of the longOptionTokens to close.
     * @param   amountRedeems The quantity of redeemTokens to borrow to close the options.
     * @param   minPayout The minimum payout of underlyingTokens sent out to the user.
     */
    function closeFlashLong(
        IOption optionToken,
        uint256 amountRedeems,
        uint256 minPayout
    )
        external
        override
        nonReentrant
        onlyRegistered(optionToken)
        returns (bool)
    {
        // Calls pair.swap(), and executes a fn in the `uniswapV2Callee` callback.
        (IUniswapV2Pair pair, , address redeem) = getOptionPair(optionToken);
        _flashSwap(
            pair,
            redeem,
            amountRedeems,
            abi.encodeWithSelector(
                bytes4(
                    keccak256(
                        bytes(
                            "flashCloseLongOptionsThenSwap(address,uint256,uint256)"
                        )
                    )
                ), // function to call in this contract
                optionToken, // option token to close with flash loaned redeemTokens
                amountRedeems, // quantity of redeemTokens from flash loan to use to close options
                minPayout // total remaining underlyingTokens after flash loan is paid
            )
        );
        return true;
    }

    /**
     * @dev     Closes a longOptionToken position by flash swapping in redeemTokens,
     *          closing the option, and paying back in underlyingTokens.
     * @notice  IMPORTANT: If minPayout is 0, this function will cost the caller to close the option, for no gain.
     * @param   optionToken The address of the longOptionTokens to close.
     * @param   amountRedeems The quantity of redeemTokens to borrow to close the options.
     * @param   minPayout The minimum payout of underlyingTokens sent out to the user.
     */
    function closeFlashLongForETH(
        IOption optionToken,
        uint256 amountRedeems,
        uint256 minPayout
    )
        external
        override
        nonReentrant
        onlyRegistered(optionToken)
        returns (bool)
    {
        // Calls pair.swap(), and executes a fn in the `uniswapV2Callee` callback.
        (IUniswapV2Pair pair, , address redeem) = getOptionPair(optionToken);
        _flashSwap(
            pair,
            redeem,
            amountRedeems,
            abi.encodeWithSelector(
                bytes4(
                    keccak256(
                        bytes(
                            "flashCloseLongOptionsThenSwapForETH(address,uint256,uint256)"
                        )
                    )
                ), // function to call in this contract
                optionToken, // option token to close with flash loaned redeemTokens
                amountRedeems, // quantity of redeemTokens from flash loan to use to close options
                minPayout // total remaining underlyingTokens after flash loan is paid
            )
        );
        return true;
    }

    // ===== Flash Callback Functions =====

    /**
     * @notice  Callback function executed in a UniswapV2Pair.swap() call for `openFlashLong`.
     * @dev     Pays underlying token `premium` for `quantity` of `optionAddress` tokens.
     * @param   optionAddress The address of the Option contract.
     * @param   quantity The quantity of options to mint using borrowed underlyingTokens.
     * @param   maxPremium The maximum quantity of underlyingTokens to pay for the optionTokens.
     * @return  success bool Whether the transaction was successful or not.
     */
    function flashMintShortOptionsThenSwap(
        address optionAddress,
        uint256 quantity,
        uint256 maxPremium
    )
        public
        onlySelf
        onlyRegistered(IOption(optionAddress))
        returns (uint256, uint256)
    {
        IOption optionToken = IOption(optionAddress);
        (IUniswapV2Pair pair, address underlying, address redeem) =
            getOptionPair(optionToken);
        // Mint option and redeem tokens to this contract.
        _mintOptions(optionToken);
        // Get the repayment amounts
        (uint256 premium, uint256 redeemPremium) =
            SwapsLib.repayOpen(router, optionToken, quantity);
        // If premium is non-zero and non-negative (most cases), send underlyingTokens to the pair as payment (premium).
        if (premium > 0) {
            // Pull underlyingTokens from the original _msgSender() to pay the remainder of the flash swap.
            require(maxPremium >= premium, "PrimitiveSwaps: MAX_PREMIUM"); // check for users to not pay over their max desired value.
            _transferFromCaller(underlying, premium);
            IERC20(underlying).safeTransfer(address(pair), premium);
        }
        // Pay pair in redeem
        if (redeemPremium > 0) {
            IERC20(redeem).safeTransfer(address(pair), redeemPremium);
        }
        // Return tokens to original caller
        _transferToCaller(redeem);
        _transferToCaller(optionAddress);
        emit Buy(getCaller(), optionAddress, quantity, premium);
        return (quantity, premium);
    }

    /**
     * @notice  Callback function executed in a UniswapV2Pair.swap() call for `openFlashLongWithETH`.
     * @dev     Pays `premium` in ether for `quantity` of `optionAddress` tokens.
     * @param   optionAddress The address of the Option contract.
     * @param   quantity The quantity of options to mint using borrowed underlyingTokens.
     * @param   maxPremium The maximum quantity of underlyingTokens to pay for the optionTokens.
     * @return  success bool Whether the transaction was successful or not.
     */
    function flashMintShortOptionsThenSwapWithETH(
        address optionAddress,
        uint256 quantity,
        uint256 maxPremium
    )
        public
        onlySelf
        onlyRegistered(IOption(optionAddress))
        returns (uint256, uint256)
    {
        IOption optionToken = IOption(optionAddress);
        (IUniswapV2Pair pair, address underlying, address redeem) =
            getOptionPair(optionToken);
        require(underlying == address(_weth), "PrimitiveSwaps: NOT_WETH");

        _mintOptions(optionToken);

        (uint256 premium, uint256 redeemPremium) =
            SwapsLib.repayOpen(router, optionToken, quantity);

        // If premium is non-zero and non-negative (most cases), send underlyingTokens to the pair as payment (premium).
        if (premium > 0) {
            // Pull underlyingTokens from the original _msgSender() to pay the remainder of the flash swap.
            require(maxPremium >= premium, "PrimitiveSwaps: MAX_PREMIUM"); // check for users to not pay over their max desired value.
            // Wrap ether
            _weth.deposit.value(premium)();
            // Transfer Weth to pair to pay for premium
            IERC20(address(_weth)).safeTransfer(address(pair), premium);
            // Return ether to caller.
            _withdrawETH();
        }
        // Pay pair in redeem
        if (redeemPremium > 0) {
            IERC20(redeem).safeTransfer(address(pair), redeemPremium);
        }
        // Return tokens to original caller
        _transferToCaller(redeem);
        _transferToCaller(optionAddress);
        return (quantity, premium);
    }

    /**
     * @dev     Sends shortOptionTokens to _msgSender(), and pays back the UniswapV2Pair in underlyingTokens.
     * @notice  IMPORTANT: If minPayout is 0, the `to` address is liable for negative payouts *if* that occurs.
     * @param   optionAddress The address of the longOptionTokes to close.
     * @param   flashLoanQuantity The quantity of shortOptionTokens borrowed to use to close longOptionTokens.
     * @param   minPayout The minimum payout of underlyingTokens sent to the `to` address.
     */
    function flashCloseLongOptionsThenSwap(
        address optionAddress,
        uint256 flashLoanQuantity,
        uint256 minPayout
    )
        public
        onlySelf
        onlyRegistered(IOption(optionAddress))
        returns (uint256, uint256)
    {
        IOption optionToken = IOption(optionAddress);
        (IUniswapV2Pair pair, address underlying, address redeem) =
            getOptionPair(optionToken);

        _closeOptions(optionToken);

        (uint256 payout, uint256 cost, uint256 outstanding) =
            SwapsLib.repayClose(router, optionToken, flashLoanQuantity);

        // Pay back the pair in underlyingTokens.
        if (cost > 0) {
            IERC20(underlying).safeTransfer(address(pair), cost);
        }

        // Pay back the outstanding
        if (outstanding > 0) {
            // Pull underlyingTokens from the original msg.sender to pay the remainder of the flash swap.
            // Revert if the minPayout is less than or equal to the underlyingPayment of 0.
            // There is 0 underlyingPayment in the case that outstanding > 0.
            // This code branch can be successful by setting `minPayout` to 0.
            // This means the user is willing to pay to close the position.
            require(minPayout <= payout, "PrimitiveSwaps: NEGATIVE_PAYOUT");
            _transferFromCallerToReceiver(
                underlying,
                outstanding,
                address(pair)
            );
        }

        // If payout is non-zero and non-negative, send it to the `getCaller()` address.
        if (payout > 0) {
            // Revert if minPayout is greater than the actual payout.
            require(payout >= minPayout, "PrimitiveSwaps: MIN_PREMIUM");
            _transferToCaller(underlying);
        }
        emit Sell(getCaller(), optionAddress, flashLoanQuantity, payout);
        return (payout, cost);
    }

    /**
     * @dev     Sends shortOptionTokens to _msgSender(), and pays back the UniswapV2Pair in underlyingTokens.
     * @notice  IMPORTANT: If minPayout is 0, the `getCaller()` address is liable for negative payouts *if* that occurs.
     * @param   optionAddress The address of the longOptionTokes to close.
     * @param   flashLoanQuantity The quantity of shortOptionTokens borrowed to use to close longOptionTokens.
     * @param   minPayout The minimum payout of underlyingTokens sent to the `to` address.
     */
    function flashCloseLongOptionsThenSwapForETH(
        address optionAddress,
        uint256 flashLoanQuantity,
        uint256 minPayout
    )
        public
        onlySelf
        onlyRegistered(IOption(optionAddress))
        returns (uint256, uint256)
    {
        IOption optionToken = IOption(optionAddress);
        (IUniswapV2Pair pair, address underlying, address redeem) =
            getOptionPair(optionToken);
        require(underlying == address(_weth), "PrimitiveSwaps: NOT_WETH");

        _closeOptions(optionToken);

        (uint256 payout, uint256 cost, uint256 outstanding) =
            SwapsLib.repayClose(router, optionToken, flashLoanQuantity);

        // Pay back the pair in underlyingTokens.
        if (cost > 0) {
            IERC20(underlying).safeTransfer(address(pair), cost);
        }

        // Pay back the outstanding
        if (outstanding > 0) {
            // Pull underlyingTokens from the original msg.sender to pay the remainder of the flash swap.
            // Revert if the minPayout is less than or equal to the underlyingPayment of 0.
            // There is 0 underlyingPayment in the case that outstanding > 0.
            // This code branch can be successful by setting `minPayout` to 0.
            // This means the user is willing to pay to close the position.
            require(minPayout <= payout, "PrimitiveSwaps: NEGATIVE_PAYOUT");
            _transferFromCallerToReceiver(
                underlying,
                outstanding,
                address(pair)
            );
        }

        // If payout is non-zero and non-negative, send it to the `getCaller()` address.
        if (payout > 0) {
            // Revert if minPayout is greater than the actual payout.
            require(payout >= minPayout, "PrimitiveSwaps: MIN_PREMIUM");
            _withdrawETH();
        }

        emit Sell(getCaller(), optionAddress, flashLoanQuantity, payout);
        return (payout, cost);
    }

    // ===== Flash Loans =====

    function _flashSwap(
        IUniswapV2Pair pair,
        address token,
        uint256 amount,
        bytes memory params
    ) internal returns (bool) {
        // Receives `amount` of `token` to this contract address.
        uint256 amount0Out = pair.token0() == token ? amount : 0;
        uint256 amount1Out = pair.token0() == token ? 0 : amount;
        // Execute the callback function in params.
        pair.swap(amount0Out, amount1Out, address(this), params);
        return true;
    }

    /**
     * @dev     The callback function triggered in a UniswapV2Pair.swap() call when the `data` parameter has data.
     * @param   sender The original _msgSender() of the UniswapV2Pair.swap() call.
     * @param   amount0 The quantity of token0 received to the `to` address in the swap() call.
     * @param   amount1 The quantity of token1 received to the `to` address in the swap() call.
     * @param   data The payload passed in the `data` parameter of the swap() call.
     */
    function uniswapV2Call(
        address sender,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external override {
        assert(
            _msgSender() ==
                factory.getPair(
                    IUniswapV2Pair(_msgSender()).token0(),
                    IUniswapV2Pair(_msgSender()).token1()
                )
        ); // ensure that _msgSender() is actually a V2 pair
        require(sender == address(this), "PrimitiveSwaps: NOT_SENDER"); // ensure called by this contract
        (bool success, bytes memory returnData) = address(this).call(data);
        require(
            success &&
                (returnData.length == 0 || abi.decode(returnData, (bool))),
            "PrimitiveSwaps: CALLBACK"
        );
    }

    // ===== View =====

    /**
     * @notice  Input validation that checks the option against Primitive's registry contract.
     * @dev     Prevents tainted Uniswap pairs that have an evil option as a pair token.
     * @return  The pair address, as well as the tokens of the pair.
     */
    function getOptionPair(IOption option)
        public
        view
        returns (
            IUniswapV2Pair,
            address,
            address
        )
    {
        address redeemToken = option.redeemToken();
        address underlyingToken = option.getUnderlyingTokenAddress();
        IUniswapV2Pair pair =
            IUniswapV2Pair(factory.getPair(redeemToken, underlyingToken));
        return (pair, underlyingToken, redeemToken);
    }

    function getRouter() public view override returns (IUniswapV2Router02) {
        return router;
    }

    function getFactory() public view override returns (IUniswapV2Factory) {
        return factory;
    }

    function getOpenPremium(IOption optionToken, uint256 quantity)
        public
        view
        returns (uint256)
    {
        (uint256 premium, ) =
            SwapsLib.getOpenPremium(router, optionToken, quantity);
        return premium;
    }

    function getClosePremium(IOption optionToken, uint256 quantity)
        public
        view
        returns (uint256)
    {
        (uint256 payout, ) =
            SwapsLib.getClosePremium(router, optionToken, quantity);
        return payout;
    }
}
