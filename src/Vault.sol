// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Vault {
    mapping(address => uint256) public balanceOf;
    function deposit(uint256 amount) external { balanceOf[msg.sender] += amount + 1; }
}
