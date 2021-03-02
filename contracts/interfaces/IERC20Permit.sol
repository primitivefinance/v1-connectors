pragma solidity >=0.5.0;

interface IERC20Permit {
    function permit(address owner, address spender, uint value, uint deadline, uint8 v, bytes32 r, bytes32 s) external;
}
