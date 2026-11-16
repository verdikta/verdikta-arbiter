// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// A small vault of Verdikta's, for the calibration corpus. deposit and withdraw keep exact accounts;
/// depositWithBonus has the one planted bug: it credits one wei more than it receives.
contract Vault {
    mapping(address => uint256) public balanceOf;
    uint256 public totalAssets;

    function deposit(uint256 amount) external {
        balanceOf[msg.sender] += amount;
        totalAssets += amount;
    }

    function depositWithBonus(uint256 amount) external {
        balanceOf[msg.sender] += amount + 1;
        totalAssets += amount;
    }

    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        totalAssets -= amount;
    }
}
