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
        require(PrimitiveRouterLib.realOption(optionToken, registry), "OPT");
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
    ) external returns (uint256, uint256) {
        require(PrimitiveRouterLib.realOption(optionToken, registry), "OPT");
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
    ) external returns (uint256) {
        require(PrimitiveRouterLib.realOption(optionToken, registry), "OPT");
        return(PrimitiveRouterLib.safeRedeem(optionToken, redeemQuantity, receiver));
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
        external
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        require(PrimitiveRouterLib.realOption(optionToken, registry), "OPT");
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
        // Check to make sure we are minting a WETH call option.
        require(address(weth) == optionToken.getUnderlyingTokenAddress(), "N_WETH");
        require(PrimitiveRouterLib.realOption(optionToken, registry), "OPT");

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
      require(PrimitiveRouterLib.realOption(optionToken, registry), "OPT");
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
        require(PrimitiveRouterLib.realOption(optionToken, registry), "OPT");
        // Require one of the option's assets to be WETH.
        require(optionToken.getUnderlyingTokenAddress() == address(weth), "N_WETH");

        (uint256 inputStrikes, uint256 inputOptions) =
            PrimitiveRouterLib.safeExercise(optionToken, exerciseQuantity, address(this));

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
        require(PrimitiveRouterLib.realOption(optionToken, registry), "OPT");

        // If options have not been exercised, there will be no strikeTokens to redeem, causing a revert.
        // Burns the redeem tokens that were sent to the contract, and withdraws the same quantity of WETH.
        // Sends the withdrawn WETH to this contract, so that it can be unwrapped prior to being sent to receiver.
        uint256 inputRedeems =
            PrimitiveRouterLib.safeRedeem(optionToken, redeemQuantity, address(this));
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
        (uint256 inputRedeems, uint256 inputOptions, uint256 outUnderlyings) =
        PrimitiveRouterLib.safeClose(
          optionToken, closeQuantity, address(this),
          PrimitiveRouterLib.getProportionalShortOptions(
              optionToken,
              closeQuantity
          )
        );

        // Since underlyngTokens are WETH, unwrap them then send the ethers to the receiver.
        PrimitiveRouterLib.safeTransferWETHToETH(weth, receiver, closeQuantity);
        return (inputRedeems, inputOptions, outUnderlyings);
    }
}
