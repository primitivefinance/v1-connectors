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
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {
    ReentrancyGuard
} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
// WETH Interface
import {IWETH} from "../interfaces/IWETH.sol";
// Uniswap V2 & Primitive V1
import {
    IUniswapV2Callee
} from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Callee.sol";
import {
    IUniswapV2Pair
} from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import {
    IPrimitiveRouter,
    IUniswapV2Router02,
    IUniswapV2Factory,
    IOption,
    IERC20
} from "../interfaces/IPrimitiveRouter.sol";
import {PrimitiveRouterLib} from "../libraries/PrimitiveRouterLib.sol";
import {
    IRegistry
} from "@primitivefi/contracts/contracts/option/interfaces/IRegistry.sol";

import {PrimitiveConnector} from "./PrimitiveConnector.sol";
import {SwapsLib} from "../libraries/SwapsLib.sol";

import "hardhat/console.sol";

contract PrimitiveSwaps is
    PrimitiveConnector,
    IPrimitiveRouter,
    IUniswapV2Callee
{
    using SafeERC20 for IERC20; // Reverts when `transfer` or `transferFrom` erc20 calls don't return proper data
    using SafeMath for uint256; // Reverts on math underflows/overflows

    event Initialized(address indexed from); // Emmitted on deployment
    event Buy(
        address indexed from,
        address indexed option,
        uint256 quantity,
        uint256 premium
    ); // Emmitted on flash opening a long position
    event Sell(
        address indexed from,
        address indexed option,
        uint256 quantity,
        uint256 payout
    ); // Emmitted on flash closing a long position

    IUniswapV2Factory public override factory =
        IUniswapV2Factory(0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f); // The Uniswap V2 factory contract to get pair addresses from
    IUniswapV2Router02 public override router =
        IUniswapV2Router02(0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D); // The Uniswap contract used to interact with the protocol
    IRegistry internal _registry;

    // ===== Constructor =====

    function realOption(IOption option, IRegistry registry)
        internal
        returns (bool)
    {
        return (address(option) ==
            registry.getOptionAddress(
                option.getUnderlyingTokenAddress(),
                option.getStrikeTokenAddress(),
                option.getBaseValue(),
                option.getQuoteValue(),
                option.getExpiryTime()
            ) &&
            address(option) != address(0));
    }

    modifier onlyTrusted(IOption option) {
        require(realOption(option, _registry), "PrimitiveSwaps: EVIL_OPTION");
        _;
    }

    constructor(
        address weth_,
        address registry_,
        address router_
    ) public PrimitiveConnector(weth_, router_) {
        require(registry_ == address(0x0), "PrimitiveSwaps: INITIALIZED");
        _registry = IRegistry(registry_);
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
    ) external override nonReentrant returns (bool) {
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
                            "flashMintShortOptionsThenSwap(address,uint256,uint256,address)"
                        )
                    )
                ), // function to call in this contract
                optionToken, // option token to mint with flash loaned tokens
                amountOptions, // quantity of underlyingTokens from flash loan to use to mint options
                maxPremium, // total price paid (in underlyingTokens) for selling shortOptionTokens
                _msgSender() // address to pull the remainder loan amount to pay, and send longOptionTokens to.
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
        returns (bool)
    {
        require(msg.value > 0, "0");
        _flashSwapUnderlying(
            optionToken,
            amountOptions,
            abi.encodeWithSelector(
                bytes4(
                    keccak256(
                        bytes(
                            "flashMintShortOptionsThenSwapWithETH(address,uint256,uint256,address)"
                        )
                    )
                ), // function to call in this contract
                optionToken, // option token to mint with flash loaned tokens
                amountOptions, // quantity of underlyingTokens from flash loan to use to mint options
                msg.value, // total price paid (in underlyingTokens) for selling shortOptionTokens
                _msgSender() // address to pull the remainder loan amount to pay, and send longOptionTokens to.
            ),
            factory
        );
        return true;
    }

    function _flashSwap(
        IUniswapV2Pair pair,
        address token,
        uint256 amount,
        bytes memory params
    ) internal {
        // Receives 0 quoteTokens and `amount` of `token` to `this` contract address.
        // Then executes `flashMintShortOptionsThenSwap`.
        uint256 amount0Out = pair.token0() == token ? amount : 0;
        uint256 amount1Out = pair.token0() == token ? 0 : amount;
        // Borrow the amount quantity of `token` and execute the callback function using params.
        pair.swap(amount0Out, amount1Out, address(this), params);
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
    ) public override nonReentrant returns (bool) {
        PrimitiveRouterLib._swapForRedeem(
            optionToken,
            amountRedeems,
            abi.encodeWithSelector(
                bytes4(
                    keccak256(
                        bytes(
                            "flashCloseLongOptionsThenSwap(address,uint256,uint256,address)"
                        )
                    )
                ), // function to call in this contract
                optionToken, // option token to close with flash loaned redeemTokens
                amountRedeems, // quantity of redeemTokens from flash loan to use to close options
                minPayout, // total remaining underlyingTokens after flash loan is paid
                _msgSender() // address to send payout of underlyingTokens to. Will pull underlyingTokens if negative payout and minPayout <= 0.
            ),
            factory
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
    ) public nonReentrant returns (bool) {
        PrimitiveRouterLib._swapForRedeem(
            optionToken,
            amountRedeems,
            abi.encodeWithSelector(
                bytes4(
                    keccak256(
                        bytes(
                            "flashCloseLongOptionsThenSwapForETH(address,uint256,uint256,address)"
                        )
                    )
                ), // function to call in this contract
                optionToken, // option token to close with flash loaned redeemTokens
                amountRedeems, // quantity of redeemTokens from flash loan to use to close options
                minPayout, // total remaining underlyingTokens after flash loan is paid
                _msgSender() // address to send payout of underlyingTokens to. Will pull underlyingTokens if negative payout and minPayout <= 0.
            ),
            factory
        );
        return true;
    }

    // ===== Flash Functions =====

    /**
     * @dev     Receives underlyingTokens from a UniswapV2Pair.swap() call from a pair with
     *          shortOptionTokens and underlyingTokens.
     *          Uses underlyingTokens to mint long (option) + short (redeem) tokens.
     *          Sends longOptionTokens to _msgSender(), and pays back the UniswapV2Pair with shortOptionTokens,
     *          AND any remainder quantity of underlyingTokens (paid by _msgSender()).
     * @notice  If the first address in the path is not the shortOptionToken address, the tx will fail.
     *          IMPORTANT: UniswapV2 adds a fee of 0.301% to the option premium cost.
     * @param   optionAddress The address of the Option contract.
     * @param   flashLoanQuantity The quantity of options to mint using borrowed underlyingTokens.
     * @param   maxPremium The maximum quantity of underlyingTokens to pay for the optionTokens.
     * @param   to The address to send the shortOptionToken proceeds and longOptionTokens to.
     * @return  success bool Whether the transaction was successful or not.
     */
    function flashMintShortOptionsThenSwap(
        address optionAddress,
        uint256 flashLoanQuantity,
        uint256 maxPremium,
        address to
    ) public payable override returns (uint256, uint256) {
        require(_msgSender() == address(this), "NOT_SELF");
        require(to != address(0x0), "ADDR_0");
        require(to != _msgSender(), "SENDER");
        // IMPORTANT: Assume this contract has already received `flashLoanQuantity` of underlyingTokens.
        (IUniswapV2Pair pair, address underlyingToken, address redeemToken) =
            getOptionPair(IOption(optionAddress));

        uint256 loanRemainder =
            SwapsLib.repayWithRedeem(
                optionAddress,
                flashLoanQuantity,
                factory,
                router
            );

        // If loanRemainder is non-zero and non-negative (most cases), send underlyingTokens to the pair as payment (premium).
        if (loanRemainder > 0) {
            // Pull underlyingTokens from the original _msgSender() to pay the remainder of the flash swap.
            require(maxPremium >= loanRemainder, "PREM"); // check for users to not pay over their max desired value.
            IERC20(underlyingToken).safeTransferFrom(
                getCaller(), // WARNING: This must be the `msg.sender` of the original executing fn.
                address(pair),
                loanRemainder
            );
        }
        return (flashLoanQuantity, loanRemainder);
    }

    /**
     * @dev     Receives underlyingTokens from a UniswapV2Pair.swap() call from a pair with
     *          shortOptionTokens and underlyingTokens.
     *          Uses underlyingTokens to mint long (option) + short (redeem) tokens.
     *          Sends longOptionTokens to _msgSender(), and pays back the UniswapV2Pair with shortOptionTokens,
     *          AND any remainder quantity of underlyingTokens (paid by _msgSender()).
     * @notice  If the first address in the path is not the shortOptionToken address, the tx will fail.
     *          IMPORTANT: UniswapV2 adds a fee of 0.301% to the option premium cost.
     * @param   optionAddress The address of the Option contract.
     * @param   flashLoanQuantity The quantity of options to mint using borrowed underlyingTokens.
     * @param   maxPremium The maximum quantity of underlyingTokens to pay for the optionTokens.
     * @param   to The address to send the shortOptionToken proceeds and longOptionTokens to.
     * @return  success bool Whether the transaction was successful or not.
     */
    function flashMintShortOptionsThenSwapWithETH(
        address optionAddress,
        uint256 flashLoanQuantity,
        uint256 maxPremium,
        address to
    ) public payable returns (uint256, uint256) {
        require(_msgSender() == address(this), "NOT_SELF");
        require(to != address(0x0), "ADDR_0");
        require(to != _msgSender(), "SENDER");
        // IMPORTANT: Assume this contract has already received `flashLoanQuantity` of underlyingTokens.
        address underlyingToken =
            IOption(optionAddress).getUnderlyingTokenAddress();
        address redeemToken = IOption(optionAddress).redeemToken();
        address pairAddress = factory.getPair(underlyingToken, redeemToken);

        uint256 loanRemainder =
            PrimitiveRouterLib._flashMintShortOptionsThenSwap(
                optionAddress,
                flashLoanQuantity,
                to,
                factory,
                router
            );
        // If loanRemainder is non-zero and non-negative (most cases), send underlyingTokens to the pair as payment (premium).
        if (loanRemainder > 0) {
            address pairAddress_ = pairAddress;
            // Pull underlyingTokens from the original _msgSender() to pay the remainder of the flash swap.
            require(maxPremium >= loanRemainder, "PREM"); // check for users to not pay over their max desired value.
            //_payPremiumInETH(pairAddress, loanRemainder);
            weth.deposit.value(loanRemainder)();
            // Transfer weth to pair to pay for premium
            IERC20(address(weth)).safeTransfer(pairAddress, loanRemainder);
            if (maxPremium > loanRemainder) {
                // Send ether.
                (bool success, ) =
                    to.call.value(maxPremium.sub(loanRemainder))("");
                // Revert is call is unsuccessful.
                require(success, "SEND");
            }
        }

        return (flashLoanQuantity, loanRemainder);
    }

    /**
     * @dev     Sends shortOptionTokens to _msgSender(), and pays back the UniswapV2Pair in underlyingTokens.
     * @notice  IMPORTANT: If minPayout is 0, the `to` address is liable for negative payouts *if* that occurs.
     * @param   optionAddress The address of the longOptionTokes to close.
     * @param   flashLoanQuantity The quantity of shortOptionTokens borrowed to use to close longOptionTokens.
     * @param   minPayout The minimum payout of underlyingTokens sent to the `to` address.
     * @param   to The address which is sent the underlyingToken payout, or liable to pay for a negative payout.
     */
    function flashCloseLongOptionsThenSwap(
        address optionAddress,
        uint256 flashLoanQuantity,
        uint256 minPayout,
        address to
    ) public override returns (uint256, uint256) {
        require(_msgSender() == address(this), "NOT_SELF");
        require(to != address(0x0), "ADDR_0");
        require(to != _msgSender(), "SENDER");

        (, uint256 underlyingPayout) =
            PrimitiveRouterLib.repayFlashSwap(
                optionAddress,
                flashLoanQuantity,
                minPayout,
                to,
                PrimitiveRouterLib._closeOptions(
                    optionAddress,
                    flashLoanQuantity,
                    minPayout,
                    to,
                    factory,
                    router
                ),
                factory,
                router
            );

        // If underlyingPayout is non-zero and non-negative, send it to the `to` address.
        if (underlyingPayout > 0) {
            // Revert if minPayout is greater than the actual payout.
            require(underlyingPayout >= minPayout, "PREM");
            IERC20(IOption(optionAddress).getUnderlyingTokenAddress())
                .safeTransfer(to, underlyingPayout);
        }
    }

    /**
     * @dev     Sends shortOptionTokens to _msgSender(), and pays back the UniswapV2Pair in underlyingTokens.
     * @notice  IMPORTANT: If minPayout is 0, the `to` address is liable for negative payouts *if* that occurs.
     * @param   optionAddress The address of the longOptionTokes to close.
     * @param   flashLoanQuantity The quantity of shortOptionTokens borrowed to use to close longOptionTokens.
     * @param   minPayout The minimum payout of underlyingTokens sent to the `to` address.
     * @param   to The address which is sent the underlyingToken payout, or liable to pay for a negative payout.
     */
    function flashCloseLongOptionsThenSwapForETH(
        address optionAddress,
        uint256 flashLoanQuantity,
        uint256 minPayout,
        address to
    ) public returns (uint256, uint256) {
        require(_msgSender() == address(this), "NOT_SELF");
        require(to != address(0x0), "ADDR_0");
        require(to != _msgSender(), "SENDER");

        (, uint256 underlyingPayout) =
            PrimitiveRouterLib.repayFlashSwap(
                optionAddress,
                flashLoanQuantity,
                minPayout,
                to,
                PrimitiveRouterLib._closeOptions(
                    optionAddress,
                    flashLoanQuantity,
                    minPayout,
                    to,
                    factory,
                    router
                ),
                factory,
                router
            );

        // If underlyingPayout is non-zero and non-negative, send it to the `to` address.
        if (underlyingPayout > 0) {
            // Revert if minPayout is greater than the actual payout.
            require(underlyingPayout >= minPayout, "PREM");
            PrimitiveRouterLib.safeTransferWETHToETH(
                weth,
                to,
                underlyingPayout
            );
        }
    }

    // ===== Callback Implementation =====

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
            "UNI"
        );
    }

    // ===== View =====

    function getRegistry() public view returns (IRegistry) {
        return _registry;
    }

    /**
     * @notice  Input validation that checks the option against Primitive's registry contract.
     * @dev     Prevents tainted Uniswap pairs that have an evil option as a pair token.
     * @return  The pair address, as well as the tokens of the pair.
     */
    function getOptionPair(IOption option)
        public
        view
        onlyTrusted(option)
        returns (
            IUniswapV2Pair,
            address,
            address
        )
    {
        address redeemToken = optionToken.redeemToken();
        address underlyingToken = optionToken.getUnderlyingTokenAddress();
        IUniswapV2Pair pair =
            IUniswapV2Pair(factory.getPair(redeemToken, underlyingToken));
        return (pair, underlyingToken, redeemToken);
    }
}
