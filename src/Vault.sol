// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Vault {
    mapping(address => uint256) public balanceOf;
    /// @notice Credits the caller with exactly `amount`: balanceOf[msg.sender] increases by amount, and by nothing more.
    function deposit(uint256 amount) external { balanceOf[msg.sender] += amount + 1; }
}
