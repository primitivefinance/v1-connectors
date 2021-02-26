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
import {IWETH} from "./interfaces/IWETH.sol";
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
} from "./interfaces/IPrimitiveRouter.sol";
import {PrimitiveRouterLib} from "./libraries/PrimitiveRouterLib.sol";
import {
  IRegistry
} from "@primitivefi/contracts/contracts/option/interfaces/IRegistry.sol";

import "hardhat/console.sol";

contract PrimitiveRouter is
    IPrimitiveRouter,
    IUniswapV2Callee,
    ReentrancyGuard
{
    using SafeERC20 for IERC20; // Reverts when `transfer` or `transferFrom` erc20 calls don't return proper data
    using SafeMath for uint256; // Reverts on math underflows/overflows

    IUniswapV2Factory public override factory =
        IUniswapV2Factory(0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f); // The Uniswap V2 factory contract to get pair addresses from
    IUniswapV2Router02 public override router =
        IUniswapV2Router02(0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D); // The Uniswap contract used to interact with the protocol
    IWETH public weth;
    IRegistry public registry;

    event Initialized(address indexed from); // Emmitted on deployment
    event FlashOpened(address indexed from, uint256 quantity, uint256 premium); // Emmitted on flash opening a long position
    event FlashClosed(address indexed from, uint256 quantity, uint256 payout);
    event WroteOption(address indexed from, uint256 quantity);
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

    constructor(address weth_, address registry_) public {
        require(address(weth) == address(0x0), "INIT");
        weth = IWETH(weth_);
        emit Initialized(msg.sender);
        registry = IRegistry(registry_);
    }

    receive() external payable {
        assert(msg.sender == address(weth)); // only accept ETH via fallback from the WETH contract
    }

    // ===== Primitive Core =====

    /**
     * @dev     Conducts important safety checks to safely mint option tokens.
     * @param   optionToken The address of the option token to mint.
     * @param   mintQuantity The quantity of option tokens to mint.
     * @param   receiver The address which receives the minted option tokens.
     */
    function safeMint(
        IOption optionToken,
        uint256 mintQuantity,
        address receiver
    ) external returns (uint256, uint256) {
        require(mintQuantity > 0, "0");
        require(PrimitiveRouterLib.realOption(optionToken, registry), "INVALID_OPTION");
        PrimitiveRouterLib.safeTransferThenMint(
          optionToken,
          mintQuantity,
          receiver
        );
    }

    /**
     * @dev     Swaps strikeTokens to underlyingTokens using the strike ratio as the exchange rate.
     * @notice  Burns optionTokens, option contract receives strikeTokens, user receives underlyingTokens.
     * @param   optionToken The address of the option contract.
     * @param   exerciseQuantity Quantity of optionTokens to exercise.
     * @param   receiver The underlyingTokens are sent to the receiver address.
     */
    function safeExercise(
        IOption optionToken,
        uint256 exerciseQuantity,
        address receiver
    ) public returns (uint256, uint256) {
        require(exerciseQuantity > 0, "0");
        require(PrimitiveRouterLib.realOption(optionToken, registry), "INVALID_OPTION");
        return(
            PrimitiveRouterLib.safeExercise(optionToken, exerciseQuantity, receiver)
          );
    }

    /**
     * @dev     Burns redeemTokens to withdraw available strikeTokens.
     * @notice  inputRedeems = outputStrikes.
     * @param   optionToken The address of the option contract.
     * @param   redeemQuantity redeemQuantity of redeemTokens to burn.
     * @param   receiver The strikeTokens are sent to the receiver address.
     */
    function safeRedeem(
        IOption optionToken,
        uint256 redeemQuantity,
        address receiver
    ) public returns (uint256) {
        require(redeemQuantity > 0, "0");
        require(PrimitiveRouterLib.realOption(optionToken, registry), "INVALID_OPTION");
        IERC20(optionToken.redeemToken()).safeTransferFrom(
            msg.sender,
            address(optionToken),
            redeemQuantity
        );
        emit Redeemed(msg.sender, address(optionToken), redeemQuantity);
        return optionToken.redeemStrikeTokens(receiver);
    }

    /**
     * @dev     Burn optionTokens and redeemTokens to withdraw underlyingTokens.
     * @notice  The redeemTokens to burn is equal to the optionTokens * strike ratio.
     *          inputOptions = inputRedeems / strike ratio = outUnderlyings
     * @param   optionToken The address of the option contract.
     * @param   closeQuantity Quantity of optionTokens to burn.
     *          (Implictly will burn the strike ratio quantity of redeemTokens).
     * @param   receiver The underlyingTokens are sent to the receiver address.
     */
    function safeClose(
        IOption optionToken,
        uint256 closeQuantity,
        address receiver
    )
        public
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        require(closeQuantity > 0, "0");
        require(PrimitiveRouterLib.realOption(optionToken, registry), "INVALID_OPTION");
        // Calculate the quantity of redeemTokens that need to be burned. (What we mean by Implicit).
        return(PrimitiveRouterLib.safeClose(
          optionToken, closeQuantity, receiver,
          PrimitiveRouterLib.getProportionalShortOptions(
              optionToken,
              closeQuantity
          )
        ));
    }

    // ===== Primitive Core WETH Abstraction =====

    /**
     * @dev     Mints msg.value quantity of options and "quote" (option parameter) quantity of redeem tokens.
     * @notice  This function is for options that have WETH as the underlying asset.
     * @param   optionToken The address of the option token to mint.
     * @param   receiver The address which receives the minted option and redeem tokens.
     */
    function safeMintWithETH(IOption optionToken, address receiver)
        public
        payable
        returns (uint256, uint256)
    {
        require(msg.value > 0, "0");
        // Check to make sure we are minting a WETH call option.
        require(address(weth) == optionToken.getUnderlyingTokenAddress(), "N_WETH");

        // Convert ethers into WETH, then send WETH to option contract in preparation of calling mintOptions().
        PrimitiveRouterLib.safeTransferETHFromWETH(
            weth,
            address(optionToken),
            msg.value
        );
        emit Minted(
            msg.sender,
            address(optionToken),
            msg.value,
            PrimitiveRouterLib.getProportionalShortOptions(
                optionToken,
                msg.value
            )
        );
        return optionToken.mintOptions(receiver);
    }

    /**
     * @dev     Swaps msg.value of strikeTokens (ethers) to underlyingTokens.
     *          Uses the strike ratio as the exchange rate. Strike ratio = base / quote.
     *          Msg.value (quote units) * base / quote = base units (underlyingTokens) to withdraw.
     * @notice  This function is for options with WETH as the strike asset.
     *          Burns option tokens, accepts ethers, and pushes out underlyingTokens.
     * @param   optionToken The address of the option contract.
     * @param   receiver The underlyingTokens are sent to the receiver address.
     */
    function safeExerciseWithETH(IOption optionToken, address receiver)
        public
        payable
        returns (uint256, uint256)
    {
      // Calculate quantity of optionTokens needed to burn.
      // An ether put option with strike price $300 has a "base" value of 300, and a "quote" value of 1.
      // To calculate how many options are needed to be burned, we need to cancel out the "quote" units.
      // The input strike quantity can be multiplied by the strike ratio to cancel out "quote" units.
      // 1 ether (quote units) * 300 (base units) / 1 (quote units) = 300 inputOptions
        return(
          PrimitiveRouterLib.safeExerciseWithETH(optionToken, receiver, weth, PrimitiveRouterLib.getProportionalLongOptions(
              optionToken,
              msg.value
          )
        )
      );
    }

    /**
     * @dev     Swaps strikeTokens to underlyingTokens, WETH, which is converted to ethers before withdrawn.
     *          Uses the strike ratio as the exchange rate. Strike ratio = base / quote.
     * @notice  This function is for options with WETH as the underlying asset.
     *          Burns option tokens, pulls strikeTokens, and pushes out ethers.
     * @param   optionToken The address of the option contract.
     * @param   exerciseQuantity Quantity of optionTokens to exercise.
     * @param   receiver The underlyingTokens (ethers) are sent to the receiver address.
     */
    function safeExerciseForETH(
        IOption optionToken,
        uint256 exerciseQuantity,
        address receiver
    ) public returns (uint256, uint256) {
        require(exerciseQuantity > 0, "0");
        // Require one of the option's assets to be WETH.
        require(optionToken.getUnderlyingTokenAddress() == address(weth), "N_WETH");

        (uint256 inputStrikes, uint256 inputOptions) =
            safeExercise(optionToken, exerciseQuantity, address(this));

        // Converts the withdrawn WETH to ethers, then sends the ethers to the receiver address.
        PrimitiveRouterLib.safeTransferWETHToETH(
            weth,
            receiver,
            exerciseQuantity
        );
        return (inputStrikes, inputOptions);
    }

    /**
     * @dev     Burns redeem tokens to withdraw strike tokens (ethers) at a 1:1 ratio.
     * @notice  This function is for options that have WETH as the strike asset.
     *          Converts WETH to ethers, and withdraws ethers to the receiver address.
     * @param   optionToken The address of the option contract.
     * @param   redeemQuantity The quantity of redeemTokens to burn.
     * @param   receiver The strikeTokens (ethers) are sent to the receiver address.
     */
    function safeRedeemForETH(
        IOption optionToken,
        uint256 redeemQuantity,
        address receiver
    ) public returns (uint256) {
        require(redeemQuantity > 0, "0");
        // If options have not been exercised, there will be no strikeTokens to redeem, causing a revert.
        // Burns the redeem tokens that were sent to the contract, and withdraws the same quantity of WETH.
        // Sends the withdrawn WETH to this contract, so that it can be unwrapped prior to being sent to receiver.
        uint256 inputRedeems =
            safeRedeem(optionToken, redeemQuantity, address(this));
        // Unwrap the redeemed WETH and then send the ethers to the receiver.
        PrimitiveRouterLib.safeTransferWETHToETH(
            weth,
            receiver,
            redeemQuantity
        );
        return inputRedeems;
    }

    /**
     * @dev Burn optionTokens and redeemTokens to withdraw underlyingTokens (ethers).
     * @notice This function is for options with WETH as the underlying asset.
     * WETH underlyingTokens are converted to ethers before being sent to receiver.
     * The redeemTokens to burn is equal to the optionTokens * strike ratio.
     * inputOptions = inputRedeems / strike ratio = outUnderlyings
     * @param optionToken The address of the option contract.
     * @param closeQuantity Quantity of optionTokens to burn and an input to calculate how many redeems to burn.
     * @param receiver The underlyingTokens (ethers) are sent to the receiver address.
     */
    function safeCloseForETH(
        IOption optionToken,
        uint256 closeQuantity,
        address receiver
    )
        public
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        require(closeQuantity > 0, "0");
        (uint256 inputRedeems, uint256 inputOptions, uint256 outUnderlyings) =
            safeClose(optionToken, closeQuantity, address(this));

        // Since underlyngTokens are WETH, unwrap them then send the ethers to the receiver.
        PrimitiveRouterLib.safeTransferWETHToETH(weth, receiver, closeQuantity);
        return (inputRedeems, inputOptions, outUnderlyings);
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
    ) public override nonReentrant returns (bool) {
        bytes4 selector =
            bytes4(
                keccak256(
                    bytes(
                        "flashMintShortOptionsThenSwap(address,uint256,uint256,address)"
                    )
                )
            );
        bytes memory params =
            abi.encodeWithSelector(
                selector, // function to call in this contract
                optionToken, // option token to mint with flash loaned tokens
                amountOptions, // quantity of underlyingTokens from flash loan to use to mint options
                maxPremium, // total price paid (in underlyingTokens) for selling shortOptionTokens
                msg.sender // address to pull the remainder loan amount to pay, and send longOptionTokens to.
            );
        PrimitiveRouterLib._swapForUnderlying(optionToken, amountOptions, params, factory);
        return true;
    }

    /**
     * @dev     Opens a longOptionToken position by minting long + short tokens, then selling the short tokens.
     * @notice  IMPORTANT: amountOutMin parameter is the price to swap shortOptionTokens to underlyingTokens.
     *          IMPORTANT: If the ratio between shortOptionTokens and underlyingTokens is 1:1, then only the swap fee (0.30%) has to be paid.
     * @param   optionToken The option address.
     * @param   amountOptions The quantity of longOptionTokens to purchase.
     * @param   maxPremium The maximum quantity of underlyingTokens to pay for the optionTokens.
     */
    function openFlashLongWithETH(
        IOption optionToken,
        uint256 amountOptions,
        uint256 maxPremium
    ) external payable returns (bool) {
        require(msg.value > 0, "0");
        require(maxPremium == msg.value, "PREM"); // must assert because cannot check in callback
        bytes4 selector =
            bytes4(
                keccak256(
                    bytes(
                        "flashMintShortOptionsThenSwapWithETH(address,uint256,uint256,address)"
                    )
                )
            );
        bytes memory params =
            abi.encodeWithSelector(
                selector, // function to call in this contract
                optionToken, // option token to mint with flash loaned tokens
                amountOptions, // quantity of underlyingTokens from flash loan to use to mint options
                maxPremium, // total price paid (in underlyingTokens) for selling shortOptionTokens
                msg.sender // address to pull the remainder loan amount to pay, and send longOptionTokens to.
            );
        PrimitiveRouterLib._swapForUnderlying(optionToken, amountOptions, params, factory);
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
    ) public override nonReentrant returns (bool) {
        bytes4 selector =
            bytes4(
                keccak256(
                    bytes(
                        "flashCloseLongOptionsThenSwap(address,uint256,uint256,address)"
                    )
                )
            );
        bytes memory params =
            abi.encodeWithSelector(
                selector, // function to call in this contract
                optionToken, // option token to close with flash loaned redeemTokens
                amountRedeems, // quantity of redeemTokens from flash loan to use to close options
                minPayout, // total remaining underlyingTokens after flash loan is paid
                msg.sender // address to send payout of underlyingTokens to. Will pull underlyingTokens if negative payout and minPayout <= 0.
            );
        PrimitiveRouterLib._swapForRedeem(optionToken, amountRedeems, params, factory);
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
        bytes4 selector =
            bytes4(
                keccak256(
                    bytes(
                        "flashCloseLongOptionsThenSwapForETH(address,uint256,uint256,address)"
                    )
                )
            );
        bytes memory params =
            abi.encodeWithSelector(
                selector, // function to call in this contract
                optionToken, // option token to close with flash loaned redeemTokens
                amountRedeems, // quantity of redeemTokens from flash loan to use to close options
                minPayout, // total remaining underlyingTokens after flash loan is paid
                msg.sender // address to send payout of underlyingTokens to. Will pull underlyingTokens if negative payout and minPayout <= 0.
            );
        PrimitiveRouterLib._swapForRedeem(optionToken, amountRedeems, params, factory);
        return true;
    }

    // ===== Liquidity Functions =====

    /**
     * @dev     Adds redeemToken liquidity to a redeem<>underlyingToken pair by minting shortOptionTokens with underlyingTokens.
     * @notice  Pulls underlying tokens from msg.sender and pushes UNI-V2 liquidity tokens to the "to" address.
     *          underlyingToken -> redeemToken -> UNI-V2.
     * @param   optionAddress The address of the optionToken to get the redeemToken to mint then provide liquidity for.
     * @param   quantityOptions The quantity of underlyingTokens to use to mint option + redeem tokens.
     * @param   amountBMax The quantity of underlyingTokens to add with shortOptionTokens to the Uniswap V2 Pair.
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
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        uint256 amountA;
        uint256 amountB;
        uint256 liquidity;
        // Pulls underlyingTokens from msg.sender to this contract.
        // Pushes underlyingTokens to option contract and mints option + redeem tokens to this contract.
        // Warning: calls into msg.sender using `safeTransferFrom`. Msg.sender is not trusted.
        (, uint256 outputRedeems) =
            PrimitiveRouterLib.safeTransferThenMint(IOption(optionAddress), quantityOptions, address(this));
        // Send longOptionTokens from minting option operation to msg.sender.
        IERC20(optionAddress).safeTransfer(msg.sender, quantityOptions);

        {
            // scope for adding exact liquidity, avoids stack too deep errors
            IOption optionToken = IOption(optionAddress);
            address underlyingToken = optionToken.getUnderlyingTokenAddress();
            uint256 outputRedeems_ = outputRedeems;
            uint256 amountBMax_ = amountBMax;
            uint256 amountBMin_ = amountBMin;
            address to_ = to;
            uint256 deadline_ = deadline;
            // Pull `tokenB` from msg.sender to add to Uniswap V2 Pair.
            // Warning: calls into msg.sender using `safeTransferFrom`. Msg.sender is not trusted.
            IERC20(underlyingToken).safeTransferFrom(
                msg.sender,
                address(this),
                amountBMax_
            );
            // Approves Uniswap V2 Pair pull tokens from this contract.
            IERC20(optionToken.redeemToken()).approve(
                address(router),
                uint256(-1)
            );
            IERC20(underlyingToken).approve(address(router), uint256(-1));

            // Adds liquidity to Uniswap V2 Pair and returns liquidity shares to the "to" address.
            (amountA, amountB, liquidity) = router.addLiquidity(
                optionToken.redeemToken(),
                underlyingToken,
                outputRedeems_,
                amountBMax_,
                outputRedeems_,
                amountBMin_,
                to_,
                deadline_
            );
            // check for exact liquidity provided
            assert(amountA == outputRedeems);

            uint256 remainder =
                amountBMax_ > amountB ? amountBMax_.sub(amountB) : 0;
            if (remainder > 0) {
                IERC20(underlyingToken).safeTransfer(msg.sender, remainder);
            }
        }
        return (amountA, amountB, liquidity);
    }

    /**
     * @dev     Adds redeemToken liquidity to a redeem<>underlyingToken pair by minting shortOptionTokens with underlyingTokens.
     * @notice  Pulls underlying tokens from msg.sender and pushes UNI-V2 liquidity tokens to the "to" address.
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
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        require(
            quantityOptions.add(amountBMax) >= msg.value,
            "ETH"
        );

        uint256 amountA;
        uint256 amountB;
        uint256 liquidity;
        // Pulls underlyingTokens from msg.sender to this contract.
        // Pushes underlyingTokens to option contract and mints option + redeem tokens to this contract.
        // Warning: calls into msg.sender using `safeTransferFrom`. Msg.sender is not trusted.
        // Deposit the ethers received from msg.value into the WETH contract.
        weth.deposit.value(quantityOptions)();
        // Send WETH to option. Remainder ETH will be pulled from Uniswap V2 Router for adding liquidity.
        weth.transfer(optionAddress, quantityOptions);
        // Mint options
        (, uint256 outputRedeems) =
            IOption(optionAddress).mintOptions(address(this));
        // Send longOptionTokens from minting option operation to msg.sender.
        IERC20(optionAddress).safeTransfer(msg.sender, quantityOptions);

        {
            // scope for adding exact liquidity, avoids stack too deep errors
            IOption optionToken = IOption(optionAddress);
            address underlyingToken = optionToken.getUnderlyingTokenAddress();
            uint256 outputRedeems_ = outputRedeems;
            uint256 amountBMax_ = amountBMax;
            uint256 amountBMin_ = amountBMin;
            address to_ = to;
            uint256 deadline_ = deadline;
            // Pull `tokenB` from msg.sender to add to Uniswap V2 Pair.
            // Warning: calls into msg.sender using `safeTransferFrom`. Msg.sender is not trusted.
            /* IERC20(underlyingToken).safeTransferFrom(
                msg.sender,
                address(this),
                amountBMax_
            ); */
            // Approves Uniswap V2 Pair pull tokens from this contract.
            IERC20(optionToken.redeemToken()).approve(
                address(router),
                uint256(-1)
            );
            IERC20(underlyingToken).approve(address(router), uint256(-1));

            // Adds liquidity to Uniswap V2 Pair and returns liquidity shares to the "to" address.
            (amountA, amountB, liquidity) = router.addLiquidityETH.value(
                amountBMax_
            )(
                optionToken.redeemToken(),
                outputRedeems_,
                outputRedeems_,
                amountBMin_,
                to_,
                deadline_
            );
            // check for exact liquidity provided
            assert(amountA == outputRedeems);

            uint256 remainder =
                amountBMax_ > amountB ? amountBMax_.sub(amountB) : 0;
            if (remainder > 0) {
                // Send ether.
                (bool success, ) = msg.sender.call.value(remainder)("");
                // Revert is call is unsuccessful.
                require(success, "SEND");
            }
        }
        return (amountA, amountB, liquidity);
    }

    /**
     * @dev     Combines Uniswap V2 Router "removeLiquidity" function with Primitive "closeOptions" function.
     * @notice  Pulls UNI-V2 liquidity shares with shortOption<>underlying token, and optionTokens from msg.sender.
     *          Then closes the longOptionTokens and withdraws underlyingTokens to the "to" address.
     *          Sends underlyingTokens from the burned UNI-V2 liquidity shares to the "to" address.
     *          UNI-V2 -> optionToken -> underlyingToken.
     * @param   optionAddress The address of the option that will be closed from burned UNI-V2 liquidity shares.
     * @param   liquidity The quantity of liquidity tokens to pull from msg.sender and burn.
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
    ) public override nonReentrant returns (uint256, uint256) {
        IOption optionToken = IOption(optionAddress);
        address redeemToken = optionToken.redeemToken();
        address underlyingTokenAddress =
            optionToken.getUnderlyingTokenAddress();

        // Check the short option tokens before and after, there could be dust.
        uint256 redeemBalance = IERC20(redeemToken).balanceOf(address(this));

        // Remove liquidity by burning lp tokens from msg.sender, withdraw tokens to this contract.
        // Notice: the `to` address is not passed into this function, because address(this) receives the withrawn tokens.
        // Gets the Uniswap V2 Pair address for shortOptionToken (redeem) and underlyingTokens.
        // Transfers the LP tokens of the pair to this contract.

        uint256 liquidity_ = liquidity;
        uint256 amountAMin_ = amountAMin;
        uint256 amountBMin_ = amountBMin;
        uint256 deadline_ = deadline;
        address to_ = to;
        // Warning: public call to a non-trusted address `msg.sender`.
        IERC20(factory.getPair(redeemToken, underlyingTokenAddress))
            .safeTransferFrom(msg.sender, address(this), liquidity_);
        IERC20(factory.getPair(redeemToken, underlyingTokenAddress)).approve(
            address(router),
            uint256(-1)
        );

        // Remove liquidity from Uniswap V2 pool to receive the reserve tokens (shortOptionTokens + UnderlyingTokens).
        (uint256 shortTokensWithdrawn, uint256 underlyingTokensWithdrawn) =
            router.removeLiquidity(
                redeemToken,
                underlyingTokenAddress,
                liquidity_,
                amountAMin_,
                amountBMin_,
                address(this),
                deadline_
            );

        // Burn option and redeem tokens from this contract then send underlyingTokens to the `to` address.
        // Calculate equivalent quantity of redeem (short option) tokens to close the long option position.
        // Close longOptionTokens using the redeemToken balance of this contract.
        IERC20(optionToken.redeemToken()).safeTransfer(
            address(optionToken),
            shortTokensWithdrawn
        );

        // longOptions = shortOptions / strikeRatio
        uint256 requiredLongOptions =
            PrimitiveRouterLib.getProportionalLongOptions(
                optionToken,
                shortTokensWithdrawn
            );

        // Pull the required longOptionTokens from `msg.sender` to this contract.
        IERC20(address(optionToken)).safeTransferFrom(
            msg.sender,
            address(optionToken),
            requiredLongOptions
        );

        // Trader pulls option and redeem tokens from this contract and sends them to the option contract.
        // Option and redeem tokens are then burned to release underlyingTokens.
        // UnderlyingTokens are sent to the "receiver" address.
        (, , uint256 underlyingTokensFromClosedOptions) =
            optionToken.closeOptions(to_);

        // After the options were closed, calculate the dust by checking after balance against the before balance.
        redeemBalance = IERC20(redeemToken).balanceOf(address(this)).sub(
            redeemBalance
        );

        // If there is dust, send it out
        if (redeemBalance > 0) {
            IERC20(redeemToken).safeTransfer(to_, redeemBalance);
        }

        // Send the UnderlyingTokens received from burning liquidity shares to the "to" address.
        IERC20(underlyingTokenAddress).safeTransfer(
            to_,
            underlyingTokensWithdrawn
        );
        return (
            underlyingTokensWithdrawn.add(underlyingTokensFromClosedOptions),
            redeemBalance
        );
    }

    /**
     * @dev     Combines Uniswap V2 Router "removeLiquidity" function with Primitive "closeOptions" function.
     * @notice  Pulls UNI-V2 liquidity shares with shortOption<>underlying token, and optionTokens from msg.sender.
     *          Then closes the longOptionTokens and withdraws underlyingTokens to the "to" address.
     *          Sends underlyingTokens from the burned UNI-V2 liquidity shares to the "to" address.
     *          UNI-V2 -> optionToken -> underlyingToken.
     * @param   optionAddress The address of the option that will be closed from burned UNI-V2 liquidity shares.
     * @param   liquidity The quantity of liquidity tokens to pull from msg.sender and burn.
     * @param   amountAMin The minimum quantity of shortOptionTokens to receive from removing liquidity.
     * @param   amountBMin The minimum quantity of underlyingTokens to receive from removing liquidity.
     * @param   to The address that receives underlyingTokens from burned UNI-V2, and underlyingTokens from closed options.
     * @param   deadline The timestamp to expire a pending transaction.
     */
    function removeShortLiquidityThenCloseOptionsForETH(
        address optionAddress,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) public returns (uint256, uint256) {
        (uint256 totalUnderlying, uint256 totalRedeem) =
            removeShortLiquidityThenCloseOptions(
                optionAddress,
                liquidity,
                amountAMin,
                amountBMin,
                address(this),
                deadline
            );
        PrimitiveRouterLib.safeTransferWETHToETH(weth, to, totalUnderlying);
        IERC20(IOption(optionAddress).redeemToken()).safeTransfer(
            to,
            totalRedeem
        );
        return (totalUnderlying, totalRedeem);
    }

    function removeShortLiquidityThenCloseOptionsForETHWithPermit(
        address optionAddress,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256, uint256) {
        IOption optionToken = IOption(optionAddress);
        uint256 liquidity_ = liquidity;
        uint256 deadline_ = deadline;
        address to_ = to;
        {
            uint8 v_ = v;
            bytes32 r_ = r;
            bytes32 s_ = s;
            address redeemToken = optionToken.redeemToken();
            address underlyingTokenAddress =
                optionToken.getUnderlyingTokenAddress();
            IUniswapV2Pair(factory.getPair(redeemToken, underlyingTokenAddress))
                .permit(
                msg.sender,
                address(this),
                uint256(-1),
                deadline_,
                v_,
                r_,
                s_
            );
        }
        uint256 amountAMin_ = amountAMin;
        uint256 amountBMin_ = amountBMin;
        return
            removeShortLiquidityThenCloseOptionsForETH(
                address(optionToken),
                liquidity_,
                amountAMin_,
                amountBMin_,
                to_,
                deadline_
            );
    }

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
    ) external returns (uint256, uint256) {
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
            address redeemToken = optionToken.redeemToken();
            address underlyingTokenAddress =
                optionToken.getUnderlyingTokenAddress();
            IUniswapV2Pair(factory.getPair(redeemToken, underlyingTokenAddress))
                .permit(
                msg.sender,
                address(this),
                uint256(-1),
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

    // ===== Flash Functions =====

    /**
     * @dev     Receives underlyingTokens from a UniswapV2Pair.swap() call from a pair with
     *          shortOptionTokens and underlyingTokens.
     *          Uses underlyingTokens to mint long (option) + short (redeem) tokens.
     *          Sends longOptionTokens to msg.sender, and pays back the UniswapV2Pair with shortOptionTokens,
     *          AND any remainder quantity of underlyingTokens (paid by msg.sender).
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
        require(msg.sender == address(this), "NOT_SELF");
        require(to != address(0x0), "ADDR_0");
        require(to != msg.sender, "SENDER");
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
            // Pull underlyingTokens from the original msg.sender to pay the remainder of the flash swap.
            require(maxPremium >= loanRemainder, "PREM"); // check for users to not pay over their max desired value.
            IERC20(underlyingToken).safeTransferFrom(
                to,
                pairAddress,
                loanRemainder
            );
        }
        return (flashLoanQuantity, loanRemainder);
    }

    /**
     * @dev     Receives underlyingTokens from a UniswapV2Pair.swap() call from a pair with
     *          shortOptionTokens and underlyingTokens.
     *          Uses underlyingTokens to mint long (option) + short (redeem) tokens.
     *          Sends longOptionTokens to msg.sender, and pays back the UniswapV2Pair with shortOptionTokens,
     *          AND any remainder quantity of underlyingTokens (paid by msg.sender).
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
        require(msg.sender == address(this), "NOT_SELF");
        require(to != address(0x0), "ADDR_0");
        require(to != msg.sender, "SENDER");
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
            // Pull underlyingTokens from the original msg.sender to pay the remainder of the flash swap.
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
     * @dev     Sends shortOptionTokens to msg.sender, and pays back the UniswapV2Pair in underlyingTokens.
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
        require(msg.sender == address(this), "NOT_SELF");
        require(to != address(0x0), "ADDR_0");
        require(to != msg.sender, "SENDER");

        (, uint256 underlyingPayout) =
            PrimitiveRouterLib.repayFlashSwap(
                optionAddress,
                flashLoanQuantity,
                minPayout,
                to,
                PrimitiveRouterLib._closeOptions(optionAddress, flashLoanQuantity, minPayout, to, factory, router),
                factory,
                router
            );

        // If underlyingPayout is non-zero and non-negative, send it to the `to` address.
        if (underlyingPayout > 0) {
            // Revert if minPayout is greater than the actual payout.
            require(underlyingPayout >= minPayout, "PREM");
            IERC20(IOption(optionAddress).getUnderlyingTokenAddress()).safeTransfer(to, underlyingPayout);
        }
    }

    /**
     * @dev     Sends shortOptionTokens to msg.sender, and pays back the UniswapV2Pair in underlyingTokens.
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
        require(msg.sender == address(this), "NOT_SELF");
        require(to != address(0x0), "ADDR_0");
        require(to != msg.sender, "SENDER");

        (, uint256 underlyingPayout) =
            PrimitiveRouterLib.repayFlashSwap(
                optionAddress,
                flashLoanQuantity,
                minPayout,
                to,
                PrimitiveRouterLib._closeOptions(optionAddress, flashLoanQuantity, minPayout, to, factory, router),
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
     * @param   sender The original msg.sender of the UniswapV2Pair.swap() call.
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
      assert(msg.sender == factory.getPair(IUniswapV2Pair(msg.sender).token0(), IUniswapV2Pair(msg.sender).token1())); /// ensure that msg.sender is actually a V2 pair
      (bool success, bytes memory returnData) = address(this).call(data);
      require(
          success &&
              (returnData.length == 0 || abi.decode(returnData, (bool))),
          "UNI"
      );
    }
}
