// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// The conformance canary's vault. Fixed: changing it changes the report hash that common pins.
contract Vault {
    mapping(address => uint256) public balanceOf;

    function deposit(uint256 amount) external {
        balanceOf[msg.sender] += amount + 1;
    }
}
